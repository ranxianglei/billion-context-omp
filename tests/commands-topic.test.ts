import { test } from "bun:test";
import assert from "node:assert/strict";
import { topicFallback } from "acp-kernel/panel";
import { makeCommands } from "../src/commands.js";
import type { AcpRuntime } from "../src/runtime.js";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

test("topicFallback: summary first slice, ≤30 chars, decorative only", () => {
  assert.equal(topicFallback("Session opener: user asked for base64 padding. More follows."), "Session opener: user asked for…");
  assert.equal(topicFallback("Short summary line\nsecond line"), "Short summary line");
  assert.equal(topicFallback("123456789012345678901234567890"), "123456789012345678901234567890");
  assert.equal(topicFallback(""), "");
});

function topicState() {
  return {
    blocks: [
      { blockId: "b1", tier: 1, active: true, topic: undefined, summary: "Database migration steps completed successfully today", compressedTokens: 5100, effectiveMessageIds: [], directBlockIds: [] },
    ],
    stats: { tokensCompressed: 5100 },
    messageRefs: { byRaw: {}, byRef: {} },
  };
}

test("/acp panel shows a topic for blocks without one (summary fallback)", async () => {
  const runtime = {
    configFor: () => ({
      modelContextLimit: 200_000,
      nudge: { growthFloorTokens: 20_000, thresholdPct: 0.2 },
      compress: { minCompressRange: 5000 },
    }),
    stateFor: async () => ({ state: topicState(), coreMessages: [] }),
    core: { processTurn: () => ({ messages: [], state: topicState(), nudge: undefined }) },
  } as unknown as AcpRuntime;

  const notified: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => notified.push(text) },
    getContextUsage: () => ({ tokens: 1000 }),
    model: { contextWindow: 200_000 },
    sessionManager: { getSessionId: () => "t", getSessionFile: () => "/tmp/x.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  const blockLine = text.split("\n").find((l) => l.includes("[b1]"));
  assert.ok(blockLine, `block line missing in:\n${text}`);
  assert.match(blockLine, /: /, "topic column must render even without model-provided topic");
  assert.match(blockLine, /Database migration steps compl…/, "falls back to summary first slice (30-char cut)");
});

test("/acp panel separates session accounting from sent view (no fake Framework)", async () => {
  const runtime = {
    configFor: () => ({ modelContextLimit: 1_000_000, nudge: {}, compress: {} }),
    stateFor: async () => ({
      state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
      coreMessages: [],
    }),
    core: { processTurn: () => ({ messages: [], state: { blocks: [], stats: { tokensCompressed: 0 } }, nudge: { shouldInject: false, reason: "idle", contextBreakdown: { system: 100, tool: 20000, text: 3000, code: 500, summaries: 400, growth: 0 } } }) },
  } as unknown as AcpRuntime;

  const notified: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => notified.push(text) },
    getContextUsage: () => ({ tokens: 430_000 }), // raw session accounting
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "t3", getSessionFile: () => "/tmp/t3.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.match(text, /Context \(session accounting, host footer scale\): 43% \(430k/, text);
  assert.match(text, /Sent to LLM \(after compression, est\.\): /, text);
  assert.ok(!/Framework/.test(text), `fake Framework bucket must be gone:\n${text}`);
});

test("/acp panel session-only uses the estimation scale, never cross-scale (issue #18)", async () => {
  // Full fold projection estimates at 134k on the chars/4 scale; the pruned
  // sent view is 24k. Session-only must read 110k (estimate − estimate),
  // NOT 430k − 24k (provider-scale footer minus estimate).
  const coreMessages = Array.from({ length: 60 }, (_, i) =>
    i % 2 === 0
      ? { role: "user", contentType: "text", text: `u${i} ${"lorem ipsum dolor ".repeat(140)}` }
      : { role: "assistant", contentType: "text", text: `a${i} ${"sit amet consectetur ".repeat(120)}` },
  );
  const runtime = {
    configFor: () => ({ modelContextLimit: 1_000_000, nudge: {}, compress: {} }),
    stateFor: async () => ({
      state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
      coreMessages,
    }),
    core: { processTurn: () => ({ messages: [], state: { blocks: [], stats: { tokensCompressed: 0 } }, nudge: { shouldInject: false, reason: "idle", contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 0, summaries: 0, growth: 0 } } }) },
  } as unknown as AcpRuntime;

  const notified: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => notified.push(text) },
    getContextUsage: () => ({ tokens: 430_000 }), // provider-scale footer number
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "t4", getSessionFile: () => "/tmp/t4.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  const line = text.split("\n").find((l) => l.startsWith("Session-only"));
  assert.ok(line, `Session-only line missing:\n${text}`);
  assert.doesNotMatch(line!, /406k/, "cross-scale subtraction must not appear");
});

test("/acp panel renders prompt cache hit rate from session entries", async () => {
  const runtime = {
    configFor: () => ({ modelContextLimit: 1_000_000, nudge: {}, compress: {} }),
    stateFor: async () => ({
      state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
      coreMessages: [],
    }),
    core: { processTurn: () => ({ messages: [], state: { blocks: [], stats: { tokensCompressed: 0 } }, nudge: { shouldInject: false, reason: "idle", contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 0, summaries: 0, growth: 0 } } }) },
  } as unknown as AcpRuntime;

  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    // request 1: 1k fresh + 99k cache-served → 99% of 100k billed
    { type: "message", message: { role: "assistant", content: [], usage: { input: 1_000, output: 50, cacheRead: 99_000, cacheWrite: 0, totalTokens: 100_050 } } },
    // no cache signal (cache-less provider) → excluded
    { type: "message", message: { role: "assistant", content: [], usage: { input: 5_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 5_010 } } },
    // request 2 (last): 180k served + 20k written → 90% of 200k billed
    { type: "message", message: { role: "assistant", content: [], usage: { input: 0, output: 80, cacheRead: 180_000, cacheWrite: 20_000, totalTokens: 200_080 } } },
  ];
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => notified.push(text) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "t5", getSessionFile: () => "/tmp/t5.json", getEntries: () => entries },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  // session = (99k + 180k) / (100k + 200k) = 93.0%; last = 180k/200k = 90.0%
  assert.match(text, /Prompt cache \(provider-reported\): 90\.0% last · 93\.0% session avg — 279k of 300k billed prompt tokens served from cache \(2 req\)/, text);
});

test("/acp panel omits the prompt cache section without cache-reported requests", async () => {
  const runtime = {
    configFor: () => ({ modelContextLimit: 1_000_000, nudge: {}, compress: {} }),
    stateFor: async () => ({
      state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
      coreMessages: [],
    }),
    core: { processTurn: () => ({ messages: [], state: { blocks: [], stats: { tokensCompressed: 0 } }, nudge: { shouldInject: false, reason: "idle", contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 0, summaries: 0, growth: 0 } } }) },
  } as unknown as AcpRuntime;

  const entries = [
    { type: "message", message: { role: "assistant", content: [], usage: { input: 5_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 5_010 } } },
  ];
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => notified.push(text) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "t6", getSessionFile: () => "/tmp/t6.json", getEntries: () => entries },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.ok(text, "panel rendered");
  assert.doesNotMatch(text, /Prompt cache/, `cache section must be omitted without cache-reported requests:\n${text}`);
});
