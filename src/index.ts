import type {
  ExtensionAPI,
  ExtensionContext,
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
import { detectWireFormat, synthesizeStream, rebuildWirePayload } from "./wire-transform.js";
import { viableRanges } from "billion-context-kit";
import { summarizeMessages } from "./auto-compress.js";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, setDebugEnabled, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import { collectCoveredMessageIds, estimateTextTokens, estimateTokens } from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { dumpContextMessages, dumpProviderRequest } from "./dump.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";
import { formatSystemPromptForEvent, getSystemPromptText } from "./compat.js";

type AgentMessage = SessionMessageEntry["message"];

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    wireCompactionDisable(pi, runtime);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi, runtime);
    // BEFORE wireProviderDebug: handlers fire in registration order, so the
    // provider dumps capture the POST-transform payload (what actually goes
    // to fetch), mirroring what context dumps show in context mode.
    wireProviderTransform(pi, runtime);
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
// summarize the FULL set of messages omp is about to discard
// (preparation.messagesToSummarize + turnPrefixMessages) with our compression
// prompts, then hand the summary back as the compaction result. omp stores it
// in a compaction entry — its own durable record — and truncates everything
// before firstKeptEntryId from the LLM view, so the summary must cover ALL of
// the discarded content (a span-only summary would drop the gap, and prior
// in-stream compress calls carrying older block summaries would vanish with
// it). Kernel blocks are NOT used here: fold blocks only replay from
// in-stream compress tool calls, which this truncation removes. On any
// failure we return undefined so Pi falls back to its own compaction rather
// than losing context.
function wireCompactionDisable(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      const prep = event.preparation;
      const toSummarize = [...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])];
      if (toSummarize.length === 0) return undefined;

      // Fold-slot refs so the compaction prompt shows stable mNNNNN ids, not
      // raw pN positions (issue #14 Minor1).
      const slot = await runtime.stateFor(ctx);

      ctx.ui?.notify?.(`ACP: compacting ${toSummarize.length} messages…`, "info");
      const result = await summarizeMessages(ctx, toSummarize, runtime.prompts, runtime.adapter.compress?.compressModel, {
        previousSummary: prep.previousSummary,
        customInstructions: event.customInstructions,
        signal: event.signal,
        messageRefs: slot.state.messageRefs,
      });
      if (!result) {
        ctx.ui?.notify?.("ACP: compression fell back to Pi native compaction", "warning");
        return undefined;
      }

      logInfo("compact", {
        sid,
        event: "acp-compaction",
        messages: toSummarize.length,
        model: result.model,
        summaryLen: result.summary.length,
      });
      debug.event("compact-acp", { sid, messages: toSummarize.length, model: result.model });
      ctx.ui?.notify?.(`ACP: compacted ${toSummarize.length} messages via ${result.model}`, "info");

      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
        },
      };
    } catch (e) {
      logThrow("compact", e, { sid: ctx.sessionManager?.getSessionId?.() ?? "" });
      return undefined;
    }
  });
}

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
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
    // Rebuild blocks from the persisted session right away so /acp and
    // acp_status show them immediately on resume — before the first LLM call.
    runtime.primeFold(ctx);
    // Awaited (not fire-and-forget): session_start is the natural update
    // point and short-lived hosts (print/JSON mode) exit right after the
    // turn — awaiting here plus the keepAlive in autoInstallLatest
    // guarantees the install completes before the process can exit.
    await checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      runtime.forgetSession(ctx.sessionManager.getSessionId());
    } catch {
      // session id unavailable — nothing to evict
    }
    closeLogStream();
  });
}

// The core integration. Two interception points share one pipeline
// (fold → processTurn → nudge → rebuild):
//  - "context" (default): omp's `context` event fires before every LLM call
//    with the messages about to be sent; we return the transformed
//    AgentMessage[]. Known defect: omp's recap/subagent pipelines re-feed our
//    output as INPUT on the next event (the feedback-view / two-truth-source
//    problem, issues #22/#47/#52 and the 01a0059b loop).
//  - "provider" (transformMode: "provider"): the context event is left
//    untouched (observer) and the surgery runs at `before_provider_request`
//    on the WIRE payload — request-local, structurally impossible to re-feed.
//    See wireProviderTransform + wire-transform.ts.
async function transformStream(
  ctx: ExtensionContext,
  runtime: AcpRuntime,
  input: AgentMessage[],
  mode: "context" | "provider",
): Promise<{ rebuilt: AgentMessage[]; nudgeInjected: boolean } | undefined> {
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  let result: { rebuilt: AgentMessage[]; nudgeInjected: boolean } | undefined;
  try {
    // A transient empty message list must not wipe a non-empty fold — bypass
    // instead of rebuilding (an empty {messages} return would clear the LLM
    // context).
    if (input.length === 0) {
      debug.event("empty-stream-bypass", { sid });
      return undefined;
    }
    debug.event("context-in-raw", { sid, msgs: input.length, mode });
    const { state, coreMessages, originalById, streamLen } = runtime.foldStream(ctx, input);
    // Nudge stamps as of the last context event. The pipeline never mutates
    // the pre-turn nudge object (nudgeNode spreads into a fresh one), so
    // these values drive the over-limit cadence guard below (issue #22).
    const preTurnNudgeBaseline = state.nudge.lastPerMessageNudgeTokens;
    const preTurnNudgeShownTokens = state.nudge.lastNudgeShownTokens;
    const preTurnNudgeShownByTier = state.nudge.lastShownByTier;
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      // Nudge arbitration MUST run on the SENT-VIEW scale (chars/4 estimate
      // over the pruned projection + measured system prompt). The host's
      // getContextUsage() is SESSION-TREE accounting: append-only, includes
      // compressed originals, never shrinks — on a session where the tree
      // outgrew the model's context window (e.g. 366K tree vs 180K window
      // after switching models), it reads as a permanent "204%" emergency
      // while the real sent view is ~5%. The tree number stays in the log
      // and the panel (labeled "host footer scale") — it must not drive
      // emergency decisions for the sent view.
      const systemPromptTokens = estimateTextTokens(getSystemPromptText(ctx) ?? "");
      const sentTokens = estimateTokens(coreMessages, coveredIds) + systemPromptTokens;
      const sessionTokens = ctx.getContextUsage?.()?.tokens ?? null;
      const tokenCount = sentTokens;

      debug.event("context-in", {
        sid,
        mode,
        streamLen,
        coreMsgs: coreMessages.length,
        tokenCount,
        sessionTokens,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      runtime.commitFoldState(ctx, turn.state);

      logInfo("turn", {
        sid,
        inMsgs: coreMessages.length,
        outMsgs: turn.messages.length,
        tokens: tokenCount,
        sessionTokens,
        pct: config.modelContextLimit > 0 ? Math.round((tokenCount / config.modelContextLimit) * 100) : null,
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

    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    debug.event("core-out", {
      sid,
      coreOutMsgs: turn.messages.length,
      originalByIdSize: originalById.size,
      rebuiltMsgs: rebuilt.length,
    });

    // omp appends the pending prompt to the session tree only after its
    // message_end is processed — but the input stream already carries it, and
    // the stream (not the tree) is our single source of truth, so no tail
    // salvage is needed.
    const debugOn = debug.enabled;
    let nudgeInjected = false;

    if (turn.nudge?.shouldInject) {
      // Feedback-view guard (defense in depth): omp fires back-to-back
      // context events on DIFFERENT views of the same session — its
      // recap/subagent pipelines re-feed our own rebuilt output as the next
      // event.messages (observed live: our 78-msg context-out at 13:41:11.430
      // became context-in the same millisecond). The PRIMARY fix for the
      // double-nudge is cadence-stamp preservation across re-folds
      // (runtime.ts freshSlot) — with stamps intact the kernel's growth gate
      // holds the line on its own. This guard covers the forms the cadence
      // gate cannot (e.g. emergency-band re-fires on a feedback view): if the
      // incoming stream already ENDS with our nudge text, the model has been
      // reminded in this very turn; stacking a second copy is noise. Matched
      // on stable kernel template phrases; historical nudges deeper in the
      // stream are normal and ignored — only the trailing message counts.
      const lastUser = [...input].reverse().find((m) => m.role === "user");
      const tailText = lastUser ? JSON.stringify(lastUser.content ?? "") : "";
      const isFeedbackView = tailText.includes("efficiency nudge to compress early") || tailText.includes("Context limit reached");
      if (isFeedbackView) {
        debug.event("nudge-feedback-skip", { sid: ctx.sessionManager.getSessionId(), msgs: input.length });
      } else {
      const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
      // The kernel's over-limit branch (usage >= maxContextLimitPct) applies no
      // growth cadence — it re-fires on every context event, i.e. every LLM
      // call of an agentic turn (issue #22: the nudge injects twice in a row).
      // Re-apply the kernel's own floor at the injection point: suppress unless
      // the sent view grew >= growthFloor since the last nudge the model
      // actually saw. Every legal re-nudge still passes: growth-path re-fires
      // already satisfy the kernel's per-tier floor, and a compress or
      // epoch-shrink reset zeroes the stamps (fresh epoch → prevShown 0).
      // Emergency stays unguarded: while usage >= emergencyThresholdPct the
      // overflow reminder must keep firing on every call.
      const epochReset = turn.state.nudge.lastPerMessageNudgeTokens !== preTurnNudgeBaseline;
      const prevShown = epochReset ? 0 : preTurnNudgeShownTokens;
      const cadenceFloor = turn.nudge.breakdown?.growthFloor ?? 0;
      const suppressed = !emergency && prevShown > 0 && tokenCount - prevShown < cadenceFloor;
      if (suppressed) {
        // processTurn already stamped lastNudgeShownTokens/lastShownByTier with
        // this suppressed event — roll both back so the stamps keep pointing
        // at the last nudge the model actually saw. turn.state IS the committed
        // slot state (commitFoldState stores the reference), so this lands.
        turn.state.nudge.lastNudgeShownTokens = prevShown;
        turn.state.nudge.lastShownByTier = preTurnNudgeShownByTier;
        logInfo("nudge", { sid, event: "cadence-suppressed", growth: tokenCount - prevShown, floor: cadenceFloor, pct: Math.round(turn.nudge.contextUsage * 100), reason: turn.nudge.reason });
        debug.event("nudge-suppressed", { sid, growth: tokenCount - prevShown, floor: cadenceFloor, pct: Math.round(turn.nudge.contextUsage * 100), reason: turn.nudge.reason });
      } else {
        nudgeInjected = true;
        // Two independent channels for the nudge:
        //  1. CONTEXT injection (always on): the nudge is appended to the
        //     messages returned to the LLM so the model sees it and compresses.
        //     This is a per-turn append — the next context event rebuilds the
        //     array from scratch, so it does NOT permanently pollute context.
        //  2. TERMINAL echo (debug only): when debug is on, also print the exact
        //     text via ctx.ui.notify so the user can observe what is being
        //     injected while debugging. The model never sees terminal output.
        {
          // Hide degenerate ranges (<200 tokens) before rendering: they cannot
          // carry the 50-char minimum summary and turn "compress all ranges in
          // one call" into an atomic-rejection trap.
          turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
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
          debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, text: rendered.text + example });
        }
      }
      }
    }

    // Always rebuild the full array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    dumpContextMessages(rebuilt, {
      sid,
      injected: nudgeInjected,
      emergency: turn.nudge?.breakdown?.emergencyOverride === 1,
    });
    result = { rebuilt, nudgeInjected };
    } catch (e) {
      logThrow("context", e, { sid, phase: "transform", mode });
      throw e;
    } finally {
      release();
    }
    // Also check for updates here (not only on session_start): resuming a
    // long-running session never re-fires session_start, so an update could
    // go unnoticed for days. checkForUpdate throttles internally (3 min) and
    // is guarded against concurrent calls, so firing it per LLM call is safe.
    // Must run OUTSIDE the fold lock: a discovered update awaits `npm install`
    // for up to 60s (update.ts autoInstallLatest), and under the lock that
    // would serialize every later context event / provider request of this
    // session behind the install.
    await checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    return result;
}

function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    if ((runtime.adapter.transformMode ?? "context") === "provider") {
      // Provider mode: the context event is an observer. The fold runs at
      // before_provider_request instead (wireProviderTransform); touching the
      // message array here is what creates the feedback-view loop.
      debug.event("context-observer-skip", { sid: ctx.sessionManager.getSessionId(), msgs: event.messages?.length ?? 0 });
      return undefined;
    }
    const result = await transformStream(ctx, runtime, event.messages ?? [], "context");
    if (!result) return undefined;
    return { messages: result.rebuilt };
  });
}

// Provider mode (issue #52's structural fix): transform the WIRE payload at
// the last boundary before fetch. omp fires `before_provider_request` after
// convertToLlm (anthropic/openai/responses wire formats) — the body is
// request-local, so a transform here can never re-enter as input. The fold
// runs on a stream SYNTHESIZED from the wire messages (wire-transform.ts);
// survivors are rebuilt from the original wire objects, so unknown fields
// (cache_control, citations, provider extras) pass through untouched. Fail-open:
// any error or unrecognized format returns the original payload.
function wireProviderTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("before_provider_request", async (event, ctx) => {
    if ((runtime.adapter.transformMode ?? "context") !== "provider") return undefined;
    const payload = (event as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== "object" || !Array.isArray((payload as { messages?: unknown }).messages)) return undefined;
    const sid = ctx.sessionManager?.getSessionId?.() ?? "";
    const fmt = detectWireFormat(payload);
    if (fmt === "unknown") {
      debug.event("provider-transform-unknown-format", { sid });
      return undefined;
    }
    try {
      const synth = synthesizeStream(payload, fmt);
      if (synth.stream.length === 0) return undefined;
      const result = await transformStream(ctx, runtime, synth.stream, "provider");
      if (!result) return undefined;
      const wireOut = rebuildWirePayload(result.rebuilt, payload, synth);
      const outMsgs = (wireOut as { messages?: unknown[] }).messages?.length ?? 0;
      const inMsgs = (payload as { messages?: unknown[] }).messages?.length ?? 0;
      if (outMsgs !== inMsgs || wireOut !== payload) {
        logInfo("provider-transform", { sid, fmt, inMsgs, outMsgs, nudge: result.nudgeInjected ? "injected" : "idle" });
      }
      debug.event("provider-transform", { sid, fmt, inMsgs, outMsgs, nudgeInjected: result.nudgeInjected });
      return wireOut === payload ? undefined : wireOut;
    } catch (e) {
      // Fail-open: never break the request itself.
      logThrow("provider-transform", e, { sid, fmt });
      return undefined;
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
