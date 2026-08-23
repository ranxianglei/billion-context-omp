// Provider-mode wire channel on the kernel codec (acp-kernel/wire): the
// before_provider_request payload is parsed by the kernel's toCore codecs,
// folded through the core-space pipeline (foldStreamCore), and rebuilt with
// coreToAnthropic/coreToOpenai. This replaces the former AgentMessage bridge
// (synthesizeStream/rebuildWirePayload): wire format knowledge now lives
// single-sourced in the kernel, shared with the billion-context proxy.
//
// The fold runs in CONTENT-HASH ID space (deriveMessageId inside the kernel
// codecs). The spaces are deliberately disjoint: a session's provider
// requests never share a fold slot, and a mid-session model switch
// re-folds deterministically from the stream, deactivating the
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
  mirrorAnthropicToCore,
  mirrorOpenaiToCore,
  mirrorResponsesToCore,
  openaiToCore,
  patchResponsesInput,
  responsesToCore,
  type BiliMessage,
  type MirrorBlock,
  type MirrorMessage,
  type ResponsesProjection,
  type ResponsesRequestBody,
} from "acp-kernel/wire";
import {
  createRenderRefsNode,
  defaultCountTokens,
  type CompressionState,
  type Config,
} from "acp-kernel";
import { stripRefTag } from "./messages.js";
import type { AgentMessage } from "./messages.js";

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
): { msgs: BiliMessage[]; cacheControls?: Map<string, unknown>; systemText?: string } {
  if (fmt === "anthropic") {
    const { msgs, cacheControls } = anthropicToCore(payload as Parameters<typeof anthropicToCore>[0]);
    return { msgs, cacheControls };
  }
  if (fmt === "responses") {
    const { msgs } = responsesToCore(payload as ResponsesRequestBody);
    return { msgs };
  }
  // openai: the kernel hoists the contiguous leading system/developer prefix
  // out of the fold id space (acp-kernel 0.0.37) — system content is host
  // runtime state, so excluding it from the fingerprints is what makes
  // restart replay converge when the live wire system differs from the
  // primeFold reconstruction. The prefix rides back onto the rebuilt wire
  // via restoreOpenaiSystemPrefix (index.ts), not through the fold.
  const { msgs, systemText } = openaiToCore(payload as Parameters<typeof openaiToCore>[0]);
  return { msgs, systemText };
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

/** Re-attach the leading system/developer messages the kernel hoisted out of
 *  the fold id space (acp-kernel 0.0.37). The rebuilt message list no longer
 *  carries them; without this pass, a compression covering the old system
 *  piece dropped the model's system prompt from the wire entirely (observed
 *  on glm-5.3: post-compression requests went from systemLen 45151 to 0).
 *  Original messages are re-attached verbatim so the host's wire shape —
 *  system vs developer roles, message count, name fields — survives
 *  byte-for-byte. Mirrors the anthropic path, where the top-level system
 *  field never enters the fold at all. */
export function restoreOpenaiSystemPrefix(originalMessages: unknown[], rebuilt: unknown[]): unknown[] {
  let prefixEnd = 0;
  for (const message of originalMessages) {
    const role = (message as { role?: unknown } | null)?.role;
    if (role === "system" || role === "developer") prefixEnd += 1;
    else break;
  }
  if (prefixEnd === 0) return rebuilt;
  return [...originalMessages.slice(0, prefixEnd), ...rebuilt];
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

/**
 * Compress-call detection and replay-guard — moved to acp-kernel
 * (wire/compress-detect, Phase K2 of the protocol consolidation). omp keeps
 * only the host-glue halves: AgentMessage-level detection lives in
 * messages.ts, view mirrors below.
 */
import {
  toolCallNames,
} from "acp-kernel/wire";
export {
  toolCallNames,
  toolResultTextsCore,
  findCompressCallsCore,
  spanFingerprintCore,
  spanFingerprintCoreIdx,
  boundaryRawCore,
  boundaryIndexCore,
  refOfPieceCore,
  staleRangeCore,
  rangeFingerprintsCore,
  rangePositionsCore,
} from "acp-kernel/wire";
export type { ReplayRangeVerdict } from "acp-kernel/wire";

/** Map the persisted session view onto the kernel's neutral MirrorMessage:
 *  the only omp-side shape knowledge left in this module — ref-tag
 *  stripping (a persisted-format concern, messages.ts) and the pi block
 *  types. Every wire-shape rule (system placement, reasoning_content vs
 *  thinking blocks vs summary_text, tool_result folding, whitespace
 *  handling) lives single-sourced in the acp-kernel mirror constructors
 *  (≥0.0.35, PR #114). */
export function toMirrorView(view: AgentMessage[]): MirrorMessage[] {
  const out: MirrorMessage[] = [];
  for (const message of view) {
    const m = message as { role?: string; content?: unknown; toolCallId?: string; summary?: string };
    if (m.role === "user" || m.role === "toolResult") {
      out.push(m.role === "toolResult" ? { role: "toolResult", toolCallId: m.toolCallId ?? "", blocks: viewTextBlocks(m.content) } : { role: "user", blocks: viewTextBlocks(m.content) });
    } else if (m.role === "assistant") {
      const blocks: MirrorBlock[] = [];
      for (const b of Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []) {
        if (b === null || typeof b !== "object") continue;
        if (b.type === "thinking" && typeof b.thinking === "string") {
          blocks.push({ type: "thinking", thinking: b.thinking, ...(typeof b.thinkingSignature === "string" && b.thinkingSignature ? { signature: b.thinkingSignature } : {}) });
        } else if (b.type === "text" && typeof b.text === "string") {
          blocks.push({ type: "text", text: stripRefTag(b.text) });
        } else if (b.type === "toolCall") {
          blocks.push({ type: "toolCall", ...(typeof b.id === "string" ? { id: b.id } : {}), ...(typeof b.name === "string" ? { name: b.name } : {}), ...(b.arguments !== undefined ? { arguments: b.arguments } : {}) });
        }
      }
      out.push({ role: "assistant", blocks });
    } else {
      // developer + custom agent messages ride the wire as out-of-band
      // traffic (kernel meta slot).
      const text = extractViewText(m.content) || (typeof m.summary === "string" ? m.summary : "");
      out.push({ role: "meta", ...(text ? { text } : {}) });
    }
  }
  return out;
}

function viewTextBlocks(content: unknown): MirrorBlock[] {
  if (typeof content === "string") return [{ type: "text", text: stripRefTag(content) }];
  if (!Array.isArray(content)) return [];
  const out: MirrorBlock[] = [];
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: stripRefTag(b.text) });
  }
  return out;
}

function extractViewText(content: unknown): string {
  // Same projection as the AgentMessage stream path (messages.ts extractText
  // with ref-tag stripping) — kept local so wire-fold stays import-light.
  return viewTextBlocks(content).map((b) => (b as { text: string }).text).join("\n");
}

/** primeFold openai/completions mirror (issue #64): system first, thinking
 *  as the `reasoning_content` field (issue #103); inline `<think>` hosts
 *  land in the same identity space via kernel normalization (PR #112). */
export function viewToCoreStream(view: AgentMessage[], systemText: string): BiliMessage[] {
  return mirrorOpenaiToCore(toMirrorView(view), systemText);
}

/** primeFold anthropic/messages mirror (issue #64): system out of the fold
 *  space, tool results folded into user messages, signed thinking blocks. */
export function viewToAnthropicCore(view: AgentMessage[]): BiliMessage[] {
  return mirrorAnthropicToCore(toMirrorView(view));
}

/** primeFold responses mirror (issue #64, responses variant): system in the
 *  top-level `instructions` field, conversation as the `input` item array. */
export function viewToResponsesCore(view: AgentMessage[], systemText: string): BiliMessage[] {
  return mirrorResponsesToCore(toMirrorView(view), systemText);
}
