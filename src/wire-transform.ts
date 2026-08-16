import type { AgentMessage } from "./messages.js";
import { extractText } from "./messages.js";
import type { AnthropicRequestBody } from "acp-kernel/wire";

// Provider-mode transformation (issue #52's architectural answer): instead of
// rewriting the context event (whose output omp re-feeds as INPUT through its
// recap/subagent pipelines — the two-truth-source defect), we leave the agent
// array untouched and perform the prune/summary/nudge surgery on the WIRE
// payload at `before_provider_request`. The wire body is request-local (it
// only flows to fetch), so nothing we do here can ever be re-fed as input.
//
// Pipeline: payload → synthesizeStream (wire → omp AgentMessage shapes, with
// back-pointers to the source wire messages) → the EXISTING fold/processTurn/
// nudge machinery (index.ts runContextTransform — untouched semantics) →
// rebuildWirePayload (survivors reuse the ORIGINAL wire message objects —
// byte-fidelity for everything that is not pruned; only summaries/nudges are
// synthesized). Unknown formats pass through untouched (fail-open).

export type WireFormat = "anthropic" | "openai" | "unknown";

/** Marks a synthesized agent's index in the synthesized stream. Enumerable
 *  symbol → survives the object spreads in patchRefTag /
 *  reconstructToolCallMessage, so rebuilt survivors can be mapped back to
 *  their source wire message. */
const AI = Symbol("acp.streamIndex");

interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  cache_control?: unknown;
  [k: string]: unknown;
}
interface AnthropicWireMessage {
  role: string;
  content: string | AnthropicBlock[];
  [k: string]: unknown;
}
interface OpenAIWireMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface SynthesisResult {
  stream: AgentMessage[];
  back: Array<{ wi: number; kind: "text" | "toolCall" | "toolResult" }>;
  format: WireFormat;
}

export function detectWireFormat(payload: unknown): WireFormat {
  if (payload === null || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;
  const messages = p.messages;
  if (!Array.isArray(messages)) return "unknown";
  if ("system" in p || "anthropic_version" in p) return "anthropic";
  for (const m of messages as Array<Record<string, unknown>>) {
    if (m === null || typeof m !== "object") continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const b of c as Array<Record<string, unknown>>) {
        if (b && typeof b === "object" && typeof b.type === "string") {
          if (b.type === "tool_use" || b.type === "tool_result" || b.type === "thinking") return "anthropic";
          if (b.type === "text" && "cache_control" in b) return "anthropic";
        }
      }
    }
    if (Array.isArray(m.tool_calls)) return "openai";
    if (m.role === "tool" && typeof m.tool_call_id === "string") return "openai";
    if (m.role === "system" || m.role === "developer") return "openai";
  }
  // Both formats have role+messages; default to openai chat (string contents,
  // no anthropic markers) — the safer generic guess for OpenAI-compatible
  // endpoints (GLM, DeepSeek, vLLM, ...), which is also the dominant local
  // setup in the field.
  return "openai";
}

function anthropicBlocks(m: AnthropicWireMessage): AnthropicBlock[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
}

const assistantBase = () => ({
  api: "anthropic" as const,
  provider: "anthropic" as const,
  model: "wire",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const,
  timestamp: Date.now(),
});

export function synthesizeStream(payload: unknown, format: WireFormat): SynthesisResult {
  // NOTE: do NOT filter invalid entries here — back-pointers (wi) must stay
  // aligned with the original payload indices for rebuildWirePayload.
  const messages = (payload as { messages?: unknown[] }).messages ?? [];
  const stream: AgentMessage[] = [];
  const back: SynthesisResult["back"] = [];
  const push = (msg: AgentMessage, wi: number, kind: "text" | "toolCall" | "toolResult") => {
    (msg as unknown as Record<symbol, unknown>)[AI] = stream.length;
    stream.push(msg);
    back.push({ wi, kind });
  };

  if (format === "anthropic") {
    // tool_use id → name, for toolResult synthesis (isProtected detection).
    const toolNames = new Map<string, string>();
    for (const raw of messages) {
      if (raw === null || typeof raw !== "object") continue;
      const m = raw as AnthropicWireMessage;
      if (m.role !== "assistant") continue;
      for (const b of anthropicBlocks(m)) if (b.type === "tool_use" && b.id) toolNames.set(b.id, b.name ?? "");
    }
    messages.forEach((raw, wi) => {
      if (raw === null || typeof raw !== "object") return;
      const m = raw as AnthropicWireMessage;
      const blocks = anthropicBlocks(m);
      if (m.role === "user") {
        // A user message may carry tool_result blocks (omp folds tool results
        // into user turns on the wire). Each tool_result becomes its own omp
        // toolResult agent; text parts merge into one user agent — mirroring
        // the shapes projectMessage already handles.
        let texts: string[] = [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
          else if (b.type === "tool_result") {
            if (texts.length > 0) { push({ role: "user", content: texts.map((t) => ({ type: "text", text: t })), timestamp: Date.now() } as AgentMessage, wi, "text"); texts = []; }
            const trText = typeof b.content === "string" ? b.content : Array.isArray(b.content)
              ? (b.content as Array<{ type?: string; text?: string }>).map((c) => c.text ?? "").join("\n")
              : "";
            push({
              role: "toolResult",
              content: [{ type: "text", text: trText }],
              toolName: toolNames.get(b.tool_use_id ?? "") ?? "",
              toolCallId: b.tool_use_id ?? "",
              isError: b.is_error === true,
              timestamp: Date.now(),
            } as unknown as AgentMessage, wi, "toolResult");
          }
        }
        if (texts.length > 0) push({ role: "user", content: texts.map((t) => ({ type: "text", text: t })), timestamp: Date.now() } as AgentMessage, wi, "text");
        return;
      }
      if (m.role === "assistant") {
        const content: Array<Record<string, unknown>> = [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) content.push({ type: "text", text: b.text });
          else if (b.type === "tool_use") content.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.input ?? {} });
        }
        if (content.length > 0) push({ role: "assistant", ...assistantBase(), content } as unknown as AgentMessage, wi, "toolCall");
        return;
      }
      // system inside messages (rare for anthropic) — synthesize as user text
      // so position accounting stays aligned; never compressible in practice.
      const t = blocks.map((b) => (typeof b.text === "string" ? b.text : "")).join("\n");
      if (t) push({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() } as AgentMessage, wi, "text");
    });
    return { stream, back, format };
  }

  // openai chat
  messages.forEach((raw, wi) => {
    if (raw === null || typeof raw !== "object") return;
    const m = raw as OpenAIWireMessage;
    const textOf = (): string => {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return (c as Array<{ type?: string; text?: string }>).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("\n");
      return "";
    };
    if (m.role === "system" || m.role === "developer") {
      const t = textOf();
      if (t) push({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() } as unknown as AgentMessage, wi, "text");
      return;
    }
    if (m.role === "tool") {
      push({
        role: "toolResult",
        content: [{ type: "text", text: textOf() }],
        toolName: "",
        toolCallId: m.tool_call_id ?? "",
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage, wi, "toolResult");
      return;
    }
    if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      if (calls.length > 0) {
        const content: Array<Record<string, unknown>> = [];
        const t = textOf();
        if (t) content.push({ type: "text", text: t });
        for (const c of calls) {
          let args: unknown = {};
          try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = { raw: c.function?.arguments ?? "" }; }
          content.push({ type: "toolCall", id: c.id, name: c.function?.name ?? "", arguments: args });
        }
        push({ role: "assistant", ...assistantBase(), content } as unknown as AgentMessage, wi, "toolCall");
        return;
      }
      const t = textOf();
      if (t) push({ role: "assistant", ...assistantBase(), content: [{ type: "text", text: t }] } as unknown as AgentMessage, wi, "text");
      return;
    }
    const t = textOf();
    if (t) push({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() } as AgentMessage, wi, "text");
  });
  return { stream, back, format };
}

/** Rebuild the wire payload from the transformed stream. Survivors reuse the
 *  ORIGINAL wire message objects (patched text only) so every field we do not
 *  understand — cache_control, citations, provider extras — passes through
 *  byte-identical. Only synthesized messages (nudge) are built from scratch.
 *  Returns the ORIGINAL payload object when nothing changed (cache-safe). */
export function rebuildWirePayload(rebuilt: AgentMessage[], payload: unknown, synth: SynthesisResult): unknown {
  const messages = ((payload as { messages?: unknown[] }).messages ?? []).slice();
  const out: unknown[] = [];

  const agentIndexOf = (m: AgentMessage): number | undefined => (m as unknown as Record<symbol, unknown>)[AI] as number | undefined;

  for (const agent of rebuilt) {
    const ai = agentIndexOf(agent);
    if (ai === undefined || ai >= synth.back.length) {
      // Synthesized message (nudge / future synthetic injections).
      // Wire reconstruction never strips: the fold's ref tags are PAYLOAD
      // here (the model reads m-refs off the wire; issue #66).
      const text = extractText((agent as { content?: unknown }).content, false);
      const role = (agent as { role?: string }).role === "assistant" ? "assistant" : "user";
      if (synth.format === "anthropic") {
        out.push({ role, content: [{ type: "text", text }] });
      } else {
        out.push({ role, content: text });
      }
      continue;
    }
    const { wi, kind } = synth.back[ai]!;
    const src = messages[wi] as Record<string, unknown> | undefined;
    if (!src) { out.push(agent); continue; }

    if (synth.format === "anthropic") {
      const srcMsg = src as AnthropicWireMessage;
      const blocks = anthropicBlocks(srcMsg);
      if (kind === "toolResult") {
        const block = blocks.find((b) => b.type === "tool_result" && b.tool_use_id === (agent as unknown as { toolCallId?: string }).toolCallId);
        const text = extractText((agent as { content?: unknown }).content, false);
        if (block) {
          // Tag-patched text; original block attrs (cache_control etc.) kept.
          out.push({ role: "user", content: [{ ...block, content: [{ type: "text", text }] }] });
          continue;
        }
      }
      if (kind === "toolCall") {
        // Assistant with tool_use blocks (possibly reconstructed from splits).
        // Reuse the original blocks: text blocks patched to the agent's text
        // (tags are skipped for assistants anyway), tool_use blocks filtered
        // to surviving call ids; everything else (thinking etc.) kept as-is.
        const callIds = new Set(
          ((agent as { content?: Array<{ type?: string; id?: string }> }).content ?? [])
            .filter((b) => b.type === "toolCall" && b.id)
            .map((b) => b.id as string),
        );
        const agentText = extractText((agent as { content?: unknown }).content, false);
        const outBlocks: AnthropicBlock[] = [];
        let textSeen = false;
        for (const b of blocks) {
          if (b.type === "tool_use") { if (callIds.has(b.id ?? "")) outBlocks.push(b); continue; }
          if (b.type === "text") {
            if (!textSeen && typeof b.text === "string") {
              // Core text merges text+args for tool-call turns; keep the
              // ORIGINAL text block (args live in the tool_use blocks).
              outBlocks.push(b);
              textSeen = true;
            }
            continue;
          }
          outBlocks.push(b);
        }
        if (agentText && !textSeen) outBlocks.unshift({ type: "text", text: agentText });
        out.push({ role: "assistant", content: outBlocks });
        continue;
      }
      // text
      const text = extractText((agent as { content?: unknown }).content, false);
      const block = blocks.find((b) => b.type === "text");
      if (block) out.push({ role: srcMsg.role, content: [{ ...block, text }] });
      else out.push({ role: srcMsg.role, content: [{ type: "text", text }] });
      continue;
    }

    // openai
    const srcMsg = src as OpenAIWireMessage;
    const text = extractText((agent as { content?: unknown }).content, false);
    if (kind === "toolResult") {
      out.push({ role: "tool", tool_call_id: (agent as unknown as { toolCallId?: string }).toolCallId ?? srcMsg.tool_call_id, content: text });
      continue;
    }
    if (kind === "toolCall") {
      const callIds = new Set(
        ((agent as { content?: Array<{ type?: string; id?: string }> }).content ?? [])
          .filter((b) => b.type === "toolCall" && b.id)
          .map((b) => b.id as string),
      );
      const surviving = (srcMsg.tool_calls ?? []).filter((c) => callIds.has(c.id));
      const entry: OpenAIWireMessage = { role: "assistant", content: text };
      if (surviving.length > 0) entry.tool_calls = surviving;
      out.push(entry);
      continue;
    }
    out.push({ role: srcMsg.role === "assistant" ? "assistant" : srcMsg.role, content: text });
  }

  return { ...(payload as object), messages: out };
}

/** True when the payload carries no messages we could fold (e.g. an empty
 *  tools-only probe). The caller bypasses instead of transforming. */
export function synthesisIsEmpty(synth: SynthesisResult): boolean {
  return synth.stream.length === 0;
}

export type { AnthropicRequestBody, OpenAIWireMessage, AnthropicWireMessage };
