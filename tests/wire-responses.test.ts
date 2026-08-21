import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  coreToPayloadMessages,
  detectProviderWireFormat,
  normalizeResponsesPayload,
  payloadRepresentable,
  payloadToCore,
  viewToResponsesCore,
} from "../src/wire-fold.js";

// ework issue #12: the responses wire channel — kernel responsesToCore folds
// input[] item bodies (omp's openai-responses / azure / codex payloads) and
// patchResponsesInput rebuilds the surgery result onto the original item
// layout. User turns ride the wire as EasyInputMessage (no `type`), so the
// adapter normalizes them into the fold space first.

const body = () => ({
  model: "qwen3.8-27b",
  instructions: "SYS",
  stream: true,
  store: false,
  prompt_cache_key: "sess-1",
  input: [
    { role: "user", content: "hello" },
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "enc-1" },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi there", annotations: [] }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
    { type: "function_call_output", call_id: "call_1", output: "21C" },
    { role: "user", content: [{ type: "input_text", text: "and tomorrow?" }] },
  ],
});

test("detectProviderWireFormat routes input[] bodies to responses", () => {
  assert.equal(detectProviderWireFormat(body()), "responses");
  assert.equal(detectProviderWireFormat({ model: "x", input: "hi" }), null, "string input is not kernel-detected → fail-open");
});

test("normalizeResponsesPayload: role-only user/assistant items gain type message, payload untouched", () => {
  const raw = body();
  const normalized = normalizeResponsesPayload(raw);
  assert.equal((normalized.input[0] as { type?: string }).type, "message");
  assert.equal((raw.input[0] as { type?: string }).type, undefined, "original payload not mutated");
  assert.equal((normalized.input[2] as { type?: string }).type, "message", "typed items stay typed");
  assert.equal((normalized.input[3] as { type?: string }).type, "function_call");
  const roleless = normalizeResponsesPayload({ input: [{ role: "system", content: "s" }] });
  assert.equal((roleless.input[0] as { type?: string }).type, undefined, "role-only system stays untouched (passthrough)");
});

test("payloadToCore folds the normalized stream: user text reachable, system out of the fold", () => {
  const { msgs, projection } = payloadToCore(body(), "responses");
  const users = msgs.filter((m) => m.role === "user");
  assert.equal(users.length, 2, "both user turns fold (EasyInputMessage normalized)");
  assert.ok(users.some((m) => m.text === "hello"));
  assert.ok(projection, "projection returned for the rebuild");
  assert.deepEqual(projection!.systemParts, ["SYS"], "instructions stay out of the fold space");
  assert.ok(msgs.some((m) => m.contentType === "reasoning" && m.text === "rs_1"));
  assert.ok(msgs.some((m) => m.contentType === "tool-call" && m.toolCallId === "call_1"));
  assert.ok(msgs.some((m) => m.contentType === "tool-result" && m.text === "21C"));
});

test("rebuild: patched texts land in the original items, folded pieces drop, inserted summaries splice in", () => {
  const { msgs, projection } = payloadToCore(body(), "responses");
  const reasoning = msgs.find((m) => m.contentType === "reasoning")!;
  const tagged = msgs
    .filter((m) => m.id !== reasoning.id)
    .map((m) => (m.text === "hello" ? { ...m, text: "hello \x3cdcp-message-id\x3em00001\x3c/dcp-message-id\x3e" } : m));
  tagged.splice(1, 0, { id: "acp_summary_1", role: "user", contentType: "text", text: "SUMMARY: early turns" });
  const out = coreToPayloadMessages(tagged, "responses", undefined, projection) as Array<Record<string, any>>;
  assert.equal(out.some((i) => i.type === "reasoning"), false, "folded reasoning item is gone");
  const patchedUser = out.find((i) => typeof i.content === "string" && (i.content as string).startsWith("hello")) as { content?: unknown };
  assert.deepEqual(patchedUser.content, "hello \x3cdcp-message-id\x3em00001\x3c/dcp-message-id\x3e", "tagged text patched in place");
  const summary = out.find((i) => i.type === "message" && (i as { content?: unknown }).content === "SUMMARY: early turns");
  assert.ok(summary, "inserted summary rides the rebuilt input");
  const fc = out.find((i) => i.type === "function_call") as { call_id: string; name: string; arguments: string };
  assert.equal(fc.call_id, "call_1", "function_call fields preserved");
  assert.ok(out.some((i) => i.type === "function_call_output"), "tool output item survives");
});

test("rebuild keeps instructions-space items verbatim and preserves unknown item types", () => {
  const exotic = {
    model: "x",
    instructions: "SYS",
    input: [
      { type: "additional_tools", tools: [{ name: "x" }] },
      { type: "future_item", payload: 7 },
      { role: "user", content: "q" },
    ],
  };
  const { msgs, projection } = payloadToCore(exotic, "responses");
  assert.equal(msgs.length, 1, "only the user text folds");
  const out = coreToPayloadMessages(msgs, "responses", undefined, projection) as Array<Record<string, any>>;
  assert.deepEqual(out.find((i) => i.type === "additional_tools"), { type: "additional_tools", tools: [{ name: "x" }] }, "opaque preamble item passes through");
  assert.deepEqual(out.find((i) => i.type === "future_item"), { type: "future_item", payload: 7 }, "unknown item types pass through");
});

test("payloadRepresentable: system/developer message items inside input fail open", () => {
  assert.deepEqual(payloadRepresentable(body(), "responses"), { ok: true });
  assert.equal(payloadRepresentable({ input: "hi" }, "responses").ok, true);
  const bad = payloadRepresentable({ input: [{ type: "message", role: "system", content: "s" }] }, "responses");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /systemParts/);
  const easyBad = payloadRepresentable({ input: [{ role: "developer", content: "s" }] }, "responses");
  assert.equal(easyBad.ok, false, "EasyInput shorthand system/developer also folds into systemParts");
  assert.equal(payloadRepresentable({ model: "x" }, "responses").ok, false, "input missing → unrepresentable");
});

test("viewToResponsesCore mirrors the responses wire shape from the session view", () => {
  const signature = JSON.stringify({ type: "reasoning", id: "rs_live", summary: [], encrypted_content: "enc-live" });
  const view = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pondering", thinkingSignature: signature },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } },
      ],
    },
    { role: "toolResult", toolCallId: "call_9", content: [{ type: "text", text: "file.txt" }] },
  ];
  const { msgs } = (() => {
    const input = viewToResponsesCore(view as never, "SYS\n\nACP");
    return { msgs: input };
  })();
  assert.ok(msgs.some((m) => m.role === "user" && m.text === "hi"), "user text folds");
  const reasoning = msgs.find((m) => m.contentType === "reasoning");
  assert.equal(reasoning?.text, "rs_live", "thinkingSignature replay keeps the live rs_ id");
  assert.ok(msgs.some((m) => m.contentType === "text" && m.text === "answer"), "assistant text folds");
  assert.ok(msgs.some((m) => m.contentType === "tool-call" && m.toolCallId === "call_9" && m.text === "{\"command\":\"ls\"}"), "toolCall mirrors function_call arguments");
  assert.ok(msgs.some((m) => m.contentType === "tool-result" && m.text === "file.txt"), "toolResult mirrors function_call_output");
  assert.ok(!msgs.some((m) => m.text?.includes("SYS")), "system text stays out of the fold space");
});
