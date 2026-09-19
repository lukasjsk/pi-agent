// Tool-call summary digests (CONTEXT.md "Tool-call summary"): one line per call —
// tool name handled by the row, here the single primary target.

import assert from "node:assert/strict";
import test from "node:test";

import { excerpt, toolCallSummary } from "./summary.ts";

test("excerpt flattens and truncates", () => {
	assert.equal(excerpt("  a\n\nb  ", 10), "a b");
	assert.equal(excerpt("x".repeat(50), 48), `${"x".repeat(48)}…`);
});

test("file tools: primary target is the file path", () => {
	assert.equal(toolCallSummary("read", { file_path: "/repo/src/util.ts" }), "/repo/src/util.ts");
	assert.equal(toolCallSummary("edit", { path: "a.ts" }), "a.ts");
	assert.equal(toolCallSummary("write", { filePath: "b.ts" }), "b.ts");
});

test("bash: primary target is the command head (first line)", () => {
	assert.equal(toolCallSummary("bash", { command: "bun test --coverage\necho done" }), "bun test --coverage");
});

test("grep/find/ls: pattern or path", () => {
	assert.equal(toolCallSummary("grep", { pattern: "createAgentSession", path: "extensions" }), "createAgentSession");
	assert.equal(toolCallSummary("find", { path: "extensions/subagents" }), "extensions/subagents");
	assert.equal(toolCallSummary("ls", {}), "");
});

test("subagent/scout: role + task excerpt", () => {
	assert.equal(
		toolCallSummary("scout", { task: "Map the repo for the footer cost feature" }),
		"Map the repo for the footer cost feature",
	);
	assert.match(toolCallSummary("subagent", { agent: "worker", task: "x".repeat(80) }), /^worker: x{40}…$/);
});

test("unknown tools fall back to the first non-empty string argument", () => {
	assert.equal(toolCallSummary("mytool", { flag: true, target: "the-thing" }), "the-thing");
	assert.equal(toolCallSummary("mytool", { count: 3 }), "");
	assert.equal(toolCallSummary("read", undefined), "");
});

test("git tools: the followed file, or the commit being inspected", () => {
	assert.equal(toolCallSummary("git_history", { path: "src/parser.ts", stats: true }), "src/parser.ts");
	assert.equal(toolCallSummary("git_history", { ref: "v1..HEAD" }), "v1..HEAD");
	assert.equal(toolCallSummary("git_history", { includeMerges: true }), "");
	assert.equal(toolCallSummary("git_show", { commit: "a1b2c3d", includePatch: true }), "a1b2c3d");
});
