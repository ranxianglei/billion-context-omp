import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Regression: the 2026-08-15 user report (issue #18 follow-up). A session ran
// on a 1M-context model until the session TREE reached ~366K tokens, then the
// user switched to a 180K-context model. omp's getContextUsage() kept
// reporting the full tree (365606 / 180000 = 204%) and the old handler fed
// that number to the kernel: permanent EMERGENCY nudges every turn while the
// real sent view (after 16 compression blocks) was ~5-10K tokens — the chat
// kept working fine. Nudge arbitration must run on the SENT-VIEW estimate,
// never on session-tree accounting.

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

const MID = "lorem ".repeat(3000);
const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }], timestamp: Date.now() });

test("handler ignores session-tree accounting for nudge arbitration (180K window, 366K tree)", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "context" } as never)(api as unknown as ExtensionAPI);

  // 180K model; the session tree "remembers" 366K (switched down from 1M).
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    getContextUsage: () => ({ tokens: 365_606, percent: 2.03, contextWindow: 180_000 }),
    sessionManager: { getSessionId: () => "tree-vs-sent", getSessionFile: () => "/tmp/tree-vs-sent.json" },
  } as unknown as ExtensionContext;

  // The stream the model would ACTUALLY see: compressed history + a small
  // live tail (the real session had 16 blocks; ~8 messages is enough to
  // prove the scale decision). The tree-sized number above is a lie the
  // handler must not believe.
  const stream: any[] = [msg("user", "start " + MID)];
  for (let i = 1; i <= 7; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));

  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [...stream] }, ctx);
  const r = (await fire()) as { messages: any[] };
  const nudges = r.messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress("));
  // Sent view ≈ 36K/180K = 20% — far below the 95% emergency threshold. The
  // 204% tree number must not produce an EMERGENCY nudge.
  assert.equal(nudges.length, 0, "no emergency nudge: the sent view is well within the window");
});

test("handler DOES go emergency when the sent view itself overflows the window", async () => {
  const { api, handlers } = capture();
  createAcpExtension({ transformMode: "context" } as never)(api as unknown as ExtensionAPI);

  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 180_000 },
    // Host reports a SMALL tree (fresh session) — irrelevant either way now.
    getContextUsage: () => ({ tokens: 1000, percent: 0.005, contextWindow: 180_000 }),
    sessionManager: { getSessionId: () => "sent-overflow", getSessionFile: () => "/tmp/sent-overflow.json" },
  } as unknown as ExtensionContext;

  // 60 × 4.5K ≈ 270K tokens of unprotected content → 150% of the 180K window.
  const stream: any[] = [msg("user", "start " + MID)];
  for (let i = 1; i <= 59; i++) stream.push(msg(i % 2 ? "assistant" : "user", `f${i} ` + MID));

  const fire = () => handlers.get("context")![0]!({ type: "context", messages: [...stream] }, ctx);
  const r = (await fire()) as { messages: any[] };
  const nudges = r.messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("compress("));
  assert.equal(nudges.length, 1, "emergency nudge fires on real sent-view overflow");
});
