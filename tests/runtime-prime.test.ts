import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import type { AgentMessage } from "../src/messages.js";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const FILLER = "filler ".repeat(1200);

function makeStream(withCompression: boolean): AgentMessage[] {
  const assistantBase = { api: "anthropic" as const, provider: "anthropic" as const, model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
  const stream: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "kick " + FILLER }], timestamp: Date.now() },
  ];
  if (withCompression) {
    stream.push(
      {
        role: "assistant",
        ...assistantBase,
        content: [{ type: "toolCall", id: "call_c1", name: "compress", arguments: { content: [{ startId: "m00001", endId: "m00001", summary: "Opener consumed by compression for the test harness run. ".repeat(4) }] } as Record<string, unknown> }],
      },
      { role: "toolResult", content: [{ type: "text", text: "Compressed 1 range — 1.2k tokens saved" }], toolName: "compress", toolCallId: "call_c1", isError: false, timestamp: Date.now() },
    );
  }
  stream.push({ role: "assistant", ...assistantBase, content: [{ type: "text", text: "done" }] });
  for (let i = 0; i < 6; i++) {
    stream.push(
      { role: "user", content: [{ type: "text", text: `turn ${i} ` + FILLER }], timestamp: Date.now() },
      { role: "assistant", ...assistantBase, content: [{ type: "text", text: `ack ${i}` }] },
    );
  }
  return stream;
}

function makeCtx(stream: AgentMessage[]): ExtensionContext {
  return {
    cwd: "/tmp",
    model: { contextWindow: 200_000 },
    sessionManager: {
      getSessionId: () => "prime-test",
      getSessionFile: () => "/tmp/prime-test.json",
      buildSessionContext: () => ({ messages: stream }),
    },
  } as unknown as ExtensionContext;
}

test("primeFold: blocks visible at session_start, before any LLM call", async () => {
  const runtime = createRuntime({} as never);
  const persisted = makeStream(true);
  runtime.primeFold(makeCtx(persisted));

  const { state } = await runtime.stateFor(makeCtx(persisted));
  assert.equal(state.blocks.length, 1, "block replayed from persisted view");
  assert.equal(state.blocks[0]!.tier, 1);
});

test("primeFold: first live context event re-folds authoritatively (preview never leaks)", () => {
  const runtime = createRuntime({} as never);
  const persisted = makeStream(true);
  runtime.primeFold(makeCtx(persisted));

  const live = makeStream(true);
  const r1 = runtime.foldStream(makeCtx(live), live);
  assert.equal(r1.state.blocks.length, 1);
  assert.notEqual(r1.state.blocks[0]!.blockId, "", "authoritative block exists");

  // An appended message afterwards must NOT trigger another replay of the
  // already-applied call (appliedCallIds of the authoritative fold).
  const grown = [...live, { role: "user", content: [{ type: "text", text: "next " + FILLER }] }] as AgentMessage[];
  const r2 = runtime.foldStream(makeCtx(grown), grown);
  assert.equal(r2.state.blocks.length, 1);
});

test("primeFold: empty persisted view is a no-op; failures swallowed", async () => {
  const runtime = createRuntime({} as never);
  runtime.primeFold(makeCtx([]));
  const { state } = await runtime.stateFor(makeCtx([]));
  assert.equal(state.blocks.length, 0);

  const bad = makeCtx([]);
  (bad.sessionManager as unknown as { buildSessionContext: () => never }).buildSessionContext = () => {
    throw new Error("boom");
  };
  runtime.primeFold(bad);
});
