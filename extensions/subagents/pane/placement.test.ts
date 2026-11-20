// placement.test.ts — the multiplexer-agnostic subagent pane placement policy
// (ADR 0001): the first spawn goes right of the orchestrator pane; later spawns
// stack down of the last successfully opened subagent pane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTarget } from "./placement.ts";

test("the first spawn goes right of the orchestrator pane", () => {
	assert.deepEqual(splitTarget({ lastSubagentPaneId: undefined }, "w1:p1"), {
		paneId: "w1:p1",
		direction: "right",
	});
});

test("later spawns stack down of the last subagent pane", () => {
	assert.deepEqual(splitTarget({ lastSubagentPaneId: "w1:p3" }, "w1:p1"), {
		paneId: "w1:p3",
		direction: "down",
	});
});

test("after a failed open the state is unchanged, so the next spawn retargets the anchor pane right", () => {
	// The manager advances state only on successful splits, so a failed open leaves
	// the state undefined and the placement is identical to the first spawn.
	const state = { lastSubagentPaneId: undefined as string | undefined };
	assert.deepEqual(splitTarget(state, "w1:p1"), { paneId: "w1:p1", direction: "right" });
	assert.deepEqual(splitTarget(state, "w1:p1"), { paneId: "w1:p1", direction: "right" });
});
