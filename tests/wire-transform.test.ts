import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { detectWireFormat, synthesizeStream, rebuildWirePayload } from "../src/wire-transform.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Provider mode (transformMode: "provider", issue #52): the context event is
// an observer and the compression surgery runs on the WIRE payload at
// before_provider_request. These tests cover format detection, wire↔stream
// synthesis fidelity, in-stream compress-call replay at the wire level, and
// mode isolation (context mode must not double-transform).

function capture() {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  return {
    handlers,
    api: {
      on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool: () => {},
      registerCommand: () => {},
      config: { load: () => ({}) },
    },
  };
}

function fakeCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }),
    sessionManager: { getSessionId: () => "wire-t", getSessionFile: () => "/tmp/wire-t.json" },
    ...overrides,
  } as unknown as ExtensionContext;
}

const FILLER = "lorem ipsum dolor sit amet ".repeat(160); // ~4.4K chars ≈ 1.1K tokens

function anthropicPayload(msgs: Array<Record<string, unknown>>): Record<string, unknown> {
  return { model: "claude-x", max_tokens: 8192, system: "sys", messages: msgs };
}

test("detectWireFormat routes anthropic / openai / unknown", () => {
  assert.equal(detectWireFormat(anthropicPayload([])), "anthropic");
  assert.equal(detectWireFormat({ messages: [{ role: "assistant", tool_calls: [{ id: "t1", function: { name: "f" } }] }] }), "openai");
  assert.equal(detectWireFormat({ messages: [{ role: "tool", tool_call_id: "t1", content: "r" }] }), "openai");
  assert.equal(detectWireFormat({ messages: [{ role: "user", content: "hi" }] }), "openai");
  assert.equal(detectWireFormat({ foo: 1 }), "unknown");
  assert.equal(detectWireFormat(null), "unknown");
});

test("wire→stream synthesis preserves identity-relevant shape (anthropic tool round-trip)", () => {
  const payload = anthropicPayload([
    { role: "user", content: [{ type: "text", text: "run it", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file1\nfile2" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  const synth = synthesizeStream(payload, "anthropic");
  // 4 agents: user text, assistant (text+toolCall), toolResult, assistant text
  assert.equal(synth.stream.length, 4);
  const [u1, a1, tr, a2] = synth.stream as Array<Record<string, any>>;
  assert.ok(u1 && a1 && tr && a2, "synthesized all four agents");
  assert.equal(u1.role, "user");
  assert.equal(a1.role, "assistant");
  assert.equal(a1.content[1].type, "toolCall");
  assert.equal(a1.content[1].id, "call_1");
  assert.equal(tr.role, "toolResult");
  assert.equal(tr.toolCallId, "call_1");
  assert.equal(tr.toolName, "bash");
  assert.equal(a2.role, "assistant");

  // No compression (short stream): rebuild keeps every message, tool ids and
  // cache_control survive on the original block objects.
  const out = rebuildWirePayload(synth.stream, payload, synth) as { messages: Array<Record<string, any>> };
  assert.equal(out.messages.length, 4);
  const m0 = out.messages[0]!;
  assert.equal(m0.content[0].cache_control?.type, "ephemeral", "cache_control preserved");
  const m1 = out.messages[1]!;
  assert.equal(m1.content.find((b: any) => b.type === "tool_use")?.id, "call_1", "tool_use id preserved");
  const m2 = out.messages[2]!;
  assert.equal(m2.content[0].tool_use_id, "call_1", "tool_result pairing preserved");
});

test("provider mode: in-stream compress call replays and prunes the wire payload", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  // 8 covered filler turns + compress tool_use + success result + 6 tail
  // fillers (≥5000 tokens of protected tail so the range is actionable).
  const msgs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `cov${i} ${FILLER}` }] });
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "call_c1", name: "compress", input: {
    content: [{ startId: "m00001", endId: "m00008", summary: "COVERED PHASE SUMMARY: early exploration, tool runs and findings compressed for context economy and continuity of the session work." }],
  } }] });
  msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_c1", content: "Compressed 1 range — 8.8k tokens saved (b1, tier 1)." }] });
  for (let i = 0; i < 6; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `tail${i} ${FILLER}` }] });
  const payload = anthropicPayload(msgs);

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  // Snapshot BEFORE firing: issue #79 syncs the surgery onto the original
  // payload in place (hosts that discard the replacement still send it), so
  // payload.messages no longer stays pristine after the call.
  const srcLen = (payload.messages as Array<Record<string, unknown>>).length;
  const out = (await fire()) as { messages: Array<Record<string, any>> };
  assert.ok(out, "transformed payload returned");
  const srcMsgs = payload.messages as Array<Record<string, unknown>>;
  assert.ok(out.messages.length < srcLen, `pruned: ${out.messages.length} < ${srcLen}`);
  // In-place mirror (issue #79): the original object the host serializes must
  // carry the same pruned view as the returned replacement.
  assert.equal(srcMsgs.length, out.messages.length, "original payload synced in place with the rebuilt view");

  const flat = JSON.stringify(out.messages);
  assert.ok(!flat.includes("cov3 "), "covered filler pruned from the wire payload");
  assert.ok(flat.includes("tail0 "), "protected tail kept");
  // The compress call itself survives (protected message) — the summary stays
  // visible to the model through its arguments.
  const compressMsg = out.messages.find((m) => JSON.stringify(m).includes("call_c1"));
  assert.ok(compressMsg, "compress tool_use block survives");
  assert.ok(JSON.stringify(compressMsg).includes("COVERED PHASE SUMMARY"), "summary text visible via call args");
  // First user message is never pruned (kernel firstUser protection).
  assert.ok(flat.includes("cov0 "), "first user message kept");
});

test("provider mode: emergency nudge appends a wire user message", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 8_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 8_000 }) });

  const msgs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `big${i} ${FILLER}` }] });
  const payload = anthropicPayload(msgs);

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { messages: Array<Record<string, any>> };
  const last = out.messages[out.messages.length - 1]!;
  assert.equal(last.role, "user");
  const text = JSON.stringify(last.content);
  assert.match(text, /compress/i, "nudge text reaches the wire payload");
});

test("provider mode: openai payloads transform too", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000 } });

  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: "sys" },
    { role: "user", content: `q ${FILLER}` },
    { role: "assistant", content: "", tool_calls: [{ id: "t9", function: { name: "grep", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", tool_call_id: "t9", content: "no matches" },
    { role: "assistant", content: "done" },
  ];
  const payload = { model: "glm-x", max_completion_tokens: 4096, messages: msgs };

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { messages: Array<Record<string, any>> };
  assert.ok(out, "openai payload transformed");
  assert.equal(out.messages.length, payload.messages.length, "nothing pruned on a small session");
  const flat = JSON.stringify(out.messages);
  assert.ok(flat.includes("no matches"), "tool result survives");
  assert.ok(flat.includes("t9"), "tool_call_id preserved");
});

test("mode isolation: context mode ignores before_provider_request; provider mode ignores context", async () => {
  const a = capture();
  createAcpExtension({ transformMode: "context" } as never)(a.api as unknown as ExtensionAPI);
  const payload = anthropicPayload([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  const r1 = await a.handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, fakeCtx());
  assert.equal(r1, undefined, "context mode: provider handler is a no-op");

  const b = capture();
  createAcpExtension({ transformMode: "provider" })(b.api as unknown as ExtensionAPI);
  const stream = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
  const r2 = await b.handlers.get("context")![0]!({ type: "context", messages: stream }, fakeCtx());
  assert.equal(r2, undefined, "provider mode: context handler is a no-op");
});

test("fail-open: malformed payloads return undefined, never throw", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const fire = (payload: unknown) => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, fakeCtx());
  assert.equal(await fire({ model: "x" }), undefined, "no messages array → pass-through");
  assert.equal(await fire({ messages: [42, null] }), undefined, "garbage entries → empty synthesis → pass-through");
});

test("default (no transformMode given) resolves per model API (issue #79)", async () => {
  const make = () => {
    const { api, handlers } = capture();
    createAcpExtension({ autoUpdate: false } as never)(api as unknown as ExtensionAPI);
    return handlers;
  };
  const model = (api: string | undefined) => fakeCtx({ model: { contextWindow: 1_000_000, ...(api ? { api } : {}) } });
  const stream = () => [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
  const wire = () => anthropicPayload([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  type CtxOut = { messages: unknown[] } | undefined;
  const fireCtx = (handlers: ReturnType<typeof capture>["handlers"], m: unknown): Promise<CtxOut> =>
    handlers.get("context")![0]!({ type: "context", messages: stream() }, m) as Promise<CtxOut>;

  // openai-completions (GLM/DeepSeek/vLLM): the wire body is parseable and
  // applyMessagesInPlace delivers the surgery even though the host drops
  // the replacement — provider by default (issue #79 root-cause fix).
  {
    const handlers = make();
    const r1 = await fireCtx(handlers, model("openai-completions"));
    assert.equal(r1, undefined, "default+openai-completions: context handler is an observer");
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model("openai-completions"));
    assert.ok(r2, "default+openai-completions: provider handler transforms the wire payload");
  }

  // anthropic-messages + ollama-chat: parseable body + honoring host → provider.
  for (const api of ["anthropic-messages", "ollama-chat"] as const) {
    const handlers = make();
    const r1 = await fireCtx(handlers, model(api));
    assert.equal(r1, undefined, `default+${api}: context handler is an observer`);
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model(api));
    assert.ok(r2, `default+${api}: provider handler transforms the wire payload`);
  }

  // Unparseable wire bodies (openai-responses `input`) and missing api → context.
  for (const api of ["openai-responses", undefined] as const) {
    const handlers = make();
    const r1 = await fireCtx(handlers, model(api));
    assert.ok(r1?.messages, `default+${api ?? "(no api)"}: context handler transforms`);
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model(api));
    assert.equal(r2, undefined, `default+${api ?? "(no api)"}: provider handler is a no-op`);
  }
});

test("explicit transformMode wins over the per-API default", async () => {
  const model = (api: string) => fakeCtx({ model: { contextWindow: 1_000_000, api } });
  const stream = () => [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
  const wire = () => anthropicPayload([{ role: "user", content: [{ type: "text", text: "hello" }] }]);

  // Explicit provider on openai-responses (unparseable body, defaults to
  // context): explicit config still forces the provider pipeline.
  const a = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(a.api as unknown as ExtensionAPI);
  const p1 = await a.handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model("openai-responses"));
  assert.ok(p1, "explicit provider+openai-responses: provider handler transforms");
  const c1 = await a.handlers.get("context")![0]!({ type: "context", messages: stream() }, model("openai-responses"));
  assert.equal(c1, undefined, "explicit provider+openai-responses: context handler is an observer");

  // Explicit context on anthropic-messages: context engages even though the
  // per-API default is provider.
  const b = capture();
  createAcpExtension({ transformMode: "context", autoUpdate: false } as never)(b.api as unknown as ExtensionAPI);
  const c2 = (await b.handlers.get("context")![0]!({ type: "context", messages: stream() }, model("anthropic-messages"))) as
    | { messages: unknown[] }
    | undefined;
  assert.ok(c2?.messages, "explicit context+anthropic-messages: context handler transforms");
  const p2 = await b.handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model("anthropic-messages"));
  assert.equal(p2, undefined, "explicit context+anthropic-messages: provider handler is a no-op");
});

// ---------------------------------------------------------------------------
// Issue #79 — hosts that DISCARD the before_provider_request replacement.
// @oh-my-pi/pi-ai's openai-completions provider (verified up to 17.3.5) runs
// `options?.onPayload?.(params, model);` WITHOUT assigning the result, unlike
// anthropic / openai-responses / azure / google which all honor the returned
// replacement. OpenAI-compatible endpoints (GLM, DeepSeek, vLLM, OpenRouter
// chat-completions) therefore never saw the nudge/summaries/pruned view — the
// model never received the injected information and never compressed. The
// transform must ALSO mirror the rebuilt messages onto the ORIGINAL payload
// object: that exact reference is what such hosts serialize to fetch.
// ---------------------------------------------------------------------------

test("issue #79: openai payload carries the surgery even when the host drops the return value (nudge)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 8_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 8_000 }) });

  const msgs: Array<Record<string, unknown>> = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `big${i} ${FILLER}` });
  const payload = { model: "glm-x", max_completion_tokens: 4096, messages: msgs };
  const messagesRef = payload.messages; // identity the host will serialize

  // Simulate the openai-completions host: call the hook, DROP the return.
  await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);

  assert.equal(payload.messages, messagesRef, "same messages array reference (host serializes this object)");
  const flat = JSON.stringify(payload.messages);
  const last = payload.messages[payload.messages.length - 1] as Record<string, unknown>;
  assert.equal(last.role, "user");
  assert.match(JSON.stringify(last.content), /compress/i, "nudge reaches the ORIGINAL payload in place");
  assert.ok(flat.length > 0, "payload still serializable");
});

test("issue #79: openai payload carries pruning in place too", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000 } });

  const msgs: Array<Record<string, unknown>> = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `cov${i} ${FILLER}` });
  msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "call_c9", function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00002", endId: "m00009", summary: "ISSUE79 PRUNED RANGE: early filler turns compressed for context economy." }] }) } }] });
  msgs.push({ role: "tool", tool_call_id: "call_c9", content: "Compressed 1 range — 8.8k tokens saved (b1, tier 1)." });
  msgs.push({ role: "user", content: `tail ${FILLER}` });
  const payload = { model: "glm-x", max_completion_tokens: 4096, messages: msgs };

  // Host discards the replacement — pruning must still land on the original.
  await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);

  const flat = JSON.stringify(payload.messages);
  assert.ok(!flat.includes("cov3 "), "covered filler pruned from the ORIGINAL payload in place");
  assert.ok(flat.includes("ISSUE79 PRUNED RANGE"), "summary visible via surviving compress call args");
  assert.ok(flat.includes("tail "), "protected tail kept");
});

test("issue #79: anthropic payloads also sync in place (identical content, honoring hosts unaffected)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000 } });

  const msgs: Array<Record<string, unknown>> = [
    { role: "user", content: [{ type: "text", text: "hello world" }] },
  ];
  const payload = anthropicPayload(msgs);
  await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const flat = JSON.stringify(payload.messages);
  assert.ok(flat.includes("hello world"), "original anthropic payload carries the transform in place");
});

test("issue #79: AWS Bedrock Converse payloads are unknown, never transformed (in-place corruption guard)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 8_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 8_000 }) });

  // Bedrock Converse shape: camelCase blocks + inferenceConfig/toolConfig. It
  // has {system, messages} and was previously misdetected as "anthropic" —
  // harmless while hosts discarded our replacement, dangerous now that the
  // transform syncs in place (snake_case rebuild would corrupt the request).
  const bedrock = {
    modelId: "anthropic.claude-3-5-sonnet",
    system: [{ text: "sys" }],
    messages: [
      { role: "user", content: [{ text: `big ${FILLER}` }] },
    ],
    inferenceConfig: { maxTokens: 4096 },
    toolConfig: { tools: [{ toolSpec: { name: "bash" } }] },
  };
  assert.equal(detectWireFormat(bedrock), "unknown", "Bedrock Converse classified unknown");
  const before = JSON.stringify(bedrock);
  const ret = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: bedrock }, ctx);
  assert.equal(ret, undefined, "unknown format passes through");
  assert.equal(JSON.stringify(bedrock), before, "payload object untouched — even under emergency nudge pressure");
});
