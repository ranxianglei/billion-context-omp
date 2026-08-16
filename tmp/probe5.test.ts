import { test } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRuntime } from "../src/runtime.js";

const SESSION = "/tmp/pai-acp-probe5.session.json";
function mkCtx(sid = "probe5") { return { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionId: () => sid, getSessionFile: () => SESSION } } as never; }
const userMsg = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const botMsg = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: Date.now() });
const toolResult = (callId: string, t: string) => ({ role: "toolResult", toolCallId: callId, toolName: "compress", isError: false, content: [{ type: "text", text: t }], timestamp: Date.now() });
const FILLER = "filler content for compression minimums ".repeat(220);
function buildStream(): any[] {
  const s: any[] = [userMsg("start " + FILLER)];
  for (let i = 1; i <= 9; i++) s.push(i % 2 ? botMsg(`b${i} ` + FILLER) : userMsg(`u${i} ` + FILLER));
  s.push({ role: "assistant", content: [{ type: "toolCall", id: "call_fix1", name: "compress", arguments: { content: [{ startId: "m00001", endId: "m00008", summary: "COVERED WORK SUMMARY: exploration and tool runs from the early phase of this session, compressed to keep context lean while preserving the goal and findings for later turns." }] } }], timestamp: Date.now() });
  s.push(toolResult("call_fix1", "Compressed 1 range — 25.6k tokens saved (b1, tier 1). [fp=22222222]"));
  // tail long enough to survive the last-5/5K protection zone
  for (let i = 0; i < 14; i++) s.push(i % 2 ? botMsg(`tail${i} ` + FILLER) : userMsg(`tail${i} ` + FILLER));
  return s;
}

test("probe: fingerprint rejection scenario (variant head → fp mismatch → freshSlot loses blocks)", async () => {
  await rm(SESSION + ".acp.json", { force: true });
  const runtime = createRuntime({ modelContextLimit: 1_000_000 } as never);
  const stream = buildStream();
  const r1 = runtime.foldStream(mkCtx(), stream);
  console.log("R1 blocks:", r1.state.blocks.length);

  // Variant projection: covered range (msgs 1-8) replaced by 4 merged messages
  // → same identities count path differs → p-ids shift → spanFingerprint differs → stale skip.
  const variant: any[] = [];
  variant.push(userMsg("merged-12 " + FILLER + FILLER));
  variant.push(botMsg("merged-34 " + FILLER + FILLER));
  variant.push(userMsg("merged-56 " + FILLER + FILLER));
  variant.push(botMsg("merged-78 " + FILLER + FILLER));
  variant.push(...stream.slice(9)); // compress call + result + long tail
  const r2 = runtime.foldStream(mkCtx(), variant);
  console.log("R2 blocks:", r2.state.blocks.length, "active:", r2.state.blocks.filter((b: any) => b.active).length);
  assert.ok(true);
});
