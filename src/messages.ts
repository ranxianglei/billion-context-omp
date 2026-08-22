import { createHash } from "node:crypto";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";
import { SUMMARY_HEADER, salvageParseRanges, type CoreMessage } from "acp-kernel";
import { debug, logWarn } from "./log.js";
type AgentMessage = SessionMessageEntry["message"];
export type { AgentMessage };

type AnyMessage = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  command?: string;
  output?: unknown;
  summary?: string;
};

const REF_TAG_SOURCE = "(?:\x3cacp\\s[^>]*\x3em\\d+\x3c/acp\x3e|\\[m\\d+\\])";
const REF_TAG = new RegExp(`^${REF_TAG_SOURCE}\\s?\\n?`);
const TRAILING_REF_TAG = new RegExp(`\\n*${REF_TAG_SOURCE}\\s*$`);

export function entriesToCoreMessages(entries: SessionEntry[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      // custom_message participates in LLM context per Pi native semantics
      // (session-manager.d.ts) — project it as a user message.
      if (entry.type === "custom_message") {
        const text = extractText(entry.content);
        if (text.length > 0) {
          out.push({ id: entry.id, role: "user", contentType: "text", text });
        }
      }
      continue;
    }
    const cores = projectMessage(entry.message, entry.id);
    out.push(...cores);
  }
  return out;
}

export function streamToCoreMessages(stream: AgentMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  stream.forEach((message, i) => out.push(...projectMessage(message, `p${i + 1}`)));
  return out;
}

/** Map of toolCallId → result text for tool results in the stream. Used to
 *  skip replaying compress calls that were REJECTED live ("No changes
 *  applied") — only calls that actually created blocks should rebuild them. */
export function toolResultTexts(stream: AgentMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of stream) {
    const m = message as AnyMessage;
    if (m.role !== "toolResult") continue;
    const id = m.toolCallId;
    if (typeof id !== "string" || !id) continue;
    results.set(id, extractText(m.content));
  }
  return results;
}

export interface StreamCompressCall {
  id: string;
  ranges: { startRef: string; endRef: string; summary: string; topic?: string; summaryMaxChars?: number; compressCallId: string }[];
}

export function findCompressCalls(message: AgentMessage): StreamCompressCall[] {
  const out: StreamCompressCall[] = [];
  for (const call of allToolCalls((message as AnyMessage).content)) {
    if (!call.id) continue;
    const args = compressToolArgs(call);
    if (!args) continue;
    const content = args.content;
    if (!Array.isArray(content)) continue;
    const ranges: StreamCompressCall["ranges"] = [];
    const callTopic = typeof args.topic === "string" ? args.topic : undefined;
    for (const item of content) {
      const r = item as { startId?: unknown; endId?: unknown; summary?: unknown; topic?: unknown };
      if (typeof r.startId !== "string" || typeof r.endId !== "string" || typeof r.summary !== "string" || r.summary.length === 0) continue;
      ranges.push({
        startRef: r.startId,
        endRef: r.endId,
        summary: r.summary,
        topic: typeof r.topic === "string" ? r.topic : callTopic,
        summaryMaxChars: typeof args.summaryMaxChars === "number" ? args.summaryMaxChars : undefined,
        compressCallId: call.id,
      });
    }
    if (ranges.length > 0) out.push({ id: call.id, ranges });
  }
  return out;
}

/** Extract a compress tool's arguments from a stream toolCall. Two call
 *  shapes exist: (1) top-level — our tools are registered with
 *  loadMode:"essential" so omp's tools.xdev does NOT mount them as xd://
 *  devices; the stream shows name:"compress" directly. (2) legacy xd:// —
 *  sessions recorded before that change (or hosts with tools.xdev forcing
 *  discoverable mounting) invoked compress through the write tool with path
 *  "xd://compress" and the tool args JSON-encoded in the content field. Both
 *  shapes must replay from the stream. Returns normalized compress args
 *  (content array
 *  plus optional topic / summaryMaxChars from wherever they live). */
export function compressToolArgs(call: { name: string; arguments?: unknown }): { content: unknown[]; topic?: unknown; summaryMaxChars?: unknown } | null {
  let args = call.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch {
      // Weak/local models emit truncated or malformed compress arguments
      // ~50% of the time (issue #121). Strict parse used to return null here,
      // silently dropping the call from replay. Route through the kernel's
      // lenient salvage ladder (fences/repairs/truncated-prefix/field-regex)
      // so recoverable calls replay; anything truly unparseable still drops.
      const raw = args as string;
      const sal = salvageParseRanges(raw);
      logWarn("messages", { event: "compress-args-salvage", layer: sal.layer, note: sal.note, ranges: sal.ranges.length });
      if (sal.ranges.length === 0) return null;
      return {
        content: sal.ranges.map((r) => ({ startId: r.startRef, endId: r.endRef, summary: r.summary, ...(r.topic ? { topic: r.topic } : {}) })),
      };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (call.name === "compress") {
    return Array.isArray(a.content) ? { content: a.content, topic: a.topic, summaryMaxChars: a.summaryMaxChars } : null;
  }
  if (call.name !== "write") return null;
  const path = typeof a.path === "string" ? a.path.split("?")[0]!.replace(/\/+$/, "") : "";
  if (path !== "xd://compress") return null;
  let inner: unknown = a.content;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); } catch { return null; }
  }
  if (!inner || typeof inner !== "object") return null;
  if (Array.isArray(inner)) return { content: inner };
  const ia = inner as Record<string, unknown>;
  return Array.isArray(ia.content) ? { content: ia.content, topic: ia.topic, summaryMaxChars: ia.summaryMaxChars } : { content: [ia] };
}

function projectMessage(message: AgentMessage, id: string): CoreMessage[] {
  const msg = message as AnyMessage;
  const role = msg.role;
  if (role === "compactionSummary" || role === "branchSummary") {
    // omp-native compaction/branch records are themselves already-compressed
    // summaries, not raw conversation. Project them with the kernel's
    // synthetic marker so ACP accounts for them exactly like its own block
    // summaries: never compressible or recommended (issue #35), counted
    // under `summaries` in the context breakdown, and always kept in the
    // rebuilt view.
    const text = (msg.summary ?? "").trim();
    if (text.length === 0) return [];
    const label = role === "branchSummary" ? "branch summary" : "compaction summary";
    return [{ id, role: "user", contentType: "text", text: `${SUMMARY_HEADER} — omp ${label}\n${text}` }];
  }
  if (role === "user") {
    return [{ id, role: "user", contentType: "text", text: extractText(msg.content) }];
  }
  if (role === "toolResult") {
    return [{
      id,
      role: "tool",
      contentType: "tool-result",
      toolName: msg.toolName,
      toolCallId: msg.toolCallId,
      text: extractText(msg.content),
    }];
  }
  if (role === "assistant") {
    const calls = allToolCalls(msg.content);
    if (calls.length > 0) {
      const textParts = extractText(msg.content);
      if (calls.length === 1) {
        const call = calls[0]!;
        const argStr = stringifyArgs(call.arguments);
        const text = argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
        return [{ id, role: "assistant", contentType: "tool-call", toolName: call.name, toolCallId: call.id, text }];
      }
      return calls.map((call) => {
        const argStr = stringifyArgs(call.arguments);
        return {
          id: `${id}#${call.id}`,
          role: "assistant" as const,
          contentType: "tool-call" as const,
          toolName: call.name,
          toolCallId: call.id,
          text: argStr || textParts,
        };
      });
    }
    const text = extractText(msg.content);
    // Drop thinking-only turns: empty assistant text makes OpenAI-compatible
    // providers (e.g. GLM) return 400 (no body), which Pi misreads as overflow.
    if (!text.trim()) return [];
    return [{ id, role: "assistant", contentType: "text", text }];
  }
  const customText = extractText(msg.content) || fallbackText(msg);
  return customText.length > 0
    ? [{ id, role: "user", contentType: "text", text: customText }]
    : [];
}

function fallbackText(msg: AnyMessage): string {
  const parts: string[] = [];
  if (msg.command) parts.push(`$ ${msg.command}`);
  const out = extractText(msg.output);
  if (out) parts.push(out);
  if (msg.summary) parts.push(msg.summary);
  return parts.join("\n").trim();
}

function stringifyArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  return safeStringify(args);
}

export function extractText(content: unknown, stripTags = true): string {
  const clean = stripTags ? stripRefTag : (s: string): string => s;
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(clean(b.text));
  }
  return parts.join("\n");
}

export function stripRefTag(text: string): string {
  return text.replace(REF_TAG, "").replace(TRAILING_REF_TAG, "");
}
export function messageIdentity(message: unknown): string {
  return JSON.stringify(normalizeIdentityValue(message, true));
}

const IDENTITY_KEYS = new Set(["role", "content", "toolName", "toolCallId", "command", "output", "summary"]);
function normalizeIdentityValue(value: unknown, message = false): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [normalizeIdentityValue(item)];
      const block = item as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        const stripped = stripRefTag(block.text);
        if (block.text !== stripped && stripped === "") return [];
      }
      return [normalizeIdentityValue(item)];
    });
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (message && !IDENTITY_KEYS.has(key)) continue;
    const item = (value as Record<string, unknown>)[key];
    if (message && key === "content" && typeof item === "string") {
      out[key] = [{ text: stripRefTag(item), type: "text" }];
    } else if (key === "text" && typeof item === "string" && (value as { type?: unknown }).type === "text") {
      out[key] = stripRefTag(item);
    } else {
      out[key] = normalizeIdentityValue(item);
    }
  }
  return out;
}

const TRUNCATION_MARKER = "[truncated for context space]";

export function matchesStoredText(stored: string, visible: string): boolean {
  const marker = `...${TRUNCATION_MARKER} — original ~`;
  const markerStart = visible.indexOf(marker);
  if (markerStart < 2 || visible.slice(markerStart - 2, markerStart) !== "\n\n") return false;
  const suffixMarker = " tokens]...\n\n";
  const suffixStart = visible.indexOf(suffixMarker, markerStart + marker.length);
  if (suffixStart < 0 || !/^\d+$/.test(visible.slice(markerStart + marker.length, suffixStart))) return false;
  const prefix = visible.slice(0, markerStart - 2);
  const suffix = visible.slice(suffixStart + suffixMarker.length);
  return prefix.length > 0 && suffix.length > 0 && stored.startsWith(prefix) && stored.endsWith(suffix);
}

function allToolCalls(content: unknown): { name: string; id: string; arguments?: unknown }[] {
  if (!Array.isArray(content)) return [];
  const calls: { name: string; id: string; arguments?: unknown }[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type === "toolCall" && b.name) calls.push({ name: b.name, id: b.id ?? "", arguments: b.arguments });
  }
  return calls;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function coreOutToAgentMessages(
  coreOut: CoreMessage[],
  originalById: Map<string, AgentMessage>,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  const emittedSplit = new Set<string>();
  const dropped: string[] = [];

  for (const core of coreOut) {
    if (core.id.startsWith("acp_summary_")) continue;

    const hashIdx = core.id.indexOf("#");
    if (hashIdx < 0) {
      const original = originalById.get(core.id);
      if (original) {
        out.push(patchRefTag(original, core));
      } else {
        dropped.push(`${core.id} (${core.role})`);
      }
      continue;
    }

    const baseId = core.id.substring(0, hashIdx);
    if (emittedSplit.has(baseId)) continue;
    emittedSplit.add(baseId);

    const original = originalById.get(baseId);
    if (!original) {
      dropped.push(`${baseId}#${core.id.substring(hashIdx + 1)} (${core.role})`);
      continue;
    }

    const survivingCallIds = new Set(
      coreOut
        .filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
        .map((c) => c.toolCallId)
        .filter((id): id is string => !!id),
    );

    out.push(reconstructToolCallMessage(original, core, survivingCallIds));
  }

  if (dropped.length > 0) {
    debug.event("core-out-dropped", { count: dropped.length, ids: dropped });
  }
  return out;
}

function reconstructToolCallMessage(
  original: AgentMessage,
  firstCore: CoreMessage,
  survivingCallIds: Set<string>,
): AgentMessage {
  const base = original as AnyMessage;
  const match = firstCore.text ? firstCore.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;

  if (base.role === "assistant" || !tag) {
    const rawBlocks2: unknown[] = Array.isArray(base.content)
      ? base.content
      : typeof base.content === "string"
        ? [{ type: "text", text: base.content }]
        : [];
    const filtered2 = rawBlocks2.filter((block) => {
      const b = block as { type?: string; id?: string };
      if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
      return true;
    });
    const peeled2 = peelRefTagBlocks(filtered2);
    return { ...(original as object), content: peeled2 } as AgentMessage;
  }

  const rawBlocks: unknown[] = Array.isArray(base.content)
    ? base.content
    : typeof base.content === "string"
      ? [{ type: "text", text: base.content }]
      : [];

  const filtered = rawBlocks.filter((block) => {
    const b = block as { type?: string; id?: string };
    if (b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
    return true;
  });

  const peeled = peelRefTagBlocks(filtered);
  const lastTextIdx = [...peeled].reverse().findIndex((b) => (b as { type?: string }).type === "text");
  if (lastTextIdx >= 0) {
    const idx = peeled.length - 1 - lastTextIdx;
    const lastBlock = peeled[idx] as { type: string; text: string };
    const baseText = lastBlock.text ?? "";
    peeled[idx] = { ...lastBlock, text: baseText.length > 0 ? `${baseText}\n\n${tag}` : tag };
    return { ...(original as object), content: peeled } as AgentMessage;
  }
  return { ...(original as object), content: [{ type: "text", text: tag }, ...peeled] } as AgentMessage;
}

function patchRefTag(original: AgentMessage, core: CoreMessage): AgentMessage {
  const match = core.text ? core.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;
  if (!tag) return original;
  const base = original as AnyMessage;
  // Skip tag injection for assistant messages — the model sees tags on its own
  // previous responses and echoes them, causing visible tag fragments in the terminal.
  // The model can still reference assistant messages by inferring refs from context.
  if (base.role === "assistant") return original;
  // Honor kernel body mutations (emergency truncation of large tool-results,
  // future rewrites): if core.text's body differs from the original text,
  // rebuild from the kernel body — otherwise truncation never reaches the model.
  const tagCore = tag.replace(/\s+$/, "");
  let bodyStart = tagCore.length;
  if (core.text && core.text.charAt(bodyStart) === "\n") bodyStart += 1;
  const coreBody = core.text ? core.text.slice(bodyStart) : "";
  const originalBody = extractText(base.content);
  const trimEnd = (s: string): string => s.replace(/\s+$/, "");
  if (coreBody && trimEnd(coreBody) !== trimEnd(originalBody)) {
    return rebuildBodyFromCore(original, coreBody, tag);
  }
  const rawBlocks = Array.isArray(base.content)
    ? base.content
    : typeof base.content === "string"
      ? [{ type: "text" as const, text: base.content }]
      : [];
  const peeled = peelRefTagBlocks(rawBlocks);

  const newBlocks = [...peeled];
  let injected = false;
  for (let i = newBlocks.length - 1; i >= 0; i--) {
    const b = newBlocks[i] as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      const baseText = b.text.replace(/\n*$/, "");
      newBlocks[i] = { ...b, text: `${baseText}\n\n${tag}` };
      injected = true;
      break;
    }
  }
  if (injected) {
    return { ...(original as object), content: newBlocks } as AgentMessage;
  }

  return {
    ...(original as object),
    content: [...peeled, { type: "text" as const, text: tag }],
  } as AgentMessage;
}

function rebuildBodyFromCore(
  original: AgentMessage,
  coreBody: string,
  tag: string,
): AgentMessage {
  const base = original as AnyMessage;
  const text = `${coreBody.replace(/\s+$/, "")}\n\n${tag}`;
  if (typeof base.content === "string") {
    return { ...(original as object), content: text } as AgentMessage;
  }
  if (Array.isArray(base.content)) {
    const nonText = base.content.filter((b) => (b as { type?: string }).type !== "text");
    return {
      ...(original as object),
      content: [...nonText, { type: "text" as const, text }],
    } as AgentMessage;
  }
  return { ...(original as object), content: [{ type: "text" as const, text }] } as AgentMessage;
}

function peelRefTagBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      const stripped = stripRefTag(b.text);
      if (stripped.length > 0 || b.text.length === 0) out.push({ ...b, text: stripped });
    } else {
      out.push(block);
    }
  }
  return out;
}

/** 1-based stream position encoded in a p-id ("p7" | "p7#tc1" → 7). */
export function rawPos(rawId: string): number {
  const n = Number.parseInt(rawId.replace(/^p/, "").split("#")[0]!, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Stable fingerprint of a covered span, computed from the deterministic core
 *  projection: hash of the first and last covered CoreMessages' content
 *  fields. Written into the compress tool's success result (which lives in
 *  the stream) and re-verified on fold replay — if a host-side rewrite
 *  (compaction, edit) shifted positions, the fingerprint mismatches and the
 *  call is skipped instead of silently compressing the wrong messages.
 *  Boundaries bind to the EXACT piece the ref names (parallel tool calls
 *  split one stream message into several pieces sharing a position —
 *  hashing "whatever is at that position" is position-collision-fragile). */
export function spanFingerprint(coreMessages: CoreMessage[], startId: string, endId: string): string {
  const key = (cm: CoreMessage): string => `${cm.role}|${cm.contentType}|${cm.toolName ?? ""}|${(cm.text ?? "").slice(0, 4096)}`;
  const find = (id: string): CoreMessage | undefined => {
    const exact = coreMessages.find((cm) => cm.id === id);
    if (exact) return exact;
    const pos = rawPos(id);
    if (pos === 0) return undefined;
    return coreMessages.find((cm) => rawPos(cm.id ?? "") === pos);
  };
  const first = find(startId);
  const last = find(endId);
  if (!first || !last) return "";
  return createHash("sha1").update(`${key(first)}\u0000${key(last)}`).digest("hex").slice(0, 8);
}

export interface BlockLike {
  blockId: string;
  effectiveMessageIds: string[];
}

export function isBlockRef(ref: string): boolean {
  return /^b\d+$/i.test(ref.trim());
}

/** Resolve a range boundary ref to the EXACT raw id of the piece it names.
 *  Message refs (mNNNNN) go through byRef; block refs (bN) resolve to the
 *  earliest (min) or latest (max) covered message's raw id. "" = unresolved. */
export function boundaryRaw(ref: string, byRef: Record<string, string>, blocks: BlockLike[], pick: "min" | "max"): string {
  const raw = byRef[ref];
  if (raw) return raw;
  const m = /^b(\d+)$/i.exec(ref.trim());
  if (!m) return "";
  const block = blocks.find((b) => b.blockId.toLowerCase() === `b${m[1]}`);
  if (!block) return "";
  const ids = block.effectiveMessageIds.filter((id) => rawPos(byRef[id] ?? id) > 0);
  if (ids.length === 0) return "";
  const pos = (id: string): number => rawPos(byRef[id] ?? id);
  return pick === "min" ? ids.reduce((a, b) => (pos(a) <= pos(b) ? a : b)) : ids.reduce((a, b) => (pos(a) >= pos(b) ? a : b));
}


/** One fingerprint per range (never filtered, "-" for unresolvable
 *  boundaries) so replay-side index lookup stays aligned even for mixed
 *  message/block boundary batches. Written into the compress tool result. */
export function rangeFingerprints(
  ranges: Array<{ startRef: string; endRef: string }>,
  coreMessages: CoreMessage[],
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string[] {
  return ranges.map((r) => {
    const start = boundaryRaw(r.startRef, byRef, blocks, "min");
    const end = start ? boundaryRaw(r.endRef, byRef, blocks, "max") : "";
    if (start && end) {
      const fp = spanFingerprint(coreMessages, start, end);
      if (fp.length > 0) return fp;
    }
    return "-";
  });
}
