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
import { debug, logWarn } from "./log.js";
import { findCompressCalls, messageIdentity, rawPos, spanFingerprint, streamToCoreMessages, toolResultTexts, type AgentMessage } from "./messages.js";

export interface FoldResult {
  state: CompressionState;
  coreMessages: CoreMessage[];
  originalById: Map<string, AgentMessage>;
  streamLen: number;
}

interface FoldSlot {
  identities: string[];
  foldedLen: number;
  state: CompressionState;
  coreMessages: CoreMessage[];
  appliedCallIds: Set<string>;
}

export interface AcpRuntime {
  core: CompressionCore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  prompts: Prompts;
  setPrompts(prompts: Prompts): void;
  markNudgeShown(turnKey: string): void;
  nudgeShownFor(turnKey: string): boolean;
  clearNudgeTracking(): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  foldStream(ctx: ExtensionContext, stream: AgentMessage[]): FoldResult;
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }>;
  commitFoldState(ctx: ExtensionContext, state: CompressionState, toolCallId?: string): void;
  forgetSession(sid: string): void;
  acquireLock(sid: string): Promise<() => void>;
}

function freshSlot(): FoldSlot {
  return { identities: [], foldedLen: 0, state: createInitialState(), coreMessages: [], appliedCallIds: new Set() };
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
  const nudgeShownTurns = new Set<string>();

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
    if (lcp < slot.foldedLen) {
      debug.event("fold-refold", { sid, foldedLen: slot.foldedLen, lcp, streamLen: ids.length });
      slot = freshSlot();
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
        const stale = call.ranges.some((r, ri) => staleRange(r, ri, resultText, coreMessages, i, slot.state.messageRefs.byRef));
        if (stale) {
          debug.event("fold-replay-stale", { sid, callId: call.id });
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

  function stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }> {
    const slot = slotFor(sidOf(ctx));
    return Promise.resolve({ state: slot.state, coreMessages: slot.coreMessages });
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
    markNudgeShown: (k) => { nudgeShownTurns.add(k); },
    nudgeShownFor: (k) => nudgeShownTurns.has(k),
    clearNudgeTracking: () => { nudgeShownTurns.clear(); },
    liveContextLimit,
    configFor,
    foldStream,
    stateFor,
    commitFoldState,
    forgetSession,
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
): boolean {
  const startRaw = byRef[r.startRef];
  const endRaw = byRef[r.endRef];
  if (!startRaw || !endRaw) return true;
  const start = rawPos(startRaw);
  const end = rawPos(endRaw);
  // Ranges always cover messages BEFORE the call that issued them — a call
  // resolving to positions at/after itself means the prefix was rewritten.
  if (start === 0 || end === 0 || end > callIndex) return true;
  const m = resultText.match(/\[fp=([0-9a-f,]+)\]/);
  if (!m) return false;
  const expected = m[1]!.split(",");
  const fp = spanFingerprint(coreMessages, startRaw, endRaw);
  if (expected[rangeIndex] === undefined) return !expected.includes(fp);
  return expected[rangeIndex] !== fp;
}
