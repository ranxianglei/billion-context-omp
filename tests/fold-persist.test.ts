import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpExtension } from "../src/index.js";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";
import { formatSystemPromptForEvent } from "../src/compat.js";
import { createInitialState, defaultPrompts } from "acp-kernel";
import { flatFileNameFor } from "acp-kernel/persist";
import type { ExtensionAPI, ExtensionContext, AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

// Issue #130: at restart the wire payload is unavailable until the first
// provider request, so primeFold folds a session-VIEW mirror — a different
// fingerprint space than the live wire fold (host transformMessages +
// convertMessages reshape the view: cross-model thinking demotion,
// developer→user remap, empty-message drops). Every in-stream compress
// replay then failed the span guard and /acp showed "Blocks: none" after
// restart. The fix checkpoints the LIVE fold slot to disk
// (acp-kernel/persist StateStore) and restores it at session_start —
// restoring blocks in the wire's own identity space (coreIdentity is a pure
// function of content, so the next process recomputes the same ids from the
// same wire).

const SYSTEM = "You are a coding agent. " + "system context filler ".repeat(200);
const FILLER = "filler content for compression minimums ".repeat(220);
const SUMMARY =
  "COVERED WORK SUMMARY: early exploration and tool runs from the first half of the session, " +
  "compressed to keep context lean while preserving the goal, key file paths and findings. ";

const ACP = buildAcpSystemPrompt(defaultPrompts);
const WIRE_SYSTEM = formatSystemPromptForEvent([SYSTEM], ACP)[0]!;

type Msg = {
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  [k: string]: unknown;
};

const assistantBase = {
  api: "anthropic" as const,
  provider: "anthropic" as const,
  model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const,
};
const userMsg = (t: string): Msg => ({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const botMsg = (t: string): Msg => ({ role: "assistant", ...assistantBase, content: [{ type: "text", text: t }] });
const toolCallMsg = (id: string, name: string, args: unknown): Msg => ({
  role: "assistant", ...assistantBase,
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const toolResultMsg = (callId: string, toolName: string, t: string): Msg => ({
  role: "toolResult", toolCallId: callId, toolName, isError: false,
  content: [{ type: "text", text: t }], timestamp: Date.now(),
});

interface Host {
  api: unknown;
  ctx: ExtensionContext;
  handlers: Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
  tools: Map<string, ToolDefinition<any, any>>;
  wire: (session: Msg[]) => Record<string, unknown>;
}

function makeHost(session: Msg[], sid: string): Host {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, ToolDefinition<any, any>>();
  const treeTokens = () => Math.ceil(session.reduce((n, m) => n + m.content.reduce((x, b) => x + (b.text?.length ?? 0), 0), 0) / 4);
  const api = {
    on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(ev) ?? [];
      list.push(h);
      handlers.set(ev, list);
    },
    registerTool: (t: ToolDefinition<any, any>) => { tools.set(t.name, t); },
    registerCommand: () => {},
    config: { load: () => ({}) },
  };
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { api: "openai-completions", contextWindow: 200_000 },
    getSystemPrompt: () => [SYSTEM],
    getContextUsage: () => ({ tokens: treeTokens(), contextWindow: 200_000 }),
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => `/tmp/${sid}.json`,
      buildSessionContext: () => ({ messages: session }),
    },
  } as unknown as ExtensionContext;
  return { api, ctx, handlers, tools, wire: openaiWire };
}

function openaiWire(session: Msg[]): Record<string, unknown> {
  const messages: unknown[] = [{ role: "system", content: WIRE_SYSTEM }];
  for (const m of session) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content.map((b) => b.text ?? "").join("\n") });
    } else if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "toolCall");
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
        });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
    } else if (m.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.map((b) => b.text ?? "").join("\n") });
    }
  }
  return { model: "glm-x", max_completion_tokens: 4096, messages };
}

async function llmCall(host: Host, payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const hs = host.handlers.get("before_provider_request") ?? [];
  let out: Record<string, unknown> | undefined;
  for (const h of hs) {
    const r = await h({ type: "before_provider_request", payload }, host.ctx);
    if (r !== undefined) out = r as Record<string, unknown>;
  }
  return out;
}

async function statusText(host: Host): Promise<string> {
  const r: AgentToolResult<unknown> = await host.tools.get("acp_status")!.execute("sc", {}, undefined, undefined, host.ctx);
  return (r.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
}

const activeBlocks = (s: string): string => s.match(/COMPRESSED BLOCKS — (\d+) active/)?.[1] ?? "0";

function fillerSession(): Msg[] {
  const session: Msg[] = [];
  for (let i = 0; i < 7; i++) {
    session.push(userMsg(`u${i} ` + FILLER));
    session.push(botMsg(`b${i} ` + FILLER));
  }
  return session;
}

async function livePhase(host: Host, session: Msg[]): Promise<void> {
  await host.handlers.get("session_start")![0]!({ type: "session_start" }, host.ctx);
  await llmCall(host, host.wire(session));
  const args = { content: [{ startId: "m00001", endId: "m00014", summary: SUMMARY }] };
  const res: AgentToolResult<unknown> = await host.tools.get("compress")!.execute("call_c1", args, undefined, undefined, host.ctx);
  const resText = (res.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
  assert.match(resText, /\[fp=[0-9a-f,-]+\]/, "compress result carries span fingerprints");
  session.push(toolCallMsg("call_c1", "compress", args));
  session.push(toolResultMsg("call_c1", "compress", resText));
  session.push(userMsg("what did we find? " + FILLER));
  session.push(botMsg("Here is the answer " + FILLER));
  const out = await llmCall(host, host.wire(session));
  assert.ok(out, "provider transform active");
  const st = await statusText(host);
  assert.equal(activeBlocks(st), "1", "live acp_status shows the block");
}

/** Isolate the fold-checkpoint dir per test: the runtime resolves
 * ACP_OMP_FOLD_DIR once at construction (foldPersistDir). */
function withFoldDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-omp-fold-test-"));
  process.env.ACP_OMP_FOLD_DIR = dir;
  return dir;
}

test("fold persistence: shutdown flush + restart restore shows the block BEFORE the first provider request (issue #130)", async () => {
  const dir = withFoldDir();
  const sid = "fp-restart";
  const session = fillerSession();

  // Process 1: live session, one compress, then shutdown (synchronous flush).
  const host1 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host1.api as ExtensionAPI);
  await livePhase(host1, session);
  await host1.handlers.get("session_shutdown")![0]!({ type: "session_shutdown" }, host1.ctx);
  const files = readdirSync(dir);
  assert.equal(files.length, 1, "shutdown flushed exactly one checkpoint:\n" + files.join(", "));

  // Process 2 (restart): session_start must restore the checkpoint — blocks
  // visible with NO provider request yet. This is the #130 contract: the
  // restored identities live in the WIRE's fingerprint space, not the
  // mirror's.
  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "post-restart pre-LLM acp_status shows the restored block:\n" + prime);

  // The first provider request re-validates the restored slot via LCP (same
  // wire ⇒ same content-hash ids) and must keep the block.
  const out = await llmCall(host2, host2.wire(session));
  assert.ok(out, "provider transform active after restore");
  assert.ok(JSON.stringify(out).includes("COVERED WORK SUMMARY"), "payload carries the summary");
  const post = await statusText(host2);
  assert.equal(activeBlocks(post), "1", "post-restart post-LLM acp_status still shows the block");
});

test("fold persistence: crash without shutdown degrades to the primeFold mirror (fallback intact)", async () => {
  withFoldDir();
  const sid = "fp-crash";
  const session = fillerSession();

  // Process 1 dies mid-debounce-window: no shutdown, nothing flushed.
  const host1 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host1.api as ExtensionAPI);
  await livePhase(host1, session);

  // Process 2: restore misses (no file) → primeFold mirror path runs — the
  // pre-persistence behavior, unchanged.
  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const prime = await statusText(host2);
  assert.equal(activeBlocks(prime), "1", "mirror fallback still rebuilds the block pre-LLM:\n" + prime);
});

test("fold persistence: a zero-block checkpoint is NOT restored — the mirror must still run", async () => {
  // Session WITH a compress call: host1 folds it live in a clean dir, then
  // host2 boots against a DIFFERENT dir holding a crafted 0-block envelope.
  withFoldDir();
  const sid = "fp-zero-block";
  const session = fillerSession();
  const host1 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host1.api as ExtensionAPI);
  await livePhase(host1, session);

  // An early-debounce checkpoint: real-looking wire identities, no blocks
  // yet. (A 0-block snapshot carries nothing the fresh slot lacks, but
  // restoring it would claim the slot and suppress the mirror — the issue
  // #103 session_switch regression this guard exists for.)
  const badDir = withFoldDir();
  const envelope = {
    version: 1,
    savedAt: Date.now(),
    id: sid,
    payload: {
      identities: ["pretend-wire-id"],
      foldedLen: 1,
      state: createInitialState(),
      coreMessages: [],
      appliedCallIds: [],
      rejectStreak: 0,
    },
  };
  writeFileSync(path.join(badDir, flatFileNameFor(sid)), JSON.stringify(envelope));

  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const st = await statusText(host2);
  assert.equal(activeBlocks(st), "1", "0-block checkpoint ignored; mirror primeFold rebuilds:\n" + st);
});

test("fold persistence: corrupt checkpoint is skipped, never blocks boot", async () => {
  // Session WITH a compress call (mirror needs it to rebuild), corrupt
  // checkpoint in the target dir.
  withFoldDir();
  const sid = "fp-corrupt";
  const session = fillerSession();
  const host1 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host1.api as ExtensionAPI);
  await livePhase(host1, session);

  const badDir = withFoldDir();
  writeFileSync(path.join(badDir, flatFileNameFor(sid)), "{not json");

  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const st = await statusText(host2);
  assert.equal(activeBlocks(st), "1", "corrupt checkpoint skipped; mirror fallback:\n" + st);
});


test("fold persistence: disabled writes nothing and restores nothing", async () => {
  const dir = withFoldDir();
  const sid = "fp-off";
  const session = fillerSession();

  const host = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false, foldPersistence: { enabled: false } })(host.api as ExtensionAPI);
  await livePhase(host, session);
  await host.handlers.get("session_shutdown")![0]!({ type: "session_shutdown" }, host.ctx);
  assert.equal(readdirSync(dir).length, 0, "no checkpoint written while disabled");

  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false, foldPersistence: { enabled: false } })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const st = await statusText(host2);
  assert.equal(activeBlocks(st), "1", "mirror fallback when disabled:\n" + st);
});

test("fold persistence: a live in-memory slot is never clobbered by restore (session switch back)", async () => {
  const dir = withFoldDir();
  const sid = "fp-switch";
  const session = fillerSession();

  // Process 1 folds live, then flushes a checkpoint.
  const host1 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host1.api as ExtensionAPI);
  await livePhase(host1, session);
  await host1.handlers.get("session_shutdown")![0]!({ type: "session_shutdown" }, host1.ctx);

  // Process 2 starts (restores), then a session_switch fires on the SAME
  // runtime instance: the in-memory slot is live truth — restore must skip.
  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  const before = await statusText(host2);
  assert.equal(activeBlocks(before), "1", "restored at start");

  // Tamper the checkpoint on disk so a second restore would observably
  // change the panel if it ran (it must NOT run).
  const hostile = {
    version: 1,
    savedAt: Date.now(),
    id: sid,
    payload: {
      identities: [],
      foldedLen: 0,
      state: createInitialState(),
      coreMessages: [],
      appliedCallIds: [],
      rejectStreak: 99,
    },
  };
  writeFileSync(path.join(dir, flatFileNameFor(sid)), JSON.stringify(hostile));

  await host2.handlers.get("session_switch")![0]!({ type: "session_switch", reason: "resume", previousSessionFile: `/tmp/${sid}.json` }, host2.ctx);
  const after = await statusText(host2);
  assert.equal(activeBlocks(after), "1", "skip-live: live slot survived the switch:\n" + after);
});

test("fold persistence: restored slot survives a mid-session restart with EXTENDED history (incremental LCP)", async () => {
  withFoldDir();
  const sid = "fp-extend";
  const session = fillerSession();

  const host1 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host1.api as ExtensionAPI);
  await livePhase(host1, session);
  await host1.handlers.get("session_shutdown")![0]!({ type: "session_shutdown" }, host1.ctx);

  // Restart, then the conversation continues: the restored identities must
  // LCP-match the prefix and new turns must NOT drop the block.
  const host2 = makeHost(session, sid);
  createAcpExtension({ autoUpdate: false })(host2.api as ExtensionAPI);
  await host2.handlers.get("session_start")![0]!({ type: "session_start" }, host2.ctx);
  session.push(userMsg("one more question " + FILLER));
  session.push(botMsg("one more answer " + FILLER));
  const out = await llmCall(host2, host2.wire(session));
  assert.ok(out, "provider transform active");
  const st = await statusText(host2);
  assert.equal(activeBlocks(st), "1", "extended tail keeps the restored block:\n" + st);
});

afterAll(() => {
  // A direct `bun test tests/fold-persist.test.ts` must not leak the env to
  // other files in the same process (scripts/test.ts isolates per file, but
  // bare invocations do not).
  delete process.env.ACP_OMP_FOLD_DIR;
});
