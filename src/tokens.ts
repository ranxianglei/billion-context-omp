import { type CoreMessage } from "acp-kernel";

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

/** Union of message ids covered by ACTIVE compression blocks. Messages in
 *  this set are already pruned from the sent view — token estimates for the
 *  sent view skip them (their summary mass is counted by the kernel
 *  breakdown as `summaries`). */
export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

/** Estimate the SENT-VIEW token mass (chars/4, CJK-aware) of a core-message
 *  projection: skips compress tool-calls and messages already covered by
 *  active blocks. This is the same estimation scale as the kernel's
 *  contextBreakdown, so its output can feed nudge decisions and panel lines
 *  without scale mixing. The host footer's session-tree accounting
 *  (provider-anchored, includes compressed originals, never shrinks) is a
 *  DIFFERENT scale and must never drive emergency arbitration for the sent
 *  view — a 180K-context model with a 366K tree reads as "204%" here while
 *  the real sent view is ~5%. */
export function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>): number {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress") continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += estimateTextTokens(m.text ?? "");
  }
  return tokens;
}

export function lastUserMessageId(entries: { id: string; message?: { role?: string } }[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.message?.role === "user") return e.id;
  }
  return undefined;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
