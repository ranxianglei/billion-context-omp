// Provider-mode wire channel on the kernel codec (acp-kernel/wire): the
// before_provider_request payload is parsed by the kernel's toCore codecs,
// folded through the core-space pipeline (foldStreamCore), and rebuilt with
// coreToAnthropic/coreToOpenai. This replaces the former AgentMessage bridge
// (synthesizeStream/rebuildWirePayload): wire format knowledge now lives
// single-sourced in the kernel, shared with the billion-context proxy.
//
// The fold runs in CONTENT-HASH ID space (deriveMessageId inside the kernel
// codecs) — not the positional p1..pN space the context-mode fold uses. The
// spaces are deliberately disjoint: a session's provider requests and
// context events never share a fold slot, and a mid-session model switch
// (mode flip) re-folds deterministically from the stream, deactivating the
// old space's orphaned blocks (syncBlocks) rather than mixing ids.
//
// Responses bodies are fail-open: the kernel ships a responses codec, but
// the omp pipeline has no responses rebuild path (the proxy covers responses
// at the wire level).

import {
  anthropicToCore,
  coreToAnthropic,
  coreToOpenai,
  detectWireFormat as kernelDetectWireFormat,
  openaiToCore,
  type BiliMessage,
} from "acp-kernel/wire";
import { defaultCountTokens, renderVisibleRefs, type CompressionState } from "acp-kernel";
import { compressToolArgs, stripRefTag } from "./messages.js";
import type { AgentMessage, BlockLike, StreamCompressCall } from "./messages.js";
import { createHash } from "node:crypto";

export type ProviderWireFormat = "anthropic" | "openai";

/** Kernel format detection narrowed to the formats the omp pipeline can
 *  rebuild onto the wire. null = fail-open (pass the payload through). */
export function detectProviderWireFormat(payload: unknown): ProviderWireFormat | null {
  const fmt = kernelDetectWireFormat(payload);
  return fmt === "anthropic" || fmt === "openai" ? fmt : null;
}

export function payloadToCore(
  payload: unknown,
  fmt: ProviderWireFormat,
): { msgs: BiliMessage[]; cacheControls?: Map<string, unknown> } {
  if (fmt === "anthropic") {
    const { msgs, cacheControls } = anthropicToCore(payload as Parameters<typeof anthropicToCore>[0]);
    return { msgs, cacheControls };
  }
  const { msgs } = openaiToCore(payload as Parameters<typeof openaiToCore>[0]);
  return { msgs };
}

export function coreToPayloadMessages(
  msgs: BiliMessage[],
  fmt: ProviderWireFormat,
  cacheControls?: Map<string, unknown>,
): unknown[] {
  return fmt === "anthropic" ? coreToAnthropic(msgs, cacheControls) : coreToOpenai(msgs);
}

/** omp's wire tag contract (issue #66) on top of the kernel's "text-only"
 *  render: the proxy keeps tool content pristine, but omp's nudge ranges
 *  target tool results — the model must be able to cite them by ref, so tag
 *  the tool-result pieces (kernel renderer, format single-sourced). The
 *  kernel's "text-only" also tags assistant text — strip it: the model
 *  echoes tags it sees on its own responses (the contract patchRefTag
 *  enforced in the AgentMessage bridge). Tool-call args stay clean (replay
 *  JSON-parses them). */
export function applyWireTagContract(msgs: BiliMessage[], state: CompressionState): BiliMessage[] {
  const toolResults = msgs.filter((m) => m.contentType === "tool-result");
  const taggedTools =
    toolResults.length > 0
      ? (renderVisibleRefs(toolResults, state, defaultCountTokens, "all") as BiliMessage[])
      : [];
  const bySource = new Map(toolResults.map((m, i) => [m, taggedTools[i]]));
  return msgs.map((m) => {
    if (m.contentType === "tool-result") return bySource.get(m) ?? m;
    if (m.contentType === "text" && m.role === "assistant") return { ...m, text: stripRefTag(m.text ?? "") };
    return m;
  });
}

/** Stable cross-turn identity for the core-space LCP fold. The text carries
 *  our own <acp> ref tags from the previous turn's output (the model sees
 *  them and they ride back in the next request) — stripped before hashing
 *  so re-folds of an unmutated prefix stay incremental. */
export function coreIdentity(msg: BiliMessage): string {
  return JSON.stringify({
    role: msg.role,
    contentType: msg.contentType,
    toolName: msg.toolName ?? null,
    toolCallId: msg.toolCallId ?? null,
    text: stripRefTag(msg.text ?? ""),
  });
}

/** toolCallId → toolName from the stream's tool-call pieces. The kernel
 *  codecs do not carry tool names on tool-result pieces, so protection
 *  checks (compress results stay ref-BLOCKED) resolve the name here. */
export function toolCallNames(msgs: BiliMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of msgs) {
    if (m.contentType === "tool-call" && m.toolCallId && m.toolName) names.set(m.toolCallId, m.toolName);
  }
  return names;
}

export function toolResultTextsCore(msgs: BiliMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const m of msgs) {
    if (m.contentType !== "tool-result" || !m.toolCallId) continue;
    results.set(m.toolCallId, m.text ?? "");
  }
  return results;
}

/** Compress calls carried by a core tool-call piece. Same two shapes as the
 *  AgentMessage stream (direct compress; legacy xd://compress via write),
 *  with the arguments JSON-encoded in the piece's text. */
export function findCompressCallsCore(msg: BiliMessage): StreamCompressCall[] {
  if (msg.contentType !== "tool-call" || !msg.toolName) return [];
  const args = compressToolArgs({ name: msg.toolName, arguments: msg.text });
  if (!args) return [];
  const content = args.content;
  if (!Array.isArray(content)) return [];
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
      compressCallId: msg.toolCallId ?? "",
    });
  }
  return ranges.length > 0 ? [{ id: msg.toolCallId ?? "", ranges }] : [];
}

/** Span fingerprint in content-hash space: hash the content keys of the
 *  exact first/last covered pieces. Boundary ids are pre-resolved (byRef /
 *  block lookup) — unlike the pN-space spanFingerprint there is no
 *  position parsing, ids are unique per piece. */
export function spanFingerprintCore(coreMessages: BiliMessage[], startId: string, endId: string): string {
  const key = (cm: BiliMessage): string => `${cm.role}|${cm.contentType}|${cm.toolName ?? ""}|${(cm.text ?? "").slice(0, 4096)}`;
  const find = (id: string): BiliMessage | undefined => coreMessages.find((cm) => cm.id === id);
  const first = find(startId);
  const last = find(endId);
  if (!first || !last) return "";
  return createHash("sha1").update(`${key(first)}\u0000${key(last)}`).digest("hex").slice(0, 8);
}

/** Resolve a range boundary to the exact id of the piece it names, in
 *  content-hash space. Message refs go through byRef; block refs resolve to
 *  the earliest (min) or latest (max) covered piece by STREAM ORDER
 *  (index in coreMessages — the hash ids carry no position). */
export function boundaryRawCore(
  ref: string,
  byRef: Record<string, string>,
  blocks: BlockLike[],
  coreMessages: BiliMessage[],
  pick: "min" | "max",
): string {
  const raw = byRef[ref];
  if (raw) return raw;
  const m = /^b(\d+)$/i.exec(ref.trim());
  if (!m) return "";
  const block = blocks.find((b) => b.blockId.toLowerCase() === `b${m[1]}`);
  if (!block) return "";
  const idx = (id: string): number => coreMessages.findIndex((cm) => cm.id === (byRef[id] ?? id));
  let best = -1;
  for (const id of block.effectiveMessageIds) {
    const i = idx(id);
    if (i < 0) continue;
    if (best < 0 || (pick === "min" ? i < best : i > best)) best = i;
  }
  return best < 0 ? "" : (coreMessages[best]?.id ?? "");
}

export function staleRangeCore(
  r: { startRef: string; endRef: string },
  rangeIndex: number,
  resultText: string,
  coreMessages: BiliMessage[],
  callIndex: number,
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string | false {
  const start = boundaryRawCore(r.startRef, byRef, blocks, coreMessages, "min");
  const end = boundaryRawCore(r.endRef, byRef, blocks, coreMessages, "max");
  if (start === "" || end === "") {
    if (!/^b\d+$/i.test(r.startRef.trim()) && !/^b\d+$/i.test(r.endRef.trim()))
      return `unresolved ${r.startRef}..${r.endRef} -> ${start}..${end}`;
    return false;
  }
  // The end piece must precede the call that issued it — a rewrite moved
  // the call and the fingerprint check below is meaningless either way.
  const endIndex = coreMessages.findIndex((cm) => cm.id === end);
  if (endIndex > callIndex) return `end idx ${endIndex} > callIndex ${callIndex}`;
  const m = resultText.match(/\[fp=([0-9a-f,-]+)\]/);
  if (!m) return false;
  const expected = m[1]!.split(",");
  const want = expected[rangeIndex];
  if (want === undefined || want === "-") return false;
  const got = spanFingerprintCore(coreMessages, start, end);
  if (want !== got) return `fp ${r.startRef}..${r.endRef} want ${want} got ${got} @${start}..${end}`;
  return false;
}

/** One fingerprint per range for the replay guard, content-hash space
 *  (mirrors rangeFingerprints for the pN space). */
export function rangeFingerprintsCore(
  ranges: Array<{ startRef: string; endRef: string }>,
  coreMessages: BiliMessage[],
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string[] {
  return ranges.map((r) => {
    const start = boundaryRawCore(r.startRef, byRef, blocks, coreMessages, "min");
    const end = start ? boundaryRawCore(r.endRef, byRef, blocks, coreMessages, "max") : "";
    if (start && end) {
      const fp = spanFingerprintCore(coreMessages, start, end);
      if (fp.length > 0) return fp;
    }
    return "-";
  });
}

/** Rebuild the WIRE-SHAPE projection of the persisted session (the mirror
 *  of the host's convertToLlm for openai chat) and parse it with the kernel
 *  codec, so primeFold (provider mode) folds exactly the space the live
 *  provider requests fold: system prompt first (it takes m00001), one
 *  tool-result piece per tool result, thinking dropped (issue #64). */
export function viewToCoreStream(view: AgentMessage[], systemText: string): BiliMessage[] {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: systemText }];
  for (const message of view) {
    const m = message as { role?: string; content?: unknown; toolCallId?: string; summary?: string };
    if (m.role === "user") {
      const text = extractViewText(m.content);
      if (text) messages.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const calls = (blocks as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>).filter(
        (b) => b !== null && typeof b === "object" && b.type === "toolCall",
      );
      const text = extractViewText(m.content);
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name ?? "", arguments: JSON.stringify(c.arguments ?? {}) },
          })),
        });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
    } else if (m.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: extractViewText(m.content) });
    } else {
      const text = extractViewText(m.content) || (typeof m.summary === "string" ? m.summary : "");
      if (text) messages.push({ role: "developer", content: text });
    }
  }
  const { msgs } = openaiToCore({ model: "prime-fold", messages } as Parameters<typeof openaiToCore>[0]);
  return msgs;
}

/** Anthropic-flavoured wire mirror for primeFold: the live anthropic
 *  request carries the system prompt as the TOP-LEVEL `system` field (out
 *  of the fold space) and folds tool results into user messages — mirror
 *  exactly that, or the preview lands in a different ref space than the
 *  live request (issue #64). */
export function viewToAnthropicCore(view: AgentMessage[]): BiliMessage[] {
  const messages: Array<Record<string, unknown>> = [];
  for (const message of view) {
    const m = message as { role?: string; content?: unknown; toolCallId?: string; summary?: string };
    if (m.role === "user") {
      const text = extractViewText(m.content);
      if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
    } else if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const calls = (blocks as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>).filter(
        (b) => b !== null && typeof b === "object" && b.type === "toolCall",
      );
      const text = extractViewText(m.content);
      const content: Array<Record<string, unknown>> = [];
      if (text) content.push({ type: "text", text });
      for (const c of calls) {
        let input: unknown = {};
        try { input = c.arguments && typeof c.arguments === "object" ? c.arguments : JSON.parse(JSON.stringify(c.arguments ?? {})); } catch { input = {}; }
        content.push({ type: "tool_use", id: c.id, name: c.name ?? "", input });
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else if (m.role === "toolResult") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: extractViewText(m.content) }],
      });
    } else {
      const text = extractViewText(m.content) || (typeof m.summary === "string" ? m.summary : "");
      if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
    }
  }
  const { msgs, cacheControls } = anthropicToCore({ model: "prime-fold", messages } as Parameters<typeof anthropicToCore>[0]);
  void cacheControls;
  return msgs;
}

function extractViewText(content: unknown): string {
  // Same projection as the AgentMessage stream path (messages.ts extractText
  // with ref-tag stripping) — kept local so wire-fold stays import-light.
  const clean = (s: string): string => stripRefTag(s);
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b.type === "text" && typeof b.text === "string") parts.push(clean(b.text));
  }
  return parts.join("\n");
}
