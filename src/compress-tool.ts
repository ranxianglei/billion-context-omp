import { type } from "@oh-my-pi/omptype";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow } from "./log.js";
import { estimateTokens, collectCoveredMessageIds, formatTokens } from "./tokens.js";

const RangeSpec = type({
  startId: type("string").describe('Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".'),
  endId: type("string").describe("Inclusive end ref. Must be at or after startId."),
  summary: type("string").describe("Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)."),
  "topic?": type("string").describe("Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality."),
});

const CompressParams = type({
  "topic?": type("string").describe("Fallback topic for entries without their own. Omit when each content entry specifies its own topic."),
  content: RangeSpec.array().describe("One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic."),
  "summaryMaxChars?": type("number").describe("Override max summary length (default max: 20000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit."),
});

type CompressArgs = typeof CompressParams.infer;

export function makeCompressTool(runtime: AcpRuntime): ToolDefinition<typeof CompressParams> {
  return {
    name: "compress",
    label: "Compress",
    description:
      "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary.",
    parameters: CompressParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: string;
      try {
        result = await handleCompress(params as CompressArgs, runtime, ctx, toolCallId);
      } catch (e) {
        logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), ranges: (params as CompressArgs).content?.length ?? 0 });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleCompress(args: CompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
  const ranges = args.content ?? [];
  if (ranges.length === 0) return "No ranges provided.";
  const releaseLock = await runtime.acquireLock(ctx.sessionManager.getSessionId());
  try {
    const { state: initialState, coreMessages } = await runtime.stateFor(ctx);
    const config = runtime.configFor(ctx);
    const estimatedTokens = estimateTokens(coreMessages, collectCoveredMessageIds(initialState));
    const realUsage = ctx.getContextUsage?.();
    const turn = runtime.core.processTurn({
      messages: coreMessages,
      state: initialState,
      config,
      tokenCount: realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : estimatedTokens,
    });
    const state = turn.state;
    const messages = turn.messages;
    const beforeTokens = estimateTokens(messages, collectCoveredMessageIds(state));
    const summaryMaxChars = args.summaryMaxChars;
    const topLevelTopic = args.topic;

    debug.event("compress-in", {
      sid: ctx.sessionManager.getSessionId(),
      ranges: ranges.length,
      spans: ranges.map((r) => ({ span: `${r.startId}..${r.endId}`, summaryLen: r.summary.length, summary: r.summary, topic: r.topic ?? topLevelTopic ?? null })),
      blocksBefore: state.blocks.length,
      activeBefore: state.blocks.filter((b) => b.active).length,
      beforeMsgCount: messages.length,
      beforeTokens,
    });

    const applied = runtime.core.applyCompression({
      ranges: ranges.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary, topic: r.topic ?? topLevelTopic, summaryMaxChars, compressCallId: toolCallId })),
      messages,
      state,
      config,
    });
    await runtime.save(applied.state, ctx);
    const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;

    const afterTokens = Math.max(0, beforeTokens - tokensCompressed);

    const newBlocks = applied.state.blocks.slice(-blocksCreated);
    debug.event("compress-out", {
      sid: ctx.sessionManager.getSessionId(),
      blocksCreated,
      tokensCompressed,
      beforeTokens,
      afterTokens,
      afterMsgCount: applied.state.blocks.length,
      errors: errors.length,
      errorDetails: errors.slice(0, 3),
      blocksAfter: applied.state.blocks.length,
      activeAfter: applied.state.blocks.filter((b) => b.active).length,
      newBlocks: newBlocks.map((b) => ({ blockId: b.blockId, tier: b.tier, summaryLen: b.summary.length, directMsgCount: b.directMessageIds.length, effectiveMsgCount: b.effectiveMessageIds.length, summary: b.summary })),
    });

    logInfo("compress", {
      sid: ctx.sessionManager.getSessionId(),
      event: "applied",
      ranges: ranges.length,
      blocksCreated,
      tokensCompressed,
      beforeTokens,
      afterTokens,
      warnings: warnings.length,
      errors: errors.length,
      newBlockIds: newBlocks.map((b) => b.blockId),
    });
    if (errors.length > 0) {
      logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "errors", count: errors.length, errors: errors.slice(0, 5) });
    }
    if (warnings.length > 0) {
      logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "warnings", count: warnings.length, warnings: warnings.slice(0, 5) });
    }

    const lines = [`▣ ACP | ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens (~${formatTokens(tokensCompressed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
    if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
    if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
    return lines.join("\n");
  } finally { releaseLock(); }
}
