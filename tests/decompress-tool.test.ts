import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

// The fold architecture needs no session tree — just a session id + model.
function fakeCtx() {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, api: "anthropic-messages" },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/omp-decompress-tool-it.session.json",
    },
  };
}

function streamUser(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

// Shared setup: fold a 7-message stream, compress m00001 into block b1 via the
// tool, and hand back the tool handles so tests can drive decompress.
async function setupWithCompressedBlock() {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false })(api as any);

  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(600);
  const stream = [
    streamUser(longText),
    ...["two", "three", "four", "five", "six", "seven"].map((n) => streamUser(filler(n))),
  ];
  const ctx = fakeCtx();
  const fire = (messages: any[]) => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: { model: "test", messages } }, ctx);
  await fire(stream);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const applied = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message for the decompress-tool tests." }] },
    undefined, undefined, ctx,
  );
  assert.match((applied.content[0] as any).text, /1 block/, (applied.content[0] as any).text);

  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  return { api, handlers, decompressTool, ctx, stream, fire };
}

test("decompress default writes content to an auto-generated file (no context bloat)", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc2", { blockId: "b1" }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /written to/, "result reports a file path");
  assert.match(text, /acp-decompress[\\/]b1-\d+\.txt/, "auto-generated path under the cache dir");
  assert.match(text, /stays compressed/, "tells model the block stays compressed");
  assert.match(text, /Preview:/, "includes a head preview");
  assert.ok(text.length < 2000,
    `inline content must NOT be the full restored text (result was ${text.length} chars)`);
});

test("decompress inline:true returns the full content in the tool result", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc3", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /inline:/, "result signals inline mode");
  assert.ok(text.includes("This is a detailed message that needs to be compressed."),
    "full restored content present in the tool result");
});

test("decompress toFile writes to the specified path", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const dir = await mkdtemp(join(tmpdir(), "omp-decompress-"));
  const target = join(dir, "custom.txt");
  const res = await decompressTool.execute("tc4", { blockId: "b1", toFile: target }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "result mentions the custom path");
  const written = await readFile(target, "utf8");
  assert.ok(written.includes("This is a detailed message that needs to be compressed."),
    "file contains the full restored content");
});

test("decompress toFile rejects paths outside allowed roots", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc5", { blockId: "b1", toFile: "/etc/passwd" }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.match(text, /must be under/i, "rejects arbitrary filesystem path");

  // Windows CI shape: "/etc/passwd" resolves to a NONEXISTENT drive-root dir
  // (<drive>:\\etc). The rejection must still be the security message, not an
  // existence error from the realpath probe.
  const res2 = await decompressTool.execute("tc5b", { blockId: "b1", toFile: "/nonexistent-root-xyz/sub/passwd" }, undefined, undefined, ctx);
  const text2 = (res2.content[0] as any).text as string;
  assert.match(text2, /must be under/i, "rejects path whose parent dir does not exist");
});

test("decompress keeps the block active after a file-mode call", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  await decompressTool.execute("tc6", { blockId: "b1" }, undefined, undefined, ctx);
  const res2 = await decompressTool.execute("tc7", { blockId: "b1" }, undefined, undefined, ctx);
  const text2 = (res2.content[0] as any).text as string;
  assert.doesNotMatch(text2, /not found/i, "block still present after first decompress");
});

test("decompress still restores after the stream grew (append-only turns)", async () => {
  const { decompressTool, ctx, stream, fire } = await setupWithCompressedBlock();
  await fire([...stream, streamUser("next turn question")]);
  const res = await decompressTool.execute("tc8", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.ok(text.includes("This is a detailed message that needs to be compressed."),
    "covered original still restorable from the full stream projection");
});

test("decompress degrades gracefully when the covered message left the stream (host compaction rewrite)", async () => {
  const { decompressTool, ctx, fire } = await setupWithCompressedBlock();
  // omp native compaction rewrote history: the covered message is gone.
  await fire([{ role: "user", content: [{ type: "text", text: "compacted history placeholder" }], timestamp: Date.now() }]);
  const res = await decompressTool.execute("tc9", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.match(text, /not found/i, "tool-executed block does not survive a full stream rewrite");
});

test("decompress restores multi tool-call assistant messages (split refs carry # suffix)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, autoUpdate: false })(api as any);
  const ctx = fakeCtx();
  const filler = (n: string) => `filler ${n} `.repeat(400);

  // OpenAI wire format: assistant with tool_calls array, tool results with tool_call_id.
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt", payload: "p".repeat(3000) }) } },
      { id: "call-2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls", payload: "q".repeat(3000) }) } },
    ],
    timestamp: Date.now(),
  };
  const stream = [
    assistant,
    { role: "tool", tool_call_id: "call-1", content: "out-a", timestamp: Date.now() },
    { role: "tool", tool_call_id: "call-2", content: "out-b", timestamp: Date.now() },
    ...["four", "five", "six", "seven"].map((n) => streamUser(filler(n))),
  ];
  await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: { model: "test", messages: stream } }, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  // The multi tool-call assistant projects to two cores (p1#call-1, p1#call-2),
  // each with its own ref (m00001, m00002).
  const applied = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00002", summary: "Tool call summary covering the multi tool-call assistant message content for the test." }] },
    undefined, undefined, ctx,
  );
  assert.match((applied.content[0] as any).text, /1 block/, (applied.content[0] as any).text);

  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  const res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.ok(text.includes("read") && text.includes("bash"),
    "both split tool-call cores restored");
  assert.ok(text.includes("p".repeat(20)) && text.includes("q".repeat(20)),
    "full arguments payload restored");
});

test("decompress survives repeated compress → decompress cycles (state not lost)", async () => {
  const { api, decompressTool, ctx, stream, fire } = await setupWithCompressedBlock();
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;

  let res = await decompressTool.execute("tc2", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  assert.ok(((res.content[0] as any).text as string).includes("This is a detailed message"),
    "cycle 1: original text restored");

  // Grow the stream, compress a second block over the second message.
  await fire([...stream, streamUser("extra turn")]);
  const applied = await compressTool.execute(
    "tc3",
    { content: [{ startId: "m00002", endId: "m00002", summary: "Second compression cycle summary covering the filler two message for the test." }] },
    undefined, undefined, ctx,
  );
  assert.match((applied.content[0] as any).text, /1 block/, (applied.content[0] as any).text);

  res = await decompressTool.execute("tc4", { blockId: "b2", inline: true }, undefined, undefined, ctx);
  const cycle2 = (res.content[0] as any).text as string;
  assert.ok(cycle2.includes("filler two"),
    "cycle 2: newly compressed block also restores");
});

test("decompress accepts a model-facing mNNNNN message ref (not just raw ids)", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  // effectiveMessageIds hold raw ids; the model only ever sees mNNNNN refs,
  // so the tool must translate through byRef before matching.
  const res = await decompressTool.execute("tc-mref", { blockId: "m00001", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.ok(text.includes("This is a detailed message that needs to be compressed."),
    `mNNNNN ref must resolve to the covered message's original text, got: ${text.slice(0, 200)}`);
});

test("auto-generated restore files rotate (cache dir stays bounded)", { timeout: 30_000 }, async () => {
  // Redirect HOME so the rotation assertions hit an isolated cache dir.
  const tmpHome = await mkdtemp(join(tmpdir(), "omp-decompress-rot-"));
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    const { decompressTool, ctx } = await setupWithCompressedBlock();
    const cacheDir = join(tmpHome, ".cache", "omp", "acp-decompress");
    // 105 stale restore files with strictly increasing mtimes. (Seeding
    // directly instead of 100+ tool calls: autoFilePath names by Date.now(),
    // so a tight loop overwrites within the same millisecond.)
    await mkdir(cacheDir, { recursive: true });
    const stale: string[] = [];
    for (let i = 0; i < 105; i++) {
      const p = join(cacheDir, `b1-${String(i).padStart(4, "0")}.txt`);
      await writeFile(p, "stale");
      const t = new Date(1_000_000 + i);
      await utimes(p, t, t);
      stale.push(p);
    }
    // One auto-path write through the tool must trigger the prune.
    await decompressTool.execute("tc-rot", { blockId: "b1" }, undefined, undefined, ctx);
    const files = (await readdir(cacheDir)).filter((f) => f.endsWith(".txt"));
    assert.equal(files.length, 100, `auto files must rotate at the cap, found ${files.length}`);
    assert.equal(existsSync(stale[0]!), false, "oldest stale file pruned");
    assert.equal(existsSync(stale[5]!), false, "six oldest pruned (106 files → cap 100)");
    assert.equal(existsSync(stale[6]!), true, "newest stale files kept");
    assert.equal(existsSync(stale[104]!), true, "newest stale file kept");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    await rm(tmpHome, { recursive: true, force: true });
  }
});
