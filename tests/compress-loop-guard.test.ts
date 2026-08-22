// @ts-nocheck — mock-heavy integration test: captureApi/fakeCtx deliberately
// approximate the ExtensionAPI shape. Verified at runtime (bun test), not by tsc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface MockApi {
  tools: Array<{ name: string; execute?: (id: string, args: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>; [k: string]: unknown }>;
  commands: Map<string, unknown>;
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
}
type HandlerMap = Map<string, Array<(e: unknown, ctx: unknown) => unknown>>;
function captureApi(): { api: MockApi; handlers: HandlerMap } {
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
      this.tools.push(tool as MockApi["tools"][number]);
    },
    registerCommand(name, options) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

function fakeCtx() {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getSessionId: () => "loop-guard-session",
      getSessionFile: () => "/tmp/nonexistent-omp-lg.session.json",
    },
  };
}

function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

// Regression (port of #48 onto #50): the reject streak must survive a
// view-flip re-fold. omp re-feeds our rebuilt output as the next context
// event (observed live, 411 of 1286 context events); the re-fold replaces
// the FoldSlot — if rejectStreak lived only on the replaced slot, every view
// flip mid-loop would reset it to 0 and the escalation threshold (3) would
// never be reached. That was exactly the issue-47 amplifier.
test("reject streak survives a view-flip re-fold", () => {
  const runtime = createRuntime({ modelContextLimit: 200_000 });
  const ctx = fakeCtx();

  const FILL = "lorem ipsum dolor sit amet consectetur. ".repeat(40);
  const raw = [{ role: "user", content: [{ type: "text", text: "s " + FILL }], timestamp: Date.now() }];
  for (let i = 1; i <= 6; i++) raw.push(i % 2 ? { role: "assistant", content: [{ type: "text", text: `a${i}` }] } : { role: "user", content: [{ type: "text", text: `u${i} ` + FILL }], timestamp: Date.now() });

  runtime.foldStream(ctx, raw);
  assert.equal(runtime.noteCompressOutcome(ctx, false), 1);
  assert.equal(runtime.noteCompressOutcome(ctx, false), 2);

  // Feedback view: identities diverge at the first position → forced freshSlot.
  const rebuilt = [{ role: "user", content: [{ type: "text", text: "[Compressed conversation section 1 — gone]" }], timestamp: Date.now() }, ...raw.slice(2)];
  runtime.foldStream(ctx, rebuilt);
  // The streak must still be 2 — one more rejection escalates to the STOP
  // directive (threshold 3), instead of starting over from 0.
  assert.equal(runtime.noteCompressOutcome(ctx, false), 3, "streak carried across the re-fold");
  // A success clears it — even across a subsequent re-fold.
  assert.equal(runtime.noteCompressOutcome(ctx, true), 0);
  runtime.foldStream(ctx, raw);
  assert.equal(runtime.noteCompressOutcome(ctx, false), 1, "reset sticks after another re-fold");
});

function assistantCompressCall(callId: string, ranges: Array<{ startId: string; endId: string; summary: string }>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "compress", arguments: JSON.stringify({ content: ranges }) }],
    timestamp: Date.now(),
  };
}

function toolResult(callId: string, text: string) {
  return { role: "toolResult", content: [{ type: "text", text }], toolName: "compress", toolCallId: callId, timestamp: Date.now() };
}

function refOf(message: unknown): string | null {
  const msg = message as { content?: unknown };
  const blocks = Array.isArray(msg.content) ? (msg.content as Array<{ type?: string; text?: string }>) : [{ type: "text", text: msg.content }];
  const textBlock = blocks.find((b) => b.type === "text");
  return textBlock?.text?.match(/m\d{5}/)?.[0] ?? null;
}

// ~5.9KB — clears the 5000-char minCompressRange on its own.
function bigText(seed: string) {
  return `${seed} large enough to compress on its own. `.repeat(130);
}

const SUMMARY = "A sufficiently long summary that passes the fifty character minimum validation gate.";

// Six 4.8KB fillers keep the compress targets OUT of the recent zone
// (last 5 visible + 5K tokens from the tail) — same recipe as the
// established "already-compressed" case in integration.test.ts.
const FILLERS = [1, 2, 3, 4, 5, 6].map((n) => userMsg(`filler ${n} `.repeat(600)));

test("loop guard: repeated rejected compress calls escalate, then suppress, then reset on success", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, transformMode: "context" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: unknown[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);
  const compress = api.tools.find((t) => t.name === "compress")!;

  const stream = [userMsg(bigText("target one")), userMsg(bigText("target two")), ...FILLERS];
  const r1 = await fire([...stream]);
  const ref1 = refOf(r1.messages[0]);
  const ref2 = refOf(r1.messages[1]);

  // Setup: one successful compression resets the streak to a clean baseline.
  const ok = await compress.execute("tc_ok", { content: [{ startId: ref1, endId: ref2, summary: SUMMARY }] }, undefined, undefined, ctx);
  assert.match(ok.content[0].text, /reclaimed/, "setup: first compression succeeds");

  // Re-target with a ref that does not exist: rejected live ("unknown ref").
  // (Kernel 0.0.31 snaps consumed refs to the owning block instead of
  //  rejecting, so an already-compressed range no longer triggers the
  //  rejection path — use an unknown ref to exercise the loop guard.)
  const call = { startId: "m99999", endId: "m99999", summary: SUMMARY };
  const r2 = await compress.execute("tc_r2", { content: [call] }, undefined, undefined, ctx);
  assert.match(r2.content[0].text, /No changes applied/, "rejection 1: replay marker intact");
  assert.doesNotMatch(r2.content[0].text, /STOP/, "rejection 1: no escalation yet");

  const r3 = await compress.execute("tc_r3", { content: [call] }, undefined, undefined, ctx);
  assert.doesNotMatch(r3.content[0].text, /STOP/, "rejection 2: no escalation yet");

  const r4 = await compress.execute("tc_r4", { content: [call] }, undefined, undefined, ctx);
  assert.match(r4.content[0].text, /STOP: 3 compress calls rejected in a row/, "rejection 3: stop directive appended");
  assert.match(r4.content[0].text, /No changes applied/, "rejection 3: replay marker intact");

  const r5 = await compress.execute("tc_r5", { content: [call] }, undefined, undefined, ctx);
  assert.match(r5.content[0].text, /again — 4 consecutive rejections/, "rejection 4: kernel detail suppressed");
  assert.match(r5.content[0].text, /No changes applied/, "rejection 4: replay marker intact (fold-skip contract)");
  assert.doesNotMatch(r5.content[0].text, /already compressed/, "rejection 4: kernel error detail gone");

  // A successful compress on NEW content must reset the streak. The fresh
  // target must sit OUT of the recent zone (last 5 visible + 5K tokens from
  // the tail), so five large tail messages follow it.
  const fresh = userMsg(bigText("fresh target"));
  const tails = [1, 2, 3, 4, 5].map((n) => userMsg(bigText(`tail ${n}`)));
  const stream2 = [
    ...stream,
    assistantCompressCall("tc_ok", [call]),
    toolResult("tc_ok", ok.content[0].text),
    assistantCompressCall("tc_r2", [call]),
    toolResult("tc_r2", r2.content[0].text),
    assistantCompressCall("tc_r3", [call]),
    toolResult("tc_r3", r3.content[0].text),
    assistantCompressCall("tc_r4", [call]),
    toolResult("tc_r4", r4.content[0].text),
    assistantCompressCall("tc_r5", [call]),
    toolResult("tc_r5", r5.content[0].text),
    fresh,
    ...tails,
  ];
  const r6 = await fire(stream2);
  const freshView = r6.messages.find((m) => JSON.stringify(m).includes("fresh target"));
  const freshRef = refOf(freshView);
  const ok2 = await compress.execute("tc_ok2", { content: [{ startId: freshRef, endId: freshRef, summary: SUMMARY }] }, undefined, undefined, ctx);
  assert.match(ok2.content[0].text, /reclaimed/, "success on fresh content after the loop");

  // Streak restarts at 1: the same doomed span needs 3 more rejections before the directive.
  const a1 = await compress.execute("tc_a1", { content: [call] }, undefined, undefined, ctx);
  const a2 = await compress.execute("tc_a2", { content: [call] }, undefined, undefined, ctx);
  assert.doesNotMatch(a1.content[0].text, /STOP/, "post-reset rejection 1: clean");
  assert.doesNotMatch(a2.content[0].text, /STOP/, "post-reset rejection 2: clean");
  const a3 = await compress.execute("tc_a3", { content: [call] }, undefined, undefined, ctx);
  assert.match(a3.content[0].text, /STOP: 3 compress calls rejected in a row/, "post-reset rejection 3: escalates again");
});

test("loop guard: a fresh extension instance starts at streak 0 (no cross-session bleed)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, transformMode: "context" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: unknown[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);
  const stream = [userMsg(bigText("target one")), userMsg(bigText("target two")), ...FILLERS];
  const r1 = await fire([...stream]);
  const ref1 = refOf(r1.messages[0]);
  const ref2 = refOf(r1.messages[1]);
  const call = { startId: ref1, endId: ref2, summary: SUMMARY };
  const ok = await api.tools.find((t) => t.name === "compress")!.execute("tc_ok", { content: [call] }, undefined, undefined, ctx);
  assert.match((ok as { content: Array<{ type: string; text: string }> }).content[0].text, /reclaimed/, "setup: first compression succeeds");

  // A second extension instance (fresh runtime + slots) re-folds the same
  // stream. Use an unknown ref to trigger a rejection (kernel 0.0.31 snaps
  // consumed refs to the owning block, so re-compressing a covered range
  // now succeeds instead of rejecting).
  const second = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, transformMode: "context" })(second.api as unknown as ExtensionAPI);
  await second.handlers.get("context")![0]!({ type: "context", messages: [...stream, assistantCompressCall("tc_ok", [call]), toolResult("tc_ok", ok.content[0].text)] }, ctx);
  const badCall = { startId: "m99999", endId: "m99999", summary: SUMMARY };
  const rejected = await second.api.tools.find((t) => t.name === "compress")!.execute("tc_new", { content: [badCall] }, undefined, undefined, ctx);
  assert.match(rejected.content[0].text, /No changes applied/, "fresh instance: rejection is a real rejection");
  assert.match(rejected.content[0].text, /does not exist/, "fresh instance: unknown ref rejected");
  assert.doesNotMatch(rejected.content[0].text, /STOP/, "fresh instance: first rejection is clean (streak 1)");
});

test("loop guard: malformed compress args count toward the reject streak", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, transformMode: "context" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: unknown[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);
  const compress = api.tools.find((t) => t.name === "compress")!;
  const stream = [userMsg(bigText("target one")), userMsg(bigText("target two")), ...FILLERS];
  await fire([...stream]);

  // {startId,endId} without summary — the weak-model shape from the
  // 2026-08-15 provider-mode e2e. Repeating it must escalate like any
  // other rejection: STOP at the third, suppressed detail at the fourth.
  const bad = { content: [{ startId: "m00001", endId: "m00002" }] };
  const r1 = await compress.execute("tc_m1", bad, undefined, undefined, ctx);
  assert.match(r1.content[0].text, /Every range needs startId/, "malformed: correctable error returned");
  assert.match(r1.content[0].text, /No changes applied/, "malformed: fold-skip marker present");
  assert.doesNotMatch(r1.content[0].text, /STOP/, "malformed rejection 1: no escalation yet");
  const r2 = await compress.execute("tc_m2", bad, undefined, undefined, ctx);
  assert.doesNotMatch(r2.content[0].text, /STOP/, "malformed rejection 2: no escalation yet");
  const r3 = await compress.execute("tc_m3", bad, undefined, undefined, ctx);
  assert.match(r3.content[0].text, /STOP: 3 compress calls rejected in a row/, "malformed rejection 3: escalates to the stop directive");
  const r4 = await compress.execute("tc_m4", bad, undefined, undefined, ctx);
  assert.match(r4.content[0].text, /again — 4 consecutive rejections/, "malformed rejection 4: detail suppressed");
  assert.doesNotMatch(r4.content[0].text, /Every range needs startId/, "malformed rejection 4: base error detail gone");

  // Empty content arrays ride the same guard — this is the 5th consecutive
  // rejection, so the guard is already in suppress mode.
  const e1 = await compress.execute("tc_e1", { content: [] }, undefined, undefined, ctx);
  assert.match(e1.content[0].text, /again — 5 consecutive rejections/, "empty content: counted, guard already suppressing");
  assert.match(e1.content[0].text, /No changes applied/, "empty content: fold-skip marker present");
});

// Issue #104: a rejected compress call creates no block, so it is orphaned.
// acp-kernel 0.0.32 (reverts #18) sets KEEP_LAST_ORPHANED=2 — the kernel's
// hide-compress-calls node now keeps the newest two orphaned call+result
// pairs visible, so the model sees its own last rejection (the loop-guard
// STOP included) and cannot sit at an unobservable fixed point. This test
// guards that the rejected pair stays visible exactly once (no duplication).
test("issue #104: rejected compress call+result stay visible in the model's view", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000, transformMode: "context" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: unknown[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);
  const compress = api.tools.find((t) => t.name === "compress")!;
  const stream = [userMsg(bigText("target one")), userMsg(bigText("target two")), ...FILLERS];
  await fire([...stream]);

  const bad = { content: [{ startId: "m99999", endId: "m99999", summary: SUMMARY }] };
  const rejected = await compress.execute("tc_v1", bad, undefined, undefined, ctx);
  assert.match(rejected.content[0].text, /No changes applied/);

  // Next context event: omp's session view carries the call+result pair.
  const r = await fire([...stream, assistantCompressCall("tc_v1", bad.content), toolResult("tc_v1", rejected.content[0].text)]);
  const json = JSON.stringify(r.messages);
  assert.ok(json.includes("No changes applied"), "the rejection result must stay visible to the model");
  assert.ok(json.includes("m99999"), "the rejected call itself must stay visible to the model");
  assert.equal((json.match(/No changes applied/g) ?? []).length, 1, "exactly one copy of the rejection — no duplication");

  // Feedback view (omp re-feeds our output verbatim): still exactly one copy.
  const r2 = await fire(r.messages);
  const json2 = JSON.stringify(r2.messages);
  assert.equal((json2.match(/No changes applied/g) ?? []).length, 1, "feedback view keeps exactly one copy");
});

// Issue #104 coherence: the over-limit/emergency nudge re-fires on every LLM
// call ("compress now") — while compress rejects everything, that demand is
// the engine of the retry loop. At streak >= 3 the nudge must become a hold
// that matches the tool's STOP directive, and a successful compress must
// restore the normal nudge.
test("issue #104: nudge becomes a hold during a reject streak, resets on success", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 10_000, transformMode: "context" })(api as unknown as ExtensionAPI);
  const ctx = fakeCtx();
  const fire = (messages: unknown[]) => handlers.get("context")![0]!({ type: "context", messages }, ctx);
  const compress = api.tools.find((t) => t.name === "compress")!;

  const stream = [userMsg(bigText("target one")), userMsg(bigText("target two")), ...FILLERS];
  const r0 = await fire([...stream]);
  const tail0 = JSON.stringify(r0.messages[r0.messages.length - 1]);
  assert.ok(tail0.includes("compress"), `setup: over-limit nudge fired (${tail0.slice(0, 120)})`);
  assert.ok(!tail0.includes("[ACP hold]"), "setup: not a hold at streak 0");
  const ref1 = refOf(r0.messages[0]);
  const ref2 = refOf(r0.messages[1]);

  const bad = { content: [{ startId: "m99999", endId: "m99999", summary: SUMMARY }] };
  const rejections: Array<{ text: string; id: string }> = [];
  for (const id of ["tc_h1", "tc_h2", "tc_h3"]) {
    const out = await compress.execute(id, bad, undefined, undefined, ctx);
    rejections.push({ text: out.content[0].text, id });
  }

  const stream2 = [...stream];
  for (const rej of rejections) stream2.push(assistantCompressCall(rej.id, bad.content), toolResult(rej.id, rej.text));
  const r1 = await fire(stream2);
  const tail1 = JSON.stringify(r1.messages[r1.messages.length - 1]);
  assert.ok(tail1.includes("[ACP hold]"), `streak 3: nudge replaced by the hold (${tail1.slice(0, 120)})`);
  assert.ok(tail1.includes("Do NOT call compress"), "hold carries the explicit stop directive");
  assert.ok(!tail1.includes("Context limit reached"), "hold does not still demand compression");

  // A successful compress resets the streak: the next over-limit nudge is
  // the normal compress-demanding one again.
  const ok = await compress.execute("tc_h_ok", { content: [{ startId: ref1, endId: ref2, summary: SUMMARY }] }, undefined, undefined, ctx);
  assert.match(ok.content[0].text, /reclaimed/, "reset: compression succeeds");
  const r2 = await fire([...stream2, assistantCompressCall("tc_h_ok", [{ startId: ref1, endId: ref2, summary: SUMMARY }]), toolResult("tc_h_ok", ok.content[0].text)]);
  const tail2 = JSON.stringify(r2.messages[r2.messages.length - 1]);
  assert.ok(!tail2.includes("[ACP hold]"), "post-success: hold is gone");
});
