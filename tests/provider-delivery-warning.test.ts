import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAcpExtension } from "../src/index.js";
import { providerDeliveryWarning } from "../src/transform-mode.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ework issue #3 follow-up: an explicit transformMode "provider" is silently
// ineffective on some host/API combos (host < 17.3.8 drops the replacement on
// openai-completions/bedrock/cursor; bedrock/cursor bodies have no codec path
// on any host). providerDeliveryWarning names the reason; the context observer
// and the unknown-format wire path surface it once per session via ui.notify +
// logWarn. The unset per-API default never warns — it already avoids the traps.

function captureApi() {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const api = {
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: () => {},
    registerCommand: () => {},
    config: { load: () => ({}) },
  };
  return { api, handlers };
}

function uiCtx(opts: { sid: string; api?: string; notify: string[] }): ExtensionContext {
  return {
    mode: "rpc",
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify: (msg: string) => opts.notify.push(msg),
      confirm: async () => true,
      select: async () => undefined,
      input: async () => "",
      setStatus: () => {},
    },
    model: { contextWindow: 200_000, ...(opts.api ? { api: opts.api } : {}) },
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    sessionManager: { getSessionId: () => opts.sid, getSessionFile: () => `/tmp/nonexistent-omp-${opts.sid}.session.json` },
  } as unknown as ExtensionContext;
}

const stream = () => [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];

test("providerDeliveryWarning: host < 17.3.8 drops the replacement on openai-completions", () => {
  const w = providerDeliveryWarning({ transformMode: "provider" }, { api: "openai-completions" }, "17.3.2");
  assert.ok(w, "explicit provider + openai-completions on old host → warning");
  assert.equal(w.key, "drop:openai-completions");
  assert.match(w.reason, /17\.3\.8/);
  assert.match(w.message, /NOT applied/);
  assert.equal(providerDeliveryWarning({ transformMode: "provider" }, { api: "openai-completions" }, "17.3.8"), undefined, "17.3.8 delivers");
});

test("providerDeliveryWarning: delivered APIs never warn at any host version", () => {
  for (const api of ["anthropic-messages", "ollama-chat"] as const) {
    assert.equal(providerDeliveryWarning({ transformMode: "provider" }, { api }, "17.0.0"), undefined, `${api} on ancient host`);
    assert.equal(providerDeliveryWarning({ transformMode: "provider" }, { api }, "17.3.8"), undefined, `${api} on new host`);
  }
});

test("providerDeliveryWarning: bedrock/cursor drop before 17.3.8, lack a codec path after", () => {
  for (const api of ["amazon-bedrock", "cursor"] as const) {
    const drop = providerDeliveryWarning({ transformMode: "provider" }, { api }, "17.3.2");
    assert.ok(drop, `${api} old host → drop warning`);
    assert.equal(drop.key, `drop:${api}`);
    const nocodec = providerDeliveryWarning({ transformMode: "provider" }, { api }, "17.3.8");
    assert.ok(nocodec, `${api} new host → codec-path warning`);
    assert.equal(nocodec.key, `nocodec:${api}`);
    assert.match(nocodec.reason, /#83/);
  }
});

test("providerDeliveryWarning: unset or context mode never warns (defaults already avoid the traps)", () => {
  assert.equal(providerDeliveryWarning({}, { api: "openai-completions" }, "17.3.2"), undefined, "unset default");
  assert.equal(providerDeliveryWarning({ transformMode: "context" }, { api: "openai-completions" }, "17.3.2"), undefined, "explicit context");
  assert.equal(providerDeliveryWarning({ transformMode: "provider" }, undefined, "17.3.2"), undefined, "no model — dynamic body check covers it");
  assert.equal(providerDeliveryWarning({ transformMode: "provider" }, { api: "kimi" }, "17.3.2"), undefined, "unknown api — body-shape check covers it");
});

test("context observer surfaces the static warning once per session", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const notify: string[] = [];
  // amazon-bedrock: no codec path on ANY host — the nocodec branch fires
  // regardless of the dev host's version.
  const fire = () =>
    handlers.get("context")![0]!({ type: "context", messages: stream() }, uiCtx({ sid: "warn-static", api: "amazon-bedrock", notify }));
  assert.equal(await fire(), undefined, "explicit provider: context handler stays an observer");
  await fire();
  await fire();
  assert.equal(notify.length, 1, "notify fires exactly once per session");
  assert.match(notify[0]!, /transformMode "provider"/);
});

test("unknown wire format surfaces the dynamic warning once per session", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const notify: string[] = [];
  // A body with neither an `input` array/string nor a `messages` array is not
  // a transformable provider body — the early shape check passes it through
  // before format detection, so no warning fires (the warning is reserved for
  // bodies that have a recognizable shape but no codec path).
  const payload = { model: "x", foo: 1 };
  const fire = () =>
    handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, uiCtx({ sid: "warn-dynamic", api: "custom-api", notify }));
  assert.equal(await fire(), undefined, "unrecognized body passes through untouched");
  await fire();
  assert.equal(notify.length, 0, "no warning for a body with no transformable shape");
});

test("distinct sessions each get the warning once", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ transformMode: "provider", autoUpdate: false } as never)(api as unknown as ExtensionAPI);
  const notify: string[] = [];
  const ctx = (sid: string) => uiCtx({ sid, api: "amazon-bedrock", notify });
  for (const sid of ["s1", "s1", "s2"]) {
    await handlers.get("context")![0]!({ type: "context", messages: stream() }, ctx(sid));
  }
  assert.equal(notify.length, 2, "one warning per session (s1 once, s2 once)");
});
