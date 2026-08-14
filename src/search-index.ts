/**
 * Search index — bridges pi's session log into acp-kernel's search.
 *
 * Builds SearchDoc[] from:
 *  1. All compression blocks (active AND inactive) — via blockDocs()
 *  2. Historical messages that compression folded into a block summary.
 *
 * Which messages are searchable? Those covered by SOME block's
 * effectiveMessageIds — i.e. messages that were compressed into a summary and
 * are no longer individually visible. Messages still live in context (not in
 * any block) are skipped: the model can already see them.
 *
 * We deliberately do NOT use pi's buildContextEntries for the visible check:
 * ACP prunes messages itself (no pi `compaction` entry is written), so pi
 * reports ALL entries as in-context. The ACP state is the source of truth.
 */

import { blockDocs, messageDocs, type CompressionState, type CoreMessage, type SearchDoc, type MessageInput } from "acp-kernel";
import { estimateTextTokens } from "./tokens.js";

/** All message refs covered by any block (active or inactive). */
function buildCoveredRefs(state: CompressionState): Set<string> {
    const s = new Set<string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) s.add(id);
    }
    return s;
}

/** ref → owning blockId (first/earliest block wins — outermost summary). */
function buildMessageOwnerMap(state: CompressionState): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) {
            if (!m.has(id)) m.set(id, b.blockId);
        }
    }
    return m;
}

export function buildSearchDocs(coreMessages: CoreMessage[], state: CompressionState): SearchDoc[] {
    const covered = buildCoveredRefs(state);
    const ownerMap = buildMessageOwnerMap(state);

    const blockTier = new Map<string, number>();
    for (const b of state.blocks) blockTier.set(b.blockId, b.tier ?? 1);

    const seenRefs = new Set<string>();
    const msgs: MessageInput[] = [];
    for (const cm of coreMessages) {
        if (!cm.id || seenRefs.has(cm.id)) continue;
        if (!covered.has(cm.id)) continue;
        seenRefs.add(cm.id);
        const text = cm.text ?? "";
        if (!text || text.length < 2) continue;
        const ownerBlock = ownerMap.get(cm.id);
        msgs.push({
            ref: cm.id,
            role: cm.role === "tool" ? "tool" : cm.role === "assistant" ? "assistant" : "user",
            text,
            tokens: estimateTextTokens(text),
            blockId: ownerBlock,
            tier: ownerBlock ? blockTier.get(ownerBlock) : undefined,
        });
    }

    return [...blockDocs(state), ...messageDocs(msgs)];
}
