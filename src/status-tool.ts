import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { buildStatusReport, defaultCountTokens, formatRanges, type CompressionState, type CoreMessage } from "acp-kernel";
import { estimateTokens, collectCoveredMessageIds } from "./tokens.js";
import { viableRanges } from "./messages.js";
import { logThrow } from "./log.js";

const StatusParams = type({
  "scope?": type('"compressed" | "uncompressed"').describe('"compressed" = drill into blocks; "uncompressed" = show visible messages/ranges. Default: overview.'),
  "view?": type('"ranges" | "messages"').describe('For uncompressed scope: "ranges" (default) or "messages" (per-message listing).'),
  "tool?": type("string").describe('Filter by tool name (e.g. "bash", "read"). Only for uncompressed+messages.'),
  "sort?": type('"size" | "time" | "tool" | "age"').describe("Sort order. Default: size."),
  "limit?": type("number").describe("Max items to show (default: 30)."),
});

type StatusArgs = typeof StatusParams.infer;

export function makeStatusTool(runtime: AcpRuntime): ToolDefinition<typeof StatusParams> {
  return {
    name: "acp_status",
    label: "ACP Status",
    description:
      "Context status: overview, compressed blocks, or uncompressed ranges/messages. No args = overview + totals + compressible ranges. scope:'uncompressed' + view:'messages' for per-message listing. scope:'compressed' for block drilldown.",
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      let result: string;
      try {
        result = await handleStatus(params as StatusArgs, runtime, ctx);
      } catch (e) {
        logThrow("status", e, { sid: ctx.sessionManager.getSessionId(), scope: (params as StatusArgs).scope ?? null });
        throw e;
      }
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleStatus(args: StatusArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, coreMessages, archive } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Run the same pipeline (assign-refs → prune → hide-compress-calls → ...) that
  // the context transform runs, so what acp_status reports matches what the
  // model actually receives. Without this, consumed/hidden compress calls and
  // pruned messages showed up in acp_status even though they never reached
  // the model.
  const tokenCount = estimateTokens(coreMessages, collectCoveredMessageIds(state));
  const realUsage = ctx.getContextUsage?.();
  const turn = runtime.core.processTurn({
    messages: coreMessages,
    state,
    config,
    tokenCount: realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : tokenCount,
  });
  const processed = turn.messages;

  const base = buildStatusReport(turn.state, processed, defaultCountTokens, {
    scope: args.scope,
    view: args.view,
    tool: args.tool,
    sort: args.sort,
    limit: args.limit,
  });

  // Overview mode additionally surfaces the nudge decision and compressible
  // ranges — the same info the /acp slash command shows. Drill-down modes
  // (scope: compressed/uncompressed) return the base report as-is.
  const report = appendArchivedBlocks(base, turn.state, archive);
  if (args.scope) return report;

  const nudge = turn.nudge;
  // Same viability filter as the nudge path: never list ranges too small to
  // carry a meaningful summary (atomic batch rejection trap).
  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  const protectedRanges = nudge?.protectedRanges ?? [];

  const extra: string[] = [];
  if (nudge) {
    extra.push("");
    extra.push(
      nudge.shouldInject
        ? `Nudge: ACTIVE — ${nudge.reason}`
        : `Nudge: idle — ${nudge.reason}`,
    );
  }
  if (ranges.length > 0 || protectedRanges.length > 0) {
    extra.push("");
    // Reuse the kernel's merged range formatter so acp_status, the nudge,
    // and /acp all render compressible+protected ranges identically
    // (merged oldest-first, with mixed-range breakdowns).
    extra.push(formatRanges(ranges, protectedRanges));
  }
  return extra.length > 0 ? `${report}\n${extra.join("\n")}` : report;
}

/** Native compaction (#19) carries folded blocks into the archive. The
 *  kernel report only lists ACTIVE blocks, so without this section the
 *  carried blocks would read as "No compressed blocks" — exactly the
 *  "compressed blocks unfindable" regression the issue reports. */
function appendArchivedBlocks(report: string, state: CompressionState, archive: CoreMessage[]): string {
  const archiveIds = new Set(archive.map((m) => m.id));
  const archived = state.blocks
    .filter((b) => !b.active && b.effectiveMessageIds.some((id) => archiveIds.has(id)))
    .sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));
  if (archived.length === 0) return report;
  const lines = [
    "",
    `ARCHIVED BLOCKS \u2014 ${archived.length} archived by native compaction (restorable via decompress)`,
  ];
  for (const b of archived) {
    const topic = b.topic ?? "(no topic)";
    lines.push(`  ${b.blockId} (T${b.tier})  ${b.effectiveMessageIds.length} msgs  "${topic}"`);
  }
  return `${report}\n${lines.join("\n")}`;
}

function numericPart(blockId: string): number {
  const match = /^b(\d+)$/.exec(blockId);
  return match ? Number(match[1]) : 0;
}
