import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  readCompressModel,
  resolveCompressModel,
  sliceRange,
  selectRangeSpan,
  formatSlice,
  parseSummary,
  buildSummaryPrompt,
} from "../src/auto-compress.ts";
import { defaultPrompts } from "acp-kernel";

type CoreMessageLite = { id: string; role: string; text?: string; toolName?: string };
type StateLite = { messageRefs: { byRaw: Record<string, string> } };

function makeState(ids: string[]): StateLite {
  const byRaw: Record<string, string> = {};
  ids.forEach((id, i) => {
    byRaw[id] = `m${String(i).padStart(5, "0")}`;
  });
  return { messageRefs: { byRaw } };
}

function makeRange(startRef: string, endRef: string, tokens: number) {
  return { startRef, endRef, tokens, dangerous: false };
}

function withHome<T>(dir: string, fn: () => T): T {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn();
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
  }
}

test("parseSummary extracts summary from plain JSON object", () => {
  assert.equal(parseSummary('{"summary":"hello world"}'), "hello world");
});

test("parseSummary strips ```json fences", () => {
  assert.equal(parseSummary('```json\n{"summary":"fenced"}\n```'), "fenced");
});

test("parseSummary returns null on non-JSON, empty, or missing summary", () => {
  assert.equal(parseSummary("not json at all"), null);
  assert.equal(parseSummary('{"summary":""}'), null);
  assert.equal(parseSummary('{"other":"x"}'), null);
  assert.equal(parseSummary('{"summary":123}'), null);
});

test("resolveCompressModel: explicit configured model wins", () => {
  const registry = { find: (p: string, id: string) => (p === "openai" && id === "gpt-4o" ? { provider: p, id } : undefined) };
  const current = { provider: "anthropic", id: "claude" };
  const r = resolveCompressModel(registry as never, current as never, "openai:gpt-4o");
  assert.equal(r?.model.provider, "openai");
  assert.equal(r?.model.id, "gpt-4o");
  assert.equal(r?.label, "openai:gpt-4o");
});

test("resolveCompressModel: configured missing → null (not fallback) so caller surfaces config error", () => {
  const registry = { find: () => undefined };
  const current = { provider: "anthropic", id: "claude" };
  assert.equal(resolveCompressModel(registry as never, current as never, "openai:nonexistent"), null);
});

test("resolveCompressModel: no config → current session model", () => {
  const registry = { find: () => undefined };
  const current = { provider: "anthropic", id: "claude" };
  const r = resolveCompressModel(registry as never, current as never, null);
  assert.equal(r?.model.provider, "anthropic");
  assert.equal(r?.label, "anthropic:claude");
});

test("resolveCompressModel: bare model id without provider defaults to openai", () => {
  const registry = { find: (p: string, id: string) => (p === "openai" ? { provider: p, id } : undefined) };
  const r = resolveCompressModel(registry as never, undefined, "gpt-4o-mini");
  assert.equal(r?.model.provider, "openai");
  assert.equal(r?.model.id, "gpt-4o-mini");
});

test("resolveCompressModel: nothing usable → null", () => {
  const registry = { find: () => undefined };
  assert.equal(resolveCompressModel(registry as never, undefined, null), null);
});

test("readCompressModel returns null when acp-omp.json absent (graceful)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-compact-"));
  try {
    withHome(dir, () => assert.equal(readCompressModel(), null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCompressModel reads provider:modelId from acp-omp.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-compact-"));
  try {
    mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(dir, CONFIG_DIR_NAME, "acp-omp.json"), JSON.stringify({ compressModel: "openai:gpt-4o" }));
    withHome(dir, () => assert.equal(readCompressModel(), "openai:gpt-4o"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCompressModel ignores empty / non-string compressModel", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-compact-"));
  try {
    mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(dir, CONFIG_DIR_NAME, "acp-omp.json"), JSON.stringify({ compressModel: "" }));
    withHome(dir, () => assert.equal(readCompressModel(), null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sliceRange filters messages within the ref span (inclusive)", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const msgs: CoreMessageLite[] = ids.map((id) => ({ id, role: "user", text: id }));
  const state = makeState(ids);
  const slice = sliceRange(msgs as never, state as never, "m00001", "m00003");
  assert.deepEqual(slice.map((m) => m.id), ["b", "c", "d"]);
});

test("sliceRange ignores messages without a ref", () => {
  const msgs: CoreMessageLite[] = [{ id: "a", role: "user", text: "a" }, { id: "nope", role: "user", text: "x" }];
  const state = makeState(["a"]);
  const slice = sliceRange(msgs as never, state as never, "m00000", "m00005");
  assert.deepEqual(slice.map((m) => m.id), ["a"]);
});

test("selectRangeSpan returns null when the whole set is below minChars", () => {
  const ids = ["a", "b"];
  const msgs: CoreMessageLite[] = ids.map((id) => ({ id, role: "user", text: "tiny" }));
  const state = makeState(ids);
  const ranges = [makeRange("m00000", "m00001", 5)];
  assert.equal(selectRangeSpan(ranges, msgs as never, state as never, 5000), null);
});

test("selectRangeSpan seeds on largest range and expands until chars >= minChars", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const msgs: CoreMessageLite[] = ids.map((id, i) => ({ id: `id${i}`, role: "user", text: "x".repeat(2000) }));
  const state = makeState(ids.map((_, i) => `id${i}`));
  const ranges = [
    makeRange("m00000", "m00001", 100),
    makeRange("m00003", "m00005", 400),
    makeRange("m00007", "m00007", 50),
  ];
  const span = selectRangeSpan(ranges, msgs as never, state as never, 5000);
  assert.ok(span, "expected a span");
  assert.equal(span!.startRef, "m00003");
  assert.ok(span!.endRef === "m00005" || span!.endRef === "m00007", `endRef=${span!.endRef}`);
  assert.ok(span!.tokens >= 1250, `tokens=${span!.tokens}`);
});

test("selectRangeSpan handles empty ranges", () => {
  const span = selectRangeSpan([], [], { messageRefs: { byRaw: {} } } as never, 5000);
  assert.equal(span, null);
});

test("formatSlice annotates refs and truncates oversized single messages", () => {
  const ids = ["a", "b"];
  const big = "y".repeat(10000);
  const msgs: CoreMessageLite[] = [{ id: "a", role: "assistant", text: "short" }, { id: "b", role: "tool", text: big, toolName: "bash" }];
  const state = makeState(ids);
  const out = formatSlice(msgs as never, state as never);
  assert.ok(out.includes("[m00000] assistant: short"));
  assert.ok(out.includes("[m00001] tool result (bash):"));
  assert.ok(out.includes("…[truncated]"));
  assert.ok(!out.includes("y".repeat(10000)));
});

test("buildSummaryPrompt embeds the kernel compressPhilosophy and howToCompressRules", () => {
  const prompt = buildSummaryPrompt(defaultPrompts);
  assert.ok(prompt.includes(defaultPrompts.compressPhilosophy), "must include compressPhilosophy");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules), "must include howToCompressRules");
  assert.ok(prompt.includes('{"summary": "..."}'), "must instruct JSON output shape");
  assert.ok(!prompt.includes("tier 2") && !prompt.includes("TIER 2"), "must NOT pull in tier-2 distillation rules");
});

test("buildSummaryPrompt reflects acp-omp.json prompt overrides (not a hard-coded constant)", () => {
  const custom = {
    compressPhilosophy: "CUSTOM-PHILOSOPHY-MARKER",
    howToCompressRules: "CUSTOM-RULES-MARKER",
    tier2DistillRules: defaultPrompts.tier2DistillRules,
    tier3CondenseRules: defaultPrompts.tier3CondenseRules,
  };
  const prompt = buildSummaryPrompt(custom);
  assert.ok(prompt.includes("CUSTOM-PHILOSOPHY-MARKER"));
  assert.ok(prompt.includes("CUSTOM-RULES-MARKER"));
});
