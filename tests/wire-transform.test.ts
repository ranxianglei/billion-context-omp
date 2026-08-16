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
  const out = (await fire()) as { messages: Array<Record<string, any>> };
  assert.ok(out, "transformed payload returned");
  const srcMsgs = payload.messages as Array<Record<string, unknown>>;
  assert.ok(out.messages.length < srcMsgs.length, `pruned: ${out.messages.length} < ${srcMsgs.length}`);

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

test("default (no transformMode given) resolves to provider mode", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  // context handler must be an observer when no explicit mode is configured
  const stream = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
  const r1 = await handlers.get("context")![0]!({ type: "context", messages: stream }, ctx);
  assert.equal(r1, undefined, "default mode: context handler is a no-op (provider)");
  // provider handler must engage
  const payload = anthropicPayload([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  const r2 = (await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx)) as
    | { messages: Array<Record<string, unknown>> }
    | undefined;
  assert.ok(r2, "default mode: provider handler transforms the wire payload");
});
