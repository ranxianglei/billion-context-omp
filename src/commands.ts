import type { ExtensionCommandContext, RegisteredCommand } from "@oh-my-pi/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent, formatRanges } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { topicFallback } from "./compress-tool.js";
import { viableRanges } from "./messages.js";
import { formatCompactTokens } from "./footer-status.js";
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

function fmtTokens(n: number): string {
  return formatCompactTokens(n);
}

function bar(value: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Use pi's real context usage (anchored on provider usage) instead of a
  // chars/4 estimate — matches the footer percentage and the nudge decision
  // the context transform computes.
  const realUsage = ctx.getContextUsage?.();
  const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n"));

  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
  const nudge = turn.nudge;
  const bd = nudge?.contextBreakdown;
  const limit = config.modelContextLimit;
  // Two different token accountings, honestly labeled:
  //  - Session accounting (omp getContextUsage): the append-only session tree
  //    INCLUDING compressed originals. It never shrinks — our pruning is a
  //    per-request transform view omp cannot see. The footer reads this.
  //  - Sent view: what actually reaches the LLM after compression (kernel's
  //    chars/4 classification over the pruned projection + measured system
  //    prompt). This is the number compression controls.
  // The old panel subtracted one from the other and dumped the difference
  // into a fake "Framework" bucket — on a well-compressed session that read
  // as "Framework 390K / 430K total" (90%!), which is just the compressed
  // originals still sitting in the session tree.
  const classified = bd ? bd.system + bd.tool + bd.summaries + bd.code + bd.text : 0;
  const systemPromptText = getSystemPromptText(ctx);
  const systemPromptTokens = systemPromptText ? defaultCountTokens(systemPromptText) : 0;
  const sentTotal = classified + systemPromptTokens;
  const sessionOnly = Math.max(0, tokenCount - sentTotal);
  const displayTotal = tokenCount;
  const displayPct = limit > 0 ? Math.round((displayTotal / limit) * 100) : 0;
  const activeBlocksList = state.blocks.filter((b) => b.active);
  const totalBlocksList = state.blocks;

  const lines: string[] = [];

  const versionStr = typeof CURRENT_VERSION !== "undefined" && CURRENT_VERSION ? `billion-context-omp@${CURRENT_VERSION}` : "";

  lines.push("╭─────────────────────────────────────────────╮");
  lines.push("│           ACP Context Analysis              │");
  lines.push("╰─────────────────────────────────────────────╯");
  if (versionStr) lines.push(versionStr);
  lines.push("");
  lines.push(`Context (session accounting): ${displayPct}% (${fmtTokens(displayTotal)} / ${fmtTokens(limit)})`);

  if (nudge && bd) {
    const growth = bd.growth;
    if (growth > 0 && displayTotal > 0) {
      lines.push(`Growth: +${fmtTokens(growth)} since last nudge`);
    }
    lines.push("");
    lines.push(`Sent to LLM (after compression): ${fmtTokens(sentTotal)}`);
    if (sessionOnly > 0) {
      lines.push(`Session-only (compressed originals + host overhead): ${fmtTokens(sessionOnly)} — pruned from every request; the footer counts it`);
    }
    lines.push("");
    lines.push("Token Breakdown (sent view):");

    const categories: Array<{ label: string; value: number }> = [
      { label: "Tool", value: bd.tool },
      { label: "SysPrompt", value: systemPromptTokens },
      { label: "Text", value: bd.text },
      { label: "Code", value: bd.code },
      { label: "Summaries", value: bd.summaries },
    ];

    for (const cat of categories) {
      if (cat.value <= 0) continue;
      const pct = sentTotal > 0 ? Math.round((cat.value / sentTotal) * 100) : 0;
      const b = bar(cat.value, sentTotal);
      lines.push(`  ${cat.label.padEnd(10)} ${b} ${String(pct).padStart(3)}%  ${fmtTokens(cat.value)}`);
    }
  }

  lines.push("");

  if (nudge) {
    if (nudge.shouldInject) {
      const tierInfo = nudge.tier ? ` [T${nudge.tier} distillation]` : "";
      lines.push(`Nudge: ACTIVE${tierInfo} — ${nudge.reason}`);
    } else {
      lines.push(`Nudge: idle — ${nudge.reason}`);
    }
  }

  // Same viability filter as the LLM injection path (index.ts) and the
  // status tool — tiny fragmented ranges are uncompressable noise the model
  // never sees, so the panel shouldn't list them either.
  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  const protectedRanges = nudge?.protectedRanges ?? [];
  if (ranges.length > 0 || protectedRanges.length > 0) {
    lines.push("");
    lines.push(formatRanges(ranges, protectedRanges));
  }

  if (activeBlocksList.length > 0) {
    lines.push("");
    lines.push(`Blocks: ${activeBlocksList.length} active / ${totalBlocksList.length} total (${fmtTokens(state.stats.tokensCompressed)} tokens compressed)`);
    for (const b of activeBlocksList) {
      const topic = b.topic ? `: ${b.topic}` : `: ${topicFallback(b.summary || "")}`;
      const summaryTok = defaultCountTokens(b.summary || "");
      const origTok = b.compressedTokens > 0 ? b.compressedTokens : summaryTok;
      lines.push(`  [${b.blockId}] T${b.tier} ${fmtTokens(origTok)}\u2192${fmtTokens(summaryTok)}${topic}`);
    }
  } else if (totalBlocksList.length > 0) {
    lines.push("");
    lines.push(`Blocks: 0 active / ${totalBlocksList.length} total (${fmtTokens(state.stats.tokensCompressed)} tokens compressed)`);
  } else {
    lines.push("");
    lines.push("Blocks: none (nothing compressed yet)");
  }

  lines.push("");
  lines.push("Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.");

  return lines.join("\n");
}
