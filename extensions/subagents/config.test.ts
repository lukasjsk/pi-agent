import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentModelConfig } from "./config.ts";

function configPath(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "subagents-config-"));
	const path = join(dir, "subagents.json");
	if (contents !== undefined) writeFileSync(path, contents);
	return path;
}

test("an absent file is a silent no-op (pure fallback)", () => {
	const result = loadAgentModelConfig(join(tmpdir(), "does-not-exist", "subagents.json"));
	assert.deepEqual(result, { models: {}, warnings: [] });
});

test("a valid config maps agent names to ordered model lists", () => {
	const path = configPath(JSON.stringify({ worker: ["a/x@medium", "b/y"], scout: ["c/z"] }));
	const result = loadAgentModelConfig(path);
	assert.deepEqual(result.models, { worker: ["a/x@medium", "b/y"], scout: ["c/z"] });
	assert.deepEqual(result.warnings, []);
});

test("invalid JSON warns and ignores the whole file", () => {
	const path = configPath("{not json");
	const result = loadAgentModelConfig(path);
	assert.deepEqual(result.models, {});
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /invalid JSON ignored/);
});

test("a non-object top level warns and ignores the whole file", () => {
	assert.match(loadAgentModelConfig(configPath("[1, 2]")).warnings[0], /top level must be an object/);
	assert.match(loadAgentModelConfig(configPath('"scout"')).warnings[0], /top level must be an object/);
});

test("a wrong-typed entry warns and is skipped; valid entries survive", () => {
	const path = configPath(
		JSON.stringify({ scout: "not-a-list", worker: ["a/x"], empty: [], blank: ["  "] }),
	);
	const result = loadAgentModelConfig(path);
	assert.deepEqual(result.models, { worker: ["a/x"] });
	assert.equal(result.warnings.length, 3);
	assert.match(result.warnings[0], /entry for "scout"/);
	assert.match(result.warnings[1], /entry for "empty"/);
	assert.match(result.warnings[2], /entry for "blank"/);
});
