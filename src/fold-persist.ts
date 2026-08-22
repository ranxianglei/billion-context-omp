import path from "node:path";
import { StateStore, mergeCompressionState, type PersistedEnvelope } from "acp-kernel/persist";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { homeDir } from "./home.js";
import { logInfo, logWarn } from "./log.js";

/**
 * Fold-state persistence: the restart checkpoint for the core-space fold
 * (issue #130).
 *
 * The live fold is the truth source — it runs on the WIRE payload at
 * `before_provider_request`, and that payload is request-local: at
 * session_start omp does not have it yet. primeFold mirrors the fold from
 * the session view instead, but the view→wire projection is host-owned
 * (pi-ai's transformMessages + convertMessages: cross-model thinking
 * demotion, developer→user mapping, empty-message drops). A mirror that
 * guesses that projection lands in a different ref/fingerprint space, every
 * in-stream compress replay fails the span guard, and /acp lies
 * "Blocks: none" until the first provider request refolds the real wire
 * (observed live: 1988 mirror pieces vs 1692 live pieces, 0/14 anchors).
 *
 * The fix: checkpoint the LIVE fold slot — identities in the wire's own
 * content-hash space (coreIdentity is a pure function of content, so the
 * next process recomputes the same ids from the same wire), the block
 * ledger, assigned refs, and the folded stream itself. On restart the slot
 * is restored directly; the first live fold then validates it through the
 * normal LCP check instead of trusting the mirror.
 *
 * Storage MECHANISM lives in `acp-kernel/persist` (StateStore: atomic
 * write, rename retries, debounce, per-id serialization, corrupt-tolerant
 * load). This module is omp POLICY: where state lives, what shape it has,
 * when it is saved.
 *
 * The store never deletes files: sessions outlive processes, and cleanup is
 * a downstream/user policy decision (kernel position — see store.ts).
 */

/** Snapshot schema. Bump when the payload shape changes; older snapshots
 * fail validation on load and the restart falls back to the primeFold
 * mirror (fail-open, blocks rebuilt from the stream at the first live
 * fold). */
export const FOLD_SCHEMA_VERSION = 1;

/** On-disk snapshot of a live FoldSlot (runtime.ts). `preview` is not
 * persisted — only live folds are checkpointed; `appliedCallIds` is a Set
 * in memory and a plain array on disk. */
export interface FoldSnapshot {
  identities: string[];
  foldedLen: number;
  state: CompressionState;
  coreMessages: CoreMessage[];
  appliedCallIds: string[];
  rejectStreak: number;
}

/** Restore shape: everything a FoldSlot carries except `preview` (the
 * runtime sets it — restored slots are live, not mirror junk). */
export interface RestoredFoldSlot {
  identities: string[];
  foldedLen: number;
  state: CompressionState;
  coreMessages: CoreMessage[];
  appliedCallIds: Set<string>;
  rejectStreak: number;
}

/** Persisted-state directory. Default `~/.omp/acp-omp-folds/` (sibling of
 * the acp-omp log), overridable per adapter config or env for tests and
 * sandboxes. */
export function foldPersistDir(configured?: string): string {
  return configured ?? process.env.ACP_OMP_FOLD_DIR ?? path.join(homeDir(), CONFIG_DIR_NAME, "acp-omp-folds");
}

function isFoldSnapshot(v: unknown): v is FoldSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    Array.isArray(p.identities) &&
    typeof p.foldedLen === "number" &&
    typeof p.state === "object" &&
    p.state !== null &&
    Array.isArray((p.state as { blocks?: unknown }).blocks) &&
    Array.isArray(p.coreMessages) &&
    Array.isArray(p.appliedCallIds) &&
    typeof p.rejectStreak === "number"
  );
}

/** Build the store for a directory. `enabled: false` (persistence off in
 * adapter config) keeps the store a silent no-op — loads miss, writes drop. */
export function createFoldStore(dir: string, enabled: boolean): StateStore<FoldSnapshot> {
  return new StateStore<FoldSnapshot>({
    dir,
    enabled,
    version: FOLD_SCHEMA_VERSION,
    log: (level, msg) => {
      if (level === "info") logInfo("fold-persist", { event: msg });
      else logWarn("fold-persist", { event: msg });
    },
    validate: (envelope: PersistedEnvelope<FoldSnapshot>) => isFoldSnapshot(envelope.payload),
  });
}

/** Rehydrate a validated snapshot into slot fields. The state runs through
 * the kernel's mergeCompressionState so a snapshot written by an older
 * version with missing fields still loads (forward-compat fill). */
export function restoreFoldSnapshot(payload: FoldSnapshot): RestoredFoldSlot {
  return {
    identities: payload.identities,
    foldedLen: payload.foldedLen,
    state: mergeCompressionState(payload.state),
    coreMessages: payload.coreMessages,
    appliedCallIds: new Set(payload.appliedCallIds),
    rejectStreak: payload.rejectStreak,
  };
}
