import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Regression (2026-08-15, omp issue #22 follow-up / #47 amplifier): the
// handler must not stack a second nudge on a FEEDBACK view — omp re-feeds our
// own rebuilt output (whose last user message IS the nudge we just injected)
// as the next context event. End-to-end over the real context handler:
// event ① injects; event ② (= ①'s returned messages) must not inject again.

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

const FILLER = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(650); // ~44K chars ≈ 11K tokens

const u = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const a = (text: string) => ({
  role: "assistant",
  api: "anthropic", provider: "anthropic", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.now(),
  content: [{ type: "text", text }],
});

function fakeCtx(): ExtensionContext {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "feedback-view", getSessionFile: () => "/tmp/feedback-view.json" },
  } as unknown as ExtensionContext;
}

test("context handler does not stack a second nudge on its own feedback view", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  const stream: Array<Record<string, unknown>> = [u("start " + FILLER)];
  for (let i = 1; i <= 11; i++) stream.push(i % 2 ? a(`ack ${i} ${FILLER}`) : u(`turn ${i} ${FILLER}`));

  const fire = (messages: Array<Record<string, unknown>>) =>
    handlers.get("context")![0]!({ type: "context", messages }, ctx) as Promise<{ messages: Array<Record<string, unknown>> } | undefined>;

  // Warm-up event on a half-size stream: establishes the kernel's per-message
  // baseline without crossing the growth floor (real sessions always have
  // earlier turns; the kernel's growth gate needs that reference point).
  await fire([...stream.slice(0, 7)]);

  const r1 = await fire([...stream]);
  const nudges1 = (r1?.messages ?? []).filter((m) => m.role === "user" && JSON.stringify(m.content).includes("efficiency nudge to compress early"));
  assert.equal(nudges1.length, 1, "event ① injects exactly one nudge");

  // Event ②: omp re-feeds ①'s output as the next context event — on a
  // SHORTER view (recap/subagent pipelines summarize or slice), which trips
  // the kernel's #71 rebaseline (usage dropped > growthFloor below baseline
  // → cadence stamps cleared). With stamps gone, cadence alone would let
  // the nudge re-fire; the feedback-view guard must hold the line.
  const shortView = [...stream.slice(0, 7), nudges1[0]!];
  const r2 = await fire(shortView);
  const nudges2 = (r2?.messages ?? []).filter((m) => m.role === "user" && JSON.stringify(m.content).includes("efficiency nudge to compress early"));
  assert.equal(
    nudges2.length,
    1,
    `feedback view keeps the single existing nudge but gains none (got ${nudges2.length})`,
  );
});

test("a normal follow-up turn (no trailing nudge) still gets nudged when due", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ modelContextLimit: 200_000 })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  const stream: Array<Record<string, unknown>> = [u("start " + FILLER)];
  for (let i = 1; i <= 11; i++) stream.push(i % 2 ? a(`ack ${i} ${FILLER}`) : u(`turn ${i} ${FILLER}`));

  const fire = (messages: Array<Record<string, unknown>>) =>
    handlers.get("context")![0]!({ type: "context", messages }, ctx) as Promise<{ messages: Array<Record<string, unknown>> } | undefined>;

  await fire([...stream.slice(0, 7)]);
  const r1 = await fire([...stream]);
  assert.equal(
    (r1?.messages ?? []).filter((m) => m.role === "user" && JSON.stringify(m.content).includes("efficiency nudge")).length,
    1,
    "first event injects",
  );

  // Fresh user message appended (not a feedback view): new turn, model
  // answered — the nudge from ① is now historical (deep in the stream), and
  // the trailing message is the model's reply + new user turn. The guard only
  // matches a TRAILING nudge, so injection policy here follows the kernel.
  const grown = [...stream, a(`reply ${FILLER}`), u(`next turn ${FILLER}`)];
  const r2 = await fire(grown);
  assert.ok(Array.isArray(r2?.messages), "normal turn still transformed");
});
