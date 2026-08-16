import { test } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRuntime } from "../src/runtime.js";

const SESSION = "/tmp/pai-acp-probe8.session.json";
function mkCtx(sid = "probe8") { return { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionId: () => sid, getSessionFile: () => SESSION } } as never; }
const userMsg = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const botMsg = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: Date.now() });
const toolResult = (callId: string, t: string) => ({ role: "toolResult", toolCallId: callId, toolName: "compress", isError: false, content: [{ type: "text", text: t }], timestamp: Date.now() });
const FILLER = "filler content for compression minimums ".repeat(220);
const SUMMARY = "COVERED WORK SUMMARY: exploration and tool runs from the early phase of this session, compressed to keep context lean while preserving the goal and findings for later turns.";
function buildStream(): any[] {
  const s: any[] = [userMsg("start " + FILLER)];
  for (let i = 1; i <= 9; i++) s.push(i % 2 ? botMsg(`b${i} ` + FILLER) : userMsg(`u${i} ` + FILLER));
  s.push({ role: "assistant", content: [{ type: "toolCall", id: "call_fix1", name: "compress", arguments: { content: [{ startId: "m00001", endId: "m00008", summary: SUMMARY }] } }], timestamp: Date.now() });
  s.push(toolResult("call_fix1", "Compressed 1 range — 25.6k tokens saved (b1, tier 1)."));
  for (let i = 0; i < 14; i++) s.push(i % 2 ? botMsg(`tail${i} ` + FILLER) : userMsg(`tail${i} ` + FILLER));
  return s;
}

test("probe: variant with mid divergence (flip path) vs shrunken head", async () => {
  await rm(SESSION + ".acp.json", { force: true });
  const runtime = createRuntime({ modelContextLimit: 1_000_000 } as never);
  const stream = buildStream();
  const r1 = runtime.foldStream(mkCtx(), stream);
  console.log("R1 blocks:", r1.state.blocks.length);

  // Variant A: shrunken head (this is what the POST-compress view looks like:
  // covered range replaced by 4 merged messages → p-shift → stale skip)
  const variantA: any[] = [];
  variantA.push(userMsg("merged-12 " + FILLER + FILLER));
  variantA.push(botMsg("merged-34 " + FILLER + FILLER));
  variantA.push(userMsg("merged-56 " + FILLER + FILLER));
  variantA.push(botMsg("merged-78 " + FILLER + FILLER));
  variantA.push(...stream.slice(10));
  const lcpA = 0; // head differs → lcp=0
  const rA = runtime.foldStream(mkCtx(), variantA);
  console.log("RA (shrunken head, lcp=" + lcpA + "):", rA.state.blocks.length, "active:", rA.state.blocks.filter((b: any) => b.active).length);

  // Variant B: same length + mid divergence (true flip: lcp=5)
  const variantB = buildStream();
  variantB[5] = userMsg("u4 " + FILLER + " FLIP-TAIL");
  const rB = runtime.foldStream(mkCtx(), variantB);
  console.log("RB (mid divergence, flip):", rB.state.blocks.length, "active:", rB.state.blocks.filter((b: any) => b.active).length);
  assert.ok(true);
});
