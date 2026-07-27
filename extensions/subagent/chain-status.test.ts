import assert from "node:assert/strict";
import test from "node:test";

import { formatChainStatus } from "./chain-status.ts";

test("labels the first running chain step as step 1 rather than zero completed steps", () => {
  assert.equal(formatChainStatus({ totalSteps: 2, completedSteps: 0, runningSteps: 1 }), "1/2 steps, 1 running");
});

test("labels the next running chain step after completed work", () => {
  assert.equal(formatChainStatus({ totalSteps: 4, completedSteps: 2, runningSteps: 1 }), "3/4 steps, 1 running");
});

test("reports completed steps once the chain is no longer running", () => {
  assert.equal(formatChainStatus({ totalSteps: 2, completedSteps: 2, runningSteps: 0 }), "2/2 steps");
});
