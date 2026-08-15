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


  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "cadence-e2e", getSessionFile: () => "/tmp/cadence-e2e.json" },
  } as unknown as ExtensionContext;

  // Append-only stream, as omp delivers it: growth enters the stream itself
  // (nudge arbitration reads the sent-view estimate, not ctx.getContextUsage).
  // No per-fire ephemeral tail — inserting before a remembered tail looks
  // like a prefix rewrite and legitimately re-folds (losing nudge stamps).
  const stream: any[] = [msg("user", "start " + MID)];
  for (let i = 1; i <= 16; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [...stream] }, ctx);
  const nudgeCount = (r: any) => r.messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress(")).length;
  // MID ≈ 4.5K tokens per message; 5 messages ≈ +22.5K.
  const grow = (tag: string) => { for (let i = 0; i < 5; i++) stream.push(msg(i % 2 ? "assistant" : "user", `${tag}${i} ` + MID)); };

  const r0 = (await fire()) as { messages: any[] };
  assert.equal(nudgeCount(r0), 0, "baseline turn must not fire");
  // fold state lives in the runtime the handler owns — successive fires share it.

  grow("g");
  const r1 = (await fire()) as { messages: any[] };
  assert.equal(nudgeCount(r1), 1, "first nudge at +20K");
  // Model ignores it — no compress call is added to the stream, just growth.

  grow("h");
  const r2 = (await fire()) as { messages: any[] };
  assert.equal(nudgeCount(r2), 1, "second nudge at +20K in the SAME user turn (was swallowed by per-turn dedup)");
});

test("nudge never lists degenerate ranges that would fail the summary floor atomically", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ compress: { nudgeGrowthTokens: 20000 } } as never)(api as unknown as ExtensionAPI);


  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "degenerate-e2e", getSessionFile: () => "/tmp/degenerate-e2e.json" },
  } as unknown as ExtensionContext;

  // Tiny isolated opener (16-token class) + a big compressible middle + tail.
  const stream: any[] = [msg("user", "hi")];
  for (let i = 1; i <= 16; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [...stream] }, ctx);
  const grow = (tag: string) => { for (let i = 0; i < 5; i++) stream.push(msg(i % 2 ? "assistant" : "user", `${tag}${i} ` + MID)); };

  await fire(); // establish growth baseline
  grow("g");
  const r1 = (await fire()) as { messages: any[] };
  const nudgeMsg = r1.messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress("));
  assert.equal(nudgeMsg.length, 1, "nudge injected");
  const text = nudgeMsg[0].content[0].text;
  // Every LISTED range must be viable (≥200 tokens): the isolated 16-token
  // opener either merges into its big neighbor (fine) or gets filtered (fine)
  // — but a standalone sub-summary-floor range must never be recommended.
  const listed = [...text.matchAll(/m\d+–m\d+\s+\d+ msgs\s+([\d.]+K?)/g)].map((m) => {
    const v = m[1]!;
    return v.endsWith("K") ? parseFloat(v) * 1000 : parseFloat(v);
  });
  assert.ok(listed.length > 0, "ranges listed");
  for (const t of listed) assert.ok(t >= 200, `degenerate range listed: ${t} tokens`);
});
