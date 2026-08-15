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
  /** Messages dropped from the live view by a host-side rewrite (native
   * compaction, rewind): kept restorable for decompress under archived ids
   * (a1..aN) so blocks survive even though their compress calls left the
   * stream. Never fed to processTurn. */
  archive: CoreMessage[];
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
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[]; archive: CoreMessage[] }>;
  commitFoldState(ctx: ExtensionContext, state: CompressionState, toolCallId?: string): void;
  forgetSession(sid: string): void;
  acquireLock(sid: string): Promise<() => void>;
  /** Rebuild blocks from the persisted session view at session_start so /acp
 *  and acp_status show them BEFORE the first LLM call of a resumed session.
 *  The slot is marked preview; the first live context event keeps it when the
 *  projection matches the live stream, otherwise carries it over (the live
 *  stream is the truth source, not the persisted view). */
  primeFold(ctx: ExtensionContext): void;
}
function freshSlot(): FoldSlot {
  return { identities: [], foldedLen: 0, preview: false, state: createInitialState(), coreMessages: [], appliedCallIds: new Set(), archive: [] };
}

/** Survive a host-side prefix rewrite (native `/compact` truncates the LLM
 * view at firstKeptEntryId, removing the in-stream compress calls blocks
 * replay from — #19). The old stream is archived under `a`-prefixed ids and
 * the block ledger is carried over: blocks stay findable/decompressable, m-refs
 * keep their meaning, and new blocks continue the b-id sequence. Kernel
 * syncBlocks deactivates carried blocks whose covered messages left the live
 * view, so they never prune or tag anything. */
function carryOverFold(old: FoldSlot): FoldSlot {
  const offset = old.archive.length;
  const remapId = (id: string): string => {
    const m = /^p(\d+)(.*)$/.exec(id);
    return m ? `a${offset + Number(m[1])}${m[2]}` : id;
  };
  const byRaw: Record<string, string> = {};
  for (const [raw, ref] of Object.entries(old.state.messageRefs.byRaw)) byRaw[remapId(raw)] = ref;
  const byRef: Record<string, string> = {};
  for (const [ref, raw] of Object.entries(old.state.messageRefs.byRef)) byRef[ref] = remapId(raw);
  return {
    identities: [],
    foldedLen: 0,
    preview: false,
    state: {
      ...old.state,
      messageRefs: { byRaw, byRef },
      blocks: old.state.blocks.map((b) => ({
        ...b,
        directMessageIds: b.directMessageIds.map(remapId),
        effectiveMessageIds: b.effectiveMessageIds.map(remapId),
        directBlockIds: [...b.directBlockIds],
      })),
    },
    coreMessages: [],
    appliedCallIds: new Set(old.appliedCallIds),
    archive: [...old.archive, ...old.coreMessages.map((m) => ({ ...m, id: remapId(m.id) }))],
  };
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
    const ids = stream.map(messageIdentity);
    let lcp = 0;
    while (lcp < Math.min(ids.length, slot.identities.length) && ids[lcp] === slot.identities[lcp]) lcp++;
    if (slot.preview && lcp < slot.identities.length) {
      // The primed projection diverges from the live stream. A full prefix
      // rewrite (first message replaced — native compaction before the first
      // live event) carries the primed blocks over (#19); any other
      // divergence falls back to a scratch re-fold so the preview never
      // leaks.
      if (lcp === 0 && slot.foldedLen > 0) {
        debug.event("fold-carryover", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length, reason: "preview-divergence" });
        slot = carryOverFold(slot);
        slots.set(sid, slot);
        lcp = 0;
      } else {
        debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length, reason: "preview-divergence" });
        slot = freshSlot();
        slots.set(sid, slot);
      }
      slot.preview = false;
    } else if (slot.preview) {
      // The live stream extends the primed prefix — promote the preview to
      // authoritative; incremental folding continues from foldedLen.
      slot.preview = false;
    } else if (lcp < slot.foldedLen) {
      if (lcp > 0) {
        // Tail rewind (retry): the prefix is intact and only the tail
        // changed. Re-fold from scratch — position-based refs stay
        // deterministic for the untouched prefix.
        debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length });
        slot = freshSlot();
        slots.set(sid, slot);
      } else {
        // Host-side prefix rewrite (native /compact): the live stream no
        // longer contains the pre-truncation compress calls, so a scratch
        // re-fold would erase every block (#19). Archive the old stream and
        // carry the block ledger over instead.
        debug.event("fold-carryover", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length });
        slot = carryOverFold(slot);
        slots.set(sid, slot);
        lcp = 0;
      }
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

  function stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[]; archive: CoreMessage[] }> {
    const slot = slotFor(sidOf(ctx));
    return Promise.resolve({ state: slot.state, coreMessages: slot.coreMessages, archive: slot.archive });
  }

  function primeFold(ctx: ExtensionContext): void {
    const sid = sidOf(ctx);
    try {
      // Replay from the FULL branch, not the collapsed context view: after a
      // native compaction the collapsed view omits the pre-truncation
      // compress calls, and blocks would be unrecoverable on resume. The
      // branch is append-only and contains every entry ever appended.
      // ReadonlySessionManager's type omits buildSessionContext (the legacy
      // fallback below); getBranch is typed.
      const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
      const stream: AgentMessage[] = [];
      for (const entry of branch) {
        if (entry.type === "message" && entry.message) stream.push(entry.message);
      }
      if (stream.length === 0) {
        const build = (ctx.sessionManager as unknown as { buildSessionContext?: () => { messages?: AgentMessage[] } }).buildSessionContext;
        stream.push(...(build?.().messages ?? []));
      }
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
