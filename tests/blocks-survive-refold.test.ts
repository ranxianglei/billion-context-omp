import { test } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRuntime } from "../src/runtime.js";

// Regression (2026-08-16, session 01a0083c live evidence + structural
// analysis): omp fires TWO provider requests per turn — the variant one
// re-projects the same history at a different granularity. If such a view
// flip hits a slot holding LIVE compression blocks, the positional ids and
// span fingerprints of the in-stream compress call do not resolve the same
// way in the new projection, the fingerprint guard rejects the replay, and
// a fresh fold drops the just-earned blocks (live: 3 consecutive
// compressions each evaporated within ~10ms, the session re-paid them every
// time). A view flip (identity prefix preserved: LCP ≥ half the folded
// length) must CARRY the live blocks; a real prefix rewrite (compaction /
// rewind: LCP collapses to ~0) must still fold fresh and replay from the
// stream deterministically.

const SESSION = "/tmp/pai-acp-blocks-survive.session.json";

function mkCtx(sid = "blocks-survive"): never {
  return { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionId: () => sid, getSessionFile: () => SESSION } } as never;
}

const userMsg = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() });
const botMsg = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: Date.now() });
const toolResult = (callId: string, t: string) => ({
  role: "toolResult", toolCallId: callId, toolName: "compress", isError: false,
  content: [{ type: "text", text: t }], timestamp: Date.now(),
});

const FILLER = "filler content for compression minimums ".repeat(220); // ~10K chars ≈ 2.5K tokens each — the 5K-token recent zone covers only the last ~2 messages
const SUMMARY = "COVERED WORK SUMMARY: exploration and tool runs from the middle phase of this session, compressed to keep context lean while preserving the goal and findings for later turns.";

// Canonical stream: 14 body messages, compress call at 14, result at 15,
// one tail message — 17 identities total. The compress range covers the
// SECOND HALF (m00009..m00014) so a divergence at index 8 is both inside
// the range (changes the span's first-piece fingerprint) AND keeps LCP
// (8) >= floor(17/2) — a genuine view flip.
function buildStream(): any[] {
  const s: any[] = [];
  for (let i = 0; i < 14; i++) s.push(i % 2 ? botMsg(`b${i} ${FILLER}`) : userMsg(`u${i} ${FILLER}`));
  s.push({ role: "assistant", content: [{ type: "toolCall", id: "call_fix1", name: "compress", arguments: { content: [{ startId: "m00009", endId: "m00014", summary: SUMMARY }] } }], timestamp: Date.now() });
  s.push(toolResult("call_fix1", "Compressed 1 range — 8.2k tokens saved (b1, tier 1)."));
  s.push(userMsg("tail question " + FILLER));
  return s;
}

test("view flip (LCP >= half) carries live blocks; range fingerprints mismatch across projections", async () => {
  await rm(SESSION + ".acp.json", { force: true });
  const runtime = createRuntime({ modelContextLimit: 1_000_000 } as never);

  // Canonical fold: the in-stream call replays and creates b1.
  const r1 = runtime.foldStream(mkCtx("flip"), buildStream());
  assert.equal(r1.state.blocks.length, 1, "canonical replay created the block");

  // Variant projection: merge messages 8+9 (inside the covered range's head)
  // → identity prefix breaks at index 8 with LCP 8 >= floor(17/2): a view
  // flip, not a compaction. The span's first-piece fingerprint changes, so a
  // fresh replay of the call would be REJECTED (fp mismatch) — without the
  // carry the blocks would evaporate exactly like the live session.
  const variant = buildStream();
  const merged = variant[8]!.content[0].text + " || " + variant[9]!.content[0].text;
  variant.splice(8, 2, userMsg(merged));
  const r2 = runtime.foldStream(mkCtx("flip"), variant);
  assert.equal(
    r2.state.blocks.filter((b) => b.active).length, 1,
    "live block survives the view flip (carried, not replayed)",
  );
});

test("real compaction (LCP collapses) still folds fresh", async () => {
  await rm(SESSION + ".acp.json", { force: true });
  const runtime = createRuntime({ modelContextLimit: 1_000_000 } as never);

  const stream = buildStream();
  const r1 = runtime.foldStream(mkCtx("compaction"), stream);
  assert.equal(r1.state.blocks.length, 1, "canonical replay created the block");

  // Host compaction: summary at the head + only the tail survives — LCP ≈ 0.
  const compacted = [
    userMsg("[Compressed conversation section] everything before summarized"),
    ...stream.slice(15), // compress result + tail (the call itself is gone)
  ];
  const r2 = runtime.foldStream(mkCtx("compaction"), compacted);
  assert.equal(r2.state.blocks.length, 0, "compaction re-folds from scratch — no carried blocks, no phantom replay");
});
