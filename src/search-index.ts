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

import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";
import { blockDocs, messageDocs, type SearchDoc, type MessageInput, type MessageRole } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import { estimateTextTokens } from "./tokens.js";
import type { CompressionState } from "acp-kernel";

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

function toRole(entry: SessionMessageEntry): MessageRole | null {
    const role = entry.message.role;
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "toolResult") return "tool";
    return null;
}

export function buildSearchDocs(ctx: ExtensionContext, state: CompressionState): SearchDoc[] {
    const sm = ctx.sessionManager;
    const allEntries: SessionEntry[] = sm.getEntries();
    const covered = buildCoveredRefs(state);
    const ownerMap = buildMessageOwnerMap(state);

    const blockTier = new Map<string, number>();
    for (const b of state.blocks) blockTier.set(b.blockId, b.tier ?? 1);

    const seenRefs = new Set<string>();
    const msgs: MessageInput[] = [];
    const processEntry = (entry: SessionEntry): void => {
        if (entry.type !== "message") return;
        const role = toRole(entry as SessionMessageEntry);
        if (!role) return;
        const cores = entriesToCoreMessages([entry]);
        for (const cm of cores) {
            if (!cm.id || seenRefs.has(cm.id)) continue;
            if (!covered.has(cm.id)) continue;
            seenRefs.add(cm.id);
            const text = cm.text ?? "";
            if (!text || text.length < 2) continue;
            const ownerBlock = ownerMap.get(cm.id);
            msgs.push({
                ref: cm.id,
                role,
                text,
                tokens: estimateTextTokens(text),
                blockId: ownerBlock,
                tier: ownerBlock ? blockTier.get(ownerBlock) : undefined,
            });
        }
    };
    for (const entry of allEntries) processEntry(entry);
    for (const id of covered) {
        if (seenRefs.has(id)) continue;
        const baseId = id.split("#")[0]!;
        const entry = sm.getEntry(baseId);
        if (entry) processEntry(entry);
    }

    return [...blockDocs(state), ...messageDocs(msgs)];
}
