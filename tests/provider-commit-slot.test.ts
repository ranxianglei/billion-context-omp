import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Regression (issue #90): in provider mode stateFor serves the CORE slot, but
// the compress tool committed its result into the CONTEXT slot (never folded
// in this mode) — decompress/acp_status/search_context saw the pre-compression
// state until the next provider request replayed the call, and the reject
// streak lived in the same split-brain slot. A commit must land where the next
// read goes, and the streak must survive core-space re-folds (wire view
// flips), mirroring the context-space contract in compress-loop-guard.test.ts.

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
      getSessionId: () => "provider-commit-slot",
      getSessionFile: () => "/tmp/nonexistent-omp-pcs.session.json",
    },
  } as unknown as ExtensionContext;
}

const FILLER = "lorem ipsum dolor sit amet ".repeat(160); // ~4.4K chars ≈ 1.1K tokens

function fillerMsg(role: "user" | "assistant", seed: string): Record<string, unknown> {
  return { role, content: [{ type: "text", text: `${seed} ${FILLER}` }] };
}

function anthropicPayload(msgs: Array<Record<string, unknown>>): Record<string, unknown> {
  return { model: "claude-x", max_tokens: 8192, system: "sys", messages: msgs };
}

const SUMMARY = "A sufficiently long summary that passes the fifty character minimum validation gate.";

// 8 covered fillers (~8.8K tokens, clears minCompressRange) + 6 tail fillers
// keep the covered range OUT of the recent zone — same recipe as the
// wire-transform.test.ts replay case.
function baseMsgs(prefix: string): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) msgs.push(fillerMsg(i % 2 ? "assistant" : "user", `${prefix}${i}`));
  for (let i = 0; i < 6; i++) msgs.push(fillerMsg(i % 2 ? "user" : "assistant", `tail${i}`));
  return msgs;
}

const text = (r: { content: Array<{ type: string; text: string }> }): string => r.content[0]!.text;

test("provider mode: a successful compress is visible to stateFor tools in the same turn (issue #90)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ autoUpdate: false })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (msgs: Array<Record<string, unknown>>) =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: anthropicPayload(msgs) }, ctx) as Promise<{ messages: unknown[] } | undefined>;

  const msgs = baseMsgs("cov");
  assert.ok(await fire(msgs), "base provider request transformed");

  const tool = (name: string): ToolEntry => api.tools.find((t) => t.name === name)!;
  const compress = tool("compress");
  const r1 = await compress.execute!("call_c1", { content: [{ startId: "m00001", endId: "m00008", summary: SUMMARY }] }, undefined, undefined, ctx);
  const okText = text(r1);
  assert.match(okText, /1 block/, `compress succeeded: ${okText.slice(0, 160)}`);
  assert.match(okText, /\[fp=[0-9a-f]/, "span fingerprint recorded for the fold-replay guard");

  // The bug: the commit landed in the context slot while stateFor serves the
  // core slot — a same-turn decompress (before the next provider request
  // replays the call) could not find the block it just created.
  const decompress = tool("decompress");
  const r2 = await decompress.execute!("call_d1", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const dText = text(r2);
  assert.match(dText, /^Restored block b1 \(/, `block resolves in the same turn: ${dText.slice(0, 160)}`);
  assert.ok(dText.includes("cov3 "), "restored content is the covered range");
  assert.ok(!dText.includes("tail0 "), "tail outside the range is not restored");

  // Next provider request: the stream now carries the compress call + result.
  // The replay must recognize the already-applied call (no double block, no
  // stale-fp skip, no crash) and keep the covered range pruned.
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "call_c1", name: "compress", input: { content: [{ startId: "m00001", endId: "m00008", summary: SUMMARY }] } }] });
  msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_c1", content: okText }] });
  const out2 = await fire(msgs);
  assert.ok(out2, "follow-up provider request transformed");
  const flat = JSON.stringify(out2.messages);
  assert.ok(!flat.includes("cov3 "), "covered filler stays pruned after the replay");
  assert.ok(flat.includes("tail0 "), "protected tail kept");
  const r3 = await decompress.execute!("call_d2", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  assert.match(text(r3), /^Restored block b1 \(/, "block still resolves after the replay");
});

test("provider mode: reject streak lives in the core slot and survives a wire re-fold (issue #90)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ autoUpdate: false })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (msgs: Array<Record<string, unknown>>) =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: anthropicPayload(msgs) }, ctx) as Promise<{ messages: unknown[] } | undefined>;

  assert.ok(await fire(baseMsgs("p")), "base provider request transformed");

  const compress = api.tools.find((t) => t.name === "compress")!;
  // A single below-minimum message: the kernel rejects it, and the rejection
  // counts toward the streak.
  const doomed = { content: [{ startId: "m00014", endId: "m00014", summary: SUMMARY }] };
  const r1 = await compress.execute!("c1", doomed, undefined, undefined, ctx);
  assert.ok(!text(r1).includes("STOP:"), "first rejection is plain");
  const r2 = await compress.execute!("c2", doomed, undefined, undefined, ctx);
  assert.ok(!text(r2).includes("STOP:"), "second rejection is plain");

  // Wire view flip: the host re-sends a rewritten prefix → core-space
  // re-fold (freshSlot). Session-level streak accounting must survive.
  assert.ok(await fire(baseMsgs("q")), "re-folded provider request transformed");

  const r3 = await compress.execute!("c3", doomed, undefined, undefined, ctx);
  assert.match(text(r3), /STOP: 3 compress calls rejected in a row/, "streak carried across the core re-fold");
  const r4 = await compress.execute!("c4", doomed, undefined, undefined, ctx);
  assert.match(text(r4), /again — 4 consecutive rejections/, "fourth rejection suppresses the kernel detail");

  // A success resets the streak — in the core slot as well.
  const r5 = await compress.execute!("c5", { content: [{ startId: "m00001", endId: "m00008", summary: SUMMARY }] }, undefined, undefined, ctx);
  assert.match(text(r5), /1 block/, "success after escalation");
  const r6 = await compress.execute!("c6", doomed, undefined, undefined, ctx);
  assert.ok(!text(r6).includes("STOP:"), "streak restarted at 1 after the success");
});
