import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  assignRefs,
  createCore,
  createInitialState,
  defaultCountTokens,
  defaultPrompts,
  highestUsedIndex,
  type CompressionCore,
  type CompressionState,
  type Config,
  type CoreMessage,
  type Prompts,
} from "acp-kernel";
import { resolveConfig, type AdapterConfig } from "./config.js";
import { debug, logInfo, logWarn } from "./log.js";
import { getSystemPromptText } from "./compat.js";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { resolveTransformMode } from "./transform-mode.js";
import {
  coreIdentity,
  findCompressCallsCore,
  staleRangeCore,
  toolCallNames,
  toolResultTextsCore,
  viewToAnthropicCore,
  viewToCoreStream,
} from "./wire-fold.js";
import type { BiliMessage } from "acp-kernel/wire";
import { boundaryRaw, findCompressCalls, isBlockRef, messageIdentity, rawPos, spanFingerprint, streamToCoreMessages, toolResultTexts, type AgentMessage, type BlockLike } from "./messages.js";

export interface FoldResult {
  state: CompressionState;
  coreMessages: CoreMessage[];
  originalById: Map<string, AgentMessage>;
  streamLen: number;
}

/** Core-space fold result (provider mode): no originalById — the output
 *  rebuilds straight onto the wire via the kernel codecs. */
export interface CoreFoldResult {
  state: CompressionState;
  coreMessages: BiliMessage[];
  streamLen: number;
}

interface FoldSlot {
  identities: string[];
  foldedLen: number;
  preview: boolean;
  state: CompressionState;
  coreMessages: CoreMessage[];
  appliedCallIds: Set<string>;
  rejectStreak: number;
  /** Identity sequence of the last recorded rebuilt output (issue #52
   *  feedback-view reuse). null = not yet recorded. */
  lastRebuiltOutput: string[] | null;
}

export interface AcpRuntime {
  core: CompressionCore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  prompts: Prompts;
  setPrompts(prompts: Prompts): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  foldStream(ctx: ExtensionContext, stream: AgentMessage[]): FoldResult;
  /** Core-space fold (provider mode): the wire payload already parsed to
 *  BiliMessage[] by the kernel codec; same incremental LCP + replay
 *  semantics as foldStream, content-hash id space (wire-fold.ts). */
  foldStreamCore(ctx: ExtensionContext, stream: BiliMessage[]): CoreFoldResult;
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }>;
  /** Commit the folded state to the slot space the session's CURRENT mode
   *  folds in (provider -> core slot, context -> context slot) — the mirror
   *  of stateFor: a commit must land where the next read goes (issue #90). */
  commitFoldState(ctx: ExtensionContext, state: CompressionState, toolCallId?: string): void;
  /** Record the identity sequence of the last rebuilt output so the next
   *  foldStream can recognize omp re-feeding it (issue #52). */
  recordRebuiltOutput(ctx: ExtensionContext, rebuilt: AgentMessage[]): void;
  /** Track the per-session streak of consecutively REJECTED compress calls.
   *  `ok=false` increments and returns the new streak; `ok=true` resets to 0.
   *  A re-fold (rewritten stream prefix) drops the slot and starts at 0. */
  noteCompressOutcome(ctx: ExtensionContext, ok: boolean): number;
  /** Current consecutive-reject streak in the space the session's CURRENT
   *  mode folds in (issue #104: the nudge must not demand compression while
   *  compress calls are being rejected in a row). */
  rejectStreakFor(ctx: ExtensionContext): number;
  forgetSession(sid: string): void;
  /** Rebuild blocks from the persisted session at session_start so /acp and
   *  acp_status show them BEFORE the first LLM call of a resumed session.
   *  Provider mode folds the WIRE projection (wire-fold.ts mirrors — the
   *  authoritative fold runs on the wire-synthesized stream, which differs
   *  from the raw session view; issue #64). The slot is marked preview and
   *  always re-folded authoritatively at the first live event (the live
   *  stream is the truth source, not the persisted view). */
  primeFold(ctx: ExtensionContext): void;
  acquireLock(sid: string): Promise<() => void>;
}

function freshSlot(preserveFrom?: FoldSlot): FoldSlot {
  const slot: FoldSlot = { identities: [], foldedLen: 0, preview: false, state: createInitialState(), coreMessages: [], appliedCallIds: new Set(), rejectStreak: 0, lastRebuiltOutput: null };
  // Cadence stamps and the reject streak are SESSION-level accounting ("when
  // was the model last reminded" / "how many compress calls has it had
  // rejected in a row"), not stream-derived state. A re-fold rebuilds blocks
  // and refs deterministically from the stream, but must not forget either:
  // omp fires back-to-back context events on DIFFERENT views of the same
  // session (its recap/subagent pipelines re-feed our own rebuilt output;
  // observed live: context-out msgs=78 at 13:41:11.430 became context-in
  // msgs=78 the same millisecond). Clearing stamps there armed the
  // growth-floor gate from zero and re-fired the nudge 4ms after the previous
  // one; clearing the streak would likewise disarm the issue-47 loop guard
  // mid-loop (each view flip resets it to 0 and the guard never reaches its
  // escalation threshold). Kernel-side epoch resets (a real compression
  // clears the stamps via applyCompression) are unaffected — they act on the
  // state we preserve. A successful compression resets the streak explicitly
  // via noteCompressOutcome.
  if (preserveFrom) {
    slot.state = { ...slot.state, nudge: preserveFrom.state.nudge };
    slot.rejectStreak = preserveFrom.rejectStreak;
  }
  return slot;
}

/** Is this re-fold a VIEW FLIP rather than a real history change? A view
 *  flip keeps the stream's identity prefix — omp's variant pipelines
 *  (recap/subagent/advisor) rebuild the same history with a different
 *  projection granularity, so LCP stays high and only the tail differs. A
 *  host compaction (/compact) rewrites the HEAD: the summary message is
 *  first, LCP collapses to ~0. Live evidence: post-compress variant request
 *  at 02:05:06 had foldedLen=198 lcp=197 streamLen=197 (flip, blocks must
 *  survive); post-/compact at 02:27:55 had foldedLen=269 lcp=1 streamLen=40
 *  (compaction, fresh fold is correct). */
function isViewFlip(foldedLen: number, lcp: number): boolean {
  return foldedLen > 0 && lcp >= Math.floor(foldedLen / 2);
}

/** Fold the same session through a different view. Compression blocks are
 *  SESSION-level state on a view flip: the model compressed against the
 *  OTHER view's projection, whose positional ids (p1..pN) and boundary
 *  fingerprints do not exist in this view's projection — replaying the call
 *  here systematically fails the fingerprint guard (observed live:
 *  "reason=fp m00001..m00100 want 24fba6b4 got 0fba5795 @p1..p88" 11ms
 *  after `compress applied 5 blocks`) and freshSlot's createInitialState
 *  threw the just-created blocks away — 3 consecutive live compressions
 *  each evaporated within one request, the session re-nudged and re-paid
 *  them every time. Carrying blocks/refs/appliedCallIds keeps the live
 *  compression; the wrapped calls stay marked applied so this fold does not
 *  try to re-run them against this view's projection. */
function preserveCompressedSlot(prev: FoldSlot): FoldSlot {
  const slot = freshSlot(prev);
  slot.state = { ...slot.state, blocks: prev.state.blocks, messageRefs: prev.state.messageRefs, stats: prev.state.stats };
  slot.appliedCallIds = new Set(prev.appliedCallIds);
  return slot;
}

function stateHasCompressCall(state: CompressionState, callId: string): boolean {
  return state.blocks.some((b) => b.compressCallId === callId);
}

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  const core = createCore({ countTokens: defaultCountTokens });
  const locks = new Map<string, Promise<void>>();
  const slots = new Map<string, FoldSlot>();
  // Disjoint slot space for the provider (core-space) fold — content-hash
  // ids must never mix with the pN ids of the context-space fold (see
  // wire-fold.ts header).
  const coreSlots = new Map<string, FoldSlot>();
  let adapterRef = adapter;
  let promptsRef: Prompts = defaultPrompts;

  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    locks.set(sid, next);
    await prev;
    return release;
  }

  function liveContextLimit(ctx: ExtensionContext): number {
    const usage = ctx.getContextUsage?.();
    if (usage?.contextWindow && usage.contextWindow > 0) return usage.contextWindow;
    const m = ctx.model as { contextWindow?: number } | undefined;
    return m?.contextWindow ?? 0;
  }

  function configFor(ctx: ExtensionContext): Config {
    return resolveConfig(adapterRef, liveContextLimit(ctx));
  }

  function slotFor(sid: string): FoldSlot {
    let slot = slots.get(sid);
    if (!slot) {
      slot = freshSlot();
      slots.set(sid, slot);
    }
    return slot;
  }

  function coreSlotFor(sid: string): FoldSlot {
    let slot = coreSlots.get(sid);
    if (!slot) {
      slot = freshSlot();
      coreSlots.set(sid, slot);
    }
    return slot;
  }

  function sidOf(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId();
  }

  // The input stream (event.messages) is the single source of truth. Identity
  // is position-based (p1..pN); refs are assigned by order and never rebind as
  // long as the prefix is immutable. Compression blocks are DERIVED state:
  // each compress tool call lives in the stream itself, so the block ledger is
  // rebuilt by replaying the calls — no sidecar state file, no host ids, no
  // cross-view alignment. Retry/rewind/compaction shrink or rewrite the
  // stream; the fold detects a mutated prefix and re-folds from scratch, so
  // state always equals fold(stream).
  function foldStream(ctx: ExtensionContext, stream: AgentMessage[]): FoldResult {
    const sid = sidOf(ctx);
    let slot = slotFor(sid);
    if (slot.preview) {
      // A primed slot is a disposable preview built from the persisted view —
      // the first live context event always re-folds from scratch so the
      // authoritative stream (not the persisted projection) rules.
      debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp: 0, streamLen: stream.length, reason: "preview" });
      slot = freshSlot(slot);
      slots.set(sid, slot);
    }
    const ids = stream.map(messageIdentity);
    // Feedback-view reuse (issue #52): omp's recap/subagent pipelines re-feed
    // our own rebuilt output as the next context event (411 of 1286 events
    // measured). When the input stream's identity sequence exactly matches the
    // last recorded rebuilt output, reuse the slot wholesale — blocks, message
    // refs, cadence stamps and rejectStreak all stay continuous. Compress-call
    // replay is skipped on this path: the fingerprint guard mis-fires against
    // our own summary content (fold-replay-stale was the #52 symptom).
    const lastOut = slot.lastRebuiltOutput;
    if (
      lastOut !== null &&
      ids.length === lastOut.length &&
      ids.every((id, i) => id === lastOut[i])
    ) {
      const coreMessages = streamToCoreMessages(stream);
      const originalById = new Map<string, AgentMessage>();
      stream.forEach((message, i) => originalById.set(`p${i + 1}`, message));
      slot.identities = ids;
      slot.foldedLen = ids.length;
      slot.coreMessages = coreMessages;
      debug.event("feedback-reuse", { sid, msgs: ids.length, blocks: slot.state.blocks.length });
      return { state: slot.state, coreMessages, originalById, streamLen: ids.length };
    }
    let lcp = 0;
    while (lcp < Math.min(ids.length, slot.identities.length) && ids[lcp] === slot.identities[lcp]) lcp++;
    if (lcp < slot.foldedLen) {
      const flip = isViewFlip(slot.foldedLen, lcp);
      debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length, flip });
      // View flip (variant pipeline re-projecting the same history): carry
      // the live compression blocks — they were earned against the session,
      // not against this particular projection. Real prefix rewrite
      // (compaction / rewind): deterministic full re-fold, blocks replay
      // from the stream.
      slot = flip ? preserveCompressedSlot(slot) : freshSlot(slot);
      slots.set(sid, slot);
      lcp = 0;
    }

    const coreMessages = streamToCoreMessages(stream);
    const config = configFor(ctx);

    // Prime refs for the current stream before replaying calls —
    // applyCompression resolves start/end refs through state.messageRefs.
    // isProtected mirrors the kernel's assign-refs node so protected-tool
    // messages (compress results, protectedTools config) keep BLOCKED_REF.
    const assigned = assignRefs(coreMessages, {
      existing: slot.state.messageRefs,
      nextIndex: highestUsedIndex(slot.state.messageRefs) + 1,
      isProtected: (m) => {
        if (m.role !== "tool" || !m.toolName) return false;
        if (m.toolName === "compress") return true;
        return (config.protectedTools ?? []).includes(m.toolName);
      },
    });
    slot.state = { ...slot.state, messageRefs: assigned.map };

    // Replay compress calls found in the stream (fresh folds scan everything,
    // incremental folds only NEW positions). Calls whose live tool result said
    // "No changes applied" must never resurrect — checked on every fold, since
    // a live rejection can also be followed by an incremental context event.
    const isFreshFold = slot.foldedLen === 0;
    const resultTexts = toolResultTexts(stream);
    let replayed = 0;
    for (let i = isFreshFold ? 0 : slot.foldedLen; i < stream.length; i++) {
      for (const call of findCompressCalls(stream[i]!)) {
        const resultText = resultTexts.get(call.id) ?? "";
        if (resultText.includes("No changes applied")) {
          debug.event("fold-replay-skipped", { sid, callId: call.id });
          continue;
        }
        // Already applied (live tool call committed, or replayed on an
        // earlier fold) — checked BEFORE the stale guard: a call applied
        // against a sibling view is legitimately applied; running the
        // fingerprint check first would log it as stale on every view
        // flip (the block is carried by preserveCompressedSlot, not replay).
        if (slot.appliedCallIds.has(call.id) || stateHasCompressCall(slot.state, call.id)) continue;
        // Guard against host-side prefix rewrites (native compaction, edits):
        // the call's ranges must resolve to messages that precede the call
        // itself in the stream, and the span fingerprint recorded in the
        // success result must still match — otherwise skip rather than
        // silently compress the wrong messages with a stale summary.
        const stale = call.ranges.map((r, ri) => staleRange(r, ri, resultText, coreMessages, i, slot.state.messageRefs.byRef, slot.state.blocks)).find((s) => s !== false);
        if (stale) {
          debug.event("fold-replay-stale", { sid, callId: call.id, reason: stale });
          continue;
        }
        if (slot.appliedCallIds.has(call.id) || stateHasCompressCall(slot.state, call.id)) continue;
        try {
          const applied = core.applyCompression({ ranges: call.ranges, messages: coreMessages, state: slot.state, config });
          if (applied.result.errors.length === 0) {
            slot.state = applied.state;
            replayed++;
            debug.event("fold-replay", { sid, callId: call.id, ranges: call.ranges.length });
          } else {
            logWarn("fold", { sid, event: "replay-rejected", callId: call.id, errors: applied.result.errors.slice(0, 3) });
          }
        } catch (e) {
          logWarn("fold", { sid, event: "replay-failed", callId: call.id, error: e instanceof Error ? e.message : String(e) });
        }
        slot.appliedCallIds.add(call.id);
      }
    }
    if (replayed > 0) logWarn("fold", { sid, event: "replayed", calls: replayed });

    slot.identities = ids;
    slot.foldedLen = ids.length;
    slot.coreMessages = coreMessages;

    const originalById = new Map<string, AgentMessage>();
    stream.forEach((message, i) => originalById.set(`p${i + 1}`, message));

    return { state: slot.state, coreMessages, originalById, streamLen: stream.length };
  }

  // Core-space fold (provider mode, wire-fold.ts): identical LCP + replay
  // semantics on BiliMessage[] with content-hash ids. No feedback-view
  // reuse (the wire payload is request-local and never re-enters) and no
  // originalById (the output rebuilds onto the wire, not to AgentMessages).
  function foldStreamCore(ctx: ExtensionContext, stream: BiliMessage[]): CoreFoldResult {
    const sid = sidOf(ctx);
    let slot = coreSlotFor(sid);
    if (slot.preview) {
      debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp: 0, streamLen: stream.length, reason: "preview" });
      slot = freshSlot(slot);
      coreSlots.set(sid, slot);
    }
    const ids = stream.map(coreIdentity);
    let lcp = 0;
    while (lcp < Math.min(ids.length, slot.identities.length) && ids[lcp] === slot.identities[lcp]) lcp++;
    if (lcp < slot.foldedLen) {
      const flip = isViewFlip(slot.foldedLen, lcp);
      debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp, streamLen: stream.length, flip, space: "core" });
      slot = flip ? preserveCompressedSlot(slot) : freshSlot(slot);
      coreSlots.set(sid, slot);
      lcp = 0;
    }

    const coreMessages = stream;
    const config = configFor(ctx);

    // The kernel codecs do not carry tool names on tool-result pieces —
    // protection checks resolve the name through the call pieces.
    const names = toolCallNames(stream);
    const assigned = assignRefs(coreMessages, {
      existing: slot.state.messageRefs,
      nextIndex: highestUsedIndex(slot.state.messageRefs) + 1,
      isProtected: (m) => {
        if (m.role !== "tool" || !m.toolCallId) return false;
        const name = names.get(m.toolCallId);
        if (!name) return false;
        if (name === "compress") return true;
        return (config.protectedTools ?? []).includes(name);
      },
    });
    slot.state = { ...slot.state, messageRefs: assigned.map };

    const isFreshFold = slot.foldedLen === 0;
    const resultTexts = toolResultTextsCore(stream);
    let replayed = 0;
    for (let i = isFreshFold ? 0 : slot.foldedLen; i < stream.length; i++) {
      for (const call of findCompressCallsCore(stream[i]!)) {
        const resultText = resultTexts.get(call.id) ?? "";
        if (resultText.includes("No changes applied")) {
          debug.event("fold-replay-skipped", { sid, callId: call.id });
          continue;
        }
        if (slot.appliedCallIds.has(call.id) || stateHasCompressCall(slot.state, call.id)) continue;
        // Guard verdicts: reject → drop (master semantics); a position-
        // recovered boundary comes back remapped to the CURRENT ref of the
        // piece it recovered — the kernel resolves ranges by ref, and a
        // drifted fold leaves the recorded m-ref dangling (issue #91).
        const verdicts = call.ranges.map((r, ri) => staleRangeCore(r, ri, resultText, coreMessages, i, slot.state.messageRefs.byRef, slot.state.blocks));
        const stale = verdicts.find((v) => v.reject);
        if (stale) {
          debug.event("fold-replay-stale", { sid, callId: call.id, reason: stale.reject });
          // A recovery that FAILED (pos hint present, range still dropped) is
          // exactly the issue-#91 symptom resurfacing — always-on, not just
          // ACP_DEBUG (a plain stale drop without hint stays debug-only, as
          // on master).
          const failed = verdicts.find((v) => v.hint && v.reject);
          if (failed) logWarn("fold", { sid, event: "replay-recovery-failed", callId: call.id, reason: failed!.reject });
          continue;
        }
        const recovered = verdicts.find((v) => v.recovered);
        const ranges = recovered
          ? call.ranges.map((r, ri) => {
              const m = verdicts[ri]!.remap;
              return m ? { ...r, startRef: m.startRef ?? r.startRef, endRef: m.endRef ?? r.endRef } : r;
            })
          : call.ranges;
        if (recovered) {
          logWarn("fold", { sid, event: "replay-recovered", callId: call.id, pos: recovered.recovered!.pos, startIdx: recovered.recovered!.startIdx, endIdx: recovered.recovered!.endIdx });
        }
        try {
          const applied = core.applyCompression({ ranges, messages: coreMessages, state: slot.state, config });
          if (applied.result.errors.length === 0) {
            slot.state = applied.state;
            replayed++;
            debug.event("fold-replay", { sid, callId: call.id, ranges: call.ranges.length });
          } else {
            logWarn("fold", { sid, event: "replay-rejected", callId: call.id, errors: applied.result.errors.slice(0, 3) });
          }
        } catch (e) {
          logWarn("fold", { sid, event: "replay-failed", callId: call.id, error: e instanceof Error ? e.message : String(e) });
        }
        slot.appliedCallIds.add(call.id);
      }
    }
    if (replayed > 0) logWarn("fold", { sid, event: "replayed", calls: replayed });

    slot.identities = ids;
    slot.foldedLen = ids.length;
    slot.coreMessages = coreMessages;

    return { state: slot.state, coreMessages, streamLen: stream.length };
  }

  /** Read the fold slot. Safe WITHOUT the lock only because this returns
   *  `Promise.resolve` over the live slot — fully synchronous, no await
   *  between read and use, so no concurrent fold can interleave. The
   *  read-only tools (decompress/search/acp_status) rely on this invariant;
   *  if this ever becomes genuinely async, take `acquireLock` in every
   *  caller or here (issue #32). */
  function stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }> {
    const sid = sidOf(ctx);
    // The two slot spaces never mix within a session; surface the space the
    // session's CURRENT mode folds in (a mid-session mode flip means the old
    // space's orphaned blocks are deactivated on the next fold, not mixed).
    const slot = slotForMode(ctx, sid);
    return Promise.resolve({ state: slot.state, coreMessages: slot.coreMessages });
  }

  function primeFold(ctx: ExtensionContext): void {
    const sid = sidOf(ctx);
    try {
      // ReadonlySessionManager's type omits buildSessionContext, but the
      // runtime object has it — it builds exactly the view omp feeds the
      // agent on resume. Purely a preview: discarded at the first live
      // event, so a mismatching projection can never leak into live state.
      const sm = ctx.sessionManager as unknown as {
        buildSessionContext?: () => { messages?: AgentMessage[] };
      };
      const view = sm.buildSessionContext?.().messages ?? [];
      if (view.length === 0) return;
      // Provider mode: the authoritative fold runs on the WIRE projection —
      // a different space than this view. The raw view is NOT equivalent:
      // for openai-style payloads the system prompt is a message in the
      // wire body (it takes m00001) and tool entries carry no names (a
      // compress result would not be ref-BLOCKED); folding the raw view puts
      // the fold in a different ref/fingerprint space: stored span
      // fingerprints mismatch, the guard rejects every in-stream replay, and
      // a resumed session shows "Blocks: none" until the first provider
      // request (issue #64). Fold the format-matched wire mirror instead —
      // openai-shape (system first) for openai/ollama payloads, anthropic-
      // shape for anthropic-messages (system stays top-level, out of the
      // fold space). The system text mirrors what before_agent_start puts on
      // the wire (base + ACP block — not yet appended at session_start).
      if (resolveTransformMode(adapterRef, ctx.model) === "provider") {
        const api = (ctx.model as { api?: string } | undefined)?.api ?? "";
        let stream: BiliMessage[];
        if (api === "anthropic-messages") {
          stream = viewToAnthropicCore(view);
        } else {
          const base = getSystemPromptText(ctx);
          const acp = buildAcpSystemPrompt(promptsRef);
          stream = viewToCoreStream(view, base.includes(acp) ? base : `${base}\n\n${acp}`);
        }
        const r = foldStreamCore(ctx, stream);
        coreSlotFor(sid).preview = true;
        logInfo("fold", { sid, event: "prime-fold", msgs: stream.length, wire: true, blocks: r.state.blocks.length });
        return;
      }
      const r = foldStream(ctx, view);
      slotFor(sid).preview = true;
      logInfo("fold", { sid, event: "prime-fold", msgs: view.length, wire: false, blocks: r.state.blocks.length });
    } catch (e) {
      logWarn("fold", { sid, event: "prime-fold-failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  function forgetSession(sid: string): void {
    slots.delete(sid);
    coreSlots.delete(sid);
    locks.delete(sid);
  }

  function slotForMode(ctx: ExtensionContext, sid: string): FoldSlot {
    return resolveTransformMode(adapterRef, ctx.model) === "provider" ? coreSlotFor(sid) : slotFor(sid);
  }

  function commitFoldState(ctx: ExtensionContext, state: CompressionState, toolCallId?: string): void {
    const slot = slotForMode(ctx, sidOf(ctx));
    slot.state = state;
    if (toolCallId) slot.appliedCallIds.add(toolCallId);
  }

  function recordRebuiltOutput(ctx: ExtensionContext, rebuilt: AgentMessage[]): void {
    const slot = slotFor(sidOf(ctx));
    slot.lastRebuiltOutput = rebuilt.map(messageIdentity);
  }

  function noteCompressOutcome(ctx: ExtensionContext, ok: boolean): number {
    const slot = slotForMode(ctx, sidOf(ctx));
    slot.rejectStreak = ok ? 0 : slot.rejectStreak + 1;
    return slot.rejectStreak;
  }

  function rejectStreakFor(ctx: ExtensionContext): number {
    return slotForMode(ctx, sidOf(ctx)).rejectStreak;
  }

  return {
    core,
    get adapter() { return adapterRef; },
    setAdapter: (a) => { adapterRef = a; },
    get prompts() { return promptsRef; },
    setPrompts: (p) => { promptsRef = p; },
    liveContextLimit,
    configFor,
    foldStream,
    foldStreamCore,
    stateFor,
    commitFoldState,
    recordRebuiltOutput,
    noteCompressOutcome,
    rejectStreakFor,
    forgetSession,
    primeFold,
    acquireLock,
  };
}

function staleRange(
  r: { startRef: string; endRef: string },
  rangeIndex: number,
  resultText: string,
  coreMessages: CoreMessage[],
  callIndex: number,
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string | false {
  const start = boundaryRaw(r.startRef, byRef, blocks, "min");
  const end = boundaryRaw(r.endRef, byRef, blocks, "max");
  if (start === "" || end === "") {
    // A vanished MESSAGE ref means the prefix was rewritten → stale. A block
    // ref we cannot resolve is left to the kernel's BoundaryNotFoundError —
    // nested blocks rebuild in replay order and may legitimately be missing
    // only if the call list itself is inconsistent.
    if (!isBlockRef(r.startRef) && !isBlockRef(r.endRef))
      return `unresolved ${r.startRef}..${r.endRef} -> ${start}..${end}`;
    return false;
  }
  // Ranges always cover messages BEFORE the call that issued them — a call
  // resolving to positions at/after itself means the prefix was rewritten.
  if (rawPos(end) > callIndex) return `end ${rawPos(end)} > callIndex ${callIndex}`;
  const m = resultText.match(/\[fp=([0-9a-f,-]+)\]/);
  if (!m) return false;
  const expected = m[1]!.split(",");
  const want = expected[rangeIndex];
  if (want === undefined || want === "-") return false;
  const got = spanFingerprint(coreMessages, start, end);
  if (want !== got) return `fp ${r.startRef}..${r.endRef} want ${want} got ${got} @${start}..${end}`;
  return false;
}
