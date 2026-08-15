import { test } from "bun:test";
import assert from "node:assert/strict";
import { topicFallback } from "../src/compress-tool.js";
import { makeCommands } from "../src/commands.js";
import type { AcpRuntime } from "../src/runtime.js";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

test("topicFallback: summary first slice, ≤30 chars, decorative only", () => {
  assert.equal(topicFallback("Session opener: user asked for base64 padding. More follows."), "Session opener: user asked for…");
  assert.equal(topicFallback("Short summary line\nsecond line"), "Short summary line");
  assert.equal(topicFallback("123456789012345678901234567890"), "123456789012345678901234567890");
  assert.equal(topicFallback(""), "");
});

test("/acp panel shows a topic for blocks without one (summary fallback)", async () => {
  const runtime = {
    configFor: () => ({
      modelContextLimit: 200_000,
      nudge: { growthFloorTokens: 20_000, thresholdPct: 0.2 },
      compress: { minCompressRange: 5000 },
    }),
    stateFor: async () => ({
      state: {
        blocks: [
          { blockId: "b1", tier: 1, active: true, topic: undefined, summary: "Database migration steps completed successfully today", compressedTokens: 5100, effectiveMessageIds: [], directBlockIds: [] },
        ],
        stats: { tokensCompressed: 5100 },
        messageRefs: { byRaw: {}, byRef: {} },
      },
      coreMessages: [],
    }),
    core: { processTurn: () => ({ messages: [], state: { blocks: [], stats: { tokensCompressed: 0 } }, nudge: undefined }) },
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
    getContextUsage: () => ({ tokens: 430_000 }), // raw session accounting (provider scale)
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "t3", getSessionFile: () => "/tmp/t3.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.match(text, /Context \(session accounting, provider tokens\): 43% \(430k/, text);
  assert.match(text, /Sent to LLM \(after compression, est\.\): 24k \(2% of limit\)/, text);
  assert.ok(!/Session-only/.test(text), `no originals to prune, line must be hidden:\n${text}`);
  assert.ok(!/Framework/.test(text), `fake Framework bucket must be gone:\n${text}`);
});

test("/acp panel: session-only is same-scale (chars/4), never provider-minus-estimate (#18)", async () => {
  // 20k chars of tool output in the tree, all covered by an active block;
  // processTurn prunes it to nothing. Session-only must read ~5.0k (chars/4
  // estimate), NOT 430k provider tokens minus the sent view.
  const covered = "x".repeat(20_000);
  const runtime = {
    configFor: () => ({ modelContextLimit: 1_000_000, nudge: {}, compress: {} }),
    stateFor: async () => ({
      state: {
        blocks: [{ blockId: "b1", tier: 1, active: true, compressedTokens: 5000, effectiveMessageIds: ["p1"], directBlockIds: [] }],
        stats: { tokensCompressed: 5000 },
        messageRefs: { byRaw: {}, byRef: {} },
      },
      coreMessages: [{ id: "p1", role: "tool", contentType: "text", text: covered }],
    }),
    core: { processTurn: () => ({ messages: [], state: { blocks: [], stats: { tokensCompressed: 5000 } }, nudge: { shouldInject: false, reason: "idle", contextBreakdown: { system: 0, tool: 0, text: 0, code: 0, summaries: 0, growth: 0 } } }) },
  } as unknown as AcpRuntime;

  const notified: string[] = [];
  const ctx = {
    ui: { notify: (text: string) => notified.push(text) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "t4", getSessionFile: () => "/tmp/t4.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  const line = text.split("\n").find((l) => l.includes("Session-only"));
  assert.ok(line, `session-only line missing:\n${text}`);
  assert.match(line, /5\.0k/, `must be the chars/4 estimate of pruned originals:\n${line}`);
  assert.ok(!/425k|426k|424k/.test(line), `cross-scale subtraction forbidden:\n${line}`);
});
