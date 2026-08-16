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
import { boundaryRaw, findCompressCalls, isBlockRef, messageIdentity, rawPos, spanFingerprint, streamToCoreMessages, toolResultTexts, type AgentMessage, type BlockLike } from "./messages.js";

export interface FoldResult {
  state: CompressionState;
  coreMessages: CoreMessage[];
  originalById: Map<string, AgentMessage>;
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
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }>;
  commitFoldState(ctx: ExtensionContext, state: CompressionState, toolCallId?: string): void;
  /** Record the identity sequence of the last rebuilt output so the next
   *  foldStream can recognize omp re-feeding it (issue #52). */
  recordRebuiltOutput(ctx: ExtensionContext, rebuilt: AgentMessage[]): void;
  /** Track the per-session streak of consecutively REJECTED compress calls.
   *  `ok=false` increments and returns the new streak; `ok=true` resets to 0.
   *  A re-fold (rewritten stream prefix) drops the slot and starts at 0. */
  noteCompressOutcome(ctx: ExtensionContext, ok: boolean): number;
  forgetSession(sid: string): void;
  /** Rebuild blocks from the persisted session view at session_start so /acp
 *  and acp_status show them BEFORE the first LLM call of a resumed session.
 *  The slot is marked preview and always re-folded authoritatively at the
 *  first context event (the live stream is the truth source, not the
 *  persisted view). */
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

function stateHasCompressCall(state: CompressionState, callId: string): boolean {
  return state.blocks.some((b) => b.compressCallId === callId);
}

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  const core = createCore({ countTokens: defaultCountTokens });
  const locks = new Map<string, Promise<void>>();
  const slots = new Map<string, FoldSlot>();
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
      debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length });
      slot = freshSlot(slot);
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

  /** Read the fold slot. Safe WITHOUT the lock only because this returns
   *  `Promise.resolve` over the live slot — fully synchronous, no await
   *  between read and use, so no concurrent fold can interleave. The
   *  read-only tools (decompress/search/acp_status) rely on this invariant;
   *  if this ever becomes genuinely async, take `acquireLock` in every
   *  caller or here (issue #32). */
  function stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }> {
    const slot = slotFor(sidOf(ctx));
    return Promise.resolve({ state: slot.state, coreMessages: slot.coreMessages });
  }

  function primeFold(ctx: ExtensionContext): void {
    const sid = sidOf(ctx);
    try {
      // ReadonlySessionManager's type omits buildSessionContext, but the
      // runtime object has it — it builds exactly the view omp feeds the
      // agent on resume. Purely a preview: discarded at the first context
      // event, so a mismatching projection can never leak into live state.
      const sm = ctx.sessionManager as unknown as {
        buildSessionContext?: () => { messages?: AgentMessage[] };
      };
      const stream = sm.buildSessionContext?.().messages ?? [];
      if (stream.length === 0) return;
      const r = foldStream(ctx, stream);
      slotFor(sid).preview = true;
      logInfo("fold", { sid, event: "prime-fold", msgs: stream.length, blocks: r.state.blocks.length });
    } catch (e) {
      logWarn("fold", { sid, event: "prime-fold-failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  function forgetSession(sid: string): void {
    slots.delete(sid);
    locks.delete(sid);
  }

  function commitFoldState(ctx: ExtensionContext, state: CompressionState, toolCallId?: string): void {
    const sid = sidOf(ctx);
    const slot = slotFor(sid);
    slot.state = state;
    if (toolCallId) slot.appliedCallIds.add(toolCallId);
  }

  function recordRebuiltOutput(ctx: ExtensionContext, rebuilt: AgentMessage[]): void {
    const slot = slotFor(sidOf(ctx));
    slot.lastRebuiltOutput = rebuilt.map(messageIdentity);
  }

  function noteCompressOutcome(ctx: ExtensionContext, ok: boolean): number {
    const slot = slotFor(sidOf(ctx));
    slot.rejectStreak = ok ? 0 : slot.rejectStreak + 1;
    return slot.rejectStreak;
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
    stateFor,
    commitFoldState,
    recordRebuiltOutput,
    noteCompressOutcome,
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
