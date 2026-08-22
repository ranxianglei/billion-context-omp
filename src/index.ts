import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import type { NudgeDecision, CompressionBlock, Prompts } from "acp-kernel";
import { renderNudgeText, resolvePrompts, defaultPrompts, viableRanges } from "acp-kernel";
import { type AdapterConfig } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool, LOOP_GUARD_STOP } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeCommands } from "./commands.js";
import { providerDeliveryWarning, hostMeetsMinimum, MIN_HOST_VERSION, type ProviderDeliveryWarning } from "./transform-mode.js";
import { VERSION } from "@oh-my-pi/pi-utils";
import { applyWireTagContract, coreToPayloadMessages, detectProviderWireFormat, payloadRepresentable, payloadToCore, responsesProjection, responsesRebuild, restoreOpenaiWireFidelity, type ProviderWireFormat } from "./wire-fold.js";
import type { BiliMessage } from "acp-kernel/wire";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { stampAndDetect } from "./instance-guard.js";
import { debug, setDebugEnabled, logInfo, logWarn, logThrow, closeLogStream } from "./log.js";
import { collectCoveredMessageIds, estimateTextTokens, estimateTokens } from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { dumpProviderRequest } from "./dump.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";
import { formatSystemPromptForEvent, getSystemPromptText } from "./compat.js";

declare const CURRENT_VERSION: string;

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    const warnDelivery = makeDeliveryWarner();
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, warnDelivery);
    wireSystemPrompt(pi, runtime);
    // BEFORE wireProviderDebug: handlers fire in registration order, so the
    // provider dumps capture the POST-transform payload (what actually goes
    // to fetch).
    wireProviderTransform(pi, runtime, warnDelivery);
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
  // Restart+resume (/resume, /fork, handoff, reload) fires session_switch —
  // NOT session_start — with the transcript already loaded; session_start on
  // a resumed boot fires before the old transcript is mounted. Without a
  // switch handler the fold is never primed and /acp shows "Blocks: none"
  // until the first LLM call (issue #103). Config/prompts re-resolution is
  // idempotent and keeps the switch path self-sufficient when session_start
  // never saw this session.
  const prepareAndPrime = async (ctx: ExtensionContext, phase: string): Promise<void> => {
    const sid = ctx.sessionManager.getSessionId();
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user));
      if (runtime.adapter.debug !== undefined) setDebugEnabled(runtime.adapter.debug);
    } catch (e) {
      logThrow("config", e, { sid, phase });
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
  };
  pi.on("session_start", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    // Model identity on every session start: diagnosing "which model loops on
    // compress rejections" from user logs required cwd forensics (issue #47
    // follow-up, 2026-08-17 log analysis) — the log never said which model it
    // was. id + contextWindow also catch window misconfigurations.
    const modelInfo = ctx.model as { id?: string; contextWindow?: number; api?: string } | undefined;
    logInfo("session", { event: "start", sid, cwd: ctx.cwd, debug: runtime.adapter.debug ?? null, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null, model: modelInfo?.id ?? null, modelApi: modelInfo?.api ?? null, contextWindow: modelInfo?.contextWindow ?? null });
    // Minimum-host gate: omp requires a host that applies the
    // before_provider_request (onPayload) replacement (pi-ai >= 17.3.8,
    // upstream can1357/oh-my-pi#8717, issue #83). Older hosts drop the
    // replacement fire-and-forget, so provider mode would deliver NOTHING to
    // the model (issue #79). Warn once, loudly — compression is a no-op there.
    if (!hostMeetsMinimum()) {
      logWarn("session", { event: "host-too-old", version: VERSION, min: MIN_HOST_VERSION.join(".") });
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(`⚠ billion-context-omp requires omp host >= ${MIN_HOST_VERSION.join(".")} (found ${VERSION}). The host discards payload rewrites, so compression is NOT applied. Upgrade with 'omp update'.`);
        }
      } catch {
        // notify unavailable — log line above is the durable record
      }
    }
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
    await prepareAndPrime(ctx, "session_start");
    // Fire-and-forget: the registry fetch (5s) or an auto-install (60s)
    // must not sit on the session-start critical path (issue #89). A
    // short-lived host still cannot exit mid-install: autoInstallLatest's
    // keepAlive interval holds the event loop until `npm install` exits.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    }).catch((e) => logThrow("update", e, { sid, phase: "session_start" }));
  });
  pi.on("session_switch", async (event, ctx) => {
    logInfo("session", { event: "switch", sid: ctx.sessionManager.getSessionId(), reason: event.reason, previous: event.previousSessionFile ?? null });
    await prepareAndPrime(ctx, "session_switch");
  });
  pi.on("session_branch", async (_event, ctx) => {
    logInfo("session", { event: "branch", sid: ctx.sessionManager.getSessionId() });
    await prepareAndPrime(ctx, "session_branch");
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

// The core integration. The compression surgery runs at
// `before_provider_request` on the WIRE payload (wireProviderTransform) —
// request-local, structurally impossible to re-feed as input. The `context`
// event is a pure observer (wireContextTransform): touching the message array
// there is what created the feedback-view / two-truth-source loop (issues
// #22/#47/#52 and the 01a0059b loop), so the legacy "context" transform mode
// was removed. Delivery is gated on the kernel having a codec for the wire
// body (transform-mode.ts, issue #83); APIs without one pass through
// untransformed (fail-open) and surface a delivery warning.
// See wireProviderTransform + wire-fold.ts.

function wireContextTransform(pi: ExtensionAPI, warnDelivery: DeliveryWarner): void {
  pi.on("context", async (event, ctx) => {
    // The context event is a pure observer. The fold runs at
    // before_provider_request instead (wireProviderTransform); touching the
    // message array here is what created the feedback-view loop (issues
    // #22/#47/#52). The legacy "context" transform mode was removed.
    const sid = ctx.sessionManager.getSessionId();
    debug.event("context-observer-skip", { sid, msgs: event.messages?.length ?? 0 });
    const warning = providerDeliveryWarning(ctx.model);
    if (warning) warnDelivery(ctx, sid, warning);
    return undefined;
  });
}

type DeliveryWarner = (ctx: ExtensionContext, sid: string, warning: ProviderDeliveryWarning) => void;

function makeDeliveryWarner(): DeliveryWarner {
  const warned = new Set<string>();
  return (ctx, sid, warning) => {
    const dedup = `${sid}:${warning.key}`;
    if (warned.has(dedup)) return;
    warned.add(dedup);
    logWarn("provider-transform", { sid, event: "undelivered", reason: warning.reason });
    try {
      if (ctx.hasUI) ctx.ui.notify(warning.message);
    } catch {
      // notify unavailable — the log line above is the durable record
    }
  };
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
function wireProviderTransform(pi: ExtensionAPI, runtime: AcpRuntime, warnDelivery: DeliveryWarner): void {
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = (event as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== "object") return undefined;
    // The wire body carries either a `messages` array (anthropic / openai
    // chat) or an `input` array/string (openai-responses). Anything else is
    // not a transformable provider body — pass through untouched.
    const p = payload as { messages?: unknown; input?: unknown };
    const hasMessages = Array.isArray(p.messages);
    const hasInput = Array.isArray(p.input) || typeof p.input === "string";
    if (!hasMessages && !hasInput) return undefined;
    const sid = ctx.sessionManager?.getSessionId?.() ?? "";
    const fmt = detectProviderWireFormat(payload);
    if (fmt === null) {
      // The kernel codec does not parse this body into a rebuildable message
      // list — pass through untouched.
      debug.event("provider-transform-unknown-format", { sid });
      warnDelivery(ctx, sid, {
        key: "unknown-wire-format",
        reason: "the wire body has no codec path (unknown format) — payload passes through",
        message: "⚠ billion-context-omp: this wire body has no codec path — compression is NOT applied here. Kernel codec tracked upstream (issue #83).",
      });
      return undefined;
    }
    const representable = payloadRepresentable(payload, fmt);
    if (!representable.ok) {
      // Fail-open (issue #3 review): the kernel codec round-trip silently
      // drops blocks it cannot parse (document PDFs, redacted_thinking,
      // server-tool results, ...). The payload passes through untouched —
      // no compression surgery, but no content loss either.
      logInfo("provider-transform", { sid, fmt, event: "unrepresentable", reason: representable.reason });
      debug.event("provider-transform-unrepresentable", { sid, fmt, reason: representable.reason });
      return undefined;
    }
    try {
      // Responses bodies rebuild from a projection (layout-preserving patch);
      // anthropic / openai rebuild from the core message list.
      const projection = fmt === "responses" ? responsesProjection(payload) : undefined;
      const { msgs, cacheControls } = payloadToCore(payload, fmt);
      if (msgs.length === 0) return undefined;
      const result = await transformStreamCore(ctx, runtime, msgs, fmt);
      if (!result) return undefined;
      let rebuilt: unknown;
      if (fmt === "responses") {
        rebuilt = responsesRebuild(projection!, result.coreOut);
      } else {
        const inMessages = (payload as { messages?: unknown[] }).messages ?? [];
        // Openai rebuilds restore the host's wire contract first (issue #105):
        // content "" on assistant tool-call messages and reasoning_details
        // replay — the codec drops/flips both and strict backends trip.
        rebuilt =
          fmt === "openai"
            ? restoreOpenaiWireFidelity(inMessages, coreToPayloadMessages(result.coreOut, fmt, cacheControls))
            : coreToPayloadMessages(result.coreOut, fmt, cacheControls);
      }
      const outMsgs = Array.isArray(rebuilt) ? rebuilt.length : 1;
      const inMsgs = Array.isArray(p.messages) ? p.messages.length : Array.isArray(p.input) ? p.input.length : 1;
      if (outMsgs !== inMsgs) {
        logInfo("provider-transform", { sid, fmt, inMsgs, outMsgs, nudge: result.nudgeInjected ? "injected" : "idle" });
      }
      debug.event("provider-transform", { sid, fmt, inMsgs, outMsgs, nudgeInjected: result.nudgeInjected });
      return fmt === "responses" ? { ...(payload as object), input: rebuilt } : { ...(payload as object), messages: rebuilt };
    } catch (e) {
      // Fail-open: never break the request itself.
      logThrow("provider-transform", e, { sid, fmt });
      return undefined;
    }
  });
}

// Core-space transform: the wire payload already parsed to BiliMessage[] by
// the kernel codec. Fold → processTurn → nudge, output stays in core space
// and rebuilds straight onto the wire — no AgentMessage detour.
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
      { config, tokenCount },
    );

    let nudgeInjected = false;
    if (turn.nudge?.shouldInject) {
      // Feedback-view guard (core space): if the incoming wire already ends
      // with our nudge text the model was reminded in this very turn.
      const lastUser = [...wireMsgs].reverse().find((m) => m.role === "user");
      const tailText = lastUser ? (lastUser.text ?? "") : "";
      const isFeedbackView = tailText.includes("efficiency nudge to compress early") || tailText.includes("Context limit reached") || tailText.includes("compress calls were rejected in a row");
      if (isFeedbackView) {
        debug.event("nudge-feedback-skip", { sid, msgs: wireMsgs.length });
      } else {
        const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
        // Same cadence floor as the context path: the kernel's over-limit
        // branch re-fires on every LLM call; suppress unless the sent view
        // grew >= growthFloor since the last nudge the model saw.
        const epochReset = turn.state.nudge.lastPerMessageNudgeTokens !== preTurnNudgeBaseline;
        // Issue #104: replace the compress demand with the hold while calls
        // are being rejected in a row (context path twin).
        const rejectStreak = runtime.rejectStreakFor(ctx);
        if (rejectStreak >= LOOP_GUARD_STOP) {
          turn.state.nudge.lastNudgeShownTokens = epochReset ? 0 : preTurnNudgeShownTokens;
          turn.state.nudge.lastShownByTier = preTurnNudgeShownByTier;
          nudgeInjected = true;
          coreOut.push({ id: `acp_hold_${Date.now()}`, role: "user", contentType: "text", text: holdText(rejectStreak) });
          logInfo("nudge", { sid, event: "hold-injected", streak: rejectStreak, pct: Math.round(turn.nudge.contextUsage * 100), reason: turn.nudge.reason });
          debug.event("nudge-hold", { sid, streak: rejectStreak });
        } else {
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

// Issue #104: the nudge-to-hold text when compress calls are being rejected
// in a row. The trailing marker phrase doubles as the feedback-view guard
// match so a re-fed view does not stack a second hold.
function holdText(streak: number): string {
  return `[ACP hold] Your last ${streak} compress calls were rejected in a row. Do NOT call compress again now and do NOT retry the same range — the compress reminder is suspended until context actually changes. Continue the actual task. If context still needs relief, run acp_status first and target ONLY a range that meets the minimum size.`;
}
