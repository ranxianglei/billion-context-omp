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
import { resolveTransformMode } from "./transform-mode.js";
import { applyWireTagContract, coreToPayloadMessages, detectProviderWireFormat, payloadToCore, type ProviderWireFormat } from "./wire-fold.js";
import type { BiliMessage } from "acp-kernel/wire";
import { viableRanges } from "billion-context-kit";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { stampAndDetect } from "./instance-guard.js";
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

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null });
    // Dual-instance guard (AGENTS.md #14): `omp install` + a manual
    // extensions path both loading this package fight over two fold
    // states — observed live as evaporating blocks. Warn once, loudly.
    const selfPath = import.meta.url;
    const conflict = stampAndDetect(selfPath, typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null);
    if (conflict) {
      logWarn("instance", { event: "dual-instance", self: selfPath, other: conflict.path, otherPid: conflict.pid, otherVersion: conflict.version });
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(`⚠ billion-context-omp loaded TWICE (also from ${conflict.path}). Two instances corrupt compression state — remove one (check 'omp plugin list' vs config.yml extensions).`);
        }
      } catch {
        // notify unavailable — log line above is the durable record
      }
    }
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
    // Fire-and-forget: the registry fetch (5s) or an auto-install (60s)
    // must not sit on the session-start critical path (issue #89). A
    // short-lived host still cannot exit mid-install: autoInstallLatest's
    // keepAlive interval holds the event loop until `npm install` exits.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    }).catch((e) => logThrow("update", e, { sid, phase: "session_start" }));
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
// (fold → processTurn → nudge → rebuild). The effective mode per API is
// resolved in transform-mode.ts (issue #79): an explicit `transformMode`
// always wins; the unset default is "provider" where the host applies the
// wire-payload replacement AND the wire body has a codec path
// (anthropic-messages, ollama-chat; openai-completions on hosts >= 17.3.8,
// issue #83) and "context" everywhere else.
//  - "context": omp's `context` event fires before every LLM call with the
//    messages about to be sent; we return the transformed AgentMessage[].
//    Known defect: omp's recap/subagent pipelines re-feed our output as INPUT
//    on the next event (the feedback-view / two-truth-source problem, issues
//    #22/#47/#52 and the 01a0059b loop).
//  - "provider": the context event is left untouched (observer) and the
//    surgery runs at `before_provider_request` on the WIRE payload —
//    request-local, structurally impossible to re-feed.
//    See wireProviderTransform + wire-fold.ts.
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
    // Record the rebuilt output's identity sequence so the next context event
    // can recognize omp re-feeding it (issue #52). Context mode only: the
    // provider-mode wire payload is request-local and never re-enters.
    if (mode === "context") {
      runtime.recordRebuiltOutput(ctx, rebuilt);
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
    // long-running session never re-fires session_start. Fire-and-forget
    // (issue #89): the host awaits this handler in the LLM pipeline with a
    // 30s budget, while the registry fetch (5s) plus an auto-install (60s)
    // can exceed it — awaiting here would make the host drop this turn's
    // transformed messages. checkForUpdate throttles internally (3 min)
    // and guards concurrent calls; the install survives a short-lived host
    // via autoInstallLatest's keepAlive interval.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    }).catch((e) => logThrow("update", e, { sid, phase: "context" }));
    return result;
}

function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    if (resolveTransformMode(runtime.adapter, ctx.model) === "provider") {
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
// convertToLlm — the body is request-local, so a transform here can never
// re-enter as input. The pipeline runs in CORE SPACE on the kernel codec
// (wire-fold.ts): payload → toCore → foldStreamCore/processTurn → coreToX
// → new payload. This is the same wire contract as the billion-context
// proxy (renderTags "text-only"), so both deployments tag identically.
// Fail-open: any error or a body the kernel cannot parse rebuilds nothing
// and the original payload passes through.
function wireProviderTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("before_provider_request", async (event, ctx) => {
    if (resolveTransformMode(runtime.adapter, ctx.model) !== "provider") return undefined;
    const payload = (event as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== "object" || !Array.isArray((payload as { messages?: unknown }).messages)) return undefined;
    const sid = ctx.sessionManager?.getSessionId?.() ?? "";
    const fmt = detectProviderWireFormat(payload);
    if (fmt === null) {
      // Responses bodies and the like: the kernel codec does not parse them
      // into a rebuildable message list yet (the proxy covers responses at
      // the wire level) — pass through untouched.
      debug.event("provider-transform-unknown-format", { sid });
      return undefined;
    }
    try {
      const { msgs, cacheControls } = payloadToCore(payload, fmt);
      if (msgs.length === 0) return undefined;
      const result = await transformStreamCore(ctx, runtime, msgs, fmt);
      if (!result) return undefined;
      const outMsgs = coreToPayloadMessages(result.coreOut, fmt, cacheControls).length;
      const inMsgs = (payload as { messages?: unknown[] }).messages?.length ?? 0;
      if (outMsgs !== inMsgs) {
        logInfo("provider-transform", { sid, fmt, inMsgs, outMsgs, nudge: result.nudgeInjected ? "injected" : "idle" });
      }
      debug.event("provider-transform", { sid, fmt, inMsgs, outMsgs, nudgeInjected: result.nudgeInjected });
      return { ...(payload as object), messages: coreToPayloadMessages(result.coreOut, fmt, cacheControls) };
    } catch (e) {
      // Fail-open: never break the request itself.
      logThrow("provider-transform", e, { sid, fmt });
      return undefined;
    }
  });
}

// Core-space transform (provider mode): the wire payload already parsed to
// BiliMessage[] by the kernel codec. Same fold → processTurn → nudge
// mechanics as transformStream (context mode), but the output stays in core
// space and rebuilds straight onto the wire — no AgentMessage detour.
async function transformStreamCore(
  ctx: ExtensionContext,
  runtime: AcpRuntime,
  wireMsgs: BiliMessage[],
  fmt: ProviderWireFormat,
): Promise<{ coreOut: BiliMessage[]; nudgeInjected: boolean } | undefined> {
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  let result: { coreOut: BiliMessage[]; nudgeInjected: boolean } | undefined;
  try {
    if (wireMsgs.length === 0) {
      debug.event("empty-stream-bypass", { sid, space: "core" });
      return undefined;
    }
    debug.event("context-in-raw", { sid, msgs: wireMsgs.length, mode: "provider" });
    const { state, coreMessages, streamLen } = runtime.foldStreamCore(ctx, wireMsgs);
    const preTurnNudgeBaseline = state.nudge.lastPerMessageNudgeTokens;
    const preTurnNudgeShownTokens = state.nudge.lastNudgeShownTokens;
    const preTurnNudgeShownByTier = state.nudge.lastShownByTier;
    const config = runtime.configFor(ctx);
    const coveredIds = collectCoveredMessageIds(state);
    // Sent-view scale for nudge arbitration — identical rationale to the
    // context path (host tree accounting must not drive emergency calls).
    const systemPromptTokens = estimateTextTokens(getSystemPromptText(ctx) ?? "");
    const sentTokens = estimateTokens(coreMessages, coveredIds) + systemPromptTokens;
    const sessionTokens = ctx.getContextUsage?.()?.tokens ?? null;
    const tokenCount = sentTokens;

    debug.event("context-in", {
      sid,
      mode: "provider",
      fmt,
      streamLen,
      coreMsgs: coreMessages.length,
      tokenCount,
      sessionTokens,
      limit: config.modelContextLimit,
      blocksBefore: state.blocks.length,
      activeBefore: state.blocks.filter((b) => b.active).length,
    });

    // "text-only": tag user/assistant text with m-refs, never tag structured
    // tool content — the proxy's wire contract (refs are still assigned on
    // tool pieces, so blocks cover them; the model cites them by block ref).
    const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount, renderTags: "text-only" });
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

    // compress-as-anchor (same contract as coreOutToAgentMessages): the
    // summary is already visible to the model through the compress call's
    // arguments in the stream — the kernel's synthetic summary message would
    // duplicate it (and emit a mid-conversation system message on openai
    // wires). The pipeline spreads BiliMessage objects (sidecar fields
    // survive) — the same downcast the proxy applies to its processTurn output.
    const coreOut = applyWireTagContract(
      (turn.messages as BiliMessage[]).filter((m) => !m.id.startsWith("acp_summary_")),
      turn.state,
    );

    let nudgeInjected = false;
    if (turn.nudge?.shouldInject) {
      // Feedback-view guard (core space): if the incoming wire already ends
      // with our nudge text the model was reminded in this very turn.
      const lastUser = [...wireMsgs].reverse().find((m) => m.role === "user");
      const tailText = lastUser ? (lastUser.text ?? "") : "";
      const isFeedbackView = tailText.includes("efficiency nudge to compress early") || tailText.includes("Context limit reached");
      if (isFeedbackView) {
        debug.event("nudge-feedback-skip", { sid, msgs: wireMsgs.length });
      } else {
        const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
        // Same cadence floor as the context path: the kernel's over-limit
        // branch re-fires on every LLM call; suppress unless the sent view
        // grew >= growthFloor since the last nudge the model saw.
        const epochReset = turn.state.nudge.lastPerMessageNudgeTokens !== preTurnNudgeBaseline;
        const prevShown = epochReset ? 0 : preTurnNudgeShownTokens;
        const cadenceFloor = turn.nudge.breakdown?.growthFloor ?? 0;
        const suppressed = !emergency && prevShown > 0 && tokenCount - prevShown < cadenceFloor;
        if (suppressed) {
          turn.state.nudge.lastNudgeShownTokens = prevShown;
          turn.state.nudge.lastShownByTier = preTurnNudgeShownByTier;
          logInfo("nudge", { sid, event: "cadence-suppressed", growth: tokenCount - prevShown, floor: cadenceFloor, pct: Math.round(turn.nudge.contextUsage * 100), reason: turn.nudge.reason });
          debug.event("nudge-suppressed", { sid, growth: tokenCount - prevShown, floor: cadenceFloor, pct: Math.round(turn.nudge.contextUsage * 100), reason: turn.nudge.reason });
        } else {
          nudgeInjected = true;
          turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
          const rendered = renderNudgeText(turn.nudge, runtime.prompts);
          const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
          const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
          if (emergency) {
            logWarn("nudge", { sid, event: "emergency-inject", pct: Math.round(turn.nudge.contextUsage * 100), voice: rendered.voice, compressible: turn.nudge.compressibleRanges.length });
          }
          const debugOn = debug.enabled;
          if (debugOn && ctx.hasUI) {
            ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
          }
          debug.event("nudge-injected", { sid, voice: rendered.voice, channels: ["wire", debugOn ? "terminal" : null].filter(Boolean), emergency, text: rendered.text + example });
          // The nudge rides the wire rebuild as the trailing user message —
          // coreToX emits it; same text the context path appends.
          coreOut.push({ id: `acp_nudge_${Date.now()}`, role: "user", contentType: "text", text: nudgeText(turn.nudge, turn.state.blocks.filter((b) => b.active), runtime.prompts, example) });
        }
      }
    }

    debug.event("core-out", { sid, coreOutMsgs: coreOut.length, space: "core", fmt });
    result = { coreOut, nudgeInjected };
  } catch (e) {
    logThrow("context-core", e, { sid, phase: "transform" });
    throw e;
  } finally {
    release();
  }
  // Fire-and-forget, same contract as the context path (issue #89): the
  // host's 30s handler budget must not be spent on a registry fetch or an
  // auto-install.
  void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
    if (ctx.hasUI) ctx.ui.notify(msg);
  }).catch((e) => logThrow("update", e, { sid, phase: "provider" }));
  return result;
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

function nudgeText(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts, example: string): string {
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

  return lines.join("\n");
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[], prompts: Prompts, example: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: nudgeText(nudge, blocks, prompts, example) }],
    timestamp: Date.now(),
  } as AgentMessage;
}
