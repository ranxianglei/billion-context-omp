import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// End-to-end through the REAL context handler (the layer that used to carry
// the per-turn dedup): inside one long user turn, after an injected nudge is
// ignored and another +20000 tokens accumulate, the next context event must
// deliver ANOTHER nudge. Replays the observed 01a00096 timeline.
//
// tokenCount is fed via getContextUsage (what index.ts prefers when present).

function capture() {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  return {
    handlers,
    api: {
      on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool: () => {},
      registerCommand: () => {},
      config: { load: () => ({}) },
    },
  };
}

const MID = "lorem ".repeat(3000);
const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }], timestamp: Date.now() });

test("context handler: ignored nudge re-delivers after +growthFloor within the same turn", async () => {
  const { api, handlers } = capture();
  // nudgeGrowthTokens pinned → kernel threshold & cadence = 20000.
  createAcpExtension({ compress: { nudgeGrowthTokens: 20000 } } as never)(api as unknown as ExtensionAPI);

  let tokens = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({ tokens, percent: tokens / 1_000_000, contextWindow: 1_000_000 }),
    sessionManager: { getSessionId: () => "cadence-e2e", getSessionFile: () => "/tmp/cadence-e2e.json" },
  } as unknown as ExtensionContext;

  const stream: any[] = [msg("user", "start " + MID)];
  for (let i = 1; i <= 16; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));
  // Same last user message for every fire — one long agentic turn.
  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [...stream, msg("user", "go on")] }, ctx);
  const nudgeCount = (r: any) => r.messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress(")).length;

  tokens = 45000;
  const r0 = (await fire()) as { messages: any[] };
  assert.equal(nudgeCount(r0), 0, "baseline turn must not fire");
  // fold state lives in the runtime the handler owns — successive fires share it.

  tokens = 65001;
  const r1 = (await fire()) as { messages: any[] };
  assert.equal(nudgeCount(r1), 1, "first nudge at +20K");
  // Model ignores it — no compress call is added to the stream, just growth.

  tokens = 85001;
  const r2 = (await fire()) as { messages: any[] };
  assert.equal(nudgeCount(r2), 1, "second nudge at +20K in the SAME user turn (was swallowed by per-turn dedup)");
});
