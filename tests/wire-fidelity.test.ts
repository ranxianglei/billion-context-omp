import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { restoreOpenaiWireFidelity } from "../src/wire-fold.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Issue #105 ("OpenAI completions stream closed before a finish_reason was
// received"): the provider-mode openai rebuild ran the payload through the
// kernel codec, which (a) re-introduced content: null on assistant tool-call
// messages — omp's buildParams deliberately emits "" there ("null trips
// strict/proxy implementations", pi-ai openai-completions.ts) — and (b)
// dropped reasoning_details (encrypted-reasoning replay keyed to tool call
// ids). Strict OpenAI-compatible backends and proxies trip on both, which
// surfaces as aborted streams without a finish_reason. The rebuild must keep
// the host's wire contract; payloads carrying fields nothing restores
// (function_call/audio/annotations/refusal) must fail OPEN.

interface ToolEntry {
  name: string;
  execute?: (id: string, args: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  [k: string]: unknown;
}
type HandlerMap = Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
interface MockApi {
  tools: ToolEntry[];
  commands: Map<string, unknown>;
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
}
function captureApi(): { api: MockApi; handlers: HandlerMap } {
  const handlers: HandlerMap = new Map();
  const api: MockApi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [],
    commands: new Map(),
    registerTool(tool) {
      this.tools.push(tool as ToolEntry);
    },
    registerCommand(name, options) {
      this.commands.set(name, options);
    },
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
    sessionManager: {
      getSessionId: () => "wire-fidelity",
      getSessionFile: () => "/tmp/nonexistent-omp-wire-fidelity.session.json",
    },
  } as unknown as ExtensionContext;
}

function openaiPayload(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return { model: "glm-x", stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: "SYS" }, ...messages] };
}

const text = (r: { content: Array<{ type: string; text: string }> }): string => r.content[0]!.text;

test("restoreOpenaiWireFidelity: re-attaches reasoning_details and normalizes null content", () => {
  const original = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      reasoning_details: [{ type: "reasoning.encrypted", id: "c1", data: "opaque-1" }],
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "done" },
  ];
  const rebuilt = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "done" },
  ];
  const out = restoreOpenaiWireFidelity(original, rebuilt) as Array<Record<string, unknown>>;
  assert.equal(out[1]!.content, "", "assistant tool-call content null -> empty string");
  assert.deepEqual(
    out[1]!.reasoning_details,
    [{ type: "reasoning.encrypted", id: "c1", data: "opaque-1" }],
    "reasoning_details re-attached by tool call id",
  );
  assert.equal(out[3]!.content, "done", "plain assistant text untouched");
  assert.equal(out[0]!.content, "hi", "user message untouched");
});

test("restoreOpenaiWireFidelity: reasoning-only assistant turns get empty content, not null", () => {
  const original = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", reasoning_content: "thinking aloud" },
  ];
  const rebuilt = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, reasoning_content: "thinking aloud" },
  ];
  const out = restoreOpenaiWireFidelity(original, rebuilt) as Array<Record<string, unknown>>;
  assert.equal(out[1]!.content, "", "reasoning-only assistant turn gets empty content");
});

test("restoreOpenaiWireFidelity: merges details when the rebuild merges two assistant messages", () => {
  const original = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", reasoning_details: [{ id: "c1", data: "d1", type: "reasoning.encrypted" }], tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "note", reasoning_details: [{ id: "c2", data: "d2", type: "reasoning.encrypted" }], tool_calls: [{ id: "c2", type: "function", function: { name: "b", arguments: "{}" } }] },
  ];
  const rebuilt = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "note", tool_calls: [{ id: "c2", type: "function", function: { name: "b", arguments: "{}" } }] },
  ];
  const out = restoreOpenaiWireFidelity(original, rebuilt) as Array<Record<string, unknown>>;
  assert.deepEqual(out[3]!.reasoning_details, [{ id: "c2", data: "d2", type: "reasoning.encrypted" }]);
});

test("provider transform: reasoning_details and empty-string content survive the wire surgery (issue #105)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: Array<Record<string, unknown>>) =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: openaiPayload(messages) }, ctx) as Promise<{ messages: unknown[] } | undefined>;

  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "run the tests please" },
    {
      role: "assistant",
      content: "",
      reasoning_details: [{ type: "reasoning.encrypted", id: "call_0", data: "opaque-blob" }],
      tool_calls: [{ id: "call_0", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "npm test" }) } }],
    },
    { role: "tool", tool_call_id: "call_0", content: "213 passed" },
    { role: "assistant", content: "all green" },
  ];
  const out = await fire(messages);
  assert.ok(out, "transform ran");
  const flat = JSON.stringify(out.messages);
  const callMsg = (out.messages as Array<Record<string, unknown>>).find((m) => Array.isArray(m.tool_calls));
  assert.ok(callMsg, "assistant tool-call message present");
  assert.notEqual(callMsg.content, null, "assistant tool-call content is never null");
  assert.ok(Array.isArray(callMsg.reasoning_details), `reasoning_details preserved through the rebuild: ${flat.slice(0, 200)}`);
  assert.deepEqual(callMsg.reasoning_details, [{ type: "reasoning.encrypted", id: "call_0", data: "opaque-blob" }]);
});

test("provider transform: reasoning_details survive an active compression replay (issue #105)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: Array<Record<string, unknown>>) =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: openaiPayload(messages) }, ctx) as Promise<{ messages: unknown[] } | undefined>;

  const FILLER = "lorem ipsum dolor sit amet ".repeat(160);
  const SUMMARY = "A sufficiently long summary that passes the fifty character minimum validation gate.";
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `cov${i} ${FILLER}` });
  for (let i = 0; i < 6; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `tail${i} ${FILLER}` });

  assert.ok(await fire(messages), "base request transformed");

  const compress = api.tools.find((t) => t.name === "compress")!;
  const r1 = await compress.execute!("call_c1", { content: [{ startId: "m00002", endId: "m00009", summary: SUMMARY }] }, undefined, undefined, ctx);
  assert.match(text(r1), /1 block/, `compress ok: ${text(r1).slice(0, 200)}`);

  messages.push({
    role: "assistant",
    content: "",
    reasoning_details: [{ type: "reasoning.encrypted", id: "call_c1", data: "opaque-compress" }],
    tool_calls: [{ id: "call_c1", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00002", endId: "m00009", summary: SUMMARY }] }) } }],
  });
  messages.push({ role: "tool", tool_call_id: "call_c1", content: text(r1) });
  messages.push({ role: "user", content: "next turn" });

  const out = await fire(messages);
  assert.ok(out, "post-compression request transformed");
  const flat = JSON.stringify(out.messages);
  const callMsg = (out.messages as Array<Record<string, unknown>>).find((m) => Array.isArray(m.tool_calls));
  assert.ok(callMsg, "compress tool-call message present after surgery");
  assert.notEqual(callMsg.content, null, "assistant tool-call content is never null after surgery");
  assert.deepEqual(callMsg.reasoning_details, [{ type: "reasoning.encrypted", id: "call_c1", data: "opaque-compress" }], "encrypted reasoning rides the compress replay");
  assert.ok(!flat.includes("cov3 "), "covered filler pruned");
  assert.ok(flat.includes("tail0 "), "tail kept");
});

test("provider transform: unrestorable wire fields fail open (issue #105)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: Array<Record<string, unknown>>) =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: openaiPayload(messages) }, ctx) as Promise<{ messages: unknown[] } | undefined>;

  const legacy = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, function_call: { name: "bash", arguments: "{}" } },
    { role: "tool", tool_call_id: "bash", content: "ok" },
  ];
  assert.equal(await fire(legacy), undefined, "legacy function_call payload passes through untouched");

  const annotated = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "cited", annotations: [{ type: "url_citation", url: "https://x", title: "x" }] },
  ];
  assert.equal(await fire(annotated), undefined, "annotated payload passes through untouched");

  const refused = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, refusal: "cannot comply" },
  ];
  assert.equal(await fire(refused), undefined, "refusal payload passes through untouched");
});
