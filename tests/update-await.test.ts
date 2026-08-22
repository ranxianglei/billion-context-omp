import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Issue #89: checkForUpdate sat AWAITed inside the LLM request pipeline
// (context event + before_provider_request). Its worst path — a 5s registry
// fetch plus a 60s auto-install — exceeded the host's 30s handler budget, so
// the host dropped the handler's return value and the turn went out with
// untransformed messages. All call sites are now fire-and-forget
// (autoInstallLatest's keepAlive interval still protects a short-lived host
// from exiting mid-install). checkForUpdate is stubbed with a controllable
// promise that ALSO settles after a 100ms fallback: mock.module is
// process-global, so other test files sharing this bun process (the
// checkForUpdate callers in tests/update.test.ts) must never hang on it.
// The no-await pin below does NOT rely on the promise staying unsettled —
// it asserts the handler settled while the update promise was STILL
// pending, which holds for any fallback delay.

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
    // Fallback for OTHER test files sharing this bun process: their
    // checkForUpdate callers await this too and must not hang. 100ms is
    // long enough that the settled-while-pending assertions below (which
    // attach their observer well before then) still see it pending.
    setTimeout(resolve, 100);
  });
  return { promise, resolve };
}

const pending: Deferred[] = [];
let calls = 0;

mock.module("../src/update.js", () => ({
  checkForUpdate: (_autoUpdate: boolean, _notify?: (msg: string) => void) => {
    calls += 1;
    const d = deferred();
    pending.push(d);
    return d.promise;
  },
}));

const { createAcpExtension } = await import("../src/index.js");

interface MockApi {
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
  config: { load: () => Record<string, never> };
}

function captureApi() {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const api: MockApi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerCommand() {},
    config: { load: () => ({}) },
  };
  return { api, handlers };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Settle = true iff `p` resolves within `budget` ms. A handler that awaits
// the (never-settling) update check loses the race and fails the assert.
async function settlesWithin(p: Promise<unknown>, budget: number): Promise<boolean> {
  return Promise.race([p.then(() => true), sleep(budget).then(() => false)]);
}

test("session_start fires checkForUpdate without awaiting it (issue #89)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({})(api as unknown as ExtensionAPI);

  const ctx = {
    cwd: "/tmp",
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => "upd-fwf-test", getSessionFile: () => "/tmp/upd-fwf-test.json" },
  };

  const started = calls;
  const p = handlers.get("session_start")![0]!({}, ctx) as Promise<unknown>;
  await sleep(50); // the fire-and-forget call has happened; the 100ms fallback has not
  assert.equal(calls, started + 1, "checkForUpdate was called once");
  const d = pending[pending.length - 1]!;
  let updateSettled = false;
  d.promise.then(() => { updateSettled = true; });
  assert.equal(await settlesWithin(p, 2000), true, "session_start must settle on its own (no await on checkForUpdate)");
  assert.equal(updateSettled, false, "the update check was still pending when the handler settled");
  d.resolve();
  await d.promise;
});

test("before_provider_request returns the transformed payload without awaiting the update check (issue #89)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ autoUpdate: false })(api as unknown as ExtensionAPI);
  const ctx = {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {} },
    model: { contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }),
    sessionManager: { getSessionId: () => "upd-fwf-prov", getSessionFile: () => "/tmp/upd-fwf-prov.json" },
  } as unknown as ExtensionContext;

  const payload = {
    model: "claude-x",
    max_tokens: 8192,
    system: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ],
  };

  const started = calls;
  const p = handlers.get("before_provider_request")![0]!({ type: "before_provider_request", payload }, ctx) as Promise<unknown>;
  await sleep(50); // the fire-and-forget call has happened; the 100ms fallback has not
  assert.equal(calls, started + 1, "checkForUpdate was fired per provider request");
  const d = pending[pending.length - 1]!;
  let updateSettled = false;
  d.promise.then(() => { updateSettled = true; });
  assert.equal(await settlesWithin(p, 2000), true, "the provider handler must settle on its own, not behind the 5s/65s update check");
  const out = (await p) as { messages: unknown[] };
  assert.ok(out, "transformed payload returned while the update check was still pending");
  assert.equal(out.messages.length, 2, "wire messages rebuilt");
  assert.equal(updateSettled, false, "the update check was still pending when the handler settled");
  d.resolve();
  await d.promise;
});
