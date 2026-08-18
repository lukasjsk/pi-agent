import assert from "node:assert/strict";
import test from "node:test";

import { formatContextTokens } from "./helpers.ts";

test("formats context sizes below 1M with a k suffix", () => {
  assert.equal(formatContextTokens(120), "0.12k");
  assert.equal(formatContextTokens(1_000), "1k");
  assert.equal(formatContextTokens(23_100), "23.1k");
  assert.equal(formatContextTokens(100_000), "100k");
  assert.equal(formatContextTokens(120_000), "120k");
});

test("switches from k to M at 1M", () => {
  assert.equal(formatContextTokens(1_000_000), "1M");
  assert.equal(formatContextTokens(1_120_000), "1.12M");
});

test("stops at the M suffix for large context sizes", () => {
  assert.equal(formatContextTokens(200_000_000), "200M");
});

test("shows zero without a suffix", () => {
  assert.equal(formatContextTokens(0), "0");
});
