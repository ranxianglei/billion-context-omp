import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTransformMode, hostVersionAtLeast } from "../src/transform-mode.js";

const MIN: readonly [number, number, number] = [17, 3, 8];

test("hostVersionAtLeast: exact match", () => {
  assert.equal(hostVersionAtLeast(MIN, "17.3.8"), true);
});

test("hostVersionAtLeast: just below", () => {
  assert.equal(hostVersionAtLeast(MIN, "17.3.7"), false);
  assert.equal(hostVersionAtLeast(MIN, "17.2.99"), false);
  assert.equal(hostVersionAtLeast(MIN, "16.9.99"), false);
});

test("hostVersionAtLeast: above", () => {
  assert.equal(hostVersionAtLeast(MIN, "17.3.9"), true);
  assert.equal(hostVersionAtLeast(MIN, "17.4.0"), true);
  assert.equal(hostVersionAtLeast(MIN, "18.0.0"), true);
});

test("hostVersionAtLeast: prerelease suffix parses the numeric prefix", () => {
  assert.equal(hostVersionAtLeast(MIN, "17.3.8-beta.1"), true);
  assert.equal(hostVersionAtLeast(MIN, "17.3.7-rc.2"), false);
});

test("hostVersionAtLeast: unparseable versions are false (fail-safe)", () => {
  assert.equal(hostVersionAtLeast(MIN, ""), false);
  assert.equal(hostVersionAtLeast(MIN, "garbage"), false);
  assert.equal(hostVersionAtLeast(MIN, "17.3"), false);
});

test("explicit transformMode always wins, even on old hosts", () => {
  assert.equal(resolveTransformMode({ transformMode: "provider" }, { api: "openai-completions" }, "17.3.7"), "provider");
  assert.equal(resolveTransformMode({ transformMode: "context" }, { api: "anthropic-messages" }, "17.3.8"), "context");
});

test("no model -> context", () => {
  assert.equal(resolveTransformMode({}, undefined, "17.3.8"), "context");
  assert.equal(resolveTransformMode({}, {}, "17.3.8"), "context");
});

test("anthropic-messages and ollama-chat: provider on any host version", () => {
  for (const api of ["anthropic-messages", "ollama-chat"]) {
    assert.equal(resolveTransformMode({}, { api }, "17.0.0"), "provider");
    assert.equal(resolveTransformMode({}, { api }, "17.3.8"), "provider");
  }
});

test("openai-completions: context below 17.3.8, provider from 17.3.8 (issue #83)", () => {
  assert.equal(resolveTransformMode({}, { api: "openai-completions" }, "17.3.7"), "context");
  assert.equal(resolveTransformMode({}, { api: "openai-completions" }, "17.3.8"), "provider");
  assert.equal(resolveTransformMode({}, { api: "openai-completions" }, "17.4.0"), "provider");
});

test("bedrock / cursor / responses / google / devin stay context even on 17.3.8 (no codec path)", () => {
  for (const api of ["amazon-bedrock", "cursor", "openai-responses", "google", "devin-agent"]) {
    assert.equal(resolveTransformMode({}, { api }, "17.3.8"), "context");
  }
});

test("unknown api -> context", () => {
  assert.equal(resolveTransformMode({}, { api: "some-future-api" }, "17.3.8"), "context");
});
