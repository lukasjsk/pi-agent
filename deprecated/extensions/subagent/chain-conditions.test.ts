import assert from "node:assert/strict";
import test from "node:test";

import { shouldSkipStep } from "./chain-conditions.ts";

test("skips a conditional step when the prior output contains its marker", () => {
  assert.equal(shouldSkipStep("## NO_FINDINGS\nEverything is correct.", "## NO_FINDINGS"), true);
});

test("runs a conditional step when the prior output does not contain its marker", () => {
  assert.equal(shouldSkipStep("## Findings\n- Missing test", "## NO_FINDINGS"), false);
});

test("runs an unconditional step", () => {
  assert.equal(shouldSkipStep("## NO_FINDINGS", undefined), false);
});
