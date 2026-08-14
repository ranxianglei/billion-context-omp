import { mock, test } from "bun:test";
import assert from "node:assert/strict";

// checkForUpdate is stubbed with a deferred promise: the session_start
// handler must AWAIT it. It used to be `void checkForUpdate(...)` —
// fire-and-forget — which let short-lived hosts (omp -p) exit before the
// npm auto-install child process finished, killing it mid-flight.

let resolveUpdate: (() => void) | undefined;
let updateStarted = false;

mock.module("../src/update.js", () => ({
  checkForUpdate: () => {
    updateStarted = true;
    return new Promise<void>((resolve) => {
      resolveUpdate = resolve;
      // Fallback for OTHER test files sharing this bun process: their
      // session_start handlers await this too and must not hang.
      setTimeout(resolve, 100);
    });
  },
}));

const { createAcpExtension } = await import("../src/index.js");

interface MockApi {
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  registerTool(): void;
  registerCommand(): void;
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

test("session_start awaits checkForUpdate before resolving (auto-install survives short-lived hosts)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({})(api as never);

  const ctx = {
    cwd: "/tmp",
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => "upd-await-test", getSessionFile: () => "/tmp/upd-await-test.json" },
  };

  let settled = false;
  const handlerPromise = (handlers.get("session_start")![0]! as (e: unknown, c: unknown) => Promise<void>)({}, ctx);
  void handlerPromise.then(() => {
    settled = true;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.ok(updateStarted, "checkForUpdate was called");
  assert.equal(settled, false, "session_start must NOT settle before checkForUpdate resolves");
  resolveUpdate!();
  await handlerPromise;
  assert.equal(settled, true, "session_start settles after checkForUpdate");
});
