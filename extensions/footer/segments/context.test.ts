import assert from "node:assert/strict";
import test from "node:test";

import { getContextProgressColor } from "./context.ts";

test("uses green progress below 100k context tokens", () => {
  assert.equal(getContextProgressColor(99_999), "success");
});

test("uses yellow progress from 100k through 119,999 context tokens", () => {
  assert.equal(getContextProgressColor(100_000), "warning");
  assert.equal(getContextProgressColor(119_999), "warning");
});

test("uses orange progress from 120k through 149,999 context tokens", () => {
  assert.equal(getContextProgressColor(120_000), "#f97316");
  assert.equal(getContextProgressColor(149_999), "#f97316");
});

test("uses red progress at 150k context tokens and above", () => {
  assert.equal(getContextProgressColor(150_000), "error");
  assert.equal(getContextProgressColor(200_000), "error");
});
