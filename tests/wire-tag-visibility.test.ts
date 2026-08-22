import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";
import { formatSystemPromptForEvent } from "../src/compat.js";
import { defaultPrompts } from "acp-kernel";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

// Issue #66 visibility: what does the MODEL actually see on the wire in
// provider mode? Two guarantees, asserted on the RETURNED wire payload (the
// true bytes the LLM receives — not the fold-output dumps):
//
// 1. The nudge reaches the final wire as the trailing user message, with its
//    compressible-range list, exactly once.
// 2. Per-message m-ref tags reach the final wire message text. The kernel's
//    render-refs prepends each tag to user text; applyWireTagContract adds
//    them to tool-result pieces (issue #66) and coreToX must NOT strip
//    them. Historical regression (#66): the old bridge's extractText
//    stripRefTag removed the tags the fold had just rendered, so the model
//    was told by the ACP system prompt "each message has an <acp …> tag"
//    while the wire carried none — refs were only visible via the nudge.

const SYSTEM = "You are a coding agent. " + "system context filler ".repeat(200);
const FILLER = "filler content for compression minimums ".repeat(220); // ~8k chars ≈ 2k tokens

const ACP = buildAcpSystemPrompt(defaultPrompts);
// What before_agent_start puts on the wire: base + ACP block (one string).
const WIRE_SYSTEM = formatSystemPromptForEvent([SYSTEM], ACP)[0]!;
const TAG = /<acp [^>]*>m\d{5}<\/acp>/;

type Msg = {
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
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
const toolCallMsg = (id: string, name: string, args: unknown): Msg => ({
  role: "assistant", ...assistantBase,
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const toolResultMsg = (callId: string, toolName: string, t: string): Msg => ({
  role: "toolResult", toolCallId: callId, toolName, isError: false,
  content: [{ type: "text", text: t }], timestamp: Date.now(),
});

function openaiWire(session: Msg[]): Record<string, unknown> {
  const messages: unknown[] = [{ role: "system", content: WIRE_SYSTEM }];
  for (const m of session) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content.map((b) => b.text ?? "").join("\n") });
    } else if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "toolCall");
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
        });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
    } else if (m.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.map((b) => b.text ?? "").join("\n") });
    }
  }
  return { model: "glm-x", max_completion_tokens: 4096, messages };
}

function anthropicWire(session: Msg[]): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const m of session) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content.map((b) => ({ type: "text", text: b.text ?? "" })) });
    } else if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "toolCall");
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      const blocks: unknown[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
    } else if (m.role === "toolResult") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content.map((b) => ({ type: "text", text: b.text ?? "" })) }],
      });
    }
  }
  return { model: "claude-x", max_tokens: 4096, system: WIRE_SYSTEM, messages };
}

async function providerRoundTrip(window: number, session: Msg[], wire: (s: Msg[]) => Record<string, unknown>, api: string, sid: string): Promise<Record<string, unknown> | undefined> {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const apiObj = {
    on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(ev) ?? [];
      list.push(h);
      handlers.set(ev, list);
    },
    registerTool: (_t: ToolDefinition<any, any>) => {},
    registerCommand: () => {},
    config: { load: () => ({}) },
  };
  const treeTokens = () => Math.ceil(session.reduce((n, m) => n + m.content.reduce((x, b) => x + (b.text?.length ?? 0), 0), 0) / 4);
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { api, contextWindow: window },
    getSystemPrompt: () => [SYSTEM],
    getContextUsage: () => ({ tokens: treeTokens(), contextWindow: window }),
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => `/tmp/${sid}.json`,
      buildSessionContext: () => ({ messages: session }),
    },
  } as unknown as ExtensionContext;
  createAcpExtension({ autoUpdate: false })(apiObj as unknown as ExtensionAPI);
  await handlers.get("session_start")![0]!({ type: "session_start" }, ctx);
  const payload = wire(session);
  const h = handlers.get("before_provider_request")![0]!;
  return (await h({ type: "before_provider_request", payload }, ctx)) as Record<string, unknown> | undefined;
}

const wireMsgs = (out: Record<string, unknown> | undefined): Array<Record<string, unknown>> =>
  ((out?.messages as Array<Record<string, unknown>>) ?? []);
const textOf = (m: Record<string, unknown>): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");

const SESSION: Msg[] = [];
for (let i = 0; i < 4; i++) {
  SESSION.push(userMsg(`u${i} ` + FILLER));
  SESSION.push(toolCallMsg(`tc${i}`, "bash", { command: `echo step ${i}` }));
  SESSION.push(toolResultMsg(`tc${i}`, "bash", `result ${i} ` + FILLER));
  SESSION.push(botMsg(`b${i} ` + FILLER));
}

test("provider+openai: nudge reaches the FINAL wire as the trailing user message (issue #66)", async () => {
  // 16 msgs × ~2.2k tokens ≈ 35k vs window 16k → OVER-LIMIT nudge (≥ 75%)
  const out = await providerRoundTrip(16_000, SESSION, openaiWire, "openai-completions", "wire-tag-nudge");
  assert.ok(out, "provider transform returned a payload");
  const msgs = wireMsgs(out);
  assert.ok(msgs.length > 0, "wire has messages");

  const inputFlat = JSON.stringify(openaiWire(SESSION));
  assert.ok(!inputFlat.includes("Context limit reached") && !inputFlat.includes("efficiency nudge"), "input wire has no nudge");

  const last = msgs[msgs.length - 1]!;
  assert.equal(last.role, "user", "final wire message is the trailing user nudge");
  const lastText = textOf(last);
  const isNudge = lastText.includes("Context limit reached") || lastText.includes("efficiency nudge to compress early");
  assert.ok(isNudge, "trailing user message carries the nudge text:\n" + lastText.slice(0, 300));
  assert.ok(lastText.includes("Compressible ranges") || /m\d{5}/.test(lastText), "nudge lists compressible ranges");
  const flat = JSON.stringify(msgs);
  const copies = (flat.match(/Context limit reached|efficiency nudge to compress early/g) ?? []).length;
  assert.equal(copies, 1, "nudge appears exactly once on the wire");
});

test("provider+openai: per-message m-ref tags reach the FINAL wire text (issue #66)", async () => {
  const out = await providerRoundTrip(200_000, SESSION, openaiWire, "openai-completions", "wire-tag-openai");
  assert.ok(out, "provider transform returned a payload");
  const msgs = wireMsgs(out);
  // Full tag shape <acp …>mNNNNN</acp>; check non-system messages only
  // (the system prompt's ACP docs contain a tag example).
  const nonSystem = msgs.filter((m) => m.role !== "system");
  const taggedUser = nonSystem.some((m) => m.role === "user" && TAG.test(textOf(m)));
  const taggedTool = nonSystem.some((m) => m.role === "tool" && TAG.test(textOf(m)));
  const firstUser = nonSystem.find((m) => m.role === "user")!;
  assert.ok(taggedUser, "user message wire text carries its m-ref tag (tail: " + textOf(firstUser).slice(-120) + ")");
  assert.ok(taggedTool, "tool result wire text carries its m-ref tag");
  // Tags are suffixes (patchRefTag) — the original body stays intact.
  assert.ok(textOf(firstUser).includes("u0 " + FILLER.slice(0, 40)), "original user body preserved");
  assert.equal(msgs[0]!.role, "system", "system prompt stays first");
});

test("provider+anthropic: per-message m-ref tags reach the FINAL wire text (issue #66)", async () => {
  const out = await providerRoundTrip(200_000, SESSION, anthropicWire, "anthropic", "wire-tag-anthropic");
  assert.ok(out, "provider transform returned a payload");
  const msgs = wireMsgs(out);

  const taggedUser = msgs.some((m) =>
    m.role === "user" &&
    Array.isArray(m.content) &&
    (m.content as Array<Record<string, string>>).some((b) => b.type === "text" && TAG.test(b.text ?? "")),
  );
  const taggedTool = msgs.some((m) =>
    m.role === "user" &&
    Array.isArray(m.content) &&
    (m.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_result" && TAG.test(JSON.stringify(b.content ?? ""))),
  );
  assert.ok(taggedUser, "user text block carries its m-ref tag");
  assert.ok(taggedTool, "tool_result block carries its m-ref tag");
  // Top-level system field passes through untouched.
  assert.equal((out as { system?: string }).system, WIRE_SYSTEM, "system field preserved");
});
