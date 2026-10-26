// frame.test.ts — pane viewer frame builder (ADR 0001), tested at the pure
// seams: pane header rendering, activity lines, frame assembly, scroll
// slicing, and width truncation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activityLines, buildFrame, buildPaneHeader, truncateToWidth, visibleSlice } from "./frame.ts";
import type { PaneActivityEvent, PaneSettledEvent } from "./protocol.ts";

/** Strip ANSI SGR escapes so assertions can match the visible text. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const sampleActivity: PaneActivityEvent = {
	type: "activity",
	progress: "reading",
	toolCalls: [
		{ toolCallId: "1", toolName: "read", summary: "src/x.ts", status: "done" },
		{ toolCallId: "2", toolName: "bash", summary: "ls", status: "error" },
		{ toolCallId: "3", toolName: "grep", summary: "pattern", status: "running" },
	],
	contentLines: ["hello", "world"],
	model: "test/provider-x/model-y",
	effectiveThinkingLevel: "medium",
	tokens: { input: 40000, output: 8000 },
	contextWindow: 200000,
	cost: 1.25,
};

test("activityLines lists tool-call summaries oldest first with status markers, then content lines", () => {
	assert.deepEqual(
		activityLines({ activity: sampleActivity, width: 120 }),
		[
			"✓ read src/x.ts",
			"✗ bash ls",
			"◦ grep pattern",
			"hello",
			"world",
		],
	);
});

test("activityLines omits the summary part when it is empty", () => {
	const activity: PaneActivityEvent = {
		...sampleActivity,
		toolCalls: [{ toolCallId: "1", toolName: "read", summary: "", status: "done" }],
		contentLines: [],
	};
	assert.deepEqual(activityLines({ activity, width: 120 }), ["✓ read"]);
});

test("activityLines in the settled state shows the status line, diagnostics, and the report preview", () => {
	const settled: PaneSettledEvent = {
		type: "settled",
		status: "completed",
		modelUsed: "anthropic/claude-x",
		cost: 2.5,
		diagnostics: ["fallback used", "retry 1 ok"],
		reportPreview: "line1\nline2",
		closeDelayMs: 15000,
	};
	assert.deepEqual(activityLines({ settled, width: 120 }), [
		"settled: completed · model: anthropic/claude-x",
		"· fallback used",
		"· retry 1 ok",
		"line1",
		"line2",
	]);
});

test("activityLines settled status line drops the model when absent and the run is not completed", () => {
	const settled: PaneSettledEvent = {
		type: "settled",
		status: "failed",
		diagnostics: [],
		reportPreview: "",
		closeDelayMs: 15000,
	};
	assert.deepEqual(activityLines({ settled, width: 120 }), ["settled: failed"]);
});

test("activityLines without any events is empty", () => {
	assert.deepEqual(activityLines({ width: 120 }), []);
});

test("buildPaneHeader shows the model id, the context percentage, and the cost", () => {
	const header = buildPaneHeader({ activity: sampleActivity, width: 120 });
	const visible = stripAnsi(header);
	assert.match(visible, /model-y/);
	assert.match(visible, /20\.0%/);
	assert.match(visible, /\$1\.25/);
	// The three segments, joined with single spaces — model leads, cost ends.
	assert.ok(visible.startsWith("provider-x/model-y"));
	assert.ok(visible.endsWith("$1.25"));
});

test("buildPaneHeader renders with no model and no activity", () => {
	const header = buildPaneHeader({ width: 120 });
	assert.equal(typeof header, "string");
	assert.ok(header.length > 0);
	const visible = stripAnsi(header);
	assert.ok(visible.includes("no-model"));
	assert.ok(visible.includes("0.0%"));
	assert.ok(visible.includes("$0.00"));
});

test("buildPaneHeader prefers the settled cost and model over the stale activity snapshot", () => {
	const settled: PaneSettledEvent = {
		type: "settled",
		status: "completed",
		modelUsed: "other/provider-z/model-z",
		cost: 3.75,
		diagnostics: [],
		closeDelayMs: 15000,
	};
	const visible = stripAnsi(buildPaneHeader({ activity: sampleActivity, settled, width: 120 }));
	assert.match(visible, /model-z/);
	assert.match(visible, /\$3\.75/);
});

test("buildPaneHeader caps the context percentage at 100 and splits the model at the first slash", () => {
	const activity: PaneActivityEvent = { ...sampleActivity, tokens: { input: 250000, output: 0 }, contextWindow: 200000 };
	const visible = stripAnsi(buildPaneHeader({ activity, width: 120 }));
	assert.match(visible, /100\.0%/);
	// "test/provider-x/model-y" → the leading provider "test" is dropped, the id keeps its slash.
	assert.ok(visible.startsWith("provider-x/model-y (MEDIUM)"));
	assert.ok(!visible.startsWith("test"));
});

test("buildFrame stacks the pane header, a blank line, and the activity lines", () => {
	assert.deepEqual(buildFrame({ activity: sampleActivity, width: 120 }), [
		buildPaneHeader({ activity: sampleActivity, width: 120 }),
		"",
		"✓ read src/x.ts",
		"✗ bash ls",
		"◦ grep pattern",
		"hello",
		"world",
	]);
});

test("buildFrame appends the countdown line with the exact number when settled", () => {
	const settled: PaneSettledEvent = {
		type: "settled",
		status: "completed",
		diagnostics: [],
		closeDelayMs: 15000,
	};
	const frame = buildFrame({ activity: sampleActivity, settled, countdownSeconds: 14, width: 120 });
	assert.equal(frame[0], buildPaneHeader({ activity: sampleActivity, settled, width: 120 }));
	assert.equal(frame[1], "");
	assert.equal(frame[frame.length - 1], "closing in 14s");
	const frameEnd = buildFrame({ settled, countdownSeconds: 0, width: 120 });
	assert.equal(frameEnd[frameEnd.length - 1], "closing in 0s");
});

test("buildFrame omits the countdown line when settled without a countdown or not settled with one", () => {
	const settled: PaneSettledEvent = {
		type: "settled",
		status: "completed",
		diagnostics: [],
		closeDelayMs: 15000,
	};
	assert.ok(!buildFrame({ settled, width: 120 }).some((l) => l.startsWith("closing in")));
	assert.ok(!buildFrame({ activity: sampleActivity, countdownSeconds: 3, width: 120 }).some((l) => l.startsWith("closing in")));
});

test("truncateToWidth cuts plain lines to width", () => {
	assert.equal(truncateToWidth("hello world", 5), "hello");
	assert.equal(truncateToWidth("abc", 10), "abc");
	assert.equal(truncateToWidth("abc", 0), "");
});

test("truncateToWidth treats ANSI escapes as zero-width", () => {
	const colored = "\x1b[38;2;1;2;3mred\x1b[0m plain";
	assert.equal(truncateToWidth(colored, 3), "\x1b[38;2;1;2;3mred");
	assert.equal(truncateToWidth(colored, 4), "\x1b[38;2;1;2;3mred\x1b[0m ");
	assert.equal(truncateToWidth(colored, 9), colored);
	assert.equal(truncateToWidth("\x1b[Habc", 3), "\x1b[Habc");
	assert.equal(truncateToWidth("\x1b[Habc", 2), "\x1b[Hab");
});

test("visibleSlice returns the last height lines when following the tail", () => {
	const lines = ["0", "1", "2", "3", "4"];
	assert.deepEqual(visibleSlice(lines, 3, 0), ["2", "3", "4"]);
});

test("visibleSlice shifts the window up for scrollback and never indexes below line 0", () => {
	const lines = ["0", "1", "2", "3", "4"];
	assert.deepEqual(visibleSlice(lines, 3, 1), ["1", "2", "3"]);
	assert.deepEqual(visibleSlice(lines, 3, 10), ["0", "1", "2"]);
});

test("visibleSlice returns the available lines without padding when the buffer is short", () => {
	const lines = ["a", "b"];
	assert.deepEqual(visibleSlice(lines, 3, 0), ["a", "b"]);
	assert.deepEqual(visibleSlice([], 3, 0), []);
	assert.deepEqual(visibleSlice(["a"], 0, 0), []);
});
