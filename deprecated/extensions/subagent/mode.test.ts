import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSubagentArguments } from "./mode.ts";

test("prefers an explicit chain mode and removes stale single and parallel fields", () => {
	assert.deepEqual(
		normalizeSubagentArguments({
		mode: "chain",
		agent: "explorer",
		task: "stale single task",
		tasks: [{ agent: "explorer", task: "stale parallel task" }],
		chain: [{ agent: "explorer", task: "investigate" }],
		agentScope: "user",
	}),
		{
			mode: "chain",
			chain: [{ agent: "explorer", task: "investigate" }],
			agentScope: "user",
		},
	);
});

test("infers chain mode for legacy calls with stale fields", () => {
	assert.deepEqual(
		normalizeSubagentArguments({
		agent: "explorer",
		task: "stale single task",
		tasks: [{ agent: "explorer", task: "stale parallel task" }],
		chain: [{ agent: "explorer", task: "investigate" }],
		}),
		{
			mode: "chain",
			chain: [{ agent: "explorer", task: "investigate" }],
		},
	);
});

test("keeps malformed arguments for schema validation", () => {
	const malformed = { agent: "explorer" };
	assert.equal(normalizeSubagentArguments(malformed), malformed);
});
