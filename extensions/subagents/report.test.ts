import assert from "node:assert/strict";
import test from "node:test";

import { parseStructuredReport, renderStructuredFields } from "./report.ts";

test("a well-formed footer is parsed off the end and stripped from the result", () => {
	const report = [
		"## Files Retrieved",
		"- `a.ts:1-2` — entry point",
		"",
		"```json",
		'{ "openQuestions": [{ "question": "Which auth?", "whyItMatters": "Scope." }],',
		'  "decisionPoints": [{ "decision": "Skipped tests dir", "rationale": "Out of scope." }],',
		'  "filesTouched": ["src/a.ts"] }',
		"```",
	].join("\n");

	const parsed = parseStructuredReport(report);
	assert.equal(parsed.result, "## Files Retrieved\n- `a.ts:1-2` — entry point");
	assert.equal(parsed.warning, undefined);
	assert.deepEqual(parsed.footer, {
		openQuestions: [{ question: "Which auth?", whyItMatters: "Scope." }],
		decisionPoints: [{ decision: "Skipped tests dir", rationale: "Out of scope." }],
		filesTouched: ["src/a.ts"],
	});
});

test("missing footer degrades to plain result, empty fields, and a warning", () => {
	const parsed = parseStructuredReport("# Just markdown\nno footer here");
	assert.equal(parsed.result, "# Just markdown\nno footer here");
	assert.deepEqual(parsed.footer, { openQuestions: [], decisionPoints: [], filesTouched: [] });
	assert.match(parsed.warning ?? "", /no JSON footer/);
});

test("footer with trailing prose after it is not treated as a footer", () => {
	const parsed = parseStructuredReport('body\n```json\n{"filesTouched": ["a.ts"]}\n```\nThanks!');
	assert.equal(parsed.result, "body\n```json\n{\"filesTouched\": [\"a.ts\"]}\n```\nThanks!");
	assert.deepEqual(parsed.footer, { openQuestions: [], decisionPoints: [], filesTouched: [] });
	assert.ok(parsed.warning);
});

test("unparseable JSON degrades without throwing and keeps the whole report", () => {
	const report = "body\n```json\n{ openQuestions: [}\n```";
	const parsed = parseStructuredReport(report);
	assert.equal(parsed.result, report);
	assert.deepEqual(parsed.footer, { openQuestions: [], decisionPoints: [], filesTouched: [] });
	assert.match(parsed.warning ?? "", /unparseable JSON footer/);
});

test("wrong field shapes degrade; missing keys default to empty", () => {
	const bad = parseStructuredReport('body\n```json\n{"filesTouched": "a.ts"}\n```');
	assert.match(bad.warning ?? "", /filesTouched/);
	assert.equal(bad.result, 'body\n```json\n{"filesTouched": "a.ts"}\n```'); // whole report on degradation

	const badPairs = parseStructuredReport('body\n```json\n{"openQuestions": [{"question": 3}]}\n```');
	assert.match(badPairs.warning ?? "", /openQuestions/);

	const sparse = parseStructuredReport('body\n```json\n{"filesTouched": ["a.ts", " b.ts ", 5]}\n```');
	assert.ok(sparse.warning);
	assert.deepEqual(sparse.footer, { openQuestions: [], decisionPoints: [], filesTouched: [] });

	const defaults = parseStructuredReport('body\n```json\n{"decisionPoints": []}\n```');
	assert.equal(defaults.warning, undefined);
	assert.deepEqual(defaults.footer, {
		openQuestions: [],
		decisionPoints: [],
		filesTouched: [],
	});
	assert.equal(defaults.result, "body");
});

test("a JSON array or scalar footer is a degradation, not a crash", () => {
	for (const junk of ["[1, 2]", '"just a string"', "42", "null"]) {
		const parsed = parseStructuredReport(`body\n\`\`\`json\n${junk}\n\`\`\``);
		assert.ok(parsed.warning);
		assert.deepEqual(parsed.footer, { openQuestions: [], decisionPoints: [], filesTouched: [] });
	}
});

test("renderStructuredFields emits only non-empty sections in fixed order", () => {
	const full = renderStructuredFields({
		openQuestions: [{ question: "Q1?", whyItMatters: "W1." }],
		decisionPoints: [{ decision: "D1", rationale: "R1" }],
		filesTouched: ["a.ts", "b.ts"],
	});
	assert.equal(
		full,
		"Open questions:\n- Q1? — W1.\n\nDecision points:\n- D1 — R1\n\nFiles touched: a.ts, b.ts",
	);

	assert.equal(renderStructuredFields({ openQuestions: [], decisionPoints: [], filesTouched: [] }), "");
	const onlyFiles = renderStructuredFields({
		openQuestions: [],
		decisionPoints: [],
		filesTouched: ["a.ts"],
	});
	assert.equal(onlyFiles, "Files touched: a.ts");
});
