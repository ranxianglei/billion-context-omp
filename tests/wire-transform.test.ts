import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import {
  coreIdentity,
  detectProviderWireFormat,
  findCompressCallsCore,
  payloadToCore,
  coreToPayloadMessages,
  spanFingerprintCore,
  boundaryRawCore,
  staleRangeCore,
  viewToAnthropicCore,
  viewToCoreStream,
} from "../src/wire-fold.js";
import { stripRefTag } from "../src/messages.js";
import { hostVersionAtLeast } from "../src/transform-mode.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BiliMessage } from "acp-kernel/wire";

// Provider mode (transformMode: "provider", issue #52): the context event is
// an observer and the compression surgery runs on the WIRE payload at
// before_provider_request — now in CORE SPACE on the kernel codec
// (wire-fold.ts), the same wire contract as the billion-context proxy.
// These tests cover format detection, kernel round-trip fidelity, core-space
// replay helpers, in-stream compress-call replay at the wire level, and mode
// isolation (context mode must not double-transform).

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

test("detectProviderWireFormat routes anthropic / openai, null otherwise", () => {
  assert.equal(detectProviderWireFormat(anthropicPayload([])), "anthropic");
  assert.equal(detectProviderWireFormat({ messages: [{ role: "assistant", tool_calls: [{ id: "t1", function: { name: "f" } }] }] }), "openai");
  assert.equal(detectProviderWireFormat({ messages: [{ role: "tool", tool_call_id: "t1", content: "r" }] }), "openai");
  assert.equal(detectProviderWireFormat({ messages: [{ role: "user", content: "hi" }] }), "openai");
  assert.equal(detectProviderWireFormat({ foo: 1 }), null);
  assert.equal(detectProviderWireFormat(null), null);
  // The kernel parses responses bodies, but the omp pipeline has no
  // responses rebuild path — fail-open, not openai-shaped.
  assert.equal(detectProviderWireFormat({ model: "gpt-x", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }), null);
});

test("kernel round-trip preserves tool ids and cache_control (anthropic)", () => {
  const payload = anthropicPayload([
    { role: "user", content: [{ type: "text", text: "run it", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file1\nfile2" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  const { msgs, cacheControls } = payloadToCore(payload, "anthropic");
  // 6 core pieces: user text, assistant text, tool-call, tool-result, assistant text
  assert.ok(msgs.length >= 5, `expected >=5 pieces, got ${msgs.length}`);
  const call = msgs.find((m) => m.contentType === "tool-call");
  assert.equal(call?.toolCallId, "call_1");
  assert.equal(call?.toolName, "bash");
  assert.ok(call?.text?.includes("ls"));
  const result = msgs.find((m) => m.contentType === "tool-result");
  assert.equal(result?.toolCallId, "call_1");
  assert.ok(result?.text?.includes("file1"));

  const out = coreToPayloadMessages(msgs, "anthropic", cacheControls) as Array<Record<string, any>>;
  const flat = JSON.stringify(out);
  assert.ok(flat.includes("call_1"), "tool ids survive the round-trip");
  assert.ok(flat.includes("file1"), "tool result text survives");
  const withCC = flat.match(/cache_control/);
  assert.ok(withCC, "cache_control re-attached from the cacheControls map");
});

test("kernel round-trip preserves tool_calls and tool results (openai)", () => {
  const payload = {
    model: "glm-x",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ id: "t9", type: "function", function: { name: "grep", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "t9", content: "no matches" },
    ],
  };
  const { msgs } = payloadToCore(payload, "openai");
  assert.ok(msgs.some((m) => m.role === "system"), "system prompt becomes a core piece (takes m00001)");
  const out = coreToPayloadMessages(msgs, "openai") as Array<Record<string, any>>;
  const flat = JSON.stringify(out);
  assert.ok(flat.includes("t9"), "tool_call_id survives");
  assert.ok(flat.includes("no matches"), "tool result survives");
  const tc = out.find((m) => Array.isArray(m.tool_calls));
  assert.equal(tc?.tool_calls?.[0]?.id, "t9");
});

test("coreIdentity strips our own ref tags (cross-turn stability)", () => {
  const bare: BiliMessage = { id: "x", role: "user", contentType: "text", text: "hello" };
  const tagged: BiliMessage = { id: "y", role: "user", contentType: "text", text: "hello\n\n<acp tokens=\"1K\" type=\"text\">m00001</acp>" };
  const taggedLead: BiliMessage = { id: "z", role: "user", contentType: "text", text: "<acp tokens=\"1K\" type=\"text\">m00001</acp>\nhello" };
  assert.equal(coreIdentity(bare), coreIdentity(tagged));
  assert.equal(coreIdentity(bare), coreIdentity(taggedLead));
  assert.notEqual(coreIdentity(bare), coreIdentity({ ...bare, text: "different" }));
  assert.equal(stripRefTag("hello\n\n<acp tokens=\"1K\" type=\"text\">m00001</acp>"), "hello");
});

test("findCompressCallsCore finds direct and xd:// compress calls", () => {
  const direct: BiliMessage = {
    id: "c1", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call_z",
    text: JSON.stringify({ content: [{ startId: "m00001", endId: "m00003", summary: "s" }] }),
  };
  const calls = findCompressCallsCore(direct);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "call_z");
  assert.equal(calls[0]!.ranges.length, 1);
  assert.equal(calls[0]!.ranges[0]!.startRef, "m00001");

  const legacy: BiliMessage = {
    id: "c2", role: "assistant", contentType: "tool-call", toolName: "write", toolCallId: "call_w",
    text: JSON.stringify({ path: "xd://compress", content: JSON.stringify([{ startId: "m00001", endId: "m00002", summary: "s2" }]) }),
  };
  const legacyCalls = findCompressCallsCore(legacy);
  assert.equal(legacyCalls.length, 1);
  assert.equal(legacyCalls[0]!.ranges[0]!.endRef, "m00002");

  const other: BiliMessage = { id: "c3", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_b", text: "{}" };
  assert.equal(findCompressCallsCore(other).length, 0);
});

test("staleRangeCore: fingerprint match passes, mismatch rejects", () => {
  const msgs: BiliMessage[] = [
    { id: "h1", role: "user", contentType: "text", text: "one" },
    { id: "h2", role: "assistant", contentType: "text", text: "two" },
    { id: "h3", role: "user", contentType: "text", text: "three" },
    { id: "call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c", text: "{}" },
  ];
  const fp = spanFingerprintCore(msgs, "h1", "h3");
  assert.match(fp, /^[0-9a-f]{8}$/);
  const byRef: Record<string, string> = { m00001: "h1", m00002: "h2", m00003: "h3" };
  const resultText = `Compressed 1 range [fp=${fp}]`;
  assert.equal(staleRangeCore({ startRef: "m00001", endRef: "m00003" }, 0, resultText, msgs, 3, byRef, []), false, "matching fp passes");
  assert.match(
    String(staleRangeCore({ startRef: "m00001", endRef: "m00003" }, 0, "Compressed 1 range [fp=00000000]", msgs, 3, byRef, [])),
    /^fp m00001\.\.m00003 want 00000000 got [0-9a-f]{8}/,
    "mismatched fp rejects",
  );
  assert.match(
    String(staleRangeCore({ startRef: "m00001", endRef: "m00099" }, 0, "Compressed 1 range [fp=x]", msgs, 3, byRef, [])),
    /^unresolved/,
    "unresolved message ref rejects",
  );
  assert.match(
    String(staleRangeCore({ startRef: "m00001", endRef: "m00002" }, 0, "Compressed 1 range [fp=00000000]", msgs, 0, byRef, [])),
    /^end idx 1 > callIndex 0$/,
    "end after the call rejects",
  );
});

test("boundaryRawCore resolves block refs by stream order", () => {
  const msgs: BiliMessage[] = [
    { id: "h1", role: "user", contentType: "text", text: "one" },
    { id: "h2", role: "assistant", contentType: "text", text: "two" },
    { id: "h3", role: "user", contentType: "text", text: "three" },
  ];
  const byRef: Record<string, string> = { m00001: "h1", m00002: "h2", m00003: "h3" };
  const blocks = [{ blockId: "b1", effectiveMessageIds: ["h1", "h2", "h3"] }];
  assert.equal(boundaryRawCore("m00002", byRef, blocks, msgs, "min"), "h2");
  assert.equal(boundaryRawCore("b1", byRef, blocks, msgs, "min"), "h1");
  assert.equal(boundaryRawCore("b1", byRef, blocks, msgs, "max"), "h3");
  assert.equal(boundaryRawCore("b9", byRef, blocks, msgs, "min"), "");
});

test("viewToCoreStream mirrors the openai wire shape (system first)", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "toolCall", id: "t1", name: "grep", arguments: { q: "x" } }] },
    { role: "toolResult", content: [{ type: "text", text: "hit" }], toolCallId: "t1" },
  ] as unknown as Parameters<typeof viewToCoreStream>[0];
  const core = viewToCoreStream(view, "base system");
  assert.equal(core[0]?.role, "system", "system prompt takes m00001");
  assert.equal(core[0]?.text, "base system");
  assert.ok(core.some((m) => m.contentType === "tool-call" && m.toolCallId === "t1"));
  assert.ok(core.some((m) => m.role === "tool" && m.text === "hit"));
});

test("viewToAnthropicCore mirrors the anthropic wire shape (no system piece)", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "grep", arguments: { q: "x" } }] },
    { role: "toolResult", content: [{ type: "text", text: "hit" }], toolCallId: "t1" },
  ] as unknown as Parameters<typeof viewToAnthropicCore>[0];
  const core = viewToAnthropicCore(view);
  assert.ok(!core.some((m) => m.role === "system"), "top-level system is out of the fold space");
  const call = core.find((m) => m.contentType === "tool-call");
  assert.equal(call?.toolCallId, "t1");
  assert.ok(core.some((m) => m.contentType === "tool-result" && m.toolCallId === "t1"));
});

test("provider mode: in-stream compress call replays and prunes the wire payload", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
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
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
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
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
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
  const flat = JSON.stringify(out.messages);
  assert.ok(flat.includes("no matches"), "tool result survives");
  assert.ok(flat.includes("t9"), "tool_call_id preserved");
});

test("mode isolation: context mode ignores before_provider_request; provider mode ignores context", async () => {
  const a = capture();
  createAcpExtension({ transformMode: "context", autoUpdate: false } as never)(a.api as unknown as ExtensionAPI);
  const payload = anthropicPayload([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  const r1 = await a.handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, fakeCtx());
  assert.equal(r1, undefined, "context mode: provider handler is a no-op");

  const b = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(b.api as unknown as ExtensionAPI);
  const stream = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
  const r2 = await b.handlers.get("context")![0]!({ type: "context", messages: stream }, fakeCtx());
  assert.equal(r2, undefined, "provider mode: context handler is a no-op");
});

test("fail-open: malformed payloads return undefined, never throw", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const fire = (payload: unknown) => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, fakeCtx());
  assert.equal(await fire({ model: "x" }), undefined, "no messages array → pass-through");
  assert.equal(await fire({ messages: [42, null] }), undefined, "garbage entries → fail-open catch → pass-through");
});

test("default (no transformMode given) resolves per model API (issues #79/#83)", async () => {
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

  // openai-completions (GLM/DeepSeek/vLLM): upstream PR can1357/oh-my-pi#8717
  // (issue #83) made the host apply the wire-payload replacement from 17.3.8,
  // and the openai wire body has a codec path — so the default is provider
  // when the host is new enough. The expectation depends on the ambient host
  // version (devDep pin), so assert both branches explicitly (M1).
  {
    const handlers = make();
    const r1 = await fireCtx(handlers, model("openai-completions"));
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model("openai-completions"));
    if (hostVersionAtLeast([17, 3, 8])) {
      assert.equal(r1, undefined, "default+openai-completions (host >= 17.3.8): context handler is an observer");
      assert.ok(r2, "default+openai-completions (host >= 17.3.8): provider handler transforms the wire payload");
    } else {
      assert.ok(r1?.messages, "default+openai-completions (host < 17.3.8): context handler transforms");
      assert.equal(r2, undefined, "default+openai-completions (host < 17.3.8): provider handler is a no-op");
    }
  }

  // anthropic-messages + ollama-chat: the host applies the replacement → provider.
  for (const api of ["anthropic-messages", "ollama-chat"] as const) {
    const handlers = make();
    const r1 = await fireCtx(handlers, model(api));
    assert.equal(r1, undefined, `default+${api}: context handler is an observer`);
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model(api));
    assert.ok(r2, `default+${api}: provider handler transforms the wire payload`);
  }

  // Non-viable wire bodies (openai-responses `input`) and missing api → context.
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

  // Explicit provider on openai-completions (e.g. a patched host that honors
  // the replacement): provider engages even though the default is context.
  const a = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(a.api as unknown as ExtensionAPI);
  const p1 = await a.handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model("openai-completions"));
  assert.ok(p1, "explicit provider+openai-completions: provider handler transforms");
  const c1 = await a.handlers.get("context")![0]!({ type: "context", messages: stream() }, model("openai-completions"));
  assert.equal(c1, undefined, "explicit provider+openai-completions: context handler is an observer");

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
