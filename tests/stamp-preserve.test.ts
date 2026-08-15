import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "../src/messages.js";

// Regression (2026-08-15, double-nudge after compression success/failure):
// omp fires back-to-back context events on DIFFERENT views of the same
// session — its recap/subagent pipelines re-feed our own rebuilt output as
// the next event.messages (live evidence: context-out msgs=78 at 13:41:11.430
// became context-in msgs=78 the same millisecond; 411 of 1286 context events
// were such view flips). The rebuilt view's identities diverge from the raw
// stream at the first pruned position, so every feedback event forced a
// freshSlot — which wiped the kernel cadence stamps. With lastShownByTier
// empty, the growth-floor gate is structurally disarmed and the very next
// processTurn re-fires the nudge (observed 4ms apart, both delivered to the
// model; on weak models this loops 30+ times — issue #47).

const FILLER = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(800); // ~54K chars ≈ 13.5K tokens
const SUM = "Consumed exploration detail retained for the fold harness: paths, decisions and failures are summarized here to satisfy the minimum summary length rule of fifty characters and well beyond. ";

const assistantBase = {
  api: "anthropic", provider: "anthropic", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.now(),
} as const;

const u = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const a = (text: string): AgentMessage => ({ role: "assistant", ...assistantBase, content: [{ type: "text", text }] });
const compressCall = (id: string, startRef: string, endRef: string): AgentMessage => ({
  role: "assistant", ...assistantBase,
  content: [{ type: "toolCall", id, name: "compress", arguments: { content: [{ startId: startRef, endId: endRef, summary: SUM }] } as Record<string, unknown> }],
});
const compressOk = (id: string): AgentMessage => ({
  role: "toolResult", content: [{ type: "text", text: `Compressed 1 range — 4500 tokens saved` }],
  toolName: "compress", toolCallId: id, isError: false, timestamp: Date.now(),
});

function makeCtx(): ExtensionContext {
  return {
    model: { contextWindow: 262_144 },
    getContextUsage: () => ({ tokens: 0 }),
    sessionManager: { getSessionId: () => "stamp-preserve", getSessionFile: () => "/tmp/stamp-preserve.json" },
  } as unknown as ExtensionContext;
}

test("re-fold on a view flip preserves cadence stamps (freshSlot keep-nudge)", async () => {
  const runtime = createRuntime({ modelContextLimit: 262_144 });
  const ctx = makeCtx();

  // Raw stream with a compress call so the fold has a block to rebuild.
  const raw: AgentMessage[] = [u("start " + FILLER), compressCall("call_p1", "m00001", "m00001"), compressOk("call_p1")];
  for (let i = 0; i < 8; i++) raw.push(u(`turn ${i} ` + FILLER), a(`ack ${i}`));

  const r1 = runtime.foldStream(ctx, raw);
  assert.equal(r1.state.blocks.length, 1, "replay built the block");

  // Simulate the nudge lifecycle: a quiet turn sets the per-message
  // baseline, then growth past the floor fires the nudge and writes stamps.
  const warm = runtime.core.processTurn({
    messages: r1.coreMessages, state: r1.state, config: runtime.configFor(ctx), tokenCount: 30_000,
  });
  const t1 = runtime.core.processTurn({
    messages: r1.coreMessages, state: warm.state, config: runtime.configFor(ctx), tokenCount: 60_000,
  });
  assert.equal(t1.nudge?.shouldInject, true, `fixture crosses the nudge threshold (reason: ${t1.nudge?.reason})`);
  assert.ok(t1.state.nudge.lastNudgeShownTokens > 0, "stamps written on inject");
  // The real handler commits turn.state back into the fold slot
  // (src/index.ts processTurn → commitFoldState) — mirror that here.
  runtime.commitFoldState(ctx, t1.state);

  // Feedback view: our rebuilt output — identities diverge at the first
  // pruned position (summary replaces the covered range) → forced re-fold.
  const rebuilt: AgentMessage[] = [
    u("[Compressed conversation section 1 — " + SUM + "]"),
    ...raw.slice(3), // tail kept verbatim
    u("This is an efficiency nudge to compress early and keep context lean — injected last turn"),
  ];
  const r2 = runtime.foldStream(ctx, rebuilt);
  assert.equal(r2.state.blocks.length, 0, "feedback view carries no compress call — no block");
  // THE assertion: the reminder history survived the re-fold.
  assert.equal(
    r2.state.nudge.lastNudgeShownTokens,
    t1.state.nudge.lastNudgeShownTokens,
    "cadence stamps survive a view-flip re-fold",
  );
  assert.deepEqual(r2.state.nudge.lastShownByTier, t1.state.nudge.lastShownByTier);
});

test("kernel cadence gate actually blocks the immediate re-fire once stamps survive", async () => {
  const runtime = createRuntime({ modelContextLimit: 262_144 });
  const ctx = makeCtx();

  const raw: AgentMessage[] = [u("start " + FILLER), compressCall("call_q1", "m00001", "m00001"), compressOk("call_q1")];
  for (let i = 0; i < 8; i++) raw.push(u(`turn ${i} ` + FILLER), a(`ack ${i}`));

  const r1 = runtime.foldStream(ctx, raw);
  const warm = runtime.core.processTurn({
    messages: r1.coreMessages, state: r1.state, config: runtime.configFor(ctx), tokenCount: 30_000,
  });
  const t1 = runtime.core.processTurn({
    messages: r1.coreMessages, state: warm.state, config: runtime.configFor(ctx), tokenCount: 60_000,
  });
  assert.equal(t1.nudge?.shouldInject, true);

  // Same-scale usage on the SAME state (stamps preserved) must NOT re-fire:
  // growth since the shown nudge is far below the floor.
  const t2 = runtime.core.processTurn({
    messages: r1.coreMessages, state: t1.state, config: runtime.configFor(ctx), tokenCount: 60_400,
  });
  assert.equal(t2.nudge?.shouldInject, false, `cadence gate blocks re-fire at +400 tokens (reason: ${t2.nudge?.reason})`);
});
