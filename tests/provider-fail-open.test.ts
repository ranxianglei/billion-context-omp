import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { applyWireTagContract, payloadRepresentable } from "../src/wire-fold.js";
import { assignRefs, createInitialState, type CompressionState, type Config } from "acp-kernel";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BiliMessage } from "acp-kernel/wire";

// Issue #3 review, defect A: the kernel anthropicToCore/openaiToCore codecs
// handle a closed set of block types/roles and silently DROP everything else
// on the rebuild (document PDFs, redacted_thinking, server-tool blocks, ...).
// payloadRepresentable must flag exactly those payloads so
// before_provider_request fails OPEN (payload passes through untouched
// instead of losing content). Also covers the applyWireTagContract rework:
// tool-result tags carry the real tool name (type="bash", not "tool") and
// token counts come from the frozen tokenSnapshot, written back into the
// fold state.

const FILLER = "lorem ipsum dolor sit amet ".repeat(160); // ~4.4K chars ≈ 1.1K tokens

function fillerMsg(role: "user" | "assistant", seed: string): Record<string, unknown> {
  return { role, content: [{ type: "text", text: `${seed} ${FILLER}` }] };
}

function anthropicPayload(msgs: Array<Record<string, unknown>>): Record<string, unknown> {
  return { model: "claude-x", max_tokens: 8192, system: "sys", messages: msgs };
}

function captureApi() {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const api = {
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: () => {},
    registerCommand: () => {},
    config: { load: () => ({}) },
  };
  return { api, handlers };
}

function fakeCtx(): ExtensionContext {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => "provider-fail-open", getSessionFile: () => "/tmp/nonexistent-omp-pfo.session.json" },
  } as unknown as ExtensionContext;
}

test("payloadRepresentable: codec-known anthropic shapes pass", () => {
  const payload = anthropicPayload([
    { role: "user", content: [{ type: "text", text: "run it", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] },
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "file1" }] }] },
    { role: "user", content: "plain string content" },
  ]);
  assert.deepEqual(payloadRepresentable(payload, "anthropic"), { ok: true });
});

test("payloadRepresentable: document / redacted_thinking / server-tool blocks fail open", () => {
  const cases: Array<[string, Array<Record<string, unknown>>]> = [
    ["document", [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "aGk=" } }] }]],
    ["redacted_thinking", [{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] }]],
    ["server_tool_use", [{ role: "assistant", content: [{ type: "server_tool_use", id: "srv1", name: "web_search", input: {} }] }]],
    ["web_search_tool_result", [{ role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "srv1", content: [] }] }]],
    ["mcp_tool_use", [{ role: "assistant", content: [{ type: "mcp_tool_use", id: "mcp1", name: "srv.tool", input: {} }] }]],
  ];
  for (const [label, msgs] of cases) {
    const verdict = payloadRepresentable(anthropicPayload([...msgs, fillerMsg("user", "after")]), "anthropic");
    assert.equal(verdict.ok, false, `${label} must be unrepresentable`);
    assert.ok(verdict.ok === false && verdict.reason.includes(label), `${label} named in reason: ${verdict.reason}`);
  }
});

test("payloadRepresentable: tool_result image parts and thinking cache_control fail open", () => {
  const imageInResult = payloadRepresentable(
    anthropicPayload([{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] }] }]),
    "anthropic",
  );
  assert.equal(imageInResult.ok, false);
  const ccOnThinking = payloadRepresentable(
    anthropicPayload([{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s", cache_control: { type: "ephemeral" } }] }]),
    "anthropic",
  );
  assert.equal(ccOnThinking.ok, false);
});

test("payloadRepresentable: codec-known openai shapes pass, lossy shapes fail", () => {
  const clean = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "t9", type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t9", content: "hits" },
    ],
  };
  assert.deepEqual(payloadRepresentable(clean, "openai"), { ok: true });

  const unknownRole = { messages: [...clean.messages, { role: "function", name: "f", content: "x" }] };
  assert.equal(payloadRepresentable(unknownRole, "openai").ok, false);

  const secondImage = {
    messages: [
      { role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ] },
    ],
  };
  assert.equal(payloadRepresentable(secondImage, "openai").ok, false);

  const remoteImage = {
    messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "https://example.com/cat.png" } }] }],
  };
  assert.equal(payloadRepresentable(remoteImage, "openai").ok, false);
});

test("provider transform fails OPEN on unrepresentable payloads, recovers after (issue #3)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (msgs: Array<Record<string, unknown>>) =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: anthropicPayload(msgs) }, ctx) as Promise<{ messages: unknown[] } | undefined>;

  const normalMsgs = [
    fillerMsg("user", "q0"),
    fillerMsg("assistant", "a0"),
    fillerMsg("user", "q1"),
  ];
  assert.ok(await fire(normalMsgs), "representable payload still transforms");

  const withDocument = [...normalMsgs, { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "aGk=" } }] }];
  assert.equal(await fire(withDocument), undefined, "document payload passes through untouched");

  const withRedacted = [...normalMsgs, { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] }];
  assert.equal(await fire(withRedacted), undefined, "redacted_thinking payload passes through untouched");

  assert.ok(await fire(normalMsgs), "guard does not latch: clean payloads transform again");
});

test("applyWireTagContract: tool-result tags carry the real tool name (type=\"bash\")", () => {
  const call: BiliMessage = { id: "h_call1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: "{\"command\":\"ls\"}" };
  const result: BiliMessage = { id: "h_res1", role: "tool", contentType: "tool-result", toolCallId: "call_1", text: "file1\nfile2" };
  const state = seededState([call, result]);
  const out = applyWireTagContract([call, result], state, renderScope());
  const tagged = out.find((m) => m.contentType === "tool-result")!;
  assert.ok(tagged.text?.includes('type="bash"'), `tag carries the tool name: ${tagged.text?.slice(0, 80)}`);
  assert.ok(/m\d{5}/.test(tagged.text ?? ""), "tag carries the m-ref");
});

test("applyWireTagContract: token counts freeze in the snapshot and persist in the fold state", () => {
  const call: BiliMessage = { id: "h_call1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: "{\"command\":\"ls\"}" };
  const result: BiliMessage = { id: "h_res1", role: "tool", contentType: "tool-result", toolCallId: "call_1", text: FILLER };
  const state = seededState([call, result]);
  const scope = renderScope();
  const first = applyWireTagContract([call, result], state, scope);
  const tokens1 = first.find((m) => m.contentType === "tool-result")!.text!.match(/tokens="([^"]+)"/)![1];
  assert.ok(Object.keys(state.tokenSnapshot ?? {}).length > 0, "snapshot written back into the fold state");

  const shortened: BiliMessage = { ...result, text: "short" };
  const second = applyWireTagContract([call, shortened], state, scope);
  const tokens2 = second.find((m) => m.contentType === "tool-result")!.text!.match(/tokens="([^"]+)"/)![1];
  assert.equal(tokens2, tokens1, `token count frozen per ref (got ${tokens1} then ${tokens2})`);
});

function renderScope(): { config: Config; tokenCount: number } {
  return { config: { modelContextLimit: 200_000 } as unknown as Config, tokenCount: 0 };
}

function seededState(msgs: BiliMessage[]): CompressionState {
  const state = createInitialState();
  const { map } = assignRefs(msgs, { existing: state.messageRefs, nextIndex: 1 });
  state.messageRefs = map;
  return state;
}
