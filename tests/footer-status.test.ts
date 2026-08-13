import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCompactTokens } from "../src/footer-status.js";

test("formatCompactTokens matches pi formatTokens at every boundary", () => {
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(1000), "1.0k");
  assert.equal(formatCompactTokens(9999), "10.0k");
  assert.equal(formatCompactTokens(10000), "10k");
  assert.equal(formatCompactTokens(999999), "1000k");
  assert.equal(formatCompactTokens(1000000), "1.0M");
  assert.equal(formatCompactTokens(9999999), "10.0M");
  assert.equal(formatCompactTokens(10000000), "10M");
});
