// @ts-nocheck — mock-heavy integration test: captureApi/fakeCtx deliberately
// approximate the ExtensionAPI shape. Verified at runtime (bun test), not by tsc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Mock Pi's ExtensionAPI — captures the event handlers the factory registers,
// so we can invoke them with a fake ExtensionContext and assert the wiring works.
interface MockApi {
  tools: Array<{ name: string; execute?: (id: string, args: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>; [k: string]: unknown }>;
  commands: Map<string, unknown>;
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
}
type HandlerMap = Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
function captureApi(): { api: MockApi; handlers: HandlerMap } {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const api: MockApi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [],
    commands: new Map(),
    registerTool(tool) {
      this.tools.push(tool as MockApi["tools"][number]);
    },
    registerCommand(name, options) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}


function fakeCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

type MockEntry = { type: string; id: string; parentId: null; timestamp: string; message: object };

test("factory registers the compress tool and 4 flat commands", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as unknown as ExtensionAPI);

  assert.ok(api.tools.some((t) => t.name === "compress"), "compress tool registered");
  assert.deepEqual([...api.commands.keys()].sort(), ["acp", "acp-decompress", "acp-search", "acp-status"]);
  assert.ok(handlers.has("context"), "context event wired");
  assert.ok(handlers.has("session_before_compact"), "compaction-disable wired");
  assert.ok(handlers.has("before_agent_start"), "system-prompt wired");
});

test("session_before_compact falls back to Pi native compaction on failure", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as unknown as ExtensionAPI);
  const handler = handlers.get("session_before_compact")![0]!;
  const result = await handler({ preparation: { firstKeptEntryId: "x", tokensBefore: 100 } }, {} as any);
  assert.equal(result, undefined, "no usable state → undefined → Pi falls back to native compaction");
});

test("before_agent_start appends the ACP system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as unknown as ExtensionAPI);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, {});
  const sp = result.systemPrompt.join("\n");
  assert.ok(sp.startsWith("BASE"));
  assert.ok(sp.includes("compress"));
  assert.ok(sp.includes("acp"));
});

test("context handler tags every message with a ref even when length matches event.messages", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);

  const entries = [userMsg("e1", "first"), userMsg("e2", "second"), userMsg("e3", "third")];
  const ctx = fakeCtx(entries, "/tmp/nonexistent-omp-it.session.json");
  // Real Pi passes event.messages with the same length/roles as the session — the
  // handler must STILL return {messages} (not undefined), or the model never sees tags.
  const sameLengthMessages = entries.map(() => ({ role: "user", content: "x", timestamp: 0 }));

  const result = await handlers.get("context")![0]!({ type: "context", messages: sameLengthMessages }, ctx);
  assert.ok(result, "must return transformed array even when length/roles match (tags must apply)");
  const out = result.messages;
  assert.equal(out.length, 3);
  const firstContent = (out[0] as any).content as any[];
  assert.ok(firstContent.some((b: any) => b.type === "text" && b.text.includes("m0000")), "first msg ref-tagged");
});

test("context handler works under omp (oh-my-pi) where sessionManager exposes getBranch() not buildContextEntries()", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);

  const entries = [userMsg("e1", "first"), userMsg("e2", "second")];
  const ctx = {
    ...fakeCtx(entries, "/tmp/nonexistent-omp-omp.session.json"),
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-omp-omp.session.json",
    },
  };
  const sameLengthMessages = entries.map(() => ({ role: "user", content: "x", timestamp: 0 }));

  const result = await handlers.get("context")![0]!({ type: "context", messages: sameLengthMessages }, ctx);
  assert.ok(result, "handler must not throw and must return transformed messages under omp");
  const out = result.messages;
  assert.equal(out.length, 2);
  const firstContent = (out[0] as any).content as any[];
  assert.ok(firstContent.some((b: any) => b.type === "text" && b.text.includes("m0000")), "omp path tags messages with refs");
});

test("omp matches emergency-truncated tool results before compression", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "omp-omp-truncation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");
  const originalText = "This large tool output must retain its persisted identity. ".repeat(130);
  const truncatedText = `${originalText.slice(0, 2000)}\n\n...[truncated for context space] — original ~1500 tokens]...\n\n${originalText.slice(-2000)}`;
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const persisted = [
    { type: "message", id: "e1", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: originalText }], timestamp: Date.now() } },
    ...["two", "three", "four", "five", "six", "seven"].map((n, index) => userMsg(`e${index + 2}`, filler(n))),
  ];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const liveMessages = [
    { role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: truncatedText }], timestamp: Date.now() },
    ...["two", "three", "four", "five", "six", "seven"].map((n) => ({ role: "user", content: [{ type: "text", text: filler(n) }], timestamp: Date.now() })),
  ];
  const transformed = await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  const targetRef = transformed.messages[0].content.find((block: { type: string; text: string }) => block.type === "text").text.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-omp-truncation", { content: [{ startId: targetRef, endId: targetRef, summary: "This large tool result was emergency-truncated in provider context and is now safely compressed from the original entry." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("acp_status refs remain usable by the next compress call", async () => {
  const { api } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const stateFile = "/tmp/nonexistent-omp-status-compress.session.json";
  await rm(`${stateFile}.acp-omp.json`, { force: true });
  const originalText = "This range is reported by acp_status and must remain addressable by compress. ".repeat(130);
  const persisted = [userMsg("e1", originalText), ...["two", "three", "four", "five", "six", "seven"].map((n, index) => userMsg(`e${index + 2}`, `filler ${n} `.repeat(400)))];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const statusTool = api.tools.find((tool: { name: string }) => tool.name === "acp_status")!;
  const status = await statusTool.execute("tc-status", {}, undefined, undefined, ctx);
  const targetRef = status.content[0].text.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-status-compress", { content: [{ startId: targetRef, endId: targetRef, summary: "This range was selected by acp_status and is now safely compressed from the original entry." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("omp rebuilds refs after stale live state before status compression", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const stateFile = "/tmp/nonexistent-omp-stale-live.session.json";
  await rm(`${stateFile}.acp-omp.json`, { force: true });
  const longText = "This stale live state must be rebuilt against the current persisted branch. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const texts = [longText, filler("two"), filler("three"), filler("four"), filler("five"), filler("six"), filler("seven")];
  let persisted: MockEntry[] = [];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };
  const liveMessages = texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }));
  await handlers.get("context")![0]!({ type: "context", messages: liveMessages }, ctx);
  persisted = texts.map((text, index) => userMsg(`e${index + 1}`, text));
  const statusTool = api.tools.find((tool: { name: string }) => tool.name === "acp_status")!;
  const status = await statusTool.execute("tc-stale-live-status", {}, undefined, undefined, ctx);
  const targetRef = status.content[0].text.match(/m\d{5}/)![0];
  assert.equal(targetRef, "m00001", status.content[0].text);
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const result = await compressTool.execute("tc-stale-live-compress", { content: [{ startId: targetRef, endId: targetRef, summary: "This stale live range was rebuilt against stable persisted entries and is now safely compressed." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("system prompt sources compression rules from acp-kernel (no hardcoded drift, no markers)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as unknown as ExtensionAPI);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  const sp = result.systemPrompt.join("\n");
  // kernel constants inlined (regression guard against reverting to a hardcoded copy)
  assert.ok(sp.includes("Work from summaries, not raw tool outputs"), "kernel COMPRESS_PHILOSOPHY inlined");
  assert.ok(sp.includes("HOW TO COMPRESS"), "kernel HOW_TO_COMPRESS_RULES inlined");
  assert.ok(sp.includes("TIER 2 COMPRESSION"), "kernel TIER2_DISTILL_RULES inlined");
  assert.ok(sp.includes("TIER 3 COMPRESSION"), "kernel TIER3_CONDENSE_RULES inlined");
  // marker system removed entirely from kernel constants
  assert.ok(!sp.includes("[[KEEP:"), "no KEEP marker teaching");
  assert.ok(!sp.includes("[[REF:"), "no REF marker teaching");
  assert.ok(!sp.includes("KEEP MARKERS"), "no KEEP MARKERS section");
  // old hardcoded copy removed
  assert.ok(!sp.includes("Two failure modes to avoid"), "old hardcoded philosophy removed");
  assert.ok(!sp.includes("Over-compression: Compressing too aggressively"), "old hardcoded over/under-compression section removed");
});

test("context handler persists state so a second call is idempotent on the same entries", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);

  const entries = [userMsg("e1", "alpha"), userMsg("e2", "beta")];
  const ctx = fakeCtx(entries, "/tmp/nonexistent-omp-it2.session.json");


  const first = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const second = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  assert.equal(first.messages.length, second.messages.length);
  const tag1 = ((first.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  const tag2 = ((second.messages[0] as any).content as any[]).find((b: any) => b.type === "text" && b.text.startsWith("[m"));
  assert.equal(tag1?.text, tag2?.text, "refs stable across calls (loaded from persisted state)");
});
test("omp keeps compression blocks active when provider context has an extra prefix", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "omp-omp-provider-prefix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");
  const texts = [
    "This first message is large enough to compress. ".repeat(130),
    "This second message is also part of the compressed range. ".repeat(130),
    ...["three", "four", "five", "six", "seven"].map((n) => `filler ${n} `.repeat(400)),
  ];
  const persisted = texts.map((text, index) => userMsg(`e${index + 1}`, text));
  const ctx = {
    ...fakeCtx(persisted, stateFile),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
  const initial = await handlers.get("context")![0]!(
    { type: "context", messages: texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })) },
    ctx,
  );
  const first = initial.messages[0] as { content: Array<{ type?: string; text?: string }> };
  const targetRef = first.content.find((block) => block.type === "text")!.text!.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const compressed = await compressTool.execute(
    "tc-omp-provider-prefix",
    { content: [{ startId: targetRef, endId: "m00002", summary: "The first two messages were compressed into a durable ACP summary." }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(compressed.content[0].text, /1 block/);

  const next = await handlers.get("context")![0]!(
    {
      type: "context",
      messages: [
        { role: "user", content: [{ type: "text", text: "provider-only context prefix" }], timestamp: Date.now() },
        ...texts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })),
      ],
    },
    ctx,
  );
  const saved = JSON.parse(await readFile(`${stateFile}.acp-omp.json`, "utf8"));
  assert.equal(saved.blocks[0].active, true, "the compressed block must remain active after the prefix");
  assert.ok(next.messages.length < texts.length + 1, "covered messages must be replaced in provider context");
});

test("omp keeps compression active when persisted and provider tails diverge", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "omp-omp-branch-divergence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");
  const commonTexts = [
    "This first common message is large enough to compress. ".repeat(130),
    "This second common message is also part of the compressed range. ".repeat(130),
    ...["three", "four", "five", "six", "seven"].map((n) => `common filler ${n} `.repeat(400)),
  ];
  let persisted = commonTexts.map((text, index) => userMsg(`e${index + 1}`, text));
  const ctx = {
    ...fakeCtx(persisted, stateFile),
    sessionManager: {
      getBranch: () => persisted,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
  const liveCommon = commonTexts.map((text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }));
  const initial = await handlers.get("context")![0]!({ type: "context", messages: liveCommon }, ctx);
  const first = initial.messages[0] as { content: Array<{ type?: string; text?: string }> };
  const targetRef = first.content.find((block) => block.type === "text")!.text!.match(/m\d{5}/)![0];
  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const compressed = await compressTool.execute(
    "tc-omp-branch-divergence",
    { content: [{ startId: targetRef, endId: "m00002", summary: "The first two common messages were compressed into a durable ACP summary." }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(compressed.content[0].text, /1 block/);

  const activeUserText = "current user on the active branch";
  persisted = [...persisted, userMsg("e-active-user", activeUserText)];
  const divergent = await handlers.get("context")![0]!(
    {
      type: "context",
      messages: [
        { role: "user", content: [{ type: "text", text: "projected provider-only prefix" }], timestamp: Date.now() },
        ...liveCommon,
        { role: "assistant", content: [{ type: "text", text: "abandoned branch assistant tail" }], timestamp: Date.now() },
        { role: "user", content: [{ type: "text", text: activeUserText }], timestamp: Date.now() },
      ],
    },
    ctx,
  );
  const saved = JSON.parse(await readFile(`${stateFile}.acp-omp.json`, "utf8"));
  assert.equal(saved.blocks[0].active, true, "the compressed block must remain active across divergent branch tails");
  assert.ok(divergent.messages.length < commonTexts.length + 3, "covered common messages must stay pruned");
});


test("system prompt never includes the ACP_DELEGATE NOTIFICATIONS section (omp defers delegation to oh-my-pi)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ delegate: true })(api as unknown as ExtensionAPI);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, {});
  const sp = result.systemPrompt.join("\n");
  assert.ok(!sp.includes("ACP_DELEGATE NOTIFICATIONS"), "delegate section always omitted (omp provides its own orchestration)");
  assert.ok(sp.includes("ACP TAGS"), "core ACP prompt present");
});

test("omp keeps compression block active across turns (stable entry IDs, no migration)", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, coreOverrides: { preserveRecentTokens: 0 } })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "omp-block-stable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");

  const target = "This large message will be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(200);

  const persisted = [
    userMsg("e1", filler("first")),
    userMsg("e2", target),
    ...["a", "b", "c", "d", "e"].map((n, i) => userMsg(`e${i + 3}`, filler(n))),
  ];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };

  const first = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const targetRef = first.messages[1]!.content.find((b: { type: string; text: string }) => b.type === "text")!.text.match(/m\d{5}/)![0];

  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const compressRes = await compressTool.execute!("tc1", { content: [{ startId: targetRef, endId: targetRef, summary: "Summary of the large compressed message across turns for stability testing." }] }, undefined, undefined, ctx);
  assert.match(compressRes.content[0]!.text, /1 block/, compressRes.content[0]!.text);

  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const saved = JSON.parse(await readFile(`${stateFile}.acp-omp.json`, "utf8"));
  const activeBlocks = saved.blocks.filter((b: { active: boolean }) => b.active);
  assert.equal(activeBlocks.length, 1, "block must stay active across turns");
  assert.ok(activeBlocks[0]!.effectiveMessageIds.includes("e2"), "block uses stable persisted entry ID");
  assert.ok(!activeBlocks[0]!.effectiveMessageIds.some((id: string) => id.startsWith("live-")), "no stale live-* IDs in block");
});

test("omp e2e: compression block stable across turns with omp metadata fields (attribution, usage, stopReason)", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, coreOverrides: { preserveRecentTokens: 0 } })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "omp-metadata-stable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");

  const target = "This large message will be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(200);

  // Persisted entries carry omp metadata fields that must not affect ref stability
  const persisted = [
    { type: "message", id: "e1", parentId: null, timestamp: "", message: { attribution: "user", role: "user", content: [{ type: "text", text: filler("first") }], timestamp: Date.now() } },
    { type: "message", id: "e2", parentId: null, timestamp: "", message: { attribution: "user", role: "user", content: [{ type: "text", text: target }], timestamp: Date.now() } },
    ...["a", "b", "c", "d", "e"].map((n, i) => ({ type: "message" as const, id: `e${i + 3}`, parentId: null, timestamp: "", message: { attribution: "user", role: "user", content: [{ type: "text", text: filler(n) }], timestamp: Date.now() } })),
  ];
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };

  const first = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  const targetRef = first.messages[1]!.content.find((b: { type: string; text: string }) => b.type === "text")!.text.match(/m\d{5}/)![0];

  const compressTool = api.tools.find((tool: { name: string }) => tool.name === "compress")!;
  const compressRes = await compressTool.execute!("tc1", { content: [{ startId: targetRef, endId: targetRef, summary: "Summary of the large compressed message with omp metadata fields for stability testing." }] }, undefined, undefined, ctx);
  assert.match(compressRes.content[0]!.text, /1 block/, compressRes.content[0]!.text);

  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const saved = JSON.parse(await readFile(`${stateFile}.acp-omp.json`, "utf8"));
  const activeBlocks = saved.blocks.filter((b: { active: boolean }) => b.active);
  assert.equal(activeBlocks.length, 1, "block must stay active across turns with metadata fields");
  assert.ok(activeBlocks[0]!.effectiveMessageIds.includes("e2"), "block uses stable persisted entry ID");
  assert.ok(!activeBlocks[0]!.effectiveMessageIds.some((id: string) => id.startsWith("live-")), "no stale live-* IDs in block");
  const liveRawIds = Object.keys(saved.messageRefs?.byRaw ?? {}).filter((id: string) => id.startsWith("live-"));
  assert.equal(liveRawIds.length, 0, `0 live-* messageRefs expected, got ${liveRawIds.length}`);
});

test("omp e2e: stable refs across full session lifecycle with provider metadata", async (t) => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const dir = await mkdtemp(join(tmpdir(), "omp-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "session.json");

  function buildConversation(n: number) {
    const msgs: any[] = [];
    for (let i = 0; i < n; i++) {
      msgs.push({ attribution: "user", role: "user", content: [{ type: "text", text: `user msg ${i} ${"x".repeat(100)}` }], timestamp: Date.now() });
      msgs.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call_${i}`, name: "read", arguments: { path: `file${i}.ts` } }],
        api: "openai-completions", model: "glm-5.2", provider: "zhipuai",
        stopReason: "tool_use", usage: { input: 1000, output: 100, totalTokens: 1100 },
        contextSnapshot: { promptTokens: 1000 }, duration: 100, ttft: 50, responseId: `resp_${i}`,
        timestamp: Date.now(),
      });
      msgs.push({ role: "toolResult", content: [{ type: "text", text: `result ${i} ${"y".repeat(100)}` }], toolName: "read", toolCallId: `call_${i}`, details: { exitCode: 0 }, isError: false, timestamp: Date.now() });
    }
    return msgs;
  }

  // Start with persisted entries that carry full omp metadata
  const conv = buildConversation(5);
  const persisted = conv.map((m, i) => ({ type: "message" as const, id: `e${i}`, parentId: null, timestamp: "", message: m }));
  const ctx = { ...fakeCtx(persisted, stateFile), sessionManager: { getBranch: () => persisted, getSessionId: () => "test-session", getSessionFile: () => stateFile } };

  const r1 = await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  assert.ok(r1.messages.length > 0, "first turn produces output");

  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const saved = JSON.parse(await readFile(`${stateFile}.acp-omp.json`, "utf8"));
  const liveRawIds = Object.keys(saved.messageRefs?.byRaw ?? {}).filter((id: string) => id.startsWith("live-"));
  assert.equal(liveRawIds.length, 0, `0 live-* messageRefs expected with persisted entries, got ${liveRawIds.length}`);
});
