import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "../src/messages.js";

// Issue #52: omp's recap/subagent pipelines re-feed billion-context-omp's
// own rebuilt output as the next context event (measured 411/1286 events;
// view A raw 216-218 msgs vs view B rebuilt 189 msgs in the #52 evidence).
// Fix: when the input stream's identity sequence exactly matches the last
// recorded rebuilt output, foldStream reuses the slot wholesale — blocks,
// message refs, cadence stamps and rejectStreak all stay continuous; no
// re-fold, and no compress-call replay (the fp-guard mis-fires against our
// own summary content — the fold-replay-stale symptom of #52). Guardrail:
// a host /compact rewrite must NOT be recognized as feedback (anti-false-
// positive, guardrail 2 of the issue).
//
// Fixture refs (kernel assignRefs skips only the compress tool RESULT as
// BLOCKED; the compress CALL keeps a ref):
//   p1 start=user(m00001, first-user protected) p2 turn 0(m00002) p3 ack 0(m00003)
//   p4 turn 1(m00004) p5 ack 1(m00005) p6 call(m00006) p7 result(BLOCKED)
//   p8 turn 2(m00007) p9 ack 2(m00008)
// The in-stream call's range m00002..m00004 precedes the call (staleRange
// guard) and sits outside the last-5 protected zone (turn 1 excluded by the
// kernel's recent-zone rule).

const FILLER = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3600); // ~241K chars ≈ 25.7K tokens

const assistantBase = {
  api: "anthropic", provider: "anthropic", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.now(),
} as const;

const u = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const a = (text: string): AgentMessage => ({ role: "assistant", ...assistantBase, content: [{ type: "text", text }] });
const compressCall = (id: string, startRef: string, endRef: string): AgentMessage => ({
  role: "assistant", ...assistantBase,
  content: [{ type: "toolCall", id, name: "compress", arguments: { content: [{ startId: startRef, endId: endRef, summary: "Consumed large range: file paths, decisions, and exact values retained in this durable summary." }] } as Record<string, unknown> },],
});
const compressOk = (id: string): AgentMessage => ({
  role: "toolResult", content: [{ type: "text", text: "Compressed 1 range — 4500 tokens saved" }],
  toolName: "compress", toolCallId: id, isError: false, timestamp: Date.now(),
});
const summaryMsg = (topic: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text: `[Compressed conversation section] ${topic}: paths, decisions, and key values from this range are retained for later retrieval via decompress.` }],
  timestamp: Date.now(),
});

function makeCtx(): ExtensionContext {
  return {
    model: { contextWindow: 262_144 },
    getContextUsage: () => ({ tokens: 0 }),
    sessionManager: { getSessionId: () => "fb-reuse", getSessionFile: () => "/tmp/feedback-view-reuse.json" },
  } as unknown as ExtensionContext;
}

/** 11-message raw view A (start, turn 0, ack 0, turn 1, ack 1, call, result, turn 2, ack 2, turn 3, ack 3). */
function rawView(): AgentMessage[] {
  return [
    u("start " + FILLER),
    u("turn 0 " + FILLER),
    a("ack 0"),
    u("turn 1 " + FILLER),
    a("ack 1"),
    compressCall("c1", "m00002", "m00004"),
    compressOk("c1"),
    u("turn 2 " + FILLER),
    a("ack 2"),
    u("turn 3 " + FILLER),
    a("ack 3"),
  ];
}

/** 8-message rebuilt view B: covered originals pruned, summary entry replaces them. */
function rebuiltView(): AgentMessage[] {
  return [
    u("start " + FILLER),
    summaryMsg("section 1"),
    compressCall("c1", "m00002", "m00004"),
    compressOk("c1"),
    u("turn 2 " + FILLER),
    a("ack 2"),
    u("turn 3 " + FILLER),
    a("ack 3"),
  ];
}

test("feedback view (own rebuilt output re-fed) reuses the fold slot (issue #52)", () => {
  const runtime = createRuntime({ modelContextLimit: 262_144 });
  const ctx = makeCtx();

  const r1 = runtime.foldStream(ctx, rawView());
  assert.equal(r1.state.blocks.length, 1, "replay rebuilt the block from the in-stream compress call");

  const rebuilt = rebuiltView();
  runtime.recordRebuiltOutput(ctx, rebuilt);

  // Nudge lifecycle: a quiet turn sets the per-message baseline, then
  // usage crossing 75% of the limit fires the over-limit nudge and
  // writes the cadence stamps (the over-limit branch needs only pending > 0).
  const warm = runtime.core.processTurn({
    messages: r1.coreMessages, state: r1.state, config: runtime.configFor(ctx), tokenCount: 30_000,
  });
  const t1 = runtime.core.processTurn({
    messages: r1.coreMessages, state: warm.state, config: runtime.configFor(ctx), tokenCount: 200_000,
  });
  assert.equal(t1.nudge?.shouldInject, true, `fixture crosses the nudge threshold (reason: ${t1.nudge?.reason})`);
  runtime.commitFoldState(ctx, t1.state);
  assert.ok(t1.state.nudge.lastNudgeShownTokens > 0, "cadence stamp written on inject");
  const streakBefore = runtime.noteCompressOutcome(ctx, false);

  // Feedback view: omp feeds `rebuilt` back as the next context event.
  const r2 = runtime.foldStream(ctx, rebuilt);
  assert.equal(r2.state.blocks.length, 1, "block survives the view flip (slot reused, not re-folded)");
  assert.equal(
    r2.state.nudge.lastNudgeShownTokens,
    t1.state.nudge.lastNudgeShownTokens,
    "cadence stamps survive the view flip",
  );
  assert.deepEqual(r2.state.nudge.lastShownByTier, t1.state.nudge.lastShownByTier);
  const streakAfter = runtime.noteCompressOutcome(ctx, false);
  assert.equal(streakBefore, 1, "rejection streak is 1 after first reject");
  assert.equal(streakAfter, 2, "reject streak stays continuous across the flip (freshSlot would reset it)");
});

test("host compaction rewrite is NOT recognized as a feedback view (issue #52 guardrail 2)", () => {
  const runtime = createRuntime({ modelContextLimit: 262_144 });
  const ctx = makeCtx();

  const r1 = runtime.foldStream(ctx, rawView());
  assert.equal(r1.state.blocks.length, 1);

  const rebuilt = rebuiltView();
  runtime.recordRebuiltOutput(ctx, rebuilt);

  // Simulate omp's native /compact: prefix truncated and replaced by a
  // compaction-summary entry; the in-stream compress call is gone from the
  // visible view (the #19 block-loss path, carried-over by PR #24).
  const compacted: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "[Compaction summary] Earlier work on the auth module: token refresh and session handling." }],
      timestamp: Date.now(),
    } as AgentMessage,
    u("recent turn " + FILLER),
  ];
  const r2 = runtime.foldStream(ctx, compacted);
  assert.equal(r2.state.blocks.length, 0, "compacted view is NOT a feedback view — LCP re-fold runs (blocks dropped, see issue #19 / PR #24)");
});

test("end-to-end: context handler re-fed its own output keeps blocks active (issue #52)", async () => {
  interface MockApi {
    tools: Array<{ name: string; execute?: (id: string, args: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>; [k: string]: unknown }>;
    commands: Map<string, unknown>;
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
    registerTool(tool: unknown): void;
    registerCommand(name: string, options: unknown): void;
  }
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

  createAcpExtension({ modelContextLimit: 200_000, transformMode: "context" })(api as unknown as ExtensionAPI);
  const ctx = {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: { getSessionId: () => "fb-e2e", getSessionFile: () => "/tmp/feedback-view-reuse-e2e.json" },
  } as unknown as ExtensionContext;

  const fire = (messages: AgentMessage[]) =>
    (handlers.get("context")![0] as (e: unknown, ctx: unknown) => unknown)({ type: "context", messages } as unknown as { type: string; messages: Array<Record<string, unknown>> }, ctx) as Promise<{ messages: Array<Record<string, unknown>> } | undefined>;

  const stream: AgentMessage[] = [
    u("start " + FILLER),
    u("turn 0 " + FILLER),
    a("ack 0"),
    compressCall("c1", "m00002", "m00003"),
    compressOk("c1"),
    u("turn 2 " + FILLER),
    a("ack 2"),
    u("turn 3 " + FILLER),
    a("ack 3"),
  ];

  const r1 = await fire(stream);
  assert.ok(r1, "context handler returned rebuilt messages");
  const statusTool = api.tools.find((t) => t.name === "acp_status")!;
  const s1 = await statusTool.execute!("s1", {}, undefined, undefined, ctx);
  assert.match(s1.content[0]!.text, /1 active/, "block active before the view flip");

  // omp's recap pipeline re-feeds r1.messages — our own rebuilt output —
  await fire(r1.messages as unknown as AgentMessage[]);
  const s2 = await statusTool.execute!("s2", {}, undefined, undefined, ctx);
  assert.match(s2.content[0]!.text, /1 active/, "block still active after the flip (slot reused, no re-fold)");
  assert.match(s2.content[0]!.text, /b1/, "block b1 listed in the re-fed view status");
});
