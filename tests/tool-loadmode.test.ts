/**
 * Tool surface contract (issue #21): the four ACP tools must be registered
 * as first-class top-level function tools (loadMode "essential"), not as
 * discoverable tools that the host mounts under xd://.
 *
 * Why this matters: every doc this extension produces (system prompt,
 * nudge examples, tool descriptions) uses direct-call syntax
 * (compress({ content: [...] })). When the tools were discoverable, the
 * host mounted them as xd:// devices, so the only real invocation path was
 * write(path="xd://compress", content="<JSON>") — JSON-in-JSON — which
 * produced malformed-device parse errors and write calls with no path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAcpExtension } from "../src/index.js";

function captureApi() {
  const handlers = new Map<string, Array<(p: unknown, c: unknown) => unknown>>();
  const tools: any[] = [];
  const commands = new Map<string, unknown>();
  const api: any = {
    on(event: string, handler: unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler as never);
      handlers.set(event, list);
    },
    tools,
    commands,
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
  };
  return { api, handlers, tools };
}

test("all four ACP tools declare loadMode 'essential' (first-class, not xd:// devices)", () => {
  const { api, tools } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api);

  const names = tools.map((t) => t.name);
  for (const expected of ["compress", "decompress", "search_context", "acp_status"]) {
    assert.ok(names.includes(expected), `registered tools include ${expected} (got ${names.join(", ")})`);
  }
  assert.equal(tools.length, 4, "exactly the four ACP tools are registered");
  for (const t of tools) {
    assert.equal(t.loadMode, "essential", `${t.name} must stay top-level (loadMode essential)`);
  }
});
