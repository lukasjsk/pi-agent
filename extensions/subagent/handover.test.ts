import assert from "node:assert/strict";
import test from "node:test";
import { createHandover, withHandoverContext } from "./handover.ts";

test("injects every prior handover before a delegated task", () => {
	const explorer = createHandover({
		agent: "explorer",
		task: "map the auth code",
		markdown: "Found `src/auth.ts:10-50`.",
		createdAt: 1,
	});
	const planner = createHandover({
		agent: "planner",
		task: "plan the auth change",
		markdown: "Change `src/auth.ts` and add a test.",
		createdAt: 2,
	});

	const task = withHandoverContext("Implement the approved plan.", [explorer, planner]);

	assert.match(task, /# Shared handover context/);
	assert.match(task, /## explorer handover/);
	assert.match(task, /src\/auth\.ts:10-50/);
	assert.match(task, /## planner handover/);
	assert.match(task, /# Your assigned task\nImplement the approved plan\./);
});

test("bounds an oversized handover while preserving a truncation marker", () => {
	const handover = createHandover({ agent: "explorer", task: "inspect", markdown: "x".repeat(20_000) });

	assert.ok(Buffer.byteLength(handover.markdown, "utf8") < 13 * 1024);
	assert.match(handover.markdown, /Handover truncated/);
});
