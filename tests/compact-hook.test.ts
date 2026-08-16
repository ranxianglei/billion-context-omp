import { mock, test } from "bun:test";
import assert from "node:assert/strict";

interface Captured {
  systemPrompt: string[];
  userText: string;
  maxTokens: number;
}

let captured: Captured | undefined;
let llmCalls = 0;
let responses: string[] = ['{"summary": "FULL DIGEST COVERING EVERYTHING"}'];
let seq = 0;

mock.module("@oh-my-pi/pi-ai", () => ({
  complete: async (
    _model: unknown,
    payload: { systemPrompt: string[]; messages: { content: { type: string; text: string }[] }[] },
    opts: { maxTokens?: number },
  ) => {
    llmCalls++;
    const response = responses[Math.min(seq, responses.length - 1)] ?? "";
    seq++;
    captured = {
      systemPrompt: payload.systemPrompt,
      userText: payload.messages[0]!.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      maxTokens: opts?.maxTokens ?? -1,
    };
    return { content: [{ type: "text", text: response }] };
  },
}));

const { createAcpExtension } = await import("../src/index.js");

interface MockApi {
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  tools: unknown[];
  commands: Map<string, unknown>;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
}

function captureApi(): { api: MockApi; handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>> } {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const api: MockApi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [],
    commands: new Map(),
    registerTool(tool) {
      this.tools.push(tool);
    },
    registerCommand(name, options) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

function compactCtx() {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, provider: "test", id: "m1" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    },
    sessionManager: {
      getSessionId: () => "compact-test",
      getSessionFile: () => "/tmp/nonexistent.session.json",
    },
  };
}

function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function compressCallMsg(summary: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "write",
        arguments: JSON.stringify({
          path: "xd://compress",
          content: JSON.stringify({ content: [{ startId: "m00002", endId: "m00003", summary }] }),
        }),
      },
    ],
    timestamp: Date.now(),
  };
}

function preparation() {
  return {
    firstKeptEntryId: "entry-9",
    tokensBefore: 12_345,
    previousSummary: "OLD COMPACT SUMMARY MUST SURVIVE",
    messagesToSummarize: [
      userMsg("gap content A before the old block"),
      compressCallMsg("PRIOR BLOCK SUMMARY ABOUT DATABASE"),
      userMsg("gap content B after the old block"),
    ],
    turnPrefixMessages: [userMsg("turn prefix content")],
    recentMessages: [userMsg("kept recent content")],
    isSplitTurn: false,
    fileOps: { read: [], edited: [] },
    settings: {},
  };
}

function fire(api: MockApi, handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>>, event: unknown, ctx: unknown) {
  void api;
  const handler = handlers.get("session_before_compact")![0]!;
  return handler(event, ctx);
}

test("/compact summarizes ALL discarded content — gap, prior compress-call summaries, turn prefix", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as never);
  const result = (await fire(api, handlers, { type: "session_before_compact", preparation: preparation(), customInstructions: "focus on auth" }, compactCtx())) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  };
  assert.ok(result, "handler must return a compaction result");
  assert.equal(result.compaction.summary, "FULL DIGEST COVERING EVERYTHING");
  assert.equal(result.compaction.firstKeptEntryId, "entry-9", "native cutoff passthrough");
  assert.equal(result.compaction.tokensBefore, 12_345);
  // Regression: omp truncates EVERYTHING before firstKeptEntryId from the LLM
  // view, so the summary prompt must include all of it — not a selected span.
  const text = captured!.userText;
  assert.ok(text.includes("gap content A"), "gap before old block must be covered");
  assert.ok(text.includes("gap content B"), "gap after old block must be covered");
  assert.ok(text.includes("PRIOR BLOCK SUMMARY ABOUT DATABASE"), "prior in-stream compress call (block summary carrier) must be covered");
  assert.ok(text.includes("turn prefix content"), "turnPrefixMessages must be covered");
  assert.ok(!text.includes("kept recent content"), "recentMessages are kept in full — must not be compressed");
  // previousSummary is folded in so iterative compactions never lose it.
  assert.ok(captured!.systemPrompt.join("\n").includes("PREVIOUS compaction"), "previousSummary handling must be instructed");
  assert.ok(captured!.systemPrompt.join("\n").includes("focus on auth"), "customInstructions must reach the prompt");
  assert.equal(captured!.maxTokens, 8000, "output budget raised: 3000 truncated long compactions mid-JSON");
});

test("/compact succeeds immediately when preparation is empty (nothing at stake)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as never);
  const callsBefore = llmCalls;
  const result = await fire(api, handlers, { type: "session_before_compact", preparation: { firstKeptEntryId: "x", tokensBefore: 100 } }, compactCtx());
  assert.equal(result, undefined, "no messagesToSummarize → nothing to do");
  assert.equal(llmCalls, callsBefore, "no LLM call for empty preparation");
});

test("/compact retries once and recovers when the first response is unparseable", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as never);
  const prev = responses;
  responses = ["total garbage, not json, too short??", '{"summary": "RETRY RECOVERED FULL DIGEST"}'];
  seq = 0;
  try {
    const callsBefore = llmCalls;
    const result = (await fire(api, handlers, { type: "session_before_compact", preparation: preparation() }, compactCtx())) as {
      compaction: { summary: string };
    };
    assert.ok(result, "second attempt must produce the compaction");
    assert.equal(result.compaction.summary, "RETRY RECOVERED FULL DIGEST");
    assert.equal(llmCalls - callsBefore, 2, "exactly two LLM calls (initial + one retry)");
  } finally {
    responses = prev;
  }
});

test("long plain-prose output is accepted as the summary (weak-model tolerance)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as never);
  const prev = responses;
  const prose = "The session covered authentication work: token refresh in lib/auth.ts:45, a retry loop fix, and three passing regression tests. " +
    "Key decision: keep the cache keyed by session id because the alternative broke prefix reuse.";
  responses = [prose];
  seq = 0;
  try {
    const result = (await fire(api, handlers, { type: "session_before_compact", preparation: preparation() }, compactCtx())) as {
      compaction: { summary: string };
    };
    assert.ok(result, "prose ≥50 chars is a usable summary");
    assert.equal(result.compaction.summary, prose);
  } finally {
    responses = prev;
  }
});

test("/compact cancels (no native fallback) when the retry also fails", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension()(api as never);
  const prev = responses;
  responses = ["??", "!!"];
  seq = 0;
  try {
    const callsBefore = llmCalls;
    const result = (await fire(api, handlers, { type: "session_before_compact", preparation: preparation() }, compactCtx())) as { cancel?: boolean };
    assert.deepEqual(result, { cancel: true }, "hard failure → compaction cancelled, native path never runs");
    assert.equal(llmCalls - callsBefore, 2, "initial + one retry, then stop");
  } finally {
    responses = prev;
  }
});

test("/compact cancels when no model resolves (no silent native compaction)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ compress: { compressModel: "nope:missing" } })(api as never);
  const callsBefore = llmCalls;
  const result = (await fire(api, handlers, { type: "session_before_compact", preparation: preparation() }, compactCtx())) as { cancel?: boolean };
  assert.deepEqual(result, { cancel: true }, "unresolvable model → cancel, never native");
  assert.equal(llmCalls, callsBefore, "no LLM call when model does not resolve");
});

test("summarizeMessages renders stable mNNNNN refs when fold refs are provided (issue #14 Minor1)", async () => {
  const { summarizeMessages } = await import("../src/auto-compress.js");
  const stream = [
    { role: "user", content: [{ type: "text", text: "hello world message body" }], timestamp: Date.now() },
  ];
  const prompts = { compressPhilosophy: "P", howToCompressRules: "R" } as never;
  const result = await summarizeMessages(compactCtx() as never, stream as never, prompts, undefined, {
    completeFn: (async (_m: unknown, payload: { systemPrompt: string[]; messages: { content: { type: string; text: string }[] }[] }) => {
      captured = {
        systemPrompt: payload.systemPrompt,
        userText: payload.messages[0]!.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
        maxTokens: 8000,
      };
      return { content: [{ type: "text", text: '{"summary": "FULL DIGEST COVERING EVERYTHING"}' }] };
    }) as never,
    messageRefs: { byRaw: { p1: "m00001" }, byRef: { m00001: "p1" } },
  });
  assert.ok(result, "summarize succeeds");
  assert.match(captured!.userText, /\[m00001\] user: hello world/, "stable m-ref rendered");
  assert.doesNotMatch(captured!.userText, /\[p1\]/, "raw position id must not be shown");
});
