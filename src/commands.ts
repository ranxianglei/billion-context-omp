import type { ExtensionCommandContext, RegisteredCommand } from "@oh-my-pi/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { collectCoveredMessageIds, estimateTokens } from "./tokens.js";
import { buildStatusPanel } from "billion-context-kit";
import { logThrow } from "./log.js";

declare const CURRENT_VERSION: string;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

function safeHandler(handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args, ctx) => {
    try {
      await handler(args, ctx);
    } catch (e) {
      logThrow("command", e, { args });
      ctx.ui.notify(`ACP command error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

export function makeCommands(runtime: AcpRuntime): Array<{ name: string; options: CommandOptions }> {
  return [
    {
      name: "acp",
      options: {
        description: "Show ACP context usage, token breakdown, and compression status.",
        handler: safeHandler(async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx))),
      },
    },
    {
      name: "acp-status",
      options: {
        description: "Detailed ACP status (block tiers, token breakdown, compressible ranges).",
        handler: safeHandler(async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx))),
      },
    },
    {
      name: "acp-decompress",
      options: {
        description: "Restore a compressed block's content (shown here, block stays folded). Usage: /acp-decompress b3",
        handler: safeHandler(async (args, ctx) => {
          const blockId = parseBlockIdArg(args);
          if (!blockId) {
            ctx.ui.notify('Usage: /acp-decompress <blockId> (e.g. "b3")');
            return;
          }
          const { state, coreMessages } = await runtime.stateFor(ctx);
          const block = state.blocks.find((b) => b.blockId === blockId);
          if (!block) {
            ctx.ui.notify(`Block ${blockId} not found.`);
            return;
          }
          const { text, count } = collectBlockContent(state, block, coreMessages, { full: false });
          if (count === 0) {
            ctx.ui.notify(`Block ${blockId} has no restorable message content.`);
            return;
          }
          ctx.ui.notify(`Block ${blockId} (${count} items):\n\n${text}`);
        }),
      },
    },
    {
      name: "acp-search",
      options: {
        description: "Search compressed block summaries. Usage: /acp-search auth token",
        handler: safeHandler(async (args, ctx) => {
          const query = args.trim();
          if (!query) {
            ctx.ui.notify("Usage: /acp-search <query>");
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const hits = runtime.core.search(query, state);
          if (hits.length === 0) {
            ctx.ui.notify("No matching blocks.");
            return;
          }
          const lines = hits.map((b) => `[${b.blockId}] (t${b.tier}) ${b.topic ?? ""}`.trim());
          ctx.ui.notify(lines.join("\n"));
        }),
      },
    },
  ];
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Host session accounting — the same number the omp footer displays
  // (anchored on provider usage when available, else chars/4 estimate).
  const realUsage = ctx.getContextUsage?.();
  const sessionTokens = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n"));

  // Nudge arbitration on the SENT-VIEW scale (must match the context
  // transform and acp_status — see src/index.ts). The session-tree number
  // above feeds only the panel's footer-scale line; letting it arbitrate
  // here too would show "Nudge: EMERGENCY" on a panel whose real sent view
  // is a few percent (issue #18 report: 366K tree vs 180K window, 204%).
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const coveredIds = collectCoveredMessageIds(state);
  const sentTokens = estimateTokens(coreMessages, coveredIds) + systemPromptTokens;

  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount: sentTokens });

  // The panel (shared kit surface) handles dual accounting, viability
  // filtering, bars, and block rendering. Host-specific inputs only:
  // systemPromptTokens (measured) and unprunedTokens — the chars/4 estimate
  // of the FULL fold projection, so the kit can derive Session-only on the
  // same estimation scale as the sent view (never cross-scale; issue #18).
  const versionStr = typeof CURRENT_VERSION !== "undefined" && CURRENT_VERSION ? `billion-context-omp@${CURRENT_VERSION}` : undefined;
  return buildStatusPanel({
    version: versionStr,
    tokenCount: sessionTokens,
    systemPromptTokens,
    state: turn.state,
    nudge: turn.nudge,
    modelContextLimit: config.modelContextLimit,
    unprunedTokens: coreMessages.reduce((sum, m) => sum + defaultCountTokens(m.text ?? ""), 0),
  });
}
