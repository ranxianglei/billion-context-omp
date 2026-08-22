import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// End-to-end through the REAL before_provider_request handler (provider mode):
// inside one long user turn, after an injected nudge is ignored and another
// +20000 tokens accumulate, the next provider request must deliver ANOTHER
// nudge. Replays the observed 01a00096 timeline.
//
// The nudge is injected as a wire user message (not a context message).

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

/** Build an anthropic wire payload from a message stream. */
function anthropicPayload(messages: unknown[]) {
  return { model: "test", messages };
}

/** Count nudge messages in a wire payload (user messages containing "compress("). */
function nudgeCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const msgs = (payload as { messages?: unknown[] }).messages;
  if (!Array.isArray(msgs)) return 0;
  return msgs.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress(")).length;
}

test("provider handler: ignored nudge re-delivers after +growthFloor within the same turn", async () => {
  const { api, handlers } = capture();
  // nudgeGrowthTokens pinned → kernel threshold & cadence = 20000.
  createAcpExtension({ compress: { nudgeGrowthTokens: 20000 }, autoUpdate: false })(api as unknown as ExtensionAPI);

  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, api: "anthropic-messages" },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "cadence-e2e", getSessionFile: () => "/tmp/cadence-e2e.json" },
  } as unknown as ExtensionContext;

  // Append-only stream, as omp delivers it: growth enters the stream itself.
  const stream: any[] = [msg("user", "start " + MID)];
  for (let i = 1; i <= 16; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: anthropicPayload([...stream]) }, ctx);
  // MID ≈ 4.5K tokens per message; 5 messages ≈ +22.5K.
  const grow = (tag: string) => { for (let i = 0; i < 5; i++) stream.push(msg(i % 2 ? "assistant" : "user", `${tag}${i} ` + MID)); };

  const r0 = await fire();
  assert.equal(nudgeCount(r0), 0, "baseline turn must not fire");
  // fold state lives in the runtime the handler owns — successive fires share it.

  grow("g");
  const r1 = await fire();
  assert.equal(nudgeCount(r1), 1, "first nudge at +20K");
  // Model ignores it — no compress call is added to the stream, just growth.

  grow("h");
  const r2 = await fire();
  assert.equal(nudgeCount(r2), 1, "second nudge at +20K in the SAME user turn (was swallowed by per-turn dedup)");
});

test("over-limit nudge does not re-inject on back-to-back LLM calls (issue #22)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ autoUpdate: false })(api as unknown as ExtensionAPI);

  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, api: "anthropic-messages" }, // over-limit at 150K, emergency at 190K
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "issue22-e2e", getSessionFile: () => "/tmp/issue22-e2e.json" },
  } as unknown as ExtensionContext;

  // ~146K sent view (73% — below the 75% over-limit line).
  const stream: any[] = [msg("user", "start " + MID)];
  for (let i = 1; i <= 32; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: anthropicPayload([...stream]) }, ctx);
  const grow = (tag: string, n: number) => { for (let i = 0; i < n; i++) stream.push(msg(i % 2 ? "assistant" : "user", `${tag}${i} ` + MID)); };

  await fire(); // baseline at 73% — no nudge
  grow("a", 1);
  const r1 = await fire();
  assert.equal(nudgeCount(r1), 1, "first over-limit nudge injects");
  // Model ignores the nudge — same turn, next LLM calls, +4.5K growth each.
  // Kernel over-limit branch has no cadence; the adapter re-applies its own
  // growth floor so an ignored nudge does not re-inject every LLM call.
  grow("b", 1);
  const r2 = await fire();
  assert.equal(nudgeCount(r2), 0, "no re-inject at +4.5K growth");
  grow("c", 1);
  const r3 = await fire();
  assert.equal(nudgeCount(r3), 0, "still suppressed at +9K growth");
  // +22.5K more crosses the kernel's growth floor since the last SHOWN nudge.
  grow("d", 5);
  const r4 = await fire();
  assert.equal(nudgeCount(r4), 1, "re-injects after +growthFloor growth (~91%, pre-emergency)");
  // Emergency (>=95%) is exempt from the cadence guard: the overflow reminder
  // must keep firing on every call while usage stays critical.
  grow("e", 2);
  const r5 = await fire();
  assert.equal(nudgeCount(r5), 1, "emergency re-injects despite small growth (~96%)");
});

test("nudge never lists degenerate ranges that would fail the summary floor atomically", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ compress: { nudgeGrowthTokens: 20000 }, autoUpdate: false })(api as unknown as ExtensionAPI);

  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, api: "anthropic-messages" },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "degenerate-e2e", getSessionFile: () => "/tmp/degenerate-e2e.json" },
  } as unknown as ExtensionContext;

  // Tiny isolated opener (16-token class) + a big compressible middle + tail.
  const stream: any[] = [msg("user", "hi")];
  for (let i = 1; i <= 16; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: anthropicPayload([...stream]) }, ctx);
  const grow = (tag: string) => { for (let i = 0; i < 5; i++) stream.push(msg(i % 2 ? "assistant" : "user", `${tag}${i} ` + MID)); };

  await fire(); // establish growth baseline
  grow("g");
  const r1 = await fire();
  const msgs = (r1 as { messages: any[] }).messages;
  const nudgeMsg = msgs.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress("));
  assert.equal(nudgeMsg.length, 1, "nudge injected");
  const content = nudgeMsg[0].content;
  const text = typeof content === "string" ? content : content[0]?.text ?? "";
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
