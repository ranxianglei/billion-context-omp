import { test } from "node:test";
import assert from "node:assert/strict";
import { lenientJsonParse } from "../src/compress-args.js";

test("lenientJsonParse: valid JSON passes through unchanged", () => {
  const raw = JSON.stringify({ content: [{ startId: "m1", endId: "m2", summary: "s" }], topic: "t" });
  const out = lenientJsonParse(raw) as Record<string, unknown>;
  assert.deepEqual(out.content, [{ startId: "m1", endId: "m2", summary: "s" }]);
  assert.equal(out.topic, "t");
});

test("lenientJsonParse: strips markdown code fences", () => {
  const inner = JSON.stringify({ content: [{ startId: "m1", endId: "m2", summary: "s" }] });
  const out = lenientJsonParse("```json\n" + inner + "\n```") as Record<string, unknown>;
  assert.equal((out.content as unknown[]).length, 1);
});

test("lenientJsonParse: strips bare code fences without language tag", () => {
  const inner = JSON.stringify({ content: [] });
  const out = lenientJsonParse("```\n" + inner + "\n```") as Record<string, unknown>;
  assert.deepEqual(out.content, []);
});

test("lenientJsonParse: repairs trailing commas before } and ]", () => {
  const raw = '{"content": [{"startId": "m1", "endId": "m2", "summary": "s",},],}';
  const out = lenientJsonParse(raw) as Record<string, unknown>;
  assert.equal((out.content as unknown[]).length, 1);
});

test("lenientJsonParse: salvages complete entries from truncated content array", () => {
  // Two complete entries, third truncated mid-string.
  const raw = '{"topic": "x", "content": [{"startId": "m1", "endId": "m2", "summary": "first"}, {"startId": "m3", "endId": "m4", "summary": "second"}, {"startId": "m5", "endId": "m6", "summary": "trunca';
  const out = lenientJsonParse(raw) as Record<string, unknown>;
  const content = out.content as Array<Record<string, string>>;
  assert.equal(content.length, 2);
  assert.equal(content[0]!.startId, "m1");
  assert.equal(content[1]!.startId, "m3");
  assert.equal(out.topic, "x");
});

test("lenientJsonParse: salvage returns null when no complete entries", () => {
  // Only a partial first entry — nothing complete to salvage.
  const raw = '{"content": [{"startId": "m1", "endId": "m2", "summary": "trunca';
  const out = lenientJsonParse(raw);
  assert.equal(out, null);
});

test("lenientJsonParse: returns null on total garbage (logs evidence)", () => {
  const out = lenientJsonParse("this is not json at all");
  assert.equal(out, null);
});

test("lenientJsonParse: handles escaped quotes inside salvaged entries", () => {
  const raw = '{"content": [{"startId": "m1", "endId": "m2", "summary": "has \\"quotes\\" and \\\\ backslash"}, {"startId": "m3"';
  const out = lenientJsonParse(raw) as Record<string, unknown>;
  const content = out.content as Array<Record<string, string>>;
  assert.equal(content.length, 1);
  assert.equal(content[0]!.summary, 'has "quotes" and \\ backslash');
});

test("lenientJsonParse: fence + trailing comma combined", () => {
  const raw = "```json\n{\"content\": [{\"startId\": \"m1\", \"endId\": \"m2\", \"summary\": \"s\",},]}\n```";
  const out = lenientJsonParse(raw) as Record<string, unknown>;
  assert.equal((out.content as unknown[]).length, 1);
});
