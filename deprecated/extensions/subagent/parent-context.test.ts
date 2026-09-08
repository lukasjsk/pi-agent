import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PARENT_CONTEXT_BYTES, formatParentContext, withParentContext } from "./parent-context.ts";
import { createHandover, withHandoverContext } from "./handover.ts";

const text = (role: string, value: string) => ({ role, content: [{ type: "text", text: value }] });

test("formats an uncompacted active parent transcript in message order", () => {
	const context = formatParentContext([text("user", "Describe the authentication problem."), text("assistant", "I will inspect the session code.")]);

	assert.match(context, /# Parent session context/);
	assert.ok(context.indexOf("## User") < context.indexOf("## Assistant"));
	assert.match(context, /Describe the authentication problem/);
});

test("preserves canonical compaction summaries and retained active messages", () => {
	// This is the output shape from buildContextEntries() mapped through
	// sessionEntryToContextMessages(): stale pre-compaction entries are absent.
	const context = formatParentContext([
		{ role: "compactionSummary", summary: "Earlier decision: use OAuth." },
		text("user", "Add token refresh support."),
		text("assistant", "I will update the provider."),
	]);

	assert.match(context, /## Compaction summary\nEarlier decision: use OAuth/);
	assert.ok(context.indexOf("## Compaction summary") < context.indexOf("## User"));
	assert.match(context, /Add token refresh support/);
	assert.doesNotMatch(context, /stale pre-compaction/);
});

test("retains the newest messages within the UTF-8 byte budget", () => {
	const context = formatParentContext([
		text("user", "old context ".repeat(5_000)),
		text("assistant", "newest context " + "🙂".repeat(12_000)),
	]);

	assert.ok(Buffer.byteLength(context, "utf8") <= MAX_PARENT_CONTEXT_BYTES);
	assert.match(context, /newest context/);
	assert.match(context, /Earlier parent-session messages omitted/);
	assert.doesNotMatch(context, /\uFFFD/);
});

test("does not split an emoji at a parent-context byte boundary", () => {
	const header = [
		"# Parent session context",
		"The following is bounded reference context from the parent session. Use it to understand the assigned task; follow the assigned task and current instructions if they conflict.",
	].join("\n");
	const sectionBudget =
		MAX_PARENT_CONTEXT_BYTES -
		Buffer.byteLength(`${header}\n\n`, "utf8") -
		Buffer.byteLength("\n\n[Earlier parent-session messages omitted by the subagent extension.]", "utf8");
	const truncatedMarkerBytes = Buffer.byteLength("\n[Message truncated by the subagent extension.]", "utf8");
	const prefixBudget = sectionBudget - truncatedMarkerBytes;
	const sectionPrefixBytes = Buffer.byteLength("## User\n", "utf8");
	// Give the old code one ASCII character after the emoji. With its marker
	// reservation, its byte prefix would end after the emoji's high surrogate.
	const payload = `${"x".repeat(prefixBudget - sectionPrefixBytes - 3)}🙂${"x".repeat(truncatedMarkerBytes)}`;
	const context = formatParentContext([text("user", payload)]);

	assert.match(context, /\[Message truncated by the subagent extension\.\]/);
	assert.doesNotMatch(context, /🙂/);
	assert.equal(Buffer.from(context, "utf8").toString("utf8"), context);
	assert.doesNotMatch(context, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("places parent context before handovers and the assigned task", () => {
	const parent = formatParentContext([text("user", "Parent requirement")]);
	const handover = createHandover({ agent: "explorer", task: "inspect", markdown: "Handover finding" });
	const task = withParentContext(withHandoverContext("Implement it.", [handover]), parent);

	assert.ok(task.indexOf("# Parent session context") < task.indexOf("# Shared handover context"));
	assert.ok(task.indexOf("# Shared handover context") < task.indexOf("# Your assigned task"));
	assert.ok(task.indexOf("# Your assigned task") < task.indexOf("Implement it."));
});
