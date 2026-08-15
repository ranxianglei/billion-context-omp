import type { ApplyCompressionResult, CompressRangeSpec } from "acp-kernel";
import { type } from "@oh-my-pi/omptype";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug, logError, logInfo, logThrow, logWarn } from "./log.js";
import { rangeFingerprints } from "./messages.js";
import { estimateTokens, collectCoveredMessageIds, formatTokens } from "./tokens.js";

const RangeSpec = type({
  startId: type("string").describe('Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".'),
  endId: type("string").describe("Inclusive end ref. Must be at or after startId."),
  summary: type("string").describe("Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)."),
  "topic?": type("string").describe("Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Recommended for every range; omit to use top-level topic."),
});

/** Label shown for a block when the model did not pass a topic: first
 *  sentence-ish slice of the summary (≤30 chars). Decorative only — never
 *  blocks compression. */

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
    // Stay a top-level tool. Extension tools default to "discoverable", which
    // omp's tools.xdev mounts behind the xd://compress device — forcing the
    // model to hand-write JSON-inside-a-JSON-string via the write tool. That
    // double-escaping layer was the direct cause of issue #21's parse errors
    // and truncated write calls; top-level structured args eliminate it.
    // (Found independently in #36, which also surfaced that device-mounted
    // descriptions are capped at 200 chars — XDEV_EXTERNAL_DESCRIPTION_CAP in
    // the host — so the escaping guidance in this description never even
    // reached the model while device-mounted.)
    loadMode: "essential",
    description:
      "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ \"topic\": \"Session Opener\", \"startId\": \"m00004\", \"endId\": \"m00022\", \"summary\": \"...\" }] }) — a short topic label is recommended but optional. Batch: one entry per range in content[].",
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
    const rangeSpecs: CompressRangeSpec[] = ranges.map((r) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary, topic: r.topic ?? topLevelTopic, summaryMaxChars, compressCallId: toolCallId }));

    const invalidRanges = rangeSpecs.filter((r) => !r.startRef || !r.endRef || typeof r.startRef !== "string" || typeof r.endRef !== "string");
    if (invalidRanges.length > 0) {
      logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "invalid-ranges", count: invalidRanges.length, ranges: invalidRanges.map((r) => `${r.startRef}..${r.endRef}`) });
      return rejectionMessage(ctx, runtime, `Rejected: ${invalidRanges.length} range(s) have invalid startId or endId (missing or non-string). All ranges must have valid message refs (e.g. "m00005") or block IDs (e.g. "b3"). No changes applied — run acp_status for current refs.`);
    }

    let applied: ApplyCompressionResult;
    try {
      applied = runtime.core.applyCompression({
        ranges: rangeSpecs,
        messages,
        state,
        config,
      });
    } catch (e) {
      logThrow("compress", e, { sid: ctx.sessionManager.getSessionId(), phase: "applyCompression", ranges: rangeSpecs.length });
      return rejectionMessage(ctx, runtime, `Compression failed: ${e instanceof Error ? e.message : String(e)}. No changes applied — state is unchanged.`);
    }
    if (applied.result.errors.length > 0) {
      logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "apply-errors", count: applied.result.errors.length, errors: applied.result.errors.slice(0, 5) });
      return rejectionMessage(ctx, runtime, `Compression rejected: ${applied.result.errors.join("; ")}. No changes applied — run acp_status to verify current state.`);
    }
    runtime.noteCompressOutcome(ctx, true);
    await runtime.commitFoldState(ctx, applied.state, toolCallId);
    const { blocksCreated, tokensCompressed, warnings } = applied.result;

    const afterTokens = Math.max(0, beforeTokens - tokensCompressed);

    const newBlocks = applied.state.blocks.slice(-blocksCreated);
    debug.event("compress-out", {
      sid: ctx.sessionManager.getSessionId(),
      blocksCreated,
      tokensCompressed,
      beforeTokens,
      afterTokens,
      afterMsgCount: applied.state.blocks.length,
      errors: 0,
      errorDetails: [],
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
      newBlockIds: newBlocks.map((b) => b.blockId),
    });
    if (warnings.length > 0) {
      logError("compress", { sid: ctx.sessionManager.getSessionId(), event: "warnings", count: warnings.length, warnings: warnings.slice(0, 5) });
    }

    // Span fingerprints: replay-time identity check written into the result
    // text (which persists in the stream). If a host-side rewrite later shifts
    // positions, fold replay re-computes and mismatches → call skipped. One
    // entry per range ("-" for block-boundary ranges the ledger can't
    // position) so replay-side index lookup stays aligned.
    const fps = rangeFingerprints(rangeSpecs, coreMessages, applied.state.messageRefs.byRef, applied.state.blocks);

    const lines = [`▣ ACP | ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens (~${formatTokens(tokensCompressed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
    if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
    if (fps.some((fp) => fp !== "-")) lines.push(`[fp=${fps.join(",")}]`);
    return lines.join("\n");
  } finally { releaseLock(); }
}

const LOOP_GUARD_STOP = 3;
const LOOP_GUARD_SUPPRESS = 4;

// Consecutive-rejection guard: weak models treat an identical error as a
// fresh prompt and re-issue the same doomed compress call dozens of times
// (observed: 33 rejections over 48 minutes on one range). Escalate at the
// third rejection with an explicit STOP directive, then suppress the kernel
// detail entirely — the repetition itself is the poison.
function rejectionMessage(ctx: ExtensionContext, runtime: AcpRuntime, base: string): string {
  const streak = runtime.noteCompressOutcome(ctx, false);
  if (streak >= LOOP_GUARD_SUPPRESS) {
    logWarn("compress", { sid: ctx.sessionManager.getSessionId(), event: "loop-guard", streak, mode: "suppressed" });
    return `Compression rejected (again — ${streak} consecutive rejections). No changes applied. STOP calling compress; it is not converging. Continue the task. Compress stays available: a fresh attempt works when acp_status shows a range that can meet the minimum size.`;
  }
  if (streak >= LOOP_GUARD_STOP) {
    logWarn("compress", { sid: ctx.sessionManager.getSessionId(), event: "loop-guard", streak, mode: "stop-directive" });
    return `${base}\n\nSTOP: ${streak} compress calls rejected in a row. Do NOT retry the same range. Run acp_status to see what is actually compressible now; if no range can meet the minimum size, nothing is left to compress — stop and continue the actual task.`;
  }
  return base;
}
