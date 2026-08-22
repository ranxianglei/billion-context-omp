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
// Responses bodies (/v1/responses) rebuild through the kernel's responses
// codec: responsesToCore parses the `input` into a layout-preserving
// projection, and patchResponsesInput re-emits the input with the
// compressed pieces patched in place (opaque items like additional_tools
// survive verbatim).

import {
  anthropicToCore,
  coreToAnthropic,
  coreToOpenai,
  coreToResponses,
  detectWireFormat as kernelDetectWireFormat,
  openaiToCore,
  patchResponsesInput,
  responsesToCore,
  type BiliMessage,
  type ResponsesProjection,
  type ResponsesRequestBody,
} from "acp-kernel/wire";
import {
  createRenderRefsNode,
  defaultCountTokens,
  type CompressionState,
  type Config,
  type CoreMessage,
} from "acp-kernel";
import { compressToolArgs, stripRefTag } from "./messages.js";
import type { AgentMessage, BlockLike, StreamCompressCall } from "./messages.js";
import { createHash } from "node:crypto";

export type ProviderWireFormat = "anthropic" | "openai" | "responses";

/** Kernel format detection narrowed to the formats the omp pipeline can
 *  rebuild onto the wire. null = fail-open (pass the payload through).
 *  The kernel's detectWireFormat only recognizes `input` arrays as
 *  "responses"; string inputs (a single user message) are also responses
 *  bodies (the kernel's responsesToCore handles them), so we add that case. */
export function detectProviderWireFormat(payload: unknown): ProviderWireFormat | null {
  const fmt = kernelDetectWireFormat(payload);
  if (fmt === "anthropic" || fmt === "openai" || fmt === "responses") return fmt;
  if (payload !== null && typeof payload === "object" && typeof (payload as { input?: unknown }).input === "string") return "responses";
  return null;
}

export function payloadToCore(
  payload: unknown,
  fmt: ProviderWireFormat,
): { msgs: BiliMessage[]; cacheControls?: Map<string, unknown> } {
  if (fmt === "anthropic") {
    const { msgs, cacheControls } = anthropicToCore(payload as Parameters<typeof anthropicToCore>[0]);
    return { msgs, cacheControls };
  }
  if (fmt === "responses") {
    const { msgs } = responsesToCore(payload as ResponsesRequestBody);
    return { msgs };
  }
  const { msgs } = openaiToCore(payload as Parameters<typeof openaiToCore>[0]);
  return { msgs };
}

/** Parse a responses body into the kernel's projection (layout + core pieces).
 *  The projection is needed for the rebuild (patchResponsesInput) — it carries
 *  the original item layout so the round-trip preserves opaque items and
 *  patches text in place rather than rebuilding from scratch. */
export function responsesProjection(payload: unknown): ResponsesProjection {
  return responsesToCore(payload as ResponsesRequestBody);
}

/** Rebuild the responses `input` from the projection + transformed core
 *  messages. Returns a string when the original input was a string (and the
 *  transform kept it a single user text piece); otherwise an item array. */
export function responsesRebuild(projection: ResponsesProjection, msgs: BiliMessage[]): string | unknown[] {
  return patchResponsesInput(projection, msgs as Parameters<typeof patchResponsesInput>[1]);
}

export function coreToPayloadMessages(
  msgs: BiliMessage[],
  fmt: ProviderWireFormat,
  cacheControls?: Map<string, unknown>,
): unknown[] {
  if (fmt === "responses") {
    // Fallback rebuild (no projection): the main path uses responsesRebuild
    // (patchResponsesInput) which preserves the original layout. This path is
    // only reached when the projection is unavailable — custom tool call ids
    // are unknown, so all tool calls emit as function_call.
    return coreToResponses(msgs as Parameters<typeof coreToResponses>[0]);
  }
  return fmt === "anthropic" ? coreToAnthropic(msgs, cacheControls) : coreToOpenai(msgs);
}

/** Anthropic content-block types the kernel anthropicToCore switch parses.
 *  Anything else (document, redacted_thinking, server_tool_use,
 *  web_search_tool_result, ...) has no case and is silently DROPPED from the
 *  rebuild (issue #3 review). */
const ANTHROPIC_CODEC_BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking", "image"]);

/** OpenAI roles the kernel openaiToCore switch parses. Anything else has no
 *  case and is silently dropped. */
const OPENAI_CODEC_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

export type Representability = { ok: true } | { ok: false; reason: string };

/** Whether the payloadToCore → coreToPayloadMessages round-trip can rebuild
 *  this payload WITHOUT content loss. The sets above mirror the kernel
 *  codec switches; everything they do not parse is dropped or flattened on
 *  the rebuild. Unrepresentable payloads must fail the transform OPEN —
 *  pass through untouched rather than lose content (issue #3 review). */
export function payloadRepresentable(payload: unknown, fmt: ProviderWireFormat): Representability {
  if (fmt === "responses") {
    // The kernel's responsesToCore preserves every input item (core pieces or
    // opaque preamble) and patchResponsesInput rebuilds from the layout — the
    // round-trip is lossless by construction. The only content loss is the
    // opt-in ACP_REASONING_KEEP=none drop, which is intentional.
    const input = (payload as { input?: unknown }).input;
    if (typeof input !== "string" && !Array.isArray(input)) return { ok: false, reason: "responses input neither string nor array" };
    return { ok: true };
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return { ok: false, reason: "messages not an array" };
  for (const message of messages) {
    if (message === null || typeof message !== "object") return { ok: false, reason: "message not an object" };
    const bad = fmt === "anthropic" ? unrepresentableAnthropicMessage(message) : unrepresentableOpenaiMessage(message);
    if (bad) return { ok: false, reason: bad };
  }
  return { ok: true };
}

function unrepresentableAnthropicMessage(message: object): string | null {
  const content = (message as { content?: unknown }).content;
  if (content == null || typeof content === "string") return null;
  if (!Array.isArray(content)) return "content neither string nor block array";
  for (const block of content) {
    const type = (block as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !ANTHROPIC_CODEC_BLOCKS.has(type)) {
      return `anthropic block type ${JSON.stringify(type) ?? "missing"}`;
    }
    if (type === "tool_result") {
      const inner = (block as { content?: unknown }).content;
      if (Array.isArray(inner) && inner.some((c) => (c as { type?: unknown } | null)?.type !== "text")) {
        return "tool_result content carries non-text parts (images are flattened away)";
      }
    }
    if (type === "thinking" && (block as { cache_control?: unknown }).cache_control != null) {
      return "cache_control on a thinking block is not re-attached";
    }
  }
  return null;
}

function unrepresentableOpenaiMessage(message: object): string | null {
  const role = (message as { role?: unknown }).role;
  if (typeof role !== "string" || !OPENAI_CODEC_ROLES.has(role)) {
    return `openai role ${JSON.stringify(role) ?? "missing"}`;
  }
  // Fields the codec round-trip drops entirely (issue #105): a legacy
  // function_call loses the call itself (orphaning its tool result), and
  // audio/annotations/refusal are replayed content some hosts echo back.
  // reasoning_details is NOT here — restoreOpenaiWireFidelity re-attaches it.
  for (const field of ["function_call", "audio", "annotations"] as const) {
    if ((message as Record<string, unknown>)[field] !== undefined) {
      return `openai ${field} field is dropped by the rebuild`;
    }
  }
  const refusal = (message as { refusal?: unknown }).refusal;
  if (refusal !== null && refusal !== undefined) return "openai refusal content is dropped by the rebuild";
  const content = (message as { content?: unknown }).content;
  if (content == null || typeof content === "string") return null;
  if (!Array.isArray(content)) return "content neither string nor part array";
  for (const part of content) {
    if (typeof part === "string") continue;
    const type = (part as { type?: unknown } | null)?.type;
    if (type === "text") continue;
    if (type === "image_url" && role === "user") {
      const url = (part as { image_url?: { url?: unknown } } | null)?.image_url?.url;
      // Multiple data: images are representable: the kernel codec keeps ALL
      // image parts (rawOpenaiContentParts) and re-emits them verbatim. Only
      // non-data: URLs are unrepresentable (the codec cannot rebuild them).
      if (typeof url !== "string" || !url.startsWith("data:")) return "image_url without a data: URL is dropped";
      continue;
    }
    return `openai content part type ${JSON.stringify(type) ?? "missing"}`;
  }
  return null;
}

/** Restore openai wire fields the kernel codec cannot carry (issue #105).
 *  omp's buildParams emits assistant tool-call messages with content "" (a
 *  null trips strict/proxy implementations) and replays encrypted reasoning
 *  as reasoning_details keyed to the tool call ids. The codec rebuild drops
 *  the details and flips "" back to null; this pass re-attaches both so the
 *  post-surgery body keeps the host's wire contract. */
export function restoreOpenaiWireFidelity(originalMessages: unknown[], rebuilt: unknown[]): unknown[] {
  const detailsByCall = new Map<string, unknown[]>();
  for (const message of originalMessages) {
    if (message === null || typeof message !== "object") continue;
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    const details = (message as { reasoning_details?: unknown }).reasoning_details;
    if (!Array.isArray(calls) || !Array.isArray(details) || details.length === 0) continue;
    for (const call of calls) {
      const id = (call as { id?: unknown } | null)?.id;
      if (typeof id === "string" && !detailsByCall.has(id)) detailsByCall.set(id, details);
    }
  }
  return rebuilt.map((message) => {
    if (message === null || typeof message !== "object") return message;
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") return message;
    const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as unknown[]) : [];
    const attached: unknown[] = [];
    for (const call of calls) {
      const id = (call as { id?: unknown } | null)?.id;
      if (typeof id !== "string") continue;
      const d = detailsByCall.get(id);
      if (d) attached.push(...d);
    }
    const hasReasoningField =
      m.reasoning_content !== undefined || m.reasoning !== undefined || m.reasoning_text !== undefined;
    const emptyContent = m.content === null && (calls.length > 0 || hasReasoningField);
    if (attached.length === 0 && !emptyContent) return message;
    const out: Record<string, unknown> = { ...m };
    if (emptyContent) out.content = "";
    if (attached.length > 0) out.reasoning_details = attached;
    return out;
  });
}

const renderRefsAll = createRenderRefsNode("all");

export type WireTagRenderScope = { config: Config; tokenCount: number };

/** omp's wire tag contract (issue #66) on top of the kernel's "text-only"
 *  render: the proxy keeps tool content pristine, but omp's nudge ranges
 *  target tool results — the model must be able to cite them by ref, so tag
 *  the tool-result pieces (kernel renderer, format single-sourced). The
 *  kernel's "text-only" also tags assistant text — strip it: the model
 *  echoes tags it sees on its own responses (the contract patchRefTag
 *  enforced in the AgentMessage bridge). Tool-call args stay clean (replay
 *  JSON-parses them).
 *
 *  Rendering goes through the kernel's render-refs NODE so token counts in
 *  the tags come from the fold state's tokenSnapshot (written once per ref,
 *  reused forever) instead of being recomputed per call; the updated
 *  snapshot is written back into the fold state in place. Tool names are
 *  re-attached from the call pieces first — the codecs drop them on
 *  tool-result pieces and classifyType would render type="tool" where the
 *  context path (and the system-prompt contract) shows the real name. */
export function applyWireTagContract(
  msgs: BiliMessage[],
  state: CompressionState,
  scope: WireTagRenderScope,
): BiliMessage[] {
  const stripAssistantTags = (m: BiliMessage): BiliMessage =>
    m.contentType === "text" && m.role === "assistant" ? { ...m, text: stripRefTag(m.text ?? "") } : m;
  const toolResults = msgs.filter((m) => m.contentType === "tool-result");
  if (toolResults.length === 0) return msgs.map(stripAssistantTags);
  const names = toolCallNames(msgs);
  const named = toolResults.map((m) => (m.toolName ? m : { ...m, toolName: names.get(m.toolCallId ?? "") ?? "tool" }));
  const io = renderRefsAll.run(
    { messages: named, state, effects: {} },
    { config: scope.config, tokenCount: scope.tokenCount, countTokens: defaultCountTokens },
  );
  if (io.state !== state) state.tokenSnapshot = io.state.tokenSnapshot;
  const tagged = io.messages as BiliMessage[];
  const bySource = new Map(toolResults.map((m, i) => [m, tagged[i]]));
  return msgs.map((m) => (m.contentType === "tool-result" ? bySource.get(m) ?? m : stripAssistantTags(m)));
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

/** Content key of a core piece for span fingerprints (issue #91): role,
 *  contentType, toolName and the FIRST 4096 chars of text. The 4096 cap is
 *  deliberate: a host re-serialization that drifts only the tail (beyond
 *  char 4096, e.g. truncation of a long tool output) keeps the key intact,
 *  so the replay guard tells a benign tail drift from a genuine rewrite. */
function corePieceKey(cm: CoreMessage): string {
  return `${cm.role}|${cm.contentType}|${cm.toolName ?? ""}|${(cm.text ?? "").slice(0, 4096)}`;
}

/** Span fingerprint in content-hash space: hash the content keys of the
 *  exact first/last covered pieces. Boundary ids are pre-resolved (byRef /
 *  block lookup) — unlike the pN-space spanFingerprint there is no
 *  position parsing, ids are unique per piece. */
export function spanFingerprintCore(coreMessages: CoreMessage[], startId: string, endId: string): string {
  const find = (id: string): CoreMessage | undefined => coreMessages.find((cm) => cm.id === id);
  const first = find(startId);
  const last = find(endId);
  if (!first || !last) return "";
  return createHash("sha1").update(`${corePieceKey(first)}\u0000${corePieceKey(last)}`).digest("hex").slice(0, 8);
}

/** Index-based span fingerprint (issue #91 replay fallback): hash the content
 *  keys of the pieces AT the given stream positions. The stored fp still
 *  decides keep/drop — the position is only a recovery hint for a drifted
 *  boundary whose content-hash id no longer matches, so a benign tail drift
 *  (first-4096 intact) is kept while a real rewrite mismatches. */
export function spanFingerprintCoreIdx(coreMessages: CoreMessage[], startIdx: number, endIdx: number): string {
  const first = coreMessages[startIdx];
  const last = coreMessages[endIdx];
  if (!first || !last) return "";
  return createHash("sha1").update(`${corePieceKey(first)}\u0000${corePieceKey(last)}`).digest("hex").slice(0, 8);
}

/** Resolve a range boundary to the exact id of the piece it names, in
 *  content-hash space. Message refs go through byRef; block refs resolve to
 *  the earliest (min) or latest (max) covered piece by STREAM ORDER
 *  (index in coreMessages — the hash ids carry no position). */
export function boundaryRawCore(
  ref: string,
  byRef: Record<string, string>,
  blocks: BlockLike[],
  coreMessages: CoreMessage[],
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

/** Resolve a range boundary to its STREAM INDEX in content-hash space. byRef /
 *  block lookup first (the exact piece it names, by array order); on a missed
 *  id (a drift re-hashed the piece so its carried ref dangles) fall back to
 *  the compress-time recorded index — the position hint, issue #91. -1 =
 *  unresolvable. */
export function boundaryIndexCore(
  ref: string,
  byRef: Record<string, string>,
  blocks: BlockLike[],
  coreMessages: CoreMessage[],
  pick: "min" | "max",
  fallbackIdx = -1,
): number {
  const id = boundaryRawCore(ref, byRef, blocks, coreMessages, pick);
  if (id) {
    const i = coreMessages.findIndex((cm) => cm.id === id);
    if (i >= 0) return i;
  }
  return fallbackIdx >= 0 && fallbackIdx < coreMessages.length ? fallbackIdx : -1;
}

/** Structured replay-guard verdict (issue #91, rework): the position
 *  fallback recovers the STREAM INDEX of a drifted boundary, but the kernel
 *  resolves ranges by REF — so when a recorded m-ref dangles, the replay
 *  must re-apply that boundary under the CURRENT ref of the recovered piece.
 *  `remap` carries exactly that (only dangling m-refs are remapped; block
 *  refs resolve themselves inside the kernel and are never touched). */
export type ReplayRangeVerdict = {
  /** Stale: the range must be dropped (master semantics, unchanged). */
  reject?: string;
  /** Dangling m-refs recovered by position, remapped to current refs. */
  remap?: { startRef?: string; endRef?: string };
  /** True when the result text carried a [pos=] pair for this range —
   *  with `reject` set it marks a RECOVERY FAILURE (always logged). */
  hint?: boolean;
  /** Diagnostics — always logged when a recovery happens. */
  recovered?: { pos: string; startIdx: number; endIdx: number };
};

/** Current m-ref of the piece at stream index idx (inverse byRef scan).
 *  "" when the piece has no ref (protected) — the replay must fail closed
 *  rather than hand the kernel a ref it does not know. Replay-time only
 *  (replayed compress calls), so the O(refs) scan stays off the hot path. */
export function refOfPieceCore(coreMessages: BiliMessage[], idx: number, byRef: Record<string, string>): string {
  const id = coreMessages[idx]?.id;
  if (!id) return "";
  for (const [ref, mapped] of Object.entries(byRef)) if (mapped === id) return ref;
  return "";
}

export function staleRangeCore(
  r: { startRef: string; endRef: string },
  rangeIndex: number,
  resultText: string,
  coreMessages: BiliMessage[],
  callIndex: number,
  byRef: Record<string, string>,
  blocks: BlockLike[],
): ReplayRangeVerdict {
  // Compress-time boundary positions (issue #91): the stream index each
  // boundary sat at when the call was recorded. A drift that re-hashes a
  // boundary piece dangles its carried ref — the position recovers it, and
  // the fingerprint below still decides keep/drop.
  const pm = resultText.match(/\[pos=([0-9,-]+)\]/);
  const pair = pm ? pm[1]!.split(",")[rangeIndex] ?? "-" : "-";
  const hinted = pair !== "-";
  const [ps, pe] = pair === "-" ? ["", ""] : pair.split("-");
  const fbStart = ps && ps !== "" ? Number.parseInt(ps, 10) : -1;
  const fbEnd = pe && pe !== "" ? Number.parseInt(pe, 10) : -1;

  // Raw resolution (id → stream index) separately from the fallback, so a
  // dangling m-ref recovered by position can be flagged for remapping.
  const startRaw = boundaryRawCore(r.startRef, byRef, blocks, coreMessages, "min");
  const endRaw = boundaryRawCore(r.endRef, byRef, blocks, coreMessages, "max");
  const rawStartIdx = startRaw ? coreMessages.findIndex((cm) => cm.id === startRaw) : -1;
  const rawEndIdx = endRaw ? coreMessages.findIndex((cm) => cm.id === endRaw) : -1;
  const startIdx = rawStartIdx >= 0 ? rawStartIdx : fbStart >= 0 && fbStart < coreMessages.length ? fbStart : -1;
  const endIdx = rawEndIdx >= 0 ? rawEndIdx : fbEnd >= 0 && fbEnd < coreMessages.length ? fbEnd : -1;
  if (startIdx < 0 || endIdx < 0) {
    if (!/^b\d+$/i.test(r.startRef.trim()) && !/^b\d+$/i.test(r.endRef.trim()))
      return { reject: `unresolved ${r.startRef}..${r.endRef} -> ${startIdx}..${endIdx}`, ...(hinted ? { hint: true } : {}) };
    return {}; // block ref(s): the kernel resolves them itself (master)
  }
  // The end piece must precede the call that issued it — a rewrite moved
  // the call and the fingerprint check below is meaningless either way.
  if (endIdx > callIndex) return { reject: `end idx ${endIdx} > callIndex ${callIndex}`, ...(hinted ? { hint: true } : {}) };
  const m = resultText.match(/\[fp=([0-9a-f,-]+)\]/);
  if (m) {
    const want = m[1]!.split(",")[rangeIndex];
    if (want !== undefined && want !== "-") {
      const got = spanFingerprintCoreIdx(coreMessages, startIdx, endIdx);
      if (want !== got) return { reject: `fp ${r.startRef}..${r.endRef} want ${want} got ${got} @${startIdx}..${endIdx}`, ...(hinted ? { hint: true } : {}) };
    }
  }
  // Remap only the boundaries that actually dangled (m-refs whose recorded id
  // no longer resolves); resolved boundaries keep their recorded ref, block
  // refs are the kernel's to resolve.
  const remap: { startRef?: string; endRef?: string } = {};
  if (/^m\d+$/i.test(r.startRef.trim()) && rawStartIdx < 0) {
    const ref = refOfPieceCore(coreMessages, startIdx, byRef);
    if (!ref) return { reject: `recovered ${r.startRef} @${startIdx} has no ref (protected piece)`, ...(hinted ? { hint: true } : {}) };
    remap.startRef = ref;
  }
  if (/^m\d+$/i.test(r.endRef.trim()) && rawEndIdx < 0) {
    const ref = refOfPieceCore(coreMessages, endIdx, byRef);
    if (!ref) return { reject: `recovered ${r.endRef} @${endIdx} has no ref (protected piece)`, ...(hinted ? { hint: true } : {}) };
    remap.endRef = ref;
  }
  if (!remap.startRef && !remap.endRef) return {};
  return { remap, recovered: { pos: pair, startIdx, endIdx } };
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

/** One boundary-index pair per range for the replay fallback (issue #91),
 *  aligned with rangeFingerprintsCore: the stream index of each range's exact
 *  first/last covered piece at record time ("-1" pair when a boundary can't
 *  be positioned), so the replay can recover a drifted boundary by position. */
export function rangePositionsCore(
  ranges: Array<{ startRef: string; endRef: string }>,
  coreMessages: CoreMessage[],
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string[] {
  return ranges.map((r) => {
    const s = boundaryIndexCore(r.startRef, byRef, blocks, coreMessages, "min");
    const e = s >= 0 ? boundaryIndexCore(r.endRef, byRef, blocks, coreMessages, "max") : -1;
    return s >= 0 && e >= 0 ? `${s}-${e}` : "-";
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
      const typed = blocks as Array<{ type?: string; id?: string; name?: string; arguments?: unknown; thinking?: unknown }>;
      const calls = typed.filter((b) => b !== null && typeof b === "object" && b.type === "toolCall");
      // Thinking blocks ride the openai wire as the `reasoning_content` field
      // (host encoder, zai/replay paths); the kernel codec turns each one into
      // an assistant/reasoning piece. Dropping them shifted every index and
      // fingerprint after a thinking-bearing turn, so restart replay guards
      // rejected the in-stream compress calls and /acp showed no blocks
      // until the first provider request (issue #103).
      const reasoning = typed
        .filter((b) => b !== null && typeof b === "object" && b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0)
        .map((b) => b.thinking as string)
        .join("\n");
      const text = extractViewText(m.content);
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name ?? "", arguments: JSON.stringify(c.arguments ?? {}) },
          })),
        });
      } else if (text || reasoning) {
        messages.push({ role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) });
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
      const typed = blocks as Array<{ type?: string; id?: string; name?: string; arguments?: unknown; text?: unknown; thinking?: unknown; thinkingSignature?: unknown }>;
      // Signed thinking blocks ride the live anthropic wire as {type:"thinking"}
      // blocks; the kernel codec maps each to an assistant/reasoning piece
      // (issue #103 — same parity reasoning as the openai mirror above).
      // Unsigned thinking is demoted to text by the live encoder; mirroring it
      // as a thinking block then diverges, the span guard rejects the replay
      // and the preview falls back to rebuilding at the first request.
      const content: Array<Record<string, unknown>> = [];
      for (const b of typed) {
        if (b === null || typeof b !== "object") continue;
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0) {
          content.push({
            type: "thinking",
            thinking: b.thinking,
            ...(typeof b.thinkingSignature === "string" && b.thinkingSignature ? { signature: b.thinkingSignature } : {}),
          });
        } else if (b.type === "text" && typeof b.text === "string" && stripRefTag(b.text).trim().length > 0) {
          content.push({ type: "text", text: stripRefTag(b.text) });
        } else if (b.type === "toolCall") {
          let input: unknown = {};
          try { input = b.arguments && typeof b.arguments === "object" ? b.arguments : JSON.parse(JSON.stringify(b.arguments ?? {})); } catch { input = {}; }
          content.push({ type: "tool_use", id: b.id, name: b.name ?? "", input });
        }
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

/** Responses-flavoured wire mirror for primeFold: the live /v1/responses
 *  request carries the system prompt in the TOP-LEVEL `instructions` field
 *  (out of the fold space) and the conversation as an `input` item array —
 *  a different ref space than the openai mirror (system as m00001). Folding
 *  the openai shape for a responses model puts the preview in the wrong
 *  ref/fingerprint space: stored span fingerprints mismatch, the guard
 *  rejects every in-stream replay, and a resumed session shows "Blocks:
 *  none" until the first provider request (issue #64, responses variant).
 *  Mirror the responses layout exactly: build the `input` item array from
 *  the view and run it through the kernel's responsesToCore, so the preview
 *  lands in the same ref/fingerprint space as the live request. */
export function viewToResponsesCore(view: AgentMessage[], systemText: string): BiliMessage[] {
  const input: Array<Record<string, unknown>> = [];
  for (const message of view) {
    const m = message as { role?: string; content?: unknown; toolCallId?: string; summary?: string };
    if (m.role === "user") {
      const text = extractViewText(m.content);
      if (text) input.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    } else if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const typed = blocks as Array<{ type?: string; id?: string; name?: string; arguments?: unknown; text?: unknown; thinking?: unknown }>;
      // Emit items in block order (thinking, text, tool calls) so the core
      // message sequence matches the live wire (issue #103 parity).
      for (const b of typed) {
        if (b === null || typeof b !== "object") continue;
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0) {
          input.push({ type: "reasoning", summary: [{ type: "summary_text", text: b.thinking }] });
        } else if (b.type === "text" && typeof b.text === "string" && stripRefTag(b.text).trim().length > 0) {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: stripRefTag(b.text) }] });
        } else if (b.type === "toolCall") {
          let args = "{}";
          try { args = JSON.stringify(b.arguments ?? {}); } catch { args = "{}"; }
          input.push({ type: "function_call", call_id: b.id ?? "", name: b.name ?? "", arguments: args });
        }
      }
    } else if (m.role === "toolResult") {
      input.push({ type: "function_call_output", call_id: m.toolCallId ?? "", output: extractViewText(m.content) });
    } else {
      const text = extractViewText(m.content) || (typeof m.summary === "string" ? m.summary : "");
      if (text) input.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    }
  }
  const { msgs } = responsesToCore({ model: "prime-fold", instructions: systemText, input } as Parameters<typeof responsesToCore>[0]);
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
