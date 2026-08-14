import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSystemPrompt, formatSystemPromptForEvent, getSystemPromptText } from "../src/compat.js";

test("normalizeSystemPrompt returns empty string for undefined", () => {
  assert.equal(normalizeSystemPrompt(undefined), "");
});

test("normalizeSystemPrompt passes string through unchanged", () => {
  assert.equal(normalizeSystemPrompt("hello world"), "hello world");
});

test("normalizeSystemPrompt joins array with newlines", () => {
  assert.equal(normalizeSystemPrompt(["line1", "line2", "line3"]), "line1\nline2\nline3");
});

test("normalizeSystemPrompt handles empty array", () => {
  assert.equal(normalizeSystemPrompt([]), "");
});

test("normalizeSystemPrompt handles single-element array", () => {
  assert.equal(normalizeSystemPrompt(["only"]), "only");
});

test("formatSystemPromptForEvent returns string[] for omp type compatibility", () => {
  const stringResult = formatSystemPromptForEvent("base", "ACP");
  assert.ok(Array.isArray(stringResult), "omp systemPrompt is string[]");
  assert.equal(stringResult[0], "base\n\nACP");
});

test("formatSystemPromptForEvent normalizes array input into the single segment", () => {
  const arrayResult = formatSystemPromptForEvent(["line1", "line2"], "ACP");
  assert.ok(Array.isArray(arrayResult));
  assert.equal(arrayResult[0], "line1\nline2\n\nACP");
});

test("formatSystemPromptForEvent handles empty string base", () => {
  const result = formatSystemPromptForEvent("", "ACP");
  assert.equal(result[0], "\n\nACP");
});

test("formatSystemPromptForEvent handles empty array base", () => {
  const result = formatSystemPromptForEvent([], "ACP");
  assert.equal(result[0], "\n\nACP");
});

test("getSystemPromptText handles pi-style string return", () => {
  const ctx = { getSystemPrompt: () => "pi system prompt" } as any;
  assert.equal(getSystemPromptText(ctx), "pi system prompt");
});

test("getSystemPromptText handles omp-style array return", () => {
  const ctx = { getSystemPrompt: () => ["omp line1", "omp line2"] } as any;
  assert.equal(getSystemPromptText(ctx), "omp line1\nomp line2");
});

test("getSystemPromptText handles missing getSystemPrompt", () => {
  const ctx = {} as any;
  assert.equal(getSystemPromptText(ctx), "");
});

test("getSystemPromptText handles undefined return", () => {
  const ctx = { getSystemPrompt: () => undefined } as any;
  assert.equal(getSystemPromptText(ctx), "");
});
