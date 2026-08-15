import { readFileSync } from "node:fs";
import { homeDir } from "./home.js";
import { join } from "node:path";
import { complete } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { createInitialState, type CoreMessage, type CompressionState, type CompressibleRange, type Prompts } from "acp-kernel";
import { debug, logInfo, logWarn } from "./log.js";
import { streamToCoreMessages, type AgentMessage } from "./messages.js";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 3000;
const MAX_SLICE_CHARS = 150_000;
const MAX_MSG_CHARS = 4000;

/** Reads `compressModel` from `~/.<CONFIG_DIR_NAME>/acp-omp.json as `provider:modelId`. */
export function readCompressModel(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(homeDir(), CONFIG_DIR_NAME, "acp-omp.json"), "utf8")) as Record<string, unknown>;
    return typeof cfg.compressModel === "string" && cfg.compressModel.length > 0 ? cfg.compressModel : null;
  } catch {
    return null;
  }
}

export function resolveCompressModel<T extends { provider: string; id: string }>(
  registry: { find(provider: string, modelId: string): T | undefined },
  currentModel: T | undefined,
  configured: string | null,
): { model: T; label: string } | null {
  if (configured) {
    const sep = configured.indexOf(":");
    const provider = sep > 0 ? configured.slice(0, sep) : "openai";
    const modelId = sep > 0 ? configured.slice(sep + 1) : configured;
    const model = registry.find(provider, modelId);
    return model ? { model, label: configured } : null;
  }
  return currentModel ? { model: currentModel, label: `${currentModel.provider}:${currentModel.id}` } : null;
}

function refNum(ref: string): number {
  const m = /^m(\d+)$/.exec(ref);
  return m ? parseInt(m[1]!, 10) : -1;
}

export function sliceRange(messages: CoreMessage[], state: CompressionState, startRef: string, endRef: string): CoreMessage[] {
  const lo = refNum(startRef);
  const hi = refNum(endRef);
  return messages.filter((m) => {
    const ref = state.messageRefs.byRaw[m.id];
    if (!ref) return false;
    const n = refNum(ref);
    return n >= lo && n <= hi;
  });
}

/** Pick the compressible span to compress. The kernel's recommended ranges are
 *  small groups (split at user boundaries and protected gaps) that routinely
 *  fall below `minCompressRange`, which the kernel would reject. Seed on the
 *  largest range and expand to adjacent ranges (smallest gap first) until the
 *  span covers enough text — counting every message in the span, matching the
 *  kernel's own validation. Returns null when even the whole compressible set
 *  is below the threshold. */
export function selectRangeSpan(
  ranges: CompressibleRange[],
  messages: CoreMessage[],
  state: CompressionState,
  minChars: number,
): { startRef: string; endRef: string; tokens: number } | null {
  const sorted = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef));
  if (sorted.length === 0) return null;
  let seed = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.tokens > sorted[seed]!.tokens) seed = i;
  }
  const charsOf = (startRef: string, endRef: string): number =>
    sliceRange(messages, state, startRef, endRef).reduce((n, m) => n + (m.text?.length ?? 0), 0);
  let lo = seed;
  let hi = seed;
  let startRef = sorted[lo]!.startRef;
  let endRef = sorted[hi]!.endRef;
  let chars = charsOf(startRef, endRef);
  while (chars < minChars && (lo > 0 || hi < sorted.length - 1)) {
    const leftGap = lo > 0 ? refNum(sorted[lo]!.startRef) - refNum(sorted[lo - 1]!.endRef) : Number.POSITIVE_INFINITY;
    const rightGap = hi < sorted.length - 1 ? refNum(sorted[hi + 1]!.startRef) - refNum(sorted[hi]!.endRef) : Number.POSITIVE_INFINITY;
    if (leftGap <= rightGap) lo--;
    else hi++;
    startRef = sorted[lo]!.startRef;
    endRef = sorted[hi]!.endRef;
    chars = charsOf(startRef, endRef);
  }
  if (chars < minChars) return null;
  return { startRef, endRef, tokens: Math.ceil(chars / 4) };
}

export function formatSlice(slice: CoreMessage[], state: CompressionState): string {
  let out = "";
  let skipped = 0;
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i]!;
    const ref = state.messageRefs.byRaw[m.id] ?? m.id;
    const role = m.role === "tool" ? "tool result" : m.role;
    const raw = m.text ?? "";
    const text = raw.slice(0, MAX_MSG_CHARS);
    const cut = text.length < raw.length;
    const line = `[${ref}] ${role}${m.toolName ? ` (${m.toolName})` : ""}: ${text}${cut ? " …[truncated]" : ""}\n`;
    if (out.length + line.length > MAX_SLICE_CHARS) {
      skipped = slice.length - i;
      break;
    }
    out += line;
  }
  if (skipped > 0) {
    out += `…[truncated: ${skipped} more message(s) in range not shown — cover them in the summary or split the range]\n`;
  }
  return out;
}

/** Positional ids (p1..pN) map onto the session's m-refs 1:1 because the
 *  slice is built from the oldest end of the session — the same numbering
 *  assignRefs derives. Feeding this state to formatSlice makes /compact
 *  summaries quote the same mNNNNN refs the fold view shows, instead of raw
 *  p-ids the model never sees. Split pieces (p2#tc1) share the base
 *  message's ref. */
export function positionalRefState(slice: CoreMessage[]): CompressionState {
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  for (const m of slice) {
    const base = m.id.split("#")[0]!;
    const n = /^p(\d+)$/.exec(base)?.[1];
    if (!n) continue;
    const ref = `m${n.padStart(5, "0")}`;
    byRaw[m.id] = ref;
    byRaw[base] = ref;
    byRef[ref] = base;
  }
  return { ...createInitialState(), messageRefs: { byRaw, byRef } };
}


export function parseSummary(text: string): string | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const obj = JSON.parse(cleaned) as { summary?: unknown };
    if (typeof obj.summary === "string" && obj.summary.length > 0) return obj.summary;
  } catch {
    // never guess — fall back so the caller lets Pi do its native compaction
  }
  return null;
}

/** Build the summary-generation system prompt FROM the kernel's load-bearing
 *  compression rules (the same `Prompts` the compress tool and tier-1
 *  compression use), so /compact honors `acp-omp.json` prompt overrides and stays
 *  consistent with the rest of the ACP pipeline. `/compact` compresses an old
 *  contiguous range, so the tier-1 `howToCompressRules` are the right rule
 *  set (not tier-2/tier-3 distillation rules). */
export function buildSummaryPrompt(prompts: Prompts): string {
  return (
    prompts.compressPhilosophy.trim() +
    "\n\n" +
    prompts.howToCompressRules.trim() +
    "\n\nCompress the message range provided below into ONE dense, self-contained technical summary " +
    "following the rules above. Output ONLY a JSON object: " +
    '{"summary": "..."} ' +
    "where the value is the full summary as a single string."
  );
}

/** Generate ONE summary covering the FULL set of messages omp is about to
 *  discard on /compact (messagesToSummarize + turnPrefixMessages), matching
 *  native compaction semantics — the compaction entry omp stores afterwards
 *  is the durable record, and it truncates everything before firstKeptEntryId
 *  from the LLM view, so the summary must cover all of it. Kernel blocks are
 *  deliberately NOT used here: fold blocks only replay from in-stream
 *  compress tool calls, which the truncation removes. `previousSummary` (an
 *  earlier compaction's summary) is folded in so iterative compactions never
 *  drop it. Returns null on any failure so the caller falls back to Pi's
 *  native compaction. */
export async function summarizeMessages(
  ctx: ExtensionContext,
  messages: AgentMessage[],
  prompts: Prompts,
  configuredModel?: string | null,
  opts?: {
    previousSummary?: string;
    customInstructions?: string;
    signal?: AbortSignal;
    completeFn?: typeof complete;
  },
): Promise<{ summary: string; model: string } | null> {
  const run = opts?.completeFn ?? complete;
  const configured = configuredModel ?? readCompressModel();
  const resolved = resolveCompressModel(ctx.modelRegistry, ctx.model, configured);
  if (!resolved) return null;
  const { model, label } = resolved;
  const slice = streamToCoreMessages(messages);
  const chars = slice.reduce((n, m) => n + (m.text?.length ?? 0), 0);
  if (slice.length === 0 || chars < 1) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    logWarn("summarize-messages", { event: "auth-missing", model: label, error: auth.ok ? null : auth.error });
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onOuterAbort = () => ac.abort();
  opts?.signal?.addEventListener("abort", onOuterAbort);
  try {
    const tokens = Math.ceil(chars / 4);
    let instructions = buildSummaryPrompt(prompts);
    const prev = opts?.previousSummary?.trim();
    const custom = opts?.customInstructions?.trim();
    if (prev) {
      instructions +=
        "\n\nThe conversation below opens with the summary of a PREVIOUS compaction whose content is being discarded with this one — fold everything it contains into the new summary; nothing from it may be lost.";
    }
    if (custom) instructions += `\n\nUser instructions for this compaction: ${custom}`;
    const userText =
      `ENTIRE conversation to compress (${slice.length} messages, ~${tokens} tokens). Compress it:\n\n` +
      formatSlice(slice, positionalRefState(slice));
    const response = await run(
      model,
      { systemPrompt: [instructions], messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: MAX_OUTPUT_TOKENS, signal: ac.signal },
    );
    const summary = parseSummary(
      response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
    );
    if (!summary) {
      logWarn("summarize-messages", { event: "unparseable-summary", model: label, messages: slice.length });
      return null;
    }
    logInfo("summarize-messages", { event: "summary", model: label, messages: slice.length, tokens, summaryLen: summary.length });
    return { summary, model: label };
  } catch (e) {
    logWarn("summarize-messages", { event: "failed", model: label, error: String(e) });
    return null;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onOuterAbort);
    debug.event("summarize-messages-done", { model: label, messages: slice.length });
  }
}

/** Generate a summary for a message range using the compression model. Shared
 *  entry point for the `/compact` handler. Returns null when no model is
 *  usable, the slice is empty, the model is unauthenticated, or the response
 *  is unparseable — the caller then returns `undefined` so Pi falls back to
 *  its native compaction. */
export async function summarizeRange(
  ctx: ExtensionContext,
  messages: CoreMessage[],
  state: CompressionState,
  startRef: string,
  endRef: string,
  prompts: Prompts,
  configuredModel?: string | null,
): Promise<{ summary: string; model: string } | null> {
  const configured = configuredModel ?? readCompressModel();
  const resolved = resolveCompressModel(ctx.modelRegistry, ctx.model, configured);
  if (!resolved) return null;
  const { model, label } = resolved;
  const slice = sliceRange(messages, state, startRef, endRef);
  if (slice.length === 0) return null;
  const tokens = Math.ceil(slice.reduce((n, m) => n + (m.text?.length ?? 0), 0) / 4);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    logWarn("summarize-range", { event: "auth-missing", model: label, error: auth.ok ? null : auth.error });
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const instructions = buildSummaryPrompt(prompts);
    const userText =
      `Message range [${startRef}..${endRef}] (${tokens} tokens, ${slice.length} messages). Compress it:\n\n` +
      formatSlice(slice, state);
    const response = await complete(
      model,
      { systemPrompt: [instructions], messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: MAX_OUTPUT_TOKENS, signal: ac.signal },
    );
    const summary = parseSummary(
      response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
    );
    if (!summary) {
      logWarn("summarize-range", { event: "unparseable-summary", model: label, span: `${startRef}..${endRef}` });
      return null;
    }
    logInfo("summarize-range", { event: "summary", span: `${startRef}..${endRef}`, model: label, tokens, summaryLen: summary.length });
    return { summary, model: label };
  } catch (e) {
    logWarn("summarize-range", { event: "failed", model: label, error: String(e) });
    return null;
  } finally {
    clearTimeout(timer);
    debug.event("summarize-range-done", { span: `${startRef}..${endRef}`, model: label });
  }
}
