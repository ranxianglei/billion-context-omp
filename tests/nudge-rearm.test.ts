import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import type { AgentMessage } from "../src/messages.js";
import type { CompressionState } from "acp-kernel";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Small nudge threshold so a modest fixture crosses the gates (anti-thrash
// minGrowthFloor stays at the kernel default 5000 — tokenCounts below span it).
const ADAPTER = {
  compress: { nudgeGrowthTokens: 300, maxContextLimit: "90%" },
} as never;

const BIG = "payload ".repeat(800);
const MID = "lorem ".repeat(800);

function u(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}
function a(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

function makeCtx(): ExtensionContext {
  return {
    cwd: "/tmp",
    model: { contextWindow: 200_000 },
    sessionManager: { getSessionId: () => "rearm", getSessionFile: () => "/tmp/rearm.json" },
  } as unknown as ExtensionContext;
}

test("rearmNudgeOnNewTurn: stamps cleared only on turn change", () => {
  const runtime = createRuntime(ADAPTER);
  const state: CompressionState = {
    blocks: [], messageRefs: { byRaw: {}, byRef: {} },
    nudge: { lastPerMessageNudgeTokens: 1000, lastNudgeShownTokens: 5000, lastShownByTier: { 1: 5000 } },
    stats: { tokensCompressed: 0, compressionCount: 0 }, nextBlockId: 1, nextRunId: 1,
  } as unknown as CompressionState;

  runtime.armNudgeWatch("rearm", "turnA");
  runtime.rearmNudgeOnNewTurn("rearm", "turnA", state); // same turn → no-op
  assert.equal(state.nudge.lastShownByTier[1], 5000);
  assert.equal(state.nudge.lastNudgeShownTokens, 5000);

  runtime.rearmNudgeOnNewTurn("rearm", "turnB", state); // new turn → cleared
  assert.deepEqual(state.nudge.lastShownByTier, {});
  assert.equal(state.nudge.lastNudgeShownTokens, 0);

  runtime.rearmNudgeOnNewTurn("rearm", "turnC", state); // no watch → no-op
  assert.equal(state.nudge.lastNudgeShownTokens, 0);
});

test("ignored nudge re-fires on the next user turn (integration)", () => {
  const runtime = createRuntime(ADAPTER);
  const ctx = makeCtx();
  const config = runtime.configFor(ctx);

  // First call of user turn 1: establishes the growth baseline, no nudge.
  const t1: AgentMessage[] = [
    u("start " + BIG),
    a("f1 " + MID), u("f2 " + MID), a("f3 " + MID), u("f4 " + MID),
    a("f5 " + MID), u("f6 " + MID), a("f7 " + MID),
  ];
  const r1 = runtime.foldStream(ctx, t1);
  const turn1 = runtime.core.processTurn({ messages: r1.coreMessages, state: r1.state, config, tokenCount: 1000 });
  runtime.commitFoldState(ctx, turn1.state);
  assert.equal(turn1.nudge?.shouldInject, false, "growth 0 must not fire");

  // Later call in the SAME turn: growth crossed the floor → nudge shown.
  const turn2 = runtime.core.processTurn({ messages: r1.coreMessages, state: turn1.state, config, tokenCount: 30000 });
  runtime.commitFoldState(ctx, turn2.state);
  assert.equal(turn2.nudge?.shouldInject, true, turn2.nudge?.reason);
  assert.ok(turn2.state.nudge.lastShownByTier[1]! > 0);
  runtime.armNudgeWatch("rearm", "turn1");
  // (The model ignores the nudge — no compress call is added to the stream.)

  // New user turn: without rearm the kernel cadence still blocks.
  const t2: AgentMessage[] = [...t1, u("next turn " + BIG)];
  const r3 = runtime.foldStream(ctx, t2);
  const blocked = runtime.core.processTurn({ messages: r3.coreMessages, state: r3.state, config, tokenCount: 30500 });
  assert.equal(blocked.nudge?.shouldInject, false, "cadence must block without rearm");

  // With rearm (what index.ts does on a new last-user message): fires again.
  runtime.rearmNudgeOnNewTurn("rearm", "turn2", r3.state);
  const fired = runtime.core.processTurn({ messages: r3.coreMessages, state: r3.state, config, tokenCount: 30500 });
  assert.equal(fired.nudge?.shouldInject, true, fired.nudge?.reason);
});
