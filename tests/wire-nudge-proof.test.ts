import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Wire-level proof (no model involved): synthesize an append-only
// conversation — 50 filler turns, then enough growth to cross the kernel
// T1 threshold (or one BIG message to cross the emergency band) — and fire
// the REAL before_provider_request handler. Whatever this handler RETURNS
// is the payload object the host serializes into the POST body: if the nudge
// text is present in the returned messages, it is on the wire. Full stop.
//
// Threshold facts this test is calibrated against (kernel 0.0.27, 200K
// window): efficiency nudge needs T1 effective (merged ranges) ≥ 50000
// tokens AND growth ≥ 22500; a ~100K-token single message crosses the
// emergency band outright. 50×~700 tok baseline + 70×~700 tok growth
// (~49K) lands just above the T1 threshold — verified empirically.

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

const FILLER = "wire proof filler line of moderate length for token estimation. ".repeat(30); // ~700 tok

function agentMsg(role: "user" | "assistant", text: string) {
  return { role, content: [{ type: "text", text }], timestamp: Date.now() };
}

function makeCtx(sid: string): ExtensionContext {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, api: "openai-completions" },
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => sid, getSessionFile: () => `/tmp/${sid}.json` },
  } as unknown as ExtensionContext;
}

function toWire(stream: Array<{ role: string; content: Array<{ text: string }> }>) {
  return stream.map((m) => ({ role: m.role, content: m.content[0]!.text }));
}

async function fireWithGrowth(sid: string, fillerTurns: number, growthTurns: number) {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const stream: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];
  for (let i = 0; i < fillerTurns; i++) stream.push(agentMsg(i % 2 ? "assistant" : "user", `f${i} ${FILLER}`));
  const payload = () => ({ model: "qwen-proof", max_completion_tokens: 2048, messages: toWire(stream) });
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: JSON.parse(JSON.stringify(payload())) }, makeCtx(sid));
  await fire(); // baseline: kernel needs a growth reference point
  for (let i = 0; i < growthTurns; i++) stream.push(agentMsg(i % 2 ? "assistant" : "user", `g${i} ${FILLER}`));
  return (await fire()) as { messages: Array<{ role: string; content: unknown }> };
}

test("wire-level: efficiency nudge rides the returned HTTP payload (growth path)", async () => {
  // 50 fillers + 70 growth ≈ 49K added → T1 effective crosses 50000.
  const out = await fireWithGrowth("wire-nudge-growth", 50, 70);
  const last = out.messages[out.messages.length - 1]!;
  assert.equal(last.role, "user", "trailing message is the nudge");
  const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  assert.ok(text.includes("efficiency nudge"), "efficiency nudge text present on the wire payload");
  assert.ok(text.includes("Compression Philosophy"), "philosophy section present");
  // Compressible ranges are cited with m-refs the model can use.
  assert.match(text, /m\d+\s*[–-]\s*m\d+/);

  // Prior messages keep their <acp> ref tags — refs are usable in calls.
  const prior = out.messages.slice(0, -1);
  const tagged = prior.filter((m) => {
    const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return /<acp[^>]*>\s*m\d+<\/acp>/.test(t);
  });
  assert.ok(tagged.length > 0, "ref tags ride the wire on prior messages");
  const firstUser = prior.find((m) => m.role === "user")!;
  const firstText = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
  assert.match(firstText, /<acp[^>]*>m0*\d+<\/acp>\s*$/, "first user message ends with its ref tag");
});

test("wire-level: emergency alert rides the returned HTTP payload (single BIG message)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const stream: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];
  for (let i = 0; i < 50; i++) stream.push(agentMsg(i % 2 ? "assistant" : "user", `f${i} ${FILLER}`));
  stream.push(agentMsg("user", "B ".repeat(400_000))); // ~100K tok → emergency band
  const payload = { model: "qwen-proof", max_completion_tokens: 2048, messages: toWire(stream) };
  const fire = () => handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload: JSON.parse(JSON.stringify(payload)) }, makeCtx("wire-nudge-emergency"));
  await fire();
  const out = (await fire()) as { messages: Array<{ role: string; content: unknown }> };
  const last = out.messages[out.messages.length - 1]!;
  assert.equal(last.role, "user");
  const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  assert.ok(text.includes("Context limit reached"), "emergency alert text present on the wire payload");
});
