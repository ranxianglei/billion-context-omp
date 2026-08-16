import { readFileSync } from "node:fs";
import { homeDir } from "./home.js";
import { join } from "node:path";
import { complete } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { createInitialState, type CoreMessage, type CompressionState, type CompressibleRange, type Prompts } from "acp-kernel";
import { debug, logInfo, logWarn } from "./log.js";
import { streamToCoreMessages, type AgentMessage } from "./messages.js";

// NO timeout: the timer that used to abort the summary call after 60/120s
// was a client-side kill switch for runaway local models. It is gone — the
// compaction is user-initiated and cancellable via the host's own signal
// (opts.signal, wired to omp's compaction abort, e.g. Ctrl+C), which is the
// only legitimate way to stop it. A slow local model writing a 20k-token
// summary is NORMAL, not runaway.
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

export function parseSummary(text: string): string | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const obj = JSON.parse(cleaned) as { summary?: unknown };
    if (typeof obj.summary === "string" && obj.summary.length > 0) return obj.summary;
    return null;
  } catch {
    // Not valid JSON. Two weak-model shapes recover here:
    // 1. plain prose despite the JSON instruction — accept when long enough
    //    (kernel minSummaryLength parity);
    // 2. TRUNCATED JSON — the wrapper opened ("summary" was being written)
    //    but the output cap cut it mid-string. Extract the partial summary
    //    text instead of storing the wrapper debris verbatim.
    const m = /^\{\s*"summary"\s*:\s*"([\s\S]*)$/.exec(cleaned);
    if (m) {
      const partial = m[1]!.replace(/\s*"?\s*\}?\s*$/, "").trim();
      return partial.length >= 50 ? partial : null;
    }
    return cleaned.length >= 50 ? cleaned : null;
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
 *  drop it. On a failed attempt the LLM call is
 *  retried ONCE (stochastic formatting failures recover on a fresh call);
 *  returns null only when the retry also fails — the caller then CANCELS the
 *  compaction (no native fallback: ACP owns compression, host-default
 *  summaries are the failure mode this hook exists to prevent). */
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
    /** Fold-slot messageRefs — when provided, formatSlice renders stable
     *  mNNNNN refs instead of raw pN position ids (issue #14 Minor1: the
     *  model was shown p-ids it must never echo back). */
    messageRefs?: CompressionState["messageRefs"];
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
      formatSlice(slice, opts?.messageRefs ? { ...createInitialState(), messageRefs: opts.messageRefs } : createInitialState());
    const attempt = async (): Promise<string | null> => {
      const response = await run(
        model,
        { systemPrompt: [instructions], messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: ac.signal },
      );
      return parseSummary(
        response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
      );
    };
    let summary: string | null = null;
    try {
      summary = await attempt();
    } catch (e) {
      if (opts?.signal?.aborted || ac.signal.aborted) throw e;
      logWarn("summarize-messages", { event: "attempt-failed", model: label, error: String(e) });
    }
    if (!summary) {
      try {
        summary = await attempt();
        if (summary) logInfo("summarize-messages", { event: "recovered-on-retry", model: label, messages: slice.length });
      } catch (e) {
        if (opts?.signal?.aborted || ac.signal.aborted) throw e;
        logWarn("summarize-messages", { event: "retry-failed", model: label, error: String(e) });
      }
    }
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
    opts?.signal?.removeEventListener("abort", onOuterAbort);
    debug.event("summarize-messages-done", { model: label, messages: slice.length });
  }
}

/** Generate a summary for a message range using the compression model.
 *  Currently unused by the extension (kept as the shared range-summary
 *  surface); null = hard failure, caller decides. */
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
  try {
    const instructions = buildSummaryPrompt(prompts);
    const userText =
      `Message range [${startRef}..${endRef}] (${tokens} tokens, ${slice.length} messages). Compress it:\n\n` +
      formatSlice(slice, state);
    const response = await complete(
      model,
      { systemPrompt: [instructions], messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: ac.signal },
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
    debug.event("summarize-range-done", { span: `${startRef}..${endRef}`, model: label });
  }
}
