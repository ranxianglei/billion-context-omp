import { test } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRuntime } from "../src/runtime.js";
import { findCompressCalls } from "../src/messages.js";

const SESSION = "/tmp/pai-acp-probe6.session.json";
function mkCtx(sid = "probe6") { return { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionId: () => sid, getSessionFile: () => SESSION } } as never; }
const userMsg = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const botMsg = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: Date.now() });
const toolResult = (callId: string, t: string) => ({ role: "toolResult", toolCallId: callId, toolName: "compress", isError: false, content: [{ type: "text", text: t }], timestamp: Date.now() });
const FILLER = "filler content for compression minimums ".repeat(220);
const SUMMARY = "COVERED WORK SUMMARY: exploration and tool runs from the early phase of this session, compressed to keep context lean while preserving the goal and findings for later turns.";
function buildStream(): any[] {
  const s: any[] = [userMsg("start " + FILLER)];
  for (let i = 1; i <= 9; i++) s.push(i % 2 ? botMsg(`b${i} ` + FILLER) : userMsg(`u${i} ` + FILLER));
  s.push({ role: "assistant", content: [{ type: "toolCall", id: "call_fix1", name: "compress", arguments: { content: [{ startId: "m00001", endId: "m00008", summary: SUMMARY }] } }], timestamp: Date.now() });
  s.push(toolResult("call_fix1", "Compressed 1 range — 25.6k tokens saved (b1, tier 1). [fp=22222222]"));
  for (let i = 0; i < 14; i++) s.push(i % 2 ? botMsg(`tail${i} ` + FILLER) : userMsg(`tail${i} ` + FILLER));
  return s;
}

test("probe: why R1 blocks=0 — findCompressCalls + stale check", async () => {
  await rm(SESSION + ".acp.json", { force: true });
  const runtime = createRuntime({ modelContextLimit: 1_000_000 } as never);
  const stream = buildStream();
  // what does findCompressCalls see at index 10?
  const calls = findCompressCalls(stream[10]);
  console.log("CALLS:", JSON.stringify(calls?.map(c => ({ id: c.id, ranges: c.ranges.length }))));
  const r1 = runtime.foldStream(mkCtx(), stream);
  console.log("R1 blocks:", r1.state.blocks.length);
  assert.ok(true);
});
