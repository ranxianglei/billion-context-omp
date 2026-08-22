import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";
import { formatSystemPromptForEvent } from "../src/compat.js";
import { defaultPrompts } from "acp-kernel";
import type { ExtensionAPI, ExtensionContext, AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

// Issue #64: provider mode (openai wire) — after restart, /acp and acp_status
// show "Blocks: none" until the first provider request. The live fold runs on
// the WIRE-synthesized stream: openai payloads carry the system prompt as the
// first message (it takes m00001) and drop tool names on role:"tool" entries
// (the compress result is not ref-BLOCKED). The persisted session view is a
// different projection — folding it in primeFold puts refs/fingerprints in the
// wrong space, the span guard rejects every in-stream replay, and the block
// only re-materializes at the first wire fold. primeFold must fold the same
// wire mirror the authoritative fold will use.

const SYSTEM = "You are a coding agent. " + "system context filler ".repeat(200);
const FILLER = "filler content for compression minimums ".repeat(220);
const SUMMARY =
  "COVERED WORK SUMMARY: early exploration and tool runs from the first half of the session, " +
  "compressed to keep context lean while preserving the goal, key file paths and findings. ";

const ACP = buildAcpSystemPrompt(defaultPrompts);
// What before_agent_start puts on the wire: base + ACP block (one string).
const WIRE_SYSTEM = formatSystemPromptForEvent([SYSTEM], ACP)[0]!;

type Msg = {
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown; thinking?: string; thinkingSignature?: string }>;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  [k: string]: unknown;
};

const assistantBase = {
  api: "anthropic" as const,
  provider: "anthropic" as const,
  model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const,
};
const userMsg = (t: string): Msg => ({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const botMsg = (t: string): Msg => ({ role: "assistant", ...assistantBase, content: [{ type: "text", text: t }] });
const thinkBot = (t: string): Msg => ({
  role: "assistant", ...assistantBase,
  content: [{ type: "thinking", thinking: "Let me work through " + t, thinkingSignature: "reasoning_content" }, { type: "text", text: t }],
});
const toolCallMsg = (id: string, name: string, args: unknown): Msg => ({
  role: "assistant", ...assistantBase,
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const toolResultMsg = (callId: string, toolName: string, t: string): Msg => ({
  role: "toolResult", toolCallId: callId, toolName, isError: false,
  content: [{ type: "text", text: t }], timestamp: Date.now(),
});

interface Host {
  api: unknown;
  ctx: ExtensionContext;
  handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
  tools: Map<string, ToolDefinition<any, any>>;
  wire: (session: Msg[]) => Record<string, unknown>;
}

function makeHost(session: Msg[], sid: string, wire: (s: Msg[]) => Record<string, unknown>, model: { api: string; contextWindow: number } = { api: "openai-completions", contextWindow: 200_000 }): Host {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, ToolDefinition<any, any>>();
  const treeTokens = () => Math.ceil(session.reduce((n, m) => n + m.content.reduce((x, b) => x + (b.text?.length ?? 0), 0), 0) / 4);
  const api = {
    on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(ev) ?? [];
      list.push(h);
      handlers.set(ev, list);
    },
    registerTool: (t: ToolDefinition<any, any>) => { tools.set(t.name, t); },
    registerCommand: () => {},
    config: { load: () => ({}) },
  };
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model,
    getSystemPrompt: () => [SYSTEM],
    getContextUsage: () => ({ tokens: treeTokens(), contextWindow: 200_000 }),
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => `/tmp/${sid}.json`,
      buildSessionContext: () => ({ messages: session }),
    },
  } as unknown as ExtensionContext;
  return { api, ctx, handlers, tools, wire };
}

// Host convertToLlm mirror (openai chat): system first, assistant text and/or
// tool_calls (content "" when only calls), one role:"tool" per result.
function openaiWire(session: Msg[]): Record<string, unknown> {
  const messages: unknown[] = [{ role: "system", content: WIRE_SYSTEM }];
  for (const m of session) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content.map((b) => b.text ?? "").join("\n") });
    } else if (m.role === "assistant") {
      const thinking = m.content.filter((b) => b.type === "thinking" && (b.thinking ?? "").trim().length > 0).map((b) => b.thinking ?? "");
      const reasoning = thinking.join("\n");
      const calls = m.content.filter((b) => b.type === "toolCall");
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
        });
      } else if (text || reasoning) {
        messages.push({ role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) });
      }
    } else if (m.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.map((b) => b.text ?? "").join("\n") });
    }
  }
  return { model: "glm-x", max_completion_tokens: 4096, messages };
}

// Host convertToLlm mirror (anthropic): system top-level, tool_result blocks
// ride in user messages, tool_use blocks in assistant messages.
function anthropicWire(session: Msg[]): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const m of session) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content.map((b) => ({ type: "text", text: b.text })) });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      for (const b of m.content) {
        if (b.type === "thinking" && (b.thinking ?? "").trim().length > 0) blocks.push({ type: "thinking", thinking: b.thinking, signature: b.thinkingSignature });
        else if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
        else if (b.type === "toolCall") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} });
      }
      messages.push({ role: "assistant", content: blocks });
    } else if (m.role === "toolResult") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content.map((b) => b.text ?? "").join("\n") }] });
    }
  }
  return { model: "claude-x", max_tokens: 8192, system: WIRE_SYSTEM, messages };
}

async function llmCall(host: Host, payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const hs = host.handlers.get("before_provider_request") ?? [];
  let out: Record<string, unknown> | undefined;
  for (const h of hs) {
    const r = await h({ type: "before_provider_request", payload }, host.ctx);
    if (r !== undefined) out = r as Record<string, unknown>;
  }
  return out;
}

async function statusText(host: Host): Promise<string> {
  const r: AgentToolResult<unknown> = await host.tools.get("acp_status")!.execute("sc", {}, undefined, undefined, host.ctx);
  return (r.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
}

const activeBlocks = (s: string): string => s.match(/COMPRESSED BLOCKS — (\d+) active/)?.[1] ?? "0";

// Shared live-session builder: filler turns, one REAL compress call (the
// handler writes the [fp=...] line), tail turns.
async function livePhase(host: Host, session: Msg[]): Promise<void> {
  await host.handlers.get("session_start")![0]!({ type: "session_start" }, host.ctx);
  await llmCall(host, host.wire(session));
  const args = { content: [{ startId: "m00001", endId: "m00014", summary: SUMMARY }] };
  const res: AgentToolResult<unknown> = await host.tools.get("compress")!.execute("call_c1", args, undefined, undefined, host.ctx);
  const resText = (res.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
  assert.match(resText, /\[fp=[0-9a-f,-]+\]/, "compress result carries span fingerprints");
  session.push(toolCallMsg("call_c1", "compress", args));
  session.push(toolResultMsg("call_c1", "compress", resText));
  session.push(userMsg("what did we find? " + FILLER));
  session.push(botMsg("Here is the answer " + FILLER));
  const out = await llmCall(host, host.wire(session));
  assert.ok(out, "provider transform active");
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes(`u2 ${FILLER.slice(0, 20)}`), "live wire payload prunes the covered filler");
  assert.ok(flat.includes("COVERED WORK SUMMARY"), "live wire payload carries the block summary");
  const st = await statusText(host);
  assert.equal(activeBlocks(st), "1", "live acp_status shows the block");
}

test("provider+openai: restart primeFold rebuilds the block BEFORE the first provider request (issue #64)", async () => {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(botMsg(`b${i} ` + FILLER));
  }

  // process 1: live provider-mode session
  const host = makeHost(session, "p64-openai", openaiWire);
  createAcpExtension({ autoUpdate: false })(host.api as ExtensionAPI);
  await livePhase(host, session);

  // process 2: restart (new extension instance, same session)
  const host2 = makeHost(session, "p64-openai", openaiWire);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);

  // The regression: /acp / acp_status right after restart, before any LLM
  // call, must already show the block.
  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "post-restart pre-LLM acp_status shows the block:\n" + prime);

  // The first provider request re-folds authoritatively and must keep it.
  const out = await llmCall(host2, host2.wire(session));
  const flat = JSON.stringify(out ?? {});
  assert.ok(flat.includes("COVERED WORK SUMMARY"), "post-restart wire payload carries the summary");
  assert.ok(!flat.includes(`u2 ${FILLER.slice(0, 20)}`), "post-restart wire payload prunes the covered filler");
  const post = await statusText(host2);
  assert.equal(activeBlocks(post), "1", "post-restart post-LLM acp_status still shows the block");
});

test("provider+anthropic: restart primeFold still rebuilds the block (unchanged path)", async () => {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(botMsg(`b${i} ` + FILLER));
  }

  const host = makeHost(session, "p64-anth", anthropicWire, { api: "anthropic-messages", contextWindow: 200_000 });
  createAcpExtension({ autoUpdate: false })(host.api as ExtensionAPI);
  await livePhase(host, session);

  const host2 = makeHost(session, "p64-anth", anthropicWire, { api: "anthropic-messages", contextWindow: 200_000 });
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);

  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "post-restart pre-LLM acp_status shows the block:\n" + prime);

  const out = await llmCall(host2, host2.wire(session));
  assert.ok(JSON.stringify(out ?? {}).includes("COVERED WORK SUMMARY"), "post-restart wire payload carries the summary");
  const post = await statusText(host2);
  assert.equal(activeBlocks(post), "1", "post-restart post-LLM acp_status still shows the block");
});

// Issue #103: `omp --resume` / reload / fork boots fire session_start
// BEFORE the old transcript is mounted (prime sees an empty view), then
// session_switch (or session_branch) once it is loaded. Without a handler
// for those events the fold is never primed for the resumed session and
// /acp shows "Blocks: none" until the first LLM call.

test("provider+openai: session_switch after resume rebuilds the block BEFORE the first provider request (issue #103)", async () => {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(botMsg(`b${i} ` + FILLER));
  }

  // process 1: live provider-mode session
  const host = makeHost(session, "p103-openai", openaiWire);
  createAcpExtension({ autoUpdate: false })(host.api as ExtensionAPI);
  await livePhase(host, session);

  // process 2: restart+resume — the extension boots with an EMPTY session;
  // the transcript lands afterwards (switchSession load), then the host
  // emits session_switch with reason "resume".
  const live: Msg[] = [];
  const host2 = makeHost(live, "p103-openai", openaiWire);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const before = await statusText(host2);
  assert.equal(activeBlocks(before), "0", "session_start saw the empty pre-resume view");

  live.push(...session);
  await host2.handlers.get("session_switch")![0]!({ type: "session_switch", reason: "resume", previousSessionFile: "/tmp/p103-openai.json" }, host2.ctx);

  // The regression: /acp / acp_status right after resume, before any LLM
  // call, must already show the block.
  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "post-resume pre-LLM acp_status shows the block:\n" + prime);

  // The first provider request re-folds authoritatively and must keep it.
  const out = await llmCall(host2, host2.wire(live));
  const flat = JSON.stringify(out ?? {});
  assert.ok(flat.includes("COVERED WORK SUMMARY"), "post-resume wire payload carries the summary");
  const post = await statusText(host2);
  assert.equal(activeBlocks(post), "1", "post-resume post-LLM acp_status still shows the block");
});

test("provider+anthropic: session_branch also rebuilds the block before the first provider request (issue #103)", async () => {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(botMsg(`b${i} ` + FILLER));
  }

  const host = makeHost(session, "p103-anthropic", anthropicWire, { api: "anthropic-messages", contextWindow: 200_000 });
  createAcpExtension({ autoUpdate: false })(host.api as ExtensionAPI);
  await livePhase(host, session);

  const live: Msg[] = [...session];
  const host2 = makeHost(live, "p103-anthropic", anthropicWire, { api: "anthropic-messages", contextWindow: 200_000 });
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  await host2.handlers.get("session_branch")![0]!({ type: "session_branch", previousSessionFile: "/tmp/p103-anthropic.json" }, host2.ctx);

  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "post-branch pre-LLM acp_status shows the block:\n" + prime);

  const out = await llmCall(host2, host2.wire(live));
  const flat = JSON.stringify(out ?? {});
  assert.ok(flat.includes("COVERED WORK SUMMARY"), "post-branch wire payload carries the summary");
  assert.ok(!flat.includes(`u2 ${FILLER.slice(0, 20)}`), "post-branch wire payload prunes the covered filler");
  const post = await statusText(host2);
  assert.equal(activeBlocks(post), "1", "post-branch post-LLM acp_status still shows the block");
});

// Issue #103 (thinking): the live wire carries assistant thinking as
// reasoning pieces (openai `reasoning_content` / anthropic thinking blocks).
// When the prime mirror dropped them, every compress replay after a
// thinking-bearing turn hit an index/fingerprint mismatch and restart showed
// "Blocks: none" until the first provider request refolded.
test("provider+openai: restart primeFold rebuilds blocks from thinking-bearing turns (issue #103)", async () => {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(thinkBot(`b${i} ` + FILLER));
  }

  // process 1: live session where every assistant turn carries thinking
  const host = makeHost(session, "p103-think", openaiWire);
  createAcpExtension({ autoUpdate: false })(host.api as ExtensionAPI);
  await livePhase(host, session);

  // process 2: restart — /acp must show the block BEFORE any LLM call
  const host2 = makeHost(session, "p103-think", openaiWire);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "post-restart pre-LLM acp_status shows the block:\n" + prime);

  const out = await llmCall(host2, host2.wire(session));
  const flat = JSON.stringify(out ?? {});
  assert.ok(flat.includes("COVERED WORK SUMMARY"), "post-restart wire payload carries the summary");
  const post = await statusText(host2);
  assert.equal(activeBlocks(post), "1", "post-restart post-LLM acp_status still shows the block");
});

test("provider+anthropic: restart primeFold rebuilds blocks from thinking-bearing turns (issue #103)", async () => {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(thinkBot(`b${i} ` + FILLER));
  }

  const host = makeHost(session, "p103-think-a", anthropicWire, { api: "anthropic-messages", contextWindow: 200_000 });
  createAcpExtension({ autoUpdate: false })(host.api as ExtensionAPI);
  await livePhase(host, session);

  const host2 = makeHost(session, "p103-think-a", anthropicWire, { api: "anthropic-messages", contextWindow: 200_000 });
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "anthropic post-restart pre-LLM acp_status shows the block:\n" + prime);
});
