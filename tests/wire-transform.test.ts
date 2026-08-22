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
  spanFingerprintCoreIdx,
  boundaryRawCore,
  boundaryIndexCore,
  staleRangeCore,
  rangePositionsCore,
  viewToAnthropicCore,
  viewToCoreStream,
  viewToResponsesCore,
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
  // Responses bodies (/v1/responses) have a codec path — the kernel's
  // responses codec rebuilds the `input` layout-preserving.
  assert.equal(detectProviderWireFormat({ model: "gpt-x", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }), "responses");
  assert.equal(detectProviderWireFormat({ model: "gpt-x", input: "plain string input" }), "responses");
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
  assert.deepEqual(staleRangeCore({ startRef: "m00001", endRef: "m00003" }, 0, resultText, msgs, 3, byRef, []), {}, "matching fp passes");
  assert.match(
    staleRangeCore({ startRef: "m00001", endRef: "m00003" }, 0, "Compressed 1 range [fp=00000000]", msgs, 3, byRef, []).reject ?? "",
    /^fp m00001\.\.m00003 want 00000000 got [0-9a-f]{8}/,
    "mismatched fp rejects",
  );
  assert.match(
    staleRangeCore({ startRef: "m00001", endRef: "m00099" }, 0, "Compressed 1 range [fp=x]", msgs, 3, byRef, []).reject ?? "",
    /^unresolved/,
    "unresolved message ref rejects",
  );
  assert.match(
    staleRangeCore({ startRef: "m00001", endRef: "m00002" }, 0, "Compressed 1 range [fp=00000000]", msgs, 0, byRef, []).reject ?? "",
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

// Issue #91: provider mode keys pieces by content hash, so a host drift that
// re-serializes a BOUNDARY piece mints a new id and dangles the carried m-ref.
// The [pos=] tag (recorded at compress time) recovers the stream index; the
// [fp=] first-4096 digest still decides keep/drop, so a benign tail drift
// (first-4096 intact) is kept while a real rewrite is dropped.
const liveMsgs: BiliMessage[] = [
  { id: "h1", role: "user", contentType: "text", text: "one" },
  { id: "h2", role: "assistant", contentType: "text", text: "two" },
  { id: "h3", role: "user", contentType: "text", text: "three" },
  { id: "call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c", text: "{}" },
];
const liveByRef: Record<string, string> = { m00001: "h1", m00002: "h2", m00003: "h3" };
// Drifted streams: the end boundary piece h3 is re-serialized to a NEW id.
// benign keeps its text (first-4096 intact); rewrite changes it.
const driftBenign: BiliMessage[] = [liveMsgs[0]!, liveMsgs[1]!, { ...liveMsgs[2]!, id: "h3b" }, liveMsgs[3]!];
const driftRewrite: BiliMessage[] = [liveMsgs[0]!, liveMsgs[1]!, { ...liveMsgs[2]!, id: "h3r", text: "rewritten" }, liveMsgs[3]!];

test("boundaryIndexCore resolves by id, else falls back to the recorded index", () => {
  assert.equal(boundaryIndexCore("m00002", liveByRef, [], liveMsgs, "min"), 1, "present id -> array index");
  assert.equal(boundaryIndexCore("m00099", liveByRef, [], liveMsgs, "min", 2), 2, "dangling id -> valid fallback index");
  assert.equal(boundaryIndexCore("m00099", liveByRef, [], liveMsgs, "min", 99), -1, "dangling id, out-of-range fallback -> -1");
  assert.equal(boundaryIndexCore("m00099", liveByRef, [], liveMsgs, "min"), -1, "dangling id, no fallback -> -1");
  assert.equal(boundaryIndexCore("b1", {}, [{ blockId: "b1", effectiveMessageIds: ["h1", "h3"] }], liveMsgs, "max"), 2, "block ref by stream order");
});

test("rangePositionsCore emits aligned s-e pairs, '-' when unpositionable", () => {
  assert.deepEqual(rangePositionsCore([{ startRef: "m00001", endRef: "m00003" }], liveMsgs, liveByRef, []), ["0-2"]);
  assert.deepEqual(rangePositionsCore([{ startRef: "m00099", endRef: "m00003" }], liveMsgs, liveByRef, []), ["-"], "unresolvable start -> '-'");
  assert.deepEqual(
    rangePositionsCore([{ startRef: "m00001", endRef: "m00003" }, { startRef: "m00099", endRef: "m00002" }], liveMsgs, liveByRef, []),
    ["0-2", "-"],
  );
});

test("staleRangeCore position fallback: benign tail drift keeps and remaps, rewrite drops", () => {
  const fp = spanFingerprintCore(liveMsgs, "h1", "h3");
  const r = { startRef: "m00001", endRef: "m00003" };
  // Live fold of the drifted stream: the re-serialized end piece lost its
  // old id and got the next free ref (m00004) from assignRefs; the stale
  // m00003 -> h3 entry lingers but resolves to nothing in the stream.
  const driftBenignByRef = { ...liveByRef, m00004: "h3b" };
  const driftRewriteByRef = { ...liveByRef, m00004: "h3r" };
  // No drift: byRef resolves, [pos=] is inert.
  assert.deepEqual(staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-2]`, liveMsgs, 99, liveByRef, []), {}, "no drift passes");
  // Benign tail drift: end id h3 re-hashed (dangles), [pos=0-2] recovers
  // idx 2, first-4096 intact -> fp matches -> KEEP, remapped to the
  // recovered piece's current ref.
  assert.deepEqual(
    staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-2]`, driftBenign, 99, driftBenignByRef, []),
    { remap: { endRef: "m00004" }, recovered: { pos: "0-2", startIdx: 0, endIdx: 2 } },
    "benign tail drift keeps and remaps",
  );
  // Genuine rewrite: end id dangles, [pos=0-2] recovers idx 2, but text
  // changed -> fp mismatches -> DROP.
  assert.match(
    staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-2]`, driftRewrite, 99, driftRewriteByRef, []).reject ?? "",
    /^fp m00001\.\.m00003 want [0-9a-f]{8} got [0-9a-f]{8} @0\.\.2$/,
    "genuine rewrite drops on fp mismatch",
  );
});

test("staleRangeCore position fallback: misaligned hint and missing tag are fail-safe", () => {
  const fp = spanFingerprintCore(liveMsgs, "h1", "h3");
  const r = { startRef: "m00001", endRef: "m00003" };
  const driftBenignByRef = { ...liveByRef, m00004: "h3b" };
  // Misaligned [pos] points at the call piece (idx 3) -> fp mismatch -> DROP.
  assert.match(
    staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-3]`, driftBenign, 99, driftBenignByRef, []).reject ?? "",
    /^fp m00001\.\.m00003 want/,
    "misaligned hint drops",
  );
  // No [pos] tag (pre-fallback result text) + dangling end id -> unresolved
  // -> DROP (master behavior preserved for results recorded without the
  // fallback).
  assert.match(
    staleRangeCore(r, 0, `[fp=${fp}]`, driftBenign, 99, driftBenignByRef, []).reject ?? "",
    /^unresolved m00001\.\.m00003 -> 0\.\.-1$/,
    "missing pos tag keeps master drop-on-dangle",
  );
});

test("staleRangeCore: recovered boundary without a current ref fails closed", () => {
  const fp = spanFingerprintCore(liveMsgs, "h1", "h3");
  const r = { startRef: "m00001", endRef: "m00003" };
  // Drifted stream where the recovered end piece is PROTECTED (no entry in
  // the live byRef): the kernel could never apply the range under it —
  // reject instead of handing the kernel a ref it does not know.
  const v = staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-2]`, driftBenign, 99, liveByRef, []);
  assert.match(v.reject ?? "", /^recovered m00003 @2 has no ref \(protected piece\)$/);
  assert.equal(v.remap, undefined);
});

test("staleRangeCore: block refs are never remapped (the kernel resolves them)", () => {
  const msgs: BiliMessage[] = [
    { id: "h1", role: "user", contentType: "text", text: "one" },
    { id: "h2", role: "assistant", contentType: "text", text: "two" },
    { id: "h3", role: "user", contentType: "text", text: "three" },
    { id: "call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c", text: "{}" },
  ];
  const byRef: Record<string, string> = { m00001: "h1", m00002: "h2", m00003: "h3" };
  const blocks = [{ blockId: "b1", effectiveMessageIds: ["h1", "h2"] }];
  // Both boundaries resolve normally -> plain pass, no remap even with [pos=].
  assert.deepEqual(staleRangeCore({ startRef: "b1", endRef: "m00003" }, 0, "Compressed 1 range [fp=-] | [pos=0-2]", msgs, 3, byRef, blocks), {});
  // Unresolvable start with a block end -> the kernel decides (master
  // pass-through, now `{}`).
  assert.deepEqual(staleRangeCore({ startRef: "m00099", endRef: "b1" }, 0, "Compressed 1 range [fp=-]", msgs, 3, byRef, blocks), {});
});

test("staleRangeCore: hint flag marks recovery failures (always-on logging)", () => {
  const fp = spanFingerprintCore(liveMsgs, "h1", "h3");
  const r = { startRef: "m00001", endRef: "m00003" };
  // Hint present + fp mismatch -> reject WITH hint (a failed recovery).
  assert.equal(staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-3]`, driftBenign, 99, liveByRef, []).hint, true, "hinted reject flags a failed recovery");
  // No hint + dangling end -> reject WITHOUT hint (plain master-style drop).
  assert.equal(staleRangeCore(r, 0, `[fp=${fp}]`, driftBenign, 99, liveByRef, []).hint, undefined, "hintless reject stays a plain drop");
  // Hint present + successful recovery -> no reject, remap carried instead.
  const ok = staleRangeCore(r, 0, `[fp=${fp}] | [pos=0-2]`, driftBenign, 99, { ...liveByRef, m00004: "h3b" }, []);
  assert.equal(ok.reject, undefined);
  assert.ok(ok.remap?.endRef, "successful recovery carries the remap");
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

// Issue #103: thinking blocks ride the wire (openai: reasoning_content field,
// anthropic: thinking blocks) and the kernel codec maps each to an
// assistant/reasoning piece. The prime mirror must reproduce those pieces or
// every index and fingerprint after a thinking-bearing turn drifts and the
// restart replay guards reject the in-stream compress calls.
test("viewToCoreStream mirrors thinking blocks as reasoning pieces (issue #103)", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "ponder", thinkingSignature: "reasoning_content" }, { type: "text", text: "answer" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan the call" }, { type: "toolCall", id: "t1", name: "grep", arguments: { q: "x" } }] },
    { role: "toolResult", content: [{ type: "text", text: "hit" }], toolCallId: "t1" },
    { role: "assistant", content: [{ type: "thinking", thinking: "   " }] },
  ] as unknown as Parameters<typeof viewToCoreStream>[0];
  const core = viewToCoreStream(view, "base system");
  const reasoning = core.filter((m) => m.contentType === "reasoning");
  assert.equal(reasoning.length, 2, "one reasoning piece per non-empty thinking block group");
  assert.ok(reasoning.some((m) => m.text === "ponder"), "thinking text preserved verbatim");
  assert.ok(reasoning.some((m) => m.text === "plan the call"), "thinking before a tool call preserved");
  const callIdx = core.findIndex((m) => m.contentType === "tool-call" && m.toolCallId === "t1");
  const reasoningIdx = core.findIndex((m) => m.contentType === "reasoning" && m.text === "plan the call");
  assert.ok(reasoningIdx >= 0 && callIdx > reasoningIdx, "reasoning piece precedes its tool-call piece");
  assert.ok(!core.some((m) => m.contentType === "reasoning" && !(m.text ?? "").trim()), "whitespace-only thinking dropped");
});

test("viewToAnthropicCore mirrors thinking blocks as reasoning pieces (issue #103)", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "ponder", thinkingSignature: "sig-1" }, { type: "text", text: "answer" }] },
  ] as unknown as Parameters<typeof viewToAnthropicCore>[0];
  const core = viewToAnthropicCore(view);
  const reasoning = core.find((m) => m.contentType === "reasoning");
  assert.ok(reasoning, "thinking block becomes a reasoning piece");
  assert.equal(reasoning?.text, "ponder");
  assert.equal((reasoning as { thinkingSignature?: string }).thinkingSignature, "sig-1", "signature carried through");
  assert.ok(core.some((m) => m.contentType === "text" && m.text === "answer"), "text piece still present");
});

test("viewToResponsesCore mirrors the responses wire shape (system in instructions, out of fold space)", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "toolCall", id: "t1", name: "grep", arguments: { q: "x" } }] },
    { role: "toolResult", content: [{ type: "text", text: "hit" }], toolCallId: "t1" },
  ] as unknown as Parameters<typeof viewToResponsesCore>[0];
  const core = viewToResponsesCore(view, "base system");
  // The system prompt rides the top-level `instructions` field, NOT the
  // `input` array — so it must be out of the fold space (unlike the openai
  // mirror, where it takes m00001). The first fold piece is the user message.
  assert.ok(!core.some((m) => m.role === "system"), "top-level instructions is out of the fold space");
  assert.equal(core[0]?.role, "user", "first fold piece is the user message, not the system prompt");
  assert.equal(core[0]?.text, "q");
  assert.ok(core.some((m) => m.contentType === "tool-call" && m.toolCallId === "t1"), "function_call becomes a tool-call piece");
  assert.ok(core.some((m) => m.role === "tool" && m.text === "hit"), "function_call_output becomes a tool-result piece");
});

test("viewToResponsesCore mirrors thinking blocks as reasoning pieces (issue #103)", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "ponder" }, { type: "text", text: "answer" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan the call" }, { type: "toolCall", id: "t1", name: "grep", arguments: { q: "x" } }] },
    { role: "toolResult", content: [{ type: "text", text: "hit" }], toolCallId: "t1" },
  ] as unknown as Parameters<typeof viewToResponsesCore>[0];
  const core = viewToResponsesCore(view, "base system");
  const reasoning = core.filter((m) => m.contentType === "reasoning");
  assert.equal(reasoning.length, 2, "one reasoning piece per non-empty thinking block");
  // NOTE: the kernel's responses codec keys the reasoning piece on the item
  // id/hash (NOT the thinking text, unlike the openai codec) — so the text is
  // a non-empty id, not the verbatim thinking. The ref/fingerprint space still
  // aligns because the piece occupies the same position in the sequence.
  assert.ok(reasoning.every((m) => typeof m.text === "string" && m.text.length > 0), "reasoning pieces carry a non-empty id");
  const callIdx = core.findIndex((m) => m.contentType === "tool-call" && m.toolCallId === "t1");
  const reasoningIdx = core.findIndex((m) => m.contentType === "reasoning");
  assert.ok(reasoningIdx >= 0 && callIdx > reasoningIdx, "reasoning piece precedes its tool-call piece");
  assert.ok(core.some((m) => m.contentType === "text" && m.text === "answer"), "text piece still present");
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

test("provider mode: in-stream compress call replays on the openai wire shape (review M6, issue #83)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();

  // Openai shape: the system prompt is a wire MESSAGE, so it takes m00001
  // and the filler refs shift by one vs the anthropic test (m00002..m00009).
  // PR #86 makes openai-completions the provider default on hosts >= 17.3.8,
  // so this shape is the e2e replay contract for GLM/DeepSeek/vLLM traffic.
  const msgs: Array<Record<string, unknown>> = [{ role: "system", content: "base system" }];
  for (let i = 0; i < 8; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `cov${i} ${FILLER}` });
  msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "call_c1", type: "function", function: { name: "compress", arguments: JSON.stringify({
    content: [{ startId: "m00002", endId: "m00009", summary: "COVERED PHASE SUMMARY: early exploration, tool runs and findings compressed for context economy and continuity of the session work." }],
  }) } }] });
  msgs.push({ role: "tool", tool_call_id: "call_c1", content: "Compressed 1 range — 8.8k tokens saved (b1, tier 1)." });
  for (let i = 0; i < 6; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `tail${i} ${FILLER}` });
  const payload = { model: "glm-x", max_completion_tokens: 4096, messages: msgs };

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { messages: Array<Record<string, unknown>> };
  assert.ok(out, "transformed openai payload returned");
  const srcMsgs = payload.messages as Array<Record<string, unknown>>;
  assert.ok(out.messages.length < srcMsgs.length, `pruned: ${out.messages.length} < ${srcMsgs.length}`);

  const flat = JSON.stringify(out.messages);
  assert.ok(!flat.includes("cov3 "), "covered filler pruned from the openai wire payload");
  assert.ok(flat.includes("tail0 "), "protected tail kept");
  assert.ok(flat.includes("base system"), "system prompt (m00001) survives the transform");
  // The compress tool_call itself survives (protected message) — the summary
  // stays visible to the model through its arguments.
  const compressMsg = out.messages.find((m) => JSON.stringify(m).includes("call_c1"));
  assert.ok(compressMsg, "compress tool_call survives");
  assert.ok(JSON.stringify(compressMsg).includes("COVERED PHASE SUMMARY"), "summary text visible via call args");
  // First user message (cov0, m00002) is never pruned (kernel firstUser protection).
  assert.ok(flat.includes("cov0 "), "first user message kept");
});

test("provider mode: drifted replay remaps dangling refs and prunes (issue #91 e2e)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", protectedTools: ["bash", "read"], autoUpdate: false })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000 } });

  // Drift scenario (openai wire shape, system takes m00001): at RECORD time
  // the bash/read results were unprotected, so the range was recorded as
  // m00002..m00014 (ovl0..covE). By REPLAY time protectedTools gained
  // ["bash","read"] — their results are ref-blocked, the numbering shifts
  // (covE = m00012 now) and the recorded endRef m00014 dangles (replay max
  // ref is m00013). The [pos=] hint must recover covE and the range must be
  // re-applied under covE's CURRENT ref — pre-fix the guard passed but the
  // kernel threw BoundaryNotFoundError on the dangling ref and the block
  // was silently dropped (issue #91). The six ovl* fillers sit outside the
  // kernel's last-5+last-user protected zone so the applied range is
  // actionable; covA/covB/covE (and the bash/read pieces) are excluded by
  // the zone / protectedTools — ovl1..ovl3 must still prune.
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: "base system" },
    { role: "user", content: `ovl0 ${FILLER}` },
    { role: "assistant", content: `ovl1 ${FILLER}` },
    { role: "user", content: `ovl2 ${FILLER}` },
    { role: "assistant", content: `ovl3 ${FILLER}` },
    { role: "user", content: `ovl4 ${FILLER}` },
    { role: "assistant", content: `ovl5 ${FILLER}` },
    { role: "user", content: `covA ${FILLER}` },
    { role: "assistant", content: `covB ${FILLER}` },
    { role: "assistant", content: "", tool_calls: [{ id: "call_c1", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] },
    { role: "tool", tool_call_id: "call_c1", content: `covD1 ${FILLER}` },
    { role: "assistant", content: "", tool_calls: [{ id: "call_c2", type: "function", function: { name: "read", arguments: "{\"path\":\"f\"}" } }] },
    { role: "tool", tool_call_id: "call_c2", content: `covD2 ${FILLER}` },
    { role: "user", content: `covE ${FILLER}` },
    { role: "assistant", content: "", tool_calls: [{ id: "call_c3", type: "function", function: { name: "compress", arguments: JSON.stringify({
      content: [{ startId: "m00002", endId: "m00014", summary: "COVERED DRIFT SUMMARY: phase-one exploration and tool runs compressed for context economy and continuity of the session work." }],
    }) } }] },
    { role: "tool", tool_call_id: "call_c3", content: "placeholder" },
  ];
  // Record the span fingerprint the way the live compress tool does: over
  // the recorded span (pieces 1..13 = ovl0..covE). The drift changes refs,
  // not contents — the fp is computable from the drifted stream.
  const { msgs: core } = payloadToCore({ model: "glm-x", max_completion_tokens: 4096, messages: msgs }, "openai");
  const fp = spanFingerprintCoreIdx(core, 1, 13);
  assert.match(fp, /^[0-9a-f]{8}$/, "recorded fp computable from the drifted stream");
  msgs[15] = { role: "tool", tool_call_id: "call_c3", content: `Compressed 1 range — 8.8k tokens saved (b1, tier 1).\n[fp=${fp}]\n[pos=1-13]` };
  const payload = { model: "glm-x", max_completion_tokens: 4096, messages: msgs };

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { messages: Array<Record<string, any>> };
  assert.ok(out, "transformed openai payload returned");
  const flat = JSON.stringify(out.messages);
  assert.ok(!flat.includes("ovl1 "), "old filler pruned (pre-fix: nothing pruned — block dropped)");
  assert.ok(!flat.includes("ovl3 "), "third old filler pruned");
  assert.ok(flat.includes("ovl0 "), "first user message kept (kernel firstUser protection)");
  assert.ok(flat.includes("ovl5 "), "protected-zone tail of the range kept");
  assert.ok(flat.includes("covA "), "zone piece kept");
  assert.ok(flat.includes("covE "), "recovered end boundary kept");
  assert.ok(flat.includes("covD1 "), "protectedTools result excluded from compression, not pruned");
  assert.ok(flat.includes("base system"), "system prompt kept");
  const compressMsg = out.messages.find((m) => JSON.stringify(m).includes("call_c3"));
  assert.ok(compressMsg, "compress tool_call survives");
  assert.ok(JSON.stringify(compressMsg).includes("COVERED DRIFT SUMMARY"), "summary visible via call args");
  const srcMsgs = payload.messages as Array<Record<string, unknown>>;
  assert.ok(out.messages.length < srcMsgs.length, `pruned: ${out.messages.length} < ${srcMsgs.length}`);
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

// /v1/responses (openai-responses API): the wire body carries `input` (an
// item array or a string) plus a top-level `instructions` field. The kernel's
// responses codec rebuilds the input layout-preserving (patchResponsesInput),
// so opaque items (additional_tools, ...) survive and text is patched in place.
test("provider mode: in-stream compress call replays and prunes the responses wire payload", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000, api: "openai-responses" } });

  // 8 covered filler turns + compress function_call + success output + 6 tail
  // fillers (≥5000 tokens of protected tail so the range is actionable).
  const input: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) input.push({ type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: i % 2 ? "output_text" : "input_text", text: `cov${i} ${FILLER}` }] });
  input.push({ type: "function_call", call_id: "call_c1", name: "compress", arguments: JSON.stringify({
    content: [{ startId: "m00001", endId: "m00008", summary: "COVERED PHASE SUMMARY: early exploration, tool runs and findings compressed for context economy and continuity of the session work." }],
  }) });
  input.push({ type: "function_call_output", call_id: "call_c1", output: "Compressed 1 range — 8.8k tokens saved (b1, tier 1)." });
  for (let i = 0; i < 6; i++) input.push({ type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: i % 2 ? "output_text" : "input_text", text: `tail${i} ${FILLER}` }] });
  const payload = { model: "gpt-x", instructions: "base system", input, stream: true };

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { input: Array<Record<string, any>>; instructions?: string; stream?: boolean };
  assert.ok(out, "transformed responses payload returned");
  assert.ok(out.input.length < input.length, `pruned: ${out.input.length} < ${input.length}`);

  const flat = JSON.stringify(out.input);
  assert.ok(!flat.includes("cov3 "), "covered filler pruned from the responses input");
  assert.ok(flat.includes("tail0 "), "protected tail kept");
  assert.ok(flat.includes("cov0 "), "first user message kept (kernel firstUser protection)");
  // The compress function_call itself survives (protected message) — the
  // summary stays visible to the model through its arguments.
  assert.ok(flat.includes("call_c1"), "compress function_call survives");
  assert.ok(flat.includes("COVERED PHASE SUMMARY"), "summary text visible via call args");
  // Top-level fields are preserved (the rebuild only touches `input`).
  assert.equal(out.instructions, "base system", "instructions preserved");
  assert.equal(out.stream, true, "stream flag preserved");
});

test("provider mode: emergency nudge appends a wire user message (responses)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 8_000, api: "openai-responses" }, getContextUsage: () => ({ tokens: 0, contextWindow: 8_000 }) });

  const input: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) input.push({ type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: i % 2 ? "output_text" : "input_text", text: `big${i} ${FILLER}` }] });
  const payload = { model: "gpt-x", input };

  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { input: Array<Record<string, any>> };
  const last = out.input[out.input.length - 1]!;
  assert.equal(last.type, "message");
  assert.equal(last.role, "user");
  const text = JSON.stringify(last.content);
  assert.match(text, /compress/i, "nudge text reaches the responses input");
});

test("provider mode: string input transforms and stays a string (responses)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000, api: "openai-responses" } });

  const payload = { model: "gpt-x", input: `hello ${FILLER}` };
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { input: unknown };
  assert.ok(out, "string-input payload transformed");
  assert.equal(typeof out.input, "string", "input stays a string (single user text piece)");
});

test("provider mode: opaque items (additional_tools) survive the responses rebuild", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const ctx = fakeCtx({ model: { contextWindow: 1_000_000, api: "openai-responses" } });

  const payload = { model: "gpt-x", input: [
    { type: "additional_tools", tools: [{ type: "web_search" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: `q ${FILLER}` }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: `a ${FILLER}` }] },
  ] };
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx);
  const out = (await fire()) as { input: Array<Record<string, any>> };
  const flat = JSON.stringify(out.input);
  assert.ok(flat.includes("additional_tools"), "opaque item survives the rebuild");
  assert.ok(flat.includes("web_search"), "opaque item content survives");
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

  // anthropic-messages, ollama-chat, and openai-responses: the host applies
  // the replacement → provider.
  for (const api of ["anthropic-messages", "ollama-chat", "openai-responses"] as const) {
    const handlers = make();
    const r1 = await fireCtx(handlers, model(api));
    assert.equal(r1, undefined, `default+${api}: context handler is an observer`);
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model(api));
    assert.ok(r2, `default+${api}: provider handler transforms the wire payload`);
  }

  // Missing api → context.
  {
    const handlers = make();
    const r1 = await fireCtx(handlers, model(undefined));
    assert.ok(r1?.messages, "default+(no api): context handler transforms");
    const r2 = await handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: wire() }, model(undefined));
    assert.equal(r2, undefined, "default+(no api): provider handler is a no-op");
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
