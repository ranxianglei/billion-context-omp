import type {
  ExtensionAPI,
  ExtensionFactory,
  SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";
import type { NudgeDecision, CompressionBlock, Prompts } from "acp-kernel";
import { renderNudgeText, resolvePrompts, defaultPrompts } from "acp-kernel";
import { type AdapterConfig } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages } from "./messages.js";
import { summarizeRange, selectRangeSpan } from "./auto-compress.js";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, setDebugEnabled, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import { collectCoveredMessageIds, estimateTokens, lastUserMessageId } from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { dumpContextMessages, dumpProviderRequest } from "./dump.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";
import { formatSystemPromptForEvent } from "./compat.js";

type AgentMessage = SessionMessageEntry["message"];

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    wireCompactionDisable(pi, runtime);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi, runtime);
    wireProviderDebug(pi);
    wireToolGuardrails(pi, runtime);
    pi.registerTool(makeCompressTool(runtime));
    pi.registerTool(makeDecompressTool(runtime));
    pi.registerTool(makeSearchTool(runtime));
    pi.registerTool(makeStatusTool(runtime));
    for (const { name, options } of makeCommands(runtime)) {
      pi.registerCommand(name, options);
    }
  };
}

export default createAcpExtension();

// ACP owns compression. On `/compact` we intercept Pi's native compaction and
// instead run the message range through the kernel's compression pipeline:
// pick a compressible span, summarize it with a model (explicit `compressModel`
// or the session model), and applyCompression. We then hand the summary back
// to Pi as the compaction result so Pi stores it. On any failure we return
// undefined so Pi falls back to its own compaction rather than losing context.
function wireCompactionDisable(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_before_compact", async (event, ctx) => {
    let release: (() => void) | undefined;
    try {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      release = await runtime.acquireLock(sid);
      const { state, coreMessages } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      const tokenCount = estimateTokens(coreMessages, coveredIds);

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      const ranges = (turn.nudge?.compressibleRanges ?? []).filter((r) => !r.dangerous);
      if (ranges.length === 0) return undefined;

      const span = selectRangeSpan(ranges, turn.messages, turn.state, config.compress.minCompressRange ?? 5000);
      if (!span) return undefined;

      ctx.ui?.notify?.(`ACP: compressing ~${span.tokens} tokens…`, "info");
      const result = await summarizeRange(ctx, turn.messages, turn.state, span.startRef, span.endRef, runtime.prompts, runtime.adapter.compress?.compressModel);
      if (!result) {
        ctx.ui?.notify?.("ACP: compression fell back to Pi native compaction", "warning");
        return undefined;
      }
      const { summary, model } = result;

      const applied = runtime.core.applyCompression({
        ranges: [{ startRef: span.startRef, endRef: span.endRef, summary }],
        messages: turn.messages,
        state: turn.state,
        config,
      });
      const errors = applied.result.errors ?? [];
      if (errors.length > 0) {
        logWarn("compact", { sid, event: "rejected", span: `${span.startRef}..${span.endRef}`, model, errors });
        return undefined;
      }
      await runtime.save(applied.state, ctx);

      logInfo("compact", {
        sid,
        event: "acp-compaction",
        span: `${span.startRef}..${span.endRef}`,
        tokens: span.tokens,
        model,
        blocksCreated: applied.result.blocksCreated,
      });
      debug.event("compact-acp", { sid, span: `${span.startRef}..${span.endRef}`, tokens: span.tokens, model });

      ctx.ui?.notify?.(`ACP: compressed ~${span.tokens} tokens via ${model}`, "info");

      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (e) {
      logThrow("compact", e, { sid: ctx.sessionManager?.getSessionId?.() ?? "" });
      return undefined;
    } finally {
      release?.();
    }
  });
}

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
    runtime.store.invalidate();
    runtime.clearNudgeTracking();
    const sid = ctx.sessionManager.getSessionId();
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null });
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user));
      if (runtime.adapter.debug !== undefined) setDebugEnabled(runtime.adapter.debug);
    } catch (e) {
      logThrow("config", e, { sid, phase: "session_start" });
    }
    try {
      runtime.setPrompts(resolvePrompts(runtime.adapter.prompts, { acknowledgeRisk: runtime.adapter.acknowledgePromptsRisk === true }));
    } catch (e) {
      logWarn("config", { event: "prompts-resolve-failed", error: e instanceof Error ? e.message : String(e) });
      runtime.setPrompts(defaultPrompts);
    }
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
  });
  pi.on("session_shutdown", () => {
    closeLogStream();
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      // Prefer pi's real token count (anchored on provider usage) over our
      // chars/4 estimate — it includes the system prompt, tool schemas, and
      // trailing messages pi has not yet received a usage for. This is what the
      // footer percentage reflects, so nudge usage/growth will match what the
      // user sees.
      const realUsage = ctx.getContextUsage?.();
      const estimated = estimateTokens(coreMessages, coveredIds);
      const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : estimated;

      debug.event("context-in", {
        sid,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        estimatedTokens: estimated,
        realTokens: realUsage?.tokens ?? null,
        realPercent: realUsage?.percent ?? null,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      // On the first context event after session restart/resume, omp's
      // getBranch() may return only metadata entries (title, session) before
      // the actual message entries are loaded. This produces coreMessages=[]
      // while event.messages has real content. If we replace event.messages
      // with our empty rebuild, the LLM sees nothing — user's first message
      // is silently lost until the next context event.
      if (coreMessages.length === 0 && (event.messages?.length ?? 0) > 0) {
        debug.event("getbranch-stale-fallback", {
          sid,
          eventMsgs: event.messages?.length ?? 0,
          entries: entries.length,
        });
        return;
      }

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      logInfo("turn", {
        sid,
        inMsgs: coreMessages.length,
        outMsgs: turn.messages.length,
        tokens: tokenCount,
        pct: realUsage?.percent ?? (config.modelContextLimit > 0 ? Math.round((tokenCount / config.modelContextLimit) * 100) : null),
        limit: config.modelContextLimit,
        nudge: turn.nudge?.shouldInject ? (turn.nudge.breakdown?.emergencyOverride === 1 ? "emergency" : "active") : "idle",
        nudgeReason: turn.nudge?.reason ?? null,
        blocks: turn.state.blocks.length,
        activeBlocks: turn.state.blocks.filter((b) => b.active).length,
      });

      debug.event("processTurn", {
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge, runtime.prompts).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    debug.event("core-out", {
      sid,
      coreOutMsgs: turn.messages.length,
      originalByIdSize: originalById.size,
      rebuiltMsgs: rebuilt.length,
    });
    const debugOn = debug.enabled;

    if (turn.nudge?.shouldInject) {
      // Two independent channels for the nudge:
      //  1. CONTEXT injection (always on): the nudge is appended to the
      //     messages returned to the LLM so the model sees it and compresses.
      //     This is a per-turn append — the next context event rebuilds the
      //     array from scratch, so it does NOT permanently pollute context.
      //  2. TERMINAL echo (debug only): when debug is on, also print the exact
      //     text via ctx.ui.notify so the user can observe what is being
      //     injected while debugging. The model never sees terminal output.
      // Emergency nudges (usage >= 80%) bypass the per-turn dedup so the
      // overflow warning always reaches the model. Other nudges inject at most
      // once per turn: pi fires the context event multiple times per assistant
      // reply (streaming/tool loop), and without this gate the same nudge
      // would be appended on every event.
      const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
      const turnKey = lastUserMessageId(entries) ?? sid;
      const alreadyShown = !emergency && runtime.nudgeShownFor(turnKey);
      if (!alreadyShown) {
        const rendered = renderNudgeText(turn.nudge, runtime.prompts);
        const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
        const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active), runtime.prompts, example));
        if (emergency) {
          logWarn("nudge", { sid: ctx.sessionManager.getSessionId(), event: "emergency-inject", pct: Math.round(turn.nudge.contextUsage * 100), voice: rendered.voice, compressible: turn.nudge.compressibleRanges.length });
        }
        if (debugOn && ctx.hasUI) {
          ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
        }
        if (!emergency) runtime.markNudgeShown(turnKey);
        debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, text: rendered.text + example });
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason });
      }
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    dumpContextMessages(rebuilt, {
      sid,
      injected: turn.nudge?.shouldInject ?? false,
      emergency: turn.nudge?.breakdown?.emergencyOverride === 1,
    });
    // Also check for updates here (not only on session_start): resuming a
    // long-running session never re-fires session_start, so an update could
    // go unnoticed for days. checkForUpdate throttles internally (3 min) and
    // is guarded against concurrent calls, so firing it per LLM call is safe.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    return { messages: rebuilt };
    } catch (e) {
      logThrow("context", e, { sid, phase: "transform" });
      throw e;
    } finally {
      release();
    }
  });
}

function wireSystemPrompt(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("before_agent_start", (event) => {
    const acp = buildAcpSystemPrompt(runtime.prompts);
    return { systemPrompt: formatSystemPromptForEvent(event.systemPrompt, acp) };
  });
}
// Debug hooks at the actual LLM provider boundary. `before_provider_request`
// fires after ALL message processing (ACP tags, omp system-reminders, tool
// definitions) — this is the true payload sent to the model. Comparing these
// dumps against the context-event dumps (NNNN.json) reveals exactly what omp
// changes after our return, which is where cache-prefix instability hides.
function wireProviderDebug(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (!debug.enabled) return;
    const sid = ctx.sessionManager.getSessionId();
    const dumpPath = dumpProviderRequest(event.payload, { sid });
    logInfo("provider-request", { sid, dumpPath });
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!debug.enabled) return;
    const h = event.headers;
    const cache: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      const lk = k.toLowerCase();
      if (lk.includes("cache") || lk.includes("usage") || lk.includes("token") || lk.includes("rate") || lk.includes("x-")) {
        cache[lk] = v;
      }
    }
    debug.event("provider-response", {
      sid: ctx.sessionManager.getSessionId(),
      status: event.status,
      requestId: event.requestId ?? null,
      cache,
    });
  });
}

function collectOriginals(entries: Array<{ type: string; id: string; message?: AgentMessage; content?: unknown }>): Map<string, AgentMessage> {
  const map = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      map.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      // Pi's convertToLlm projects custom messages as { role: "user", content }
      // for the LLM. Mirror that here so coreOutToAgentMessages restores a
      // proper user AgentMessage — using role:"custom" would be dropped by Pi.
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      map.set(entry.id, { role: "user", content } as AgentMessage);
    }
  }
  return map;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts, example: string): AgentMessage {
  const rendered = renderNudgeText(nudge, prompts);
  const lines = [rendered.text];

  if (blocks.length > 0) {
    const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
    const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
    const tierCounts: Record<number, number> = {};
    for (const b of blocks) {
      const t = b.tier ?? 1;
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierStr = Object.keys(tierCounts).map(Number).sort().map((t) => `T${t}:${tierCounts[t]}`).join(" ");
    const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
    const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
    lines.push("");
    lines.push(`Compressed blocks: ${blocks.length} active (${tierStr}) — ${fmt(totalSummary)} summary, ${fmt(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
  }

  if (example) lines.push(example);

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
