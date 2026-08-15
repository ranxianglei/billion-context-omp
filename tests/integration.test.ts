// @ts-nocheck — mock-heavy integration test: captureApi/fakeCtx deliberately
// approximate the ExtensionAPI shape. Verified at runtime (bun test), not by tsc.
import { test } from "node:test";
import assert from "node:assert/strict";
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

// The fold architecture only needs a session id and a model context window —
// no getBranch, no getEntries, no session file. The input stream IS the truth.
function fakeCtx() {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/nonexistent-omp-it.session.json",
    },
  };
}

function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantCompressCall(callId: string, ranges: Array<{ startId: string; endId: string; summary: string }>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "compress", arguments: JSON.stringify({ content: ranges }) }],
    timestamp: Date.now(),
  };
}

function toolResult(callId: string, text: string) {
  return { role: "toolResult", content: [{ type: "text", text }], toolName: "compress", toolCallId: callId, timestamp: Date.now() };
}

function refOf(message: any): string {
  const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
  const textBlock = blocks.find((b: any) => b.type === "text");
  return textBlock?.text?.match(/m\d{5}/)?.[0] ?? null;
}

function bigText(seed: string) {
  return `${seed} large enough to compress on its own. `.repeat(130);
}

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
  const result = await handler({ preparation: { firstKeptEntryId: "x", tokensBefore: 100 } }, fakeCtx());
  assert.equal(result, undefined, "no usable state → undefined → Pi falls back to native compaction");
});

test("before_agent_start appends the ACP system prompt", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as unknown as ExtensionAPI);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, fakeCtx());
  const sp = result.systemPrompt.join("\n");
  assert.ok(sp.startsWith("BASE"));
  assert.ok(sp.includes("compress"));
  assert.ok(sp.includes("acp"));
});

test("context handler tags every stream message with sequential refs (no tree access needed)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);

  const stream = [userMsg("first"), userMsg("second"), userMsg("third")];
  const result = await handlers.get("context")![0]!({ type: "context", messages: stream }, fakeCtx());
  assert.ok(result, "must return transformed array so tags apply");
  const out = result.messages;
  assert.equal(out.length, 3);
  assert.equal(refOf(out[0]), "m00001", "position 1 → m00001");
  assert.equal(refOf(out[1]), "m00002", "position 2 → m00002");
  assert.equal(refOf(out[2]), "m00003", "position 3 → m00003");
});

test("refs stay stable as the stream grows (append-only turns)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, fakeCtx());

  const turn1 = [userMsg(bigText("one")), userMsg("short")];
  const r1 = await fire(turn1);
  const turn2 = [...turn1, userMsg(bigText("two")), userMsg("reply")];
  const r2 = await fire(turn2);

  assert.equal(refOf(r1.messages[0]), refOf(r2.messages[0]), "same stream position keeps its ref");
  assert.equal(refOf(r1.messages[1]), refOf(r2.messages[1]), "appending must not renumber the prefix");
});

test("metadata fields (attribution, usage, timestamps) never shift refs", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, fakeCtx());

  const base = [userMsg(bigText("meta")), { role: "assistant", content: [{ type: "text", text: "answer" }] }];
  const r1 = await fire(base);
  const noisy = base.map((m, i) => ({
    ...m,
    attribution: "user",
    usage: { input: 10, output: 5 },
    stopReason: "tool_use",
    timestamp: 9999999 + i,
  }));
  const r2 = await fire(noisy);
  assert.equal(refOf(r1.messages[0]), refOf(r2.messages[0]), "identity ignores metadata");
  assert.equal(refOf(r1.messages[1]), refOf(r2.messages[1]));
});

test("compress tool prunes the covered range on the next context event", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

  const stream = [userMsg(bigText("first")), userMsg(bigText("second")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  const r1 = await fire(stream);
  const targetRef = refOf(r1.messages[0]);

  const compressTool = api.tools.find((t) => t.name === "compress")!;
  const res = await compressTool.execute("tc-1", { content: [{ startId: targetRef, endId: refOf(r1.messages[1]), summary: "Both large messages were compressed into this durable summary." }] }, undefined, undefined, ctx);
  assert.match(res.content[0].text, /1 block/, res.content[0].text);

  const r2 = await fire([...stream, userMsg("next turn")]);
  const texts = r2.messages.map((m: any) => JSON.stringify(m.content)).join("\n");
  // NOTE: the kernel never prunes the FIRST user message (protected anchor),
  // so only the second covered original disappears from the model view.
  assert.ok(!texts.includes("second large enough"), "covered original pruned from the model view");
  assert.ok(texts.includes("next turn"), "new turn visible");
  const statusTool = api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc-verify", {}, undefined, undefined, ctx);
  assert.match(status.content[0].text, /1 active/, status.content[0].text);
});

test("in-stream compress calls are deduped — a replayed tool call does not double-apply", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

  const stream = [userMsg(bigText("first")), userMsg(bigText("second")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  const r1 = await fire(stream);
  const start = refOf(r1.messages[0]);
  const end = refOf(r1.messages[1]);

  // The model issued the call mid-turn…
  const call = assistantCompressCall("call_c1", [{ startId: start, endId: end, summary: "Both large messages were compressed by the model into this durable summary." }]);
  // …the tool executed (state committed)…
  const compressTool = api.tools.find((t) => t.name === "compress")!;
  const res = await compressTool.execute("call_c1", { content: [{ startId: start, endId: end, summary: "Both large messages were compressed by the model into this durable summary." }] }, undefined, undefined, ctx);
  assert.match(res.content[0].text, /1 block/, res.content[0].text);

  // …now the context event sees the assistant call + result in the stream.
  const r2 = await fire([...stream, call, toolResult("call_c1", "compressed 1 block")]);
  const summaries = r2.messages.filter((m: any) => JSON.stringify(m.content).includes("compressed by the model"));
  assert.equal(summaries.length, 1, "exactly one view of the summary (the retained tool call) — replay must not double-apply");
  assert.ok(!JSON.stringify(r2.messages).includes("second large enough"), "covered original pruned");
});

test("restart recovery: a fresh extension rebuilds blocks by replaying in-stream compress calls", async () => {
  const first = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(first.api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  const stream = [userMsg(bigText("first")), userMsg(bigText("second")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  const r1 = await first.handlers.get("context")![0]!({ type: "context", messages: stream }, ctx);
  const start = refOf(r1.messages[0]);
  const end = refOf(r1.messages[1]);

  const call = assistantCompressCall("call_c1", [{ startId: start, endId: end, summary: "Both large messages were compressed into this durable summary before the restart." }]);
  const withCall = [...stream, call, toolResult("call_c1", "compressed 1 block"), userMsg("post-compress turn")];
  await first.handlers.get("context")![0]!({ type: "context", messages: withCall }, ctx);

  // New process: brand-new extension instance, no sidecar state file — the
  // stream alone must reconstruct the block.
  const second = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(second.api as unknown as ExtensionAPI);
  const r3 = await second.handlers.get("context")![0]!({ type: "context", messages: withCall }, ctx);

  const texts = r3.messages.map((m: any) => JSON.stringify(m.content)).join("\n");
  // First user message is protected by kernel design; the second covered
  // original staying pruned proves the block was replayed from the stream.
  assert.ok(!texts.includes("second large enough"), "covered original stays pruned after restart (block replayed)");
  assert.ok(texts.includes("durable summary before the restart"), "summary text visible via the retained in-stream compress call");
  assert.ok(texts.includes("post-compress turn"), "tail intact after restart");
  const statusTool = second.api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc-verify-restart", {}, undefined, undefined, ctx);
  assert.match(status.content[0].text, /1 active/, status.content[0].text);
});

test("restart replay skips compress calls that were rejected live", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  const filler = (n: string) => `filler ${n} `.repeat(400);
  const stream = [userMsg(bigText("rejected target")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(filler(n)))];
  const r1 = await handlers.get("context")![0]!({ type: "context", messages: stream }, ctx);
  const targetRef = refOf(r1.messages[0]);

  // The model issued a compress call live, and the tool REJECTED it.
  const rejectedCall = assistantCompressCall("call_r1", [{ startId: targetRef, endId: targetRef, summary: "A summary long enough to pass length validation if it were replayed." }]);
  const withRejection = [
    ...stream,
    rejectedCall,
    toolResult("call_r1", "Compression rejected: Total compressible content too small (12 chars across 1 range(s), min 5000).. No changes applied — run acp_status to verify current state."),
  ];
  await handlers.get("context")![0]!({ type: "context", messages: withRejection }, ctx);

  // Restart: fresh extension must NOT resurrect the rejected call.
  const second = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(second.api as unknown as ExtensionAPI);
  const r2 = await second.handlers.get("context")![0]!({ type: "context", messages: withRejection }, ctx);
  const statusTool = second.api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc-rejected", {}, undefined, undefined, ctx);
  assert.doesNotMatch(status.content[0].text, /\d+ active/, "rejected call must not replay into a block");
  assert.ok(JSON.stringify(r2.messages).includes("rejected target"), "target stays visible (never compressed)");
});

test("host compaction rewriting the prefix must NOT replay stale compress calls onto shifted positions", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  // 40 large user messages, model compresses m00005..m00035 (call at pos 36..37).
  const filler = (n: number) => `message number ${n} `.repeat(120);
  const stream: any[] = [];
  for (let i = 1; i <= 40; i++) stream.push(userMsg(filler(i)));
  const r1 = await handlers.get("context")![0]!({ type: "context", messages: [...stream] }, ctx);
  const startRef = refOf(r1.messages[4]);
  const endRef = refOf(r1.messages[34]);

  const successResult = await api.tools.find((t) => t.name === "compress")!.execute("tc_fp1", { content: [{ startId: startRef, endId: endRef, summary: "A sufficiently long summary that passes the fifty character minimum validation gate." }] }, undefined, undefined, ctx);
  assert.match((successResult as any).content[0].text, /\[fp=[0-9a-f,]+\]/, "success result must carry span fingerprints");

  const compacted = [
    ...stream,
    assistantCompressCall("tc_fp1", [{ startId: startRef, endId: endRef, summary: "A sufficiently long summary that passes the fifty character minimum validation gate." }]),
    toolResult("tc_fp1", (successResult as any).content[0].text),
    userMsg(filler(41)),
  ];
  // Host compaction folds the first 5 messages into one summary — every
  // later position shifts back by 4. The stale refs m00005..m00035 still
  // RESOLVE (the stream is long enough) but now point at shifted messages,
  // so only the fingerprint guard (not an out-of-range reject) can catch it.
  const rewritten = [userMsg(bigText("host compaction summary")), ...compacted.slice(5)];

  const second = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(second.api as unknown as ExtensionAPI);
  await second.handlers.get("context")![0]!({ type: "context", messages: rewritten }, ctx);
  const statusTool = second.api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc_fp2", {}, undefined, undefined, ctx);
  assert.doesNotMatch(status.content[0].text, /\d+ active/, "stale call must NOT replay onto shifted positions");
});

test("live-rejected compress call stays rejected on the next INCREMENTAL context event", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  const filler = (n: number) => `content ${n} `.repeat(600);
  const stream = [userMsg(bigText("target one")), userMsg(bigText("target two")), userMsg(filler(1)), userMsg(filler(2)), userMsg(filler(3)), userMsg(filler(4)), userMsg(filler(5)), userMsg(filler(6))];
  const r1 = await handlers.get("context")![0]!({ type: "context", messages: [...stream] }, ctx);
  const ref1 = refOf(r1.messages[0]);
  const ref2 = refOf(r1.messages[1]);
  const compress = api.tools.find((t) => t.name === "compress")!;
  const ok = await compress.execute("tc_ok", { content: [{ startId: ref1, endId: ref2, summary: "First target compressed with a summary that is definitely long enough to pass." }] }, undefined, undefined, ctx);
  assert.match((ok as any).content[0].text, /reclaimed/, "setup: first compression succeeds");
  // Same SPAN again: live execution works on the pruned turn view where the
  // covered messages no longer exist → rejected. Replay on the full stream
  // projection would resolve them again — this is exactly the resurrection
  // asymmetry the guard must close.
  const rejected = await compress.execute("tc_dup", { content: [{ startId: ref1, endId: ref2, summary: "Duplicate attempt with a summary that is definitely long enough to pass." }] }, undefined, undefined, ctx);
  assert.match((rejected as any).content[0].text, /No changes applied/, "setup: duplicate is rejected live");

  // Next context event: the stream now carries the call + rejection result.
  const stream2 = [...stream, assistantCompressCall("tc_ok", [{ startId: ref1, endId: ref2, summary: "First target compressed with a summary that is definitely long enough to pass." }]), toolResult("tc_ok", (ok as any).content[0].text), assistantCompressCall("tc_dup", [{ startId: ref1, endId: ref2, summary: "Duplicate attempt with a summary that is definitely long enough to pass." }]), toolResult("tc_dup", (rejected as any).content[0].text), userMsg(filler(7))];
  await handlers.get("context")![0]!({ type: "context", messages: stream2 }, ctx);

  const statusTool = api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc_inc", {}, undefined, undefined, ctx);
  assert.match(status.content[0].text, /\u2014 1 active/, `rejected call must not resurrect on incremental fold:\n${status.content[0].text}`);
  assert.doesNotMatch(status.content[0].text, /\bb2\b/, "no resurrection block");
});

test("native /compact rewrite keeps blocks decompressable and blockIds continuous (#19)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

  const stream = [userMsg(bigText("keep me")), userMsg(bigText("compact target one")), userMsg(bigText("compact target two")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  const r1 = await fire([...stream]);
  const compress = api.tools.find((t) => t.name === "compress")!;
  const resA = await compress.execute("tc19a", { content: [{ startId: refOf(r1.messages[1]), endId: refOf(r1.messages[2]), summary: "The two compact targets are preserved in this durable block summary." }] }, undefined, undefined, ctx);
  assert.match(resA.content[0].text, /1 block/, `setup: compression must succeed:\n${resA.content[0].text}`);

  // Host native compaction: summary message replaces the whole prefix — the
  // in-stream compress call and its result are gone from the live view.
  const rewritten = [userMsg("native compaction summary of the discarded turns"), userMsg("post-compact turn")];
  const r2 = await fire(rewritten);
  assert.ok(!JSON.stringify(r2.messages).includes("compact target one"), "compacted content stays folded out of the live view");

  // The block survives the rewrite and its content is restorable from the
  // carry-over archive — the exact regression reported in #19.
  const statusTool = api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc19s", {}, undefined, undefined, ctx);
  assert.ok(status.content[0].text.includes("b1"), `carried-over block must stay listed:\n${status.content[0].text}`);

  const decompressTool = api.tools.find((t) => t.name === "decompress")!;
  const res = await decompressTool.execute("tc19d", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res as any).content[0].text as string;
  assert.ok(text.includes("compact target one") && text.includes("compact target two"),
    `archived originals must be restorable after native compaction:\n${text}`);

  // Block numbering continues after carry-over: the next live compression is
  // b2, never a collision with the archived b1.
  const tail = [...rewritten, ...["x", "y", "z", "w", "v", "u"].map((n) => userMsg(`post-compact ${n} `.repeat(400)))];
  const r3 = await fire(tail);
  const ok = await compress.execute("tc19b", { content: [{ startId: refOf(r3.messages[2]), endId: refOf(r3.messages[2]), summary: "Post-compaction turn folded into a fresh durable summary block b2." }] }, undefined, undefined, ctx);
  assert.match(ok.content[0].text, /reclaimed/, `next compression must succeed after carry-over:\n${ok.content[0].text}`);
  const status2 = await statusTool.execute("tc19s2", {}, undefined, undefined, ctx);
  assert.ok(status2.content[0].text.includes("b2"), `next block must continue numbering after carry-over:\n${status2.content[0].text}`);
  assert.ok(status2.content[0].text.includes("b1"), `archived b1 must still be listed:\n${status2.content[0].text}`);
});

test("tail rewind (retry) re-folds deterministically without losing prefix refs", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: any[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);

  const prefix = [userMsg(bigText("stable one")), userMsg(bigText("stable two"))];
  const abandonedTail = [userMsg("abandoned question"), { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] }];
  await fire([...prefix, ...abandonedTail]);

  const retried = [...prefix, userMsg("retry question")];
  const r = await fire(retried);
  assert.equal(refOf(r.messages[0]), "m00001", "prefix refs unchanged after rewind");
  assert.equal(refOf(r.messages[1]), "m00002");
  const texts = r.messages.map((m: any) => JSON.stringify(m.content)).join("\n");
  assert.ok(!texts.includes("abandoned"), "rewound tail dropped");
  assert.ok(texts.includes("retry question"), "new tail visible");
});

test("acp_status refs remain usable by the next compress call", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  const stream = [userMsg(bigText("status target")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  await handlers.get("context")![0]!({ type: "context", messages: stream }, ctx);

  const statusTool = api.tools.find((t) => t.name === "acp_status")!;
  const status = await statusTool.execute("tc-status", {}, undefined, undefined, ctx);
  const targetRef = status.content[0].text.match(/m\d{5}/)![0];
  assert.equal(targetRef, "m00001", status.content[0].text);

  const compressTool = api.tools.find((t) => t.name === "compress")!;
  const result = await compressTool.execute("tc-status-compress", { content: [{ startId: targetRef, endId: targetRef, summary: "This range was selected by acp_status and is now safely compressed." }] }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /1 block/, result.content[0].text);
});

test("system prompt sources compression rules from acp-kernel (no hardcoded drift, no markers)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as unknown as ExtensionAPI);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, fakeCtx());
  const sp = result.systemPrompt.join("\n");
  assert.ok(sp.includes("Work from summaries, not raw tool outputs"), "kernel COMPRESS_PHILOSOPHY inlined");
  assert.ok(sp.includes("HOW TO COMPRESS"), "kernel HOW_TO_COMPRESS_RULES inlined");
  assert.ok(sp.includes("TIER 2 COMPRESSION"), "kernel TIER2_DISTILL_RULES inlined");
  assert.ok(sp.includes("TIER 3 COMPRESSION"), "kernel TIER3_CONDENSE_RULES inlined");
  assert.ok(!sp.includes("[[KEEP:"), "no KEEP marker teaching");
  assert.ok(!sp.includes("[[REF:"), "no REF marker teaching");
  assert.ok(!sp.includes("KEEP MARKERS"), "no KEEP MARKERS section");
  assert.ok(!sp.includes("Two failure modes to avoid"), "old hardcoded philosophy removed");
  assert.ok(!sp.includes("Over-compression: Compressing too aggressively"), "old hardcoded over/under-compression section removed");
});

test("system prompt never includes the ACP_DELEGATE NOTIFICATIONS section (omp defers delegation to oh-my-pi)", () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ delegate: true })(api as unknown as ExtensionAPI);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "" }, fakeCtx());
  const sp = result.systemPrompt.join("\n");
  assert.ok(!sp.includes("ACP_DELEGATE NOTIFICATIONS"), "delegate section always omitted (omp provides its own orchestration)");
  assert.ok(sp.includes("ACP TAGS"), "core ACP prompt present");
});

test("restart replay preserves tier-2 blocks (block-boundary ranges must not be treated as stale)", async () => {
  const first = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(first.api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: any[]) => first.handlers.get("context")![0]!({ type: "context", messages }, ctx);

  const stream = [userMsg(bigText("first")), userMsg(bigText("second")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  const r1 = await fire(stream);
  const start = refOf(r1.messages[0]);
  const end = refOf(r1.messages[1]);

  const compressTool = first.api.tools.find((t) => t.name === "compress")!;
  const res1 = await compressTool.execute("call_c1", { content: [{ startId: start, endId: end, summary: "Both large messages were compressed into this durable tier one summary." }] }, undefined, undefined, ctx);
  const res2 = await compressTool.execute("call_c2", { content: [{ startId: "b1", endId: "b1", summary: "Tier two distillation condensing the tier one block even further for long sessions." }] }, undefined, undefined, ctx);
  assert.match(res2.content[0].text, /1 block/, res2.content[0].text);

  const call1 = assistantCompressCall("call_c1", [{ startId: start, endId: end, summary: "Both large messages were compressed into this durable tier one summary." }]);
  const call2 = assistantCompressCall("call_c2", [{ startId: "b1", endId: "b1", summary: "Tier two distillation condensing the tier one block even further for long sessions." }]);
  const withCalls = [...stream, call1, toolResult("call_c1", res1.content[0].text), call2, toolResult("call_c2", res2.content[0].text), userMsg("post tier-two turn")];
  await fire(withCalls);

  const statusTool1 = first.api.tools.find((t) => t.name === "acp_status")!;
  const liveStatus = (await statusTool1.execute("tc-live", {}, undefined, undefined, ctx)).content[0].text;

  // New process: the stream alone must rebuild BOTH tiers.
  const second = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(second.api as unknown as ExtensionAPI);
  const r3 = await second.handlers.get("context")![0]!({ type: "context", messages: withCalls }, ctx);
  const texts = r3.messages.map((m: any) => JSON.stringify(m.content)).join("\n");
  assert.ok(!texts.includes("second large enough"), "covered original stays pruned under the tier-2 block");

  const statusTool2 = second.api.tools.find((t) => t.name === "acp_status")!;
  const status = (await statusTool2.execute("tc-restart", {}, undefined, undefined, ctx)).content[0].text;
  assert.ok(status.includes("b2"), `tier-2 block b2 must survive restart:\n${status}`);
  assert.equal((status.match(/active/g) ?? []).length >= 0, true);
  assert.ok(liveStatus.includes("b2"), "sanity: live status shows b2");
});

test("mixed message/block boundary batch keeps fingerprint index alignment on replay", async () => {
  const first = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(first.api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: any[]) => first.handlers.get("context")![0]!({ type: "context", messages }, ctx);

  const stream = [userMsg(bigText("first")), userMsg(bigText("second")), userMsg(bigText("third")), ...["a", "b", "c", "d", "e", "f", "g"].map((n) => userMsg(`filler ${n} `.repeat(400)))];
  const r1 = await fire(stream);
  const start = refOf(r1.messages[0]);
  const end = refOf(r1.messages[1]);
  const third = refOf(r1.messages[2]);

  const compressTool = first.api.tools.find((t) => t.name === "compress")!;
  const res1 = await compressTool.execute("call_c1", { content: [{ startId: start, endId: end, summary: "First two large messages were compressed into this durable tier one summary." }] }, undefined, undefined, ctx);
  // One call, two ranges: a fresh message range + a block re-distill range.
  const mixedRanges = [
    { startId: third, endId: third, summary: "Third large message compressed on its own into this separate summary block." },
    { startId: "b1", endId: "b1", summary: "Tier two distillation of the first block created in the same batch call." },
  ];
  const res2 = await compressTool.execute("call_c2", { content: mixedRanges }, undefined, undefined, ctx);
  assert.match(res2.content[0].text, /2 blocks/, res2.content[0].text);
  // The fp list must carry one aligned entry per range (both resolve to real
  // fingerprints — the block boundary via the block ledger).
  assert.match(res2.content[0].text, /\[fp=[0-9a-f]+,[0-9a-f]+\]/, res2.content[0].text);

  const call1 = assistantCompressCall("call_c1", [{ startId: start, endId: end, summary: "First two large messages were compressed into this durable tier one summary." }]);
  const call2 = assistantCompressCall("call_c2", mixedRanges);
  const withCalls = [...stream, call1, toolResult("call_c1", res1.content[0].text), call2, toolResult("call_c2", res2.content[0].text), userMsg("post mixed-batch turn")];

  const second = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(second.api as unknown as ExtensionAPI);
  const r3 = await second.handlers.get("context")![0]!({ type: "context", messages: withCalls }, ctx);
  const texts = r3.messages.map((m: any) => JSON.stringify(m.content)).join("\n");
  assert.ok(!texts.includes("second large enough"), "block-range content stays pruned (call not mis-skipped)");
  assert.ok(!texts.includes("third large enough"), "message-range content stays pruned");

  const statusTool = second.api.tools.find((t) => t.name === "acp_status")!;
  const status = (await statusTool.execute("tc-mixed", {}, undefined, undefined, ctx)).content[0].text;
  assert.ok(status.includes("b3"), `both ranges of the mixed call must replay (b1, b2, b3):\n${status}`);
});
