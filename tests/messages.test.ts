import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToCoreMessages, coreOutToAgentMessages, matchesStoredText, messageIdentity, streamToCoreMessages, findCompressCalls } from "../src/messages.js";
import { viableRanges } from "billion-context-kit";
import type { CoreMessage } from "acp-kernel";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";

const LT = "\x3c";
const GT = "\x3e";
function acpRef(ref: string, tokens = "2", type = "text"): string {
  return LT + 'acp tokens="' + tokens + '" type="' + type + '"' + GT + ref + LT + "/acp" + GT;
}

function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}

function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function userBlocks(text: string): object {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistantToolCall(name: string): object {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name, arguments: {} }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function assistantParallelToolCalls(calls: { id: string; name: string; args?: unknown }[]): object {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Running multiple tools" },
      ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function toolResult(callId: string, name: string, text: string): object {
  return { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

test("entriesToCoreMessages projects user/assistant/toolResult roles and extracts text", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello world")),
    msgEntry("b", userBlocks("block text")),
    msgEntry("c", assistantToolCall("read")),
    msgEntry("d", toolResult("tc1", "read", "file contents")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "hello world");
  assert.equal(core[1]!.text, "block text");
  assert.equal(core[2]!.role, "assistant");
  assert.equal(core[2]!.contentType, "tool-call");
  assert.equal(core[2]!.toolName, "read");
  assert.equal(core[3]!.role, "tool");
  assert.equal(core[3]!.contentType, "tool-result");
  assert.equal(core[3]!.text, "file contents");
});

function assistantThinkingOnly(thinking: string): object {
  return { role: "assistant", content: [{ type: "thinking", thinking }], timestamp: Date.now() };
}
function assistantThinkingAndText(thinking: string, text: string): object {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }, { type: "text", text }],
    timestamp: Date.now(),
  };
}

test("entriesToCoreMessages drops thinking-only assistant turns (no empty assistant text → no provider 400)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    msgEntry("b", assistantThinkingOnly("internal reasoning, no output") as object),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "thinking-only assistant dropped, not emitted as empty text");
  assert.ok(
    !core.some((m) => m.role === "assistant" && (!m.text || !m.text.trim())),
    "no empty-text assistant message in output",
  );
});

test("entriesToCoreMessages keeps assistant turn that has thinking AND text (text extracted, thinking ignored)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", assistantThinkingAndText("private reasoning", "visible answer") as object),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "assistant");
  assert.equal(core[0]!.contentType, "text");
  assert.equal(core[0]!.text, "visible answer", "text kept, thinking block not inlined");
});

test("entriesToCoreMessages drops assistant turn whose text is whitespace-only", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    msgEntry("b", { role: "assistant", content: [{ type: "text", text: "   \n  " }], timestamp: Date.now() } as object),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "whitespace-only assistant dropped");
});

function customEntry(id: string, customType: string, content: string | unknown[]): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    content,
  } as SessionEntry;
}

test("entriesToCoreMessages projects custom_message as user message (string content)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello")),
    customEntry("b", "subagent_result", "Sub-agent test completed (6s)."),
    msgEntry("c", user("ok")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 3, "all 3 entries projected");
  assert.equal(core[1]!.id, "b");
  assert.equal(core[1]!.role, "user", "custom_message projected as user");
  assert.equal(core[1]!.contentType, "text");
  assert.equal(core[1]!.text, "Sub-agent test completed (6s).");
});

test("entriesToCoreMessages projects custom_message with array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [{ type: "text", text: "Array content here" }]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "Array content here");
});

test("entriesToCoreMessages drops custom_message with empty content", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    customEntry("b", "subagent_result", ""),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "empty custom_message skipped");
});

test("entriesToCoreMessages extracts only text blocks from array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [
      { type: "text", text: "visible text" },
      { type: "image", url: "https://example.com/img.png" },
      { type: "text", text: "more text" },
    ]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1, "entry projected");
  assert.equal(core[0]!.text, "visible text\nmore text", "only text blocks extracted, joined with newline");
});

test("entriesToCoreMessages drops custom_message with non-text-only array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [{ type: "image", url: "https://example.com/img.png" }]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 0, "non-text array content yields empty text → skipped");
});

test("custom_message round-trip: entriesToCoreMessages → collectOriginals → coreOutToAgentMessages preserves user role", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello")),
    customEntry("b", "subagent_result", "Sub-agent test completed (6s)."),
    msgEntry("c", user("ok")),
  ];

  // Step 1: entries → CoreMessage[]
  const coreMessages = entriesToCoreMessages(entries);

  // Step 2: simulate collectOriginals (mirrors src/index.ts collectOriginals logic)
  // For message entries, the original is entry.message.
  // For custom_message entries, the original is projected as a user AgentMessage
  // (NOT role:"custom", which Pi would silently drop).
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  for (const entry of entries) {
    if (entry.type === "message") {
      originalById.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      originalById.set(entry.id, { role: "user", content } as SessionMessageEntry["message"]);
    }
  }

  // Step 3: coreOutToAgentMessages restores from originalById
  const out = coreOutToAgentMessages(coreMessages, originalById);

  // The custom_message (id "b") should be restored as role:"user", not role:"custom"
  const customOut = out.find((m) => (m as { role?: string }).role === "user" &&
    Array.isArray((m as { content?: unknown[] }).content) &&
    ((m as { content: Array<{ type?: string; text?: string }> }).content.some((b) => b.text?.includes("Sub-agent test"))));
  assert.ok(customOut, "custom_message restored as a user message");
  assert.equal((customOut as { role: string }).role, "user", "role is user, not custom");

  // Ensure no role:"custom" in output (that would be silently dropped by Pi)
  const customs = out.filter((m) => (m as { role?: string }).role === "custom");
  assert.equal(customs.length, 0, "no role:custom messages in output");
});

test("entriesToCoreMessages still skips compaction and model_change", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("alpha")),
    { type: "compaction", id: "x", parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "a", tokensBefore: 0 } as SessionEntry,
    { type: "model_change", id: "y", parentId: null, timestamp: "", provider: "p", modelId: "m" } as unknown as SessionEntry,
    msgEntry("b", user("beta")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b"]);
});

test("entriesToCoreMessages preserves omp execution roles (bashExecution/pythonExecution) as user text instead of dropping them", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", { role: "user", content: "run ls", timestamp: Date.now() }),
    msgEntry("b", { role: "bashExecution", command: "ls -la", output: [{ type: "text", text: "file1\nfile2" }], exitCode: 0, timestamp: Date.now() } as object),
    msgEntry("c", { role: "pythonExecution", command: "print('hi')", output: "hi", exitCode: 0, timestamp: Date.now() } as object),
    msgEntry("d", { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() } as object),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b", "c", "d"], "no messages dropped");
  const b = core[1]!;
  assert.equal(b.role, "user");
  assert.ok(b.text!.includes("$ ls -la"), "command rendered as $ command");
  assert.ok(b.text!.includes("file1"), "output text preserved");
  const c = core[2]!;
  assert.equal(c.role, "user");
  assert.ok(c.text!.includes("print('hi')"));
  assert.ok(c.text!.includes("hi"));
});

test("entriesToCoreMessages prefers content over fallback fields when an omp role carries both", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", { role: "bashExecution", content: [{ type: "text", text: "primary text" }], command: "should-not-appear", output: "neither", timestamp: Date.now() } as object),
  ];
  const core = entriesToCoreMessages(entries);
  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "primary text");
});

test("coreOutToAgentMessages patches the ref tag onto original messages", () => {
  const tag = acpRef("m00001") + "\n";
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: tag + "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]!.type, "text");
  assert.ok(content[0]!.text.includes("hello"), "content includes original text");
  assert.ok(content[0]!.text.includes("m00001"), "content includes ref id");
  assert.equal(content.length, 1, "tag embedded in single text block, not separate");
});

test("coreOutToAgentMessages honors kernel-truncated body instead of original (emergency truncate)", () => {
  const tag = acpRef("m00002", "13K", "tool:bash") + "\n";
  const full = "X".repeat(50000);
  const truncatedBody = "PREFIX".repeat(100) + "\n\n...[truncated for context space]...\n\nSUFFIX";
  const original = msgEntry("t", toolResult("tc1", "bash", full)).message;
  const originalById = new Map([["t", original]]);
  const coreOut: CoreMessage[] = [
    { id: "t", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc1", text: tag + truncatedBody },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const msg = out[0] as { role: string; toolCallId: string; toolName: string; content: Array<{ type: string; text: string }> };
  assert.equal(msg.role, "toolResult", "role preserved");
  assert.equal(msg.toolCallId, "tc1", "toolCallId preserved");
  const text = msg.content.find((b) => b.type === "text")!.text;
  assert.ok(text.includes("[truncated for context space]"), "truncation marker present in rebuilt body");
  assert.ok(!text.includes("X".repeat(100)), "full original body not emitted");
  assert.ok(text.includes("m00002"), "ref tag preserved");
  assert.ok(text.length < full.length, "body is shorter than original");
});

test("coreOutToAgentMessages does NOT rebuild when non-truncated body starts with newlines (no false positive)", () => {
  const tag = acpRef("m00003", "2", "tool:bash") + "\n";
  const body = "\n\nbash output line";
  const original = msgEntry("n", toolResult("tc3", "bash", body)).message;
  const originalById = new Map([["n", original]]);
  const coreOut: CoreMessage[] = [
    { id: "n", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc3", text: tag + body },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const text = (out[0] as { content: Array<{ type: string; text: string }> }).content.find((b) => b.type === "text")!.text;
  assert.ok(text.startsWith("\n\nbash output line"), "leading newlines preserved (no false rebuild)");
  assert.ok(!text.includes("[truncated"), "no truncation marker on non-truncated message");
  assert.ok(text.includes("m00003"), "ref tag still appended");
});

test("coreOutToAgentMessages honors kernel-truncated body for string-content tool results", () => {
  const tag = acpRef("m00004", "13K", "tool:bash") + "\n";
  const full = "Y".repeat(40000);
  const truncatedBody = "PRE".repeat(80) + "\n\n...[truncated for context space]...\n\nEND";
  const original = {
    role: "toolResult",
    toolCallId: "tc4",
    toolName: "bash",
    content: full,
    isError: false,
    timestamp: Date.now(),
  };
  const originalById = new Map([["s", original as SessionMessageEntry["message"]]]);
  const coreOut: CoreMessage[] = [
    { id: "s", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc4", text: tag + truncatedBody },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const msg = out[0] as { role: string; content: string };
  assert.equal(msg.role, "toolResult");
  assert.equal(typeof msg.content, "string", "string content preserved as string");
  assert.ok(msg.content.includes("[truncated for context space]"), "truncated body present");
  assert.ok(!msg.content.includes("Y".repeat(100)), "full original not emitted");
  assert.ok(msg.content.includes("m00004"), "ref tag preserved");
});

test("truncation matching requires the OMP marker", () => {
  assert.equal(matchesStoredText("a\nb", "a\nb"), false);
  assert.equal(matchesStoredText("a\nb", "a\nb\nc"), false);
  assert.equal(matchesStoredText("a\nb", "a\n\nb"), false);
});

test("coreOutToAgentMessages returns original unchanged when no ref tag is present", () => {
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out[0], original, "un-tagged message returned by reference, untouched");
});

test("coreOutToAgentMessages filters out synthetic summary messages (compress-as-anchor)", () => {
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  const coreOut: CoreMessage[] = [
    { id: "acp_summary_b0", role: "system", contentType: "text", text: "[Compressed conversation section]\nbody" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 0, "synthetic summary messages should be filtered out");
});

test("coreOutToAgentMessages reconstructs parallel tool-call assistant message from split core messages", () => {
  const assistantMsg = assistantParallelToolCalls([
    { id: "call_a", name: "read" },
    { id: "call_b", name: "write" },
    { id: "call_c", name: "list" },
  ]);
  const originalById = new Map([["entry1", assistantMsg as SessionMessageEntry["message"]]]);

  const tag = acpRef("m00003");
  const coreOut: CoreMessage[] = [
    { id: "entry1#call_a", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_a", text: tag + "\nRunning multiple tools\n{}" },
    { id: "entry1#call_b", role: "assistant", contentType: "tool-call", toolName: "write", toolCallId: "call_b", text: tag + "\n{}" },
    { id: "entry1#call_c", role: "assistant", contentType: "tool-call", toolName: "list", toolCallId: "call_c", text: tag + "\n{}" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 1, "3 split tool-calls merge into 1 assistant message");

  const content = (out[0] as { content: Array<{ type: string; id?: string; text?: string }> }).content;
  const toolCalls = content.filter((b) => b.type === "toolCall");
  assert.equal(toolCalls.length, 3, "all 3 toolCall blocks preserved");
  assert.deepEqual(toolCalls.map((b) => b.id), ["call_a", "call_b", "call_c"]);

  const textBlocks = content.filter((b) => b.type === "text");
  assert.ok(textBlocks.length >= 1, "text block preserved");
  assert.ok(!textBlocks[0]!.text!.includes("m00003"), "assistant message: no tag injected (skip applied)");
});

test("coreOutToAgentMessages drops pruned tool-call blocks when only some survive", () => {
  const assistantMsg = assistantParallelToolCalls([
    { id: "call_a", name: "read" },
    { id: "call_b", name: "write" },
    { id: "call_c", name: "list" },
  ]);
  const originalById = new Map([["entry1", assistantMsg as SessionMessageEntry["message"]]]);

  const coreOut: CoreMessage[] = [
    { id: "entry1#call_a", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_a", text: "[m00003] {}" },
    { id: "entry1#call_c", role: "assistant", contentType: "tool-call", toolName: "list", toolCallId: "call_c", text: "[m00003] {}" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 1);

  const content = (out[0] as { content: Array<{ type: string; id?: string }> }).content;
  const toolCalls = content.filter((b) => b.type === "toolCall");
  assert.equal(toolCalls.length, 2, "only 2 surviving tool-call blocks");
  assert.deepEqual(toolCalls.map((b) => b.id), ["call_a", "call_c"]);
});

test("message identity ignores tag-only text blocks but preserves original empty blocks", () => {
  const image = { type: "image", data: "same", mimeType: "image/png" };
  const tag = acpRef("m00042");
  const taggedImage = { role: "user", content: [image, { type: "text", text: tag }], timestamp: 1 };
  const imageOnly = { role: "user", content: [image], timestamp: 2 };
  const emptyText = { role: "user", content: [image, { type: "text", text: "" }], timestamp: 3 };
  assert.equal(messageIdentity(taggedImage), messageIdentity(imageOnly));
  assert.notEqual(messageIdentity(emptyText), messageIdentity(imageOnly));
});
test("message identity ignores omp metadata fields (attribution, usage, stopReason, etc.)", () => {
  const baseContent = [{ type: "text", text: "hello world" }];

  const liveUser = { attribution: "user", content: baseContent, role: "user", timestamp: 1 };
  const persistedUser = { content: baseContent, role: "user", timestamp: 2 };
  assert.equal(messageIdentity(liveUser), messageIdentity(persistedUser),
    "user messages with/without attribution must match");

  const liveAssistant = { role: "assistant", content: baseContent, timestamp: 1 };
  const persistedAssistant = {
    role: "assistant", content: baseContent, timestamp: 2,
    api: "openai-completions", contextSnapshot: { promptTokens: 50000 },
    duration: 1234, model: "glm-5.2", provider: "zhipuai",
    responseId: "resp_123", stopReason: "end_turn", ttft: 567,
    usage: { input: 50000, output: 1000, totalTokens: 51000 },
  };
  assert.equal(messageIdentity(liveAssistant), messageIdentity(persistedAssistant),
    "assistant messages with/without provider metadata must match");

  const liveTool = { role: "toolResult", content: baseContent, toolName: "bash", toolCallId: "call_1", timestamp: 1 };
  const persistedTool = { role: "toolResult", content: baseContent, toolName: "bash", toolCallId: "call_1",
    details: { exitCode: 0 }, isError: false, timestamp: 2 };
  assert.equal(messageIdentity(liveTool), messageIdentity(persistedTool),
    "tool results with/without details/isError must match");

  const msgA = { role: "user", content: [{ type: "text", text: "hello" }] };
  const msgB = { role: "user", content: [{ type: "text", text: "goodbye" }] };
  assert.notEqual(messageIdentity(msgA), messageIdentity(msgB),
    "different content must still produce different identities");
});

test("streamToCoreMessages assigns position ids p1..pN in order", () => {
  const stream = [
    userBlocks("first question"),
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    userBlocks("second question"),
  ] as SessionMessageEntry["message"][];
  const cores = streamToCoreMessages(stream);
  assert.equal(cores.length, 3);
  assert.deepEqual(cores.map((c) => c.id), ["p1", "p2", "p3"]);
  assert.equal(cores[0]!.text, "first question");
  assert.equal(cores[2]!.text, "second question");
});

test("streamToCoreMessages splits multi tool-call assistants into stable position ids", () => {
  const stream = [
    userBlocks("run two tools"),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "tc2", name: "read", arguments: { path: "x" } },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: "out1" }], toolName: "bash", toolCallId: "tc1" },
    { role: "toolResult", content: [{ type: "text", text: "out2" }], toolName: "read", toolCallId: "tc2" },
  ] as SessionMessageEntry["message"][];
  const cores = streamToCoreMessages(stream);
  const ids = cores.map((c) => c.id).join(",");
  assert.ok(ids.includes("p2#tc1") && ids.includes("p2#tc2"), `ids: ${ids}`);
  assert.equal(cores.filter((c) => c.role === "tool").length, 2);
});

test("streamToCoreMessages keeps plain position id for single-tool assistants", () => {
  const stream = [
    userBlocks("run one tool"),
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }] },
    { role: "toolResult", content: [{ type: "text", text: "out1" }], toolName: "bash", toolCallId: "tc1" },
  ] as SessionMessageEntry["message"][];
  const cores = streamToCoreMessages(stream);
  assert.deepEqual(cores.map((c) => c.id), ["p1", "p2", "p3"]);
});

test("streamToCoreMessages projects compactionSummary with the synthetic marker (issue #35: never compressible)", () => {
  const stream = [
    { role: "compactionSummary", summary: "  prior work summarized here  ", shortSummary: "s", tokensBefore: 80000, timestamp: Date.now() },
    userBlocks("after compaction"),
  ] as SessionMessageEntry["message"][];
  const cores = streamToCoreMessages(stream);
  const [first, second] = cores;
  assert.ok(first, "compaction message projected");
  assert.ok(first.text, "projected as text");
  assert.ok(first.text.startsWith("[Compressed conversation section]"), "summary carries the kernel synthetic marker");
  assert.ok(first.text.includes("prior work summarized here"), "summary text preserved");
  assert.equal(second?.text, "after compaction");
});

test("streamToCoreMessages projects branchSummary with the synthetic marker", () => {
  const stream = [
    { role: "branchSummary", summary: "abandoned branch recap", fromId: "x", timestamp: Date.now() },
  ] as SessionMessageEntry["message"][];
  const cores = streamToCoreMessages(stream);
  const first = cores[0];
  assert.ok(first, "branch summary projected");
  assert.ok(first.text, "projected as text");
  assert.ok(first.text.startsWith("[Compressed conversation section]"));
  assert.ok(first.text.includes("abandoned branch recap"));
});

test("streamToCoreMessages drops compactionSummary with empty summary", () => {
  const stream = [
    { role: "compactionSummary", summary: "   ", tokensBefore: 1, timestamp: Date.now() },
    userBlocks("next"),
  ] as SessionMessageEntry["message"][];
  const cores = streamToCoreMessages(stream);
  assert.equal(cores.length, 1);
  assert.equal(cores[0]?.id, "p2");
});

test("findCompressCalls extracts ranges from assistant compress tool calls", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_1", name: "compress", arguments: JSON.stringify({
        content: [{ startId: "m00003", endId: "m00009", summary: "covered early exploration", topic: "exploration" }],
      }) },
    ],
  };
  const calls = findCompressCalls(assistant as unknown as SessionMessageEntry["message"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "call_1");
  assert.equal(calls[0]!.ranges.length, 1);
  const r = calls[0]!.ranges[0]!;
  assert.equal(r.compressCallId, "call_1");
  assert.equal(r.startRef, "m00003");
  assert.equal(r.endRef, "m00009");
  assert.equal(r.summary, "covered early exploration");
  assert.equal(r.topic, "exploration");
});

test("findCompressCalls salvages truncated compress arguments (issue #121)", () => {
  // Weak/local model stream cut mid-args: strict JSON.parse fails, the old
  // compressToolArgs returned null and the compress call silently vanished
  // from replay. The kernel salvage ladder must recover the complete entry.
  // Cut AFTER the first entry closes but mid-way through the second entry —
  // the wrapper never closes, so strict JSON.parse fails on the whole payload
  // while the balanced first entry is still recoverable by the brace scanner.
  const truncated =
    '{"content":[{"startId":"m00010","endId":"m00020","summary":"salvaged complete summary entry for the truncated replay test."},{"startId":"m00';
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_trunc", name: "compress", arguments: truncated },
    ],
  };
  const calls = findCompressCalls(assistant as unknown as SessionMessageEntry["message"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "call_trunc");
  assert.equal(calls[0]!.ranges.length, 1);
  const r = calls[0]!.ranges[0]!;
  assert.equal(r.startRef, "m00010");
  assert.equal(r.endRef, "m00020");
  assert.ok(r.summary.length > 0);
});

test("findCompressCalls still drops unparseable garbage arguments", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_garbage", name: "compress", arguments: "not json at all, just words" },
    ],
  };
  const calls = findCompressCalls(assistant as unknown as SessionMessageEntry["message"]);
  assert.equal(calls.length, 0);
});

test("findCompressCalls recognizes omp xd://compress write-device invocations", () => {
  // omp mounts extension tools as xd:// devices: the model calls the write
  // tool with path xd://compress and the compress args JSON-encoded in content.
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_xd1", name: "write", arguments: {
        path: "xd://compress",
        content: JSON.stringify({ content: [{ startId: "m00002", endId: "m00004", summary: "xd device compress call summary for the replay test." }] }),
        intent: "compress old range",
      } },
    ],
  };
  const calls = findCompressCalls(assistant as unknown as SessionMessageEntry["message"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "call_xd1");
  const r = calls[0]!.ranges[0]!;
  assert.equal(r.startRef, "m00002");
  assert.equal(r.endRef, "m00004");
  assert.equal(r.summary, "xd device compress call summary for the replay test.");

  // object (pre-decoded) content form
  const assistantObj = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_xd2", name: "write", arguments: {
        path: "xd://compress",
        content: { content: [{ startId: "m00001", endId: "m00001", summary: "object form of the xd compress invocation." }] },
      } },
    ],
  };
  const calls2 = findCompressCalls(assistantObj as unknown as SessionMessageEntry["message"]);
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0]!.ranges[0]!.startRef, "m00001");

  // other xd:// devices and plain file writes are not compress calls
  const other = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "w1", name: "write", arguments: { path: "xd://acp_status", content: "{}" } },
      { type: "toolCall", id: "w2", name: "write", arguments: { path: "src/index.ts", content: "export {}" } },
      { type: "toolCall", id: "w3", name: "write", arguments: { path: "xd://compress", content: "not json {" } },
    ],
  };
  assert.equal(findCompressCalls(other as unknown as SessionMessageEntry["message"]).length, 0);
});

test("findCompressCalls accepts already-object arguments and skips empty ranges", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_2", name: "compress", arguments: {
        content: [{ startId: "m00001", endId: "m00002", summary: "s" }, { summary: "empty item no ids" }],
      } },
    ],
  };
  const calls = findCompressCalls(assistant as unknown as SessionMessageEntry["message"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ranges.length, 1);
  assert.equal(calls[0]!.ranges[0]!.startRef, "m00001");

  const none = findCompressCalls({ role: "user", content: [{ type: "text", text: "hi" }] } as SessionMessageEntry["message"]);
  assert.equal(none.length, 0);
});
import { rangeFingerprints, spanFingerprint } from "../src/messages.js";

test("spanFingerprint binds the exact split piece at a parallel-toolcall boundary", async () => {
  const big = "x".repeat(600);
  const stream = [
    user("task " + big),
    assistantParallelToolCalls([
      { id: "callAAA", name: "read", args: { path: "a.ts" } },
      { id: "callBBB", name: "read", args: { path: "b.ts" } },
    ]),
    toolResult("callAAA", "read", "result-a " + big),
    toolResult("callBBB", "read", "result-b " + big),
  ];
  const core = streamToCoreMessages(stream as never);
  // position of the parallel message's split pieces
  const pieceA = core.find((c) => c.id === "p2#callAAA");
  const pieceB = core.find((c) => c.id === "p2#callBBB");
  assert.ok(pieceA && pieceB, "split pieces expected");
  const byRef: Record<string, string> = { m00002: "p2#callAAA", m00003: "p2#callBBB", m00004: "p3" };
  // fingerprint starting at m00002 must hash pieceA's text (exact id), not
  // whatever piece lands last at position 2
  const fpA = spanFingerprint(core, "p2#callAAA", "p3");
  const fpB = spanFingerprint(core, "p2#callBBB", "p3");
  assert.notEqual(fpA, fpB, "two different pieces must fingerprint differently");
  const fps = rangeFingerprints([{ startRef: "m00002", endRef: "m00004" }], core, byRef, []);
  assert.equal(fps[0], fpA, `range starting at m00002 must bind pieceA exactly (got ${fps[0]} want ${fpA})`);
});

test("viableRanges drops isolated sub-summary-floor ranges, keeps the rest", () => {
  const mk = (tokens: number) => ({ startRef: "x", endRef: "y", tokens });
  const out = viableRanges([mk(16), mk(199), mk(200), mk(29551)]);
  assert.deepEqual(out.map((r) => r.tokens), [200, 29551]);
});
