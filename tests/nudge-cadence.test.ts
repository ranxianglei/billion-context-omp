import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import type { BiliMessage } from "acp-kernel/wire";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Pin the adaptive threshold like production (nudgeGrowthTokens=20000):
// growthFloor/cap=20000, kernel minGrowthFloor=20000 → cadence = +20000.
const ADAPTER = {
  compress: { nudgeGrowthTokens: 20000, maxContextLimit: "90%" },
} as never;

const BIG = "payload ".repeat(800);   // > min 5000 chars
const MID = "lorem ".repeat(3000);    // ~4.5K tokens each — pending must cross 20000

const u = (t: string, i: number): BiliMessage => ({ id: `u${i}`, role: "user", contentType: "text", text: t }) as BiliMessage;
const a = (t: string, i: number): BiliMessage => ({ id: `a${i}`, role: "assistant", contentType: "text", text: t }) as BiliMessage;

function makeCtx(): ExtensionContext {
  return {
    cwd: "/tmp",
    model: { contextWindow: 200_000 },
    sessionManager: { getSessionId: () => "cadence", getSessionFile: () => "/tmp/cadence.json" },
  } as unknown as ExtensionContext;
}

/** Replay the observed 01a00096 timeline inside ONE long user turn:
 *  baseline → fire @+20K → (model ignores, stream keeps growing) →
 *  re-fire @+20K → suppressed-by-nothing → idle between. */
test("long agentic turn: nudge re-fires every +growthFloor, never at same token", () => {
  const runtime = createRuntime(ADAPTER);
  const ctx = makeCtx();
  const config = runtime.configFor(ctx);

  const mid = (n: number) => a(`f${n} ` + MID, n);
  const midU = (n: number) => u(`f${n} ` + MID, n);
  const stream: BiliMessage[] = [
    u("start " + BIG, 0),
    mid(1), midU(2), mid(3), midU(4), mid(5), midU(6), mid(7), midU(8),
    mid(9), midU(10), mid(11), midU(12), mid(13), midU(14), mid(15), midU(16),
  ];

  // t0: establishes baseline (growth 0 → no fire).
  const r0 = runtime.foldStreamCore(ctx, stream);
  const t0 = runtime.core.processTurn({ messages: r0.coreMessages, state: r0.state, config, tokenCount: 45000 });
  runtime.commitFoldState(ctx, t0.state);
  assert.equal(t0.nudge?.shouldInject, false, t0.nudge?.reason ?? "");

  // t1 (+20001): first fire (this is the injection the model ignores).
  const t1 = runtime.core.processTurn({ messages: r0.coreMessages, state: t0.state, config, tokenCount: 65001 });
  runtime.commitFoldState(ctx, t1.state);
  assert.equal(t1.nudge?.shouldInject, true, t1.nudge?.reason ?? "");

  // t1b (same token, next context event in the same turn): kernel cadence
  // prevents a duplicate — this is what makes per-turn dedup unnecessary.
  const t1b = runtime.core.processTurn({ messages: r0.coreMessages, state: t1.state, config, tokenCount: 65001 });
  assert.equal(t1b.nudge?.shouldInject, false, "same tokenCount must not fire twice");
  assert.match(t1b.nudge!.reason, /cadence/);

  // t2 (+20000 more, same long turn — stream grew): re-fires. The old
  // per-turn dedup swallowed exactly this injection.
  const grown = [...stream, mid(17), midU(18), mid(19)];
  const r2 = runtime.foldStreamCore(ctx, grown);
  const t2 = runtime.core.processTurn({ messages: r2.coreMessages, state: r2.state, config, tokenCount: 85001 });
  assert.equal(t2.nudge?.shouldInject, true, `expected re-fire at +20K inside the same turn: ${t2.nudge?.reason}`);

  // t3 (between windows): idle again.
  const t3 = runtime.core.processTurn({ messages: r2.coreMessages, state: t2.state, config, tokenCount: 95001 });
  assert.equal(t3.nudge?.shouldInject, false, "inside the cadence window must stay idle");
});
