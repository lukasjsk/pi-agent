import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DefinitionError,
	discoverAgents,
	parseAgentDefinition,
	resolveAgent,
	splitFrontmatter,
	UnknownAgentError,
} from "./definitions.ts";

function tempDirs(): { bundledDir: string; userDir: string } {
	const base = mkdtempSync(join(tmpdir(), "subagents-test-"));
	const bundledDir = join(base, "bundled");
	const userDir = join(base, "user");
	mkdirSync(bundledDir);
	mkdirSync(userDir);
	return { bundledDir, userDir };
}

function writeAgent(dir: string, file: string, contents: string): void {
	writeFileSync(join(dir, file), contents);
}

test("splitFrontmatter parses scalars, inline arrays, block sequences, and body", () => {
	const result = splitFrontmatter(`---
name: scout
description: "Quoted description"
tools: [read, grep, find, ls]
thinkingLevel: low
---
Prompt body line one.
Prompt body line two.`);
	assert.ok(result);
	assert.equal(result.fields.name, "scout");
	assert.equal(result.fields.description, "Quoted description");
	assert.deepEqual(result.fields.tools, ["read", "grep", "find", "ls"]);
	assert.equal(result.fields.thinkingLevel, "low");
	assert.equal(result.body, "Prompt body line one.\nPrompt body line two.");
});

test("splitFrontmatter parses block-sequence lists and strips CRLF", () => {
	const result = splitFrontmatter("---\r\nname: worker\r\ntools:\r\n  - read\r\n  - bash\r\n---\r\nBody.");
	assert.ok(result);
	assert.deepEqual(result.fields.tools, ["read", "bash"]);
	assert.equal(result.body, "Body.");
});

test("splitFrontmatter returns undefined without frontmatter", () => {
	assert.equal(splitFrontmatter("just a body"), undefined);
	assert.equal(splitFrontmatter("---\nno closing marker"), undefined);
});

test("parseAgentDefinition builds the definition", () => {
	const def = parseAgentDefinition(
		"/x/scout.md",
		"---\nname: scout\ndescription: explores\ntools: [read, grep]\n---\nDo recon.",
		"bundled",
	);
	assert.deepEqual(
		def,
		{
			name: "scout",
			description: "explores",
			tools: ["read", "grep"],
			model: undefined,
			thinkingLevel: undefined,
			skills: true,
			systemPrompt: "Do recon.",
			warnings: [],
			filePath: "/x/scout.md",
			source: "bundled",
		},
	);
});

test("model parses as a single string or a list; empty list fails", () => {
	const single = parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nmodel: anthropic/claude-sonnet-4-5\n---\nP", "user");
	assert.deepEqual(single.model, ["anthropic/claude-sonnet-4-5"]);
	const list = parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nmodel: [a/x, b/y]\n---\nP", "user");
	assert.deepEqual(list.model, ["a/x", "b/y"]);
	assert.throws(
		() => parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nmodel: []\n---\nP", "user"),
		/list must not be empty/,
	);
});

test("thinkingLevel validates against the platform levels", () => {
	const def = parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nthinkingLevel: high\n---\nP", "user");
	assert.equal(def.thinkingLevel, "high");
	assert.throws(
		() => parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nthinkingLevel: extreme\n---\nP", "user"),
		/thinkingLevel" must be one of/,
	);
});

test("skills accepts on/off (and true/false), defaults to on", () => {
	assert.equal(parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nskills: off\n---\nP", "user").skills, false);
	assert.equal(parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nskills: on\n---\nP", "user").skills, true);
	assert.equal(parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nskills: false\n---\nP", "user").skills, false);
	assert.equal(parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\n---\nP", "user").skills, true);
	assert.throws(
		() => parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\nskills: maybe\n---\nP", "user"),
		/skills" must be "on" or "off"/,
	);
});

test("unknown fields are ignored with a warning carried on the definition", () => {
	const def = parseAgentDefinition(
		"/x/a.md",
		"---\nname: a\ntools: [read]\ncustomField: hello\n---\nP",
		"user",
	);
	assert.deepEqual(def.warnings, ['/x/a.md: unknown frontmatter field "customField" ignored']);
});

test("parseAgentDefinition rejects missing name, missing tools, and empty body", () => {
	assert.throws(() => parseAgentDefinition("/x/a.md", "---\ntools: [read]\n---\nBody", "bundled"), DefinitionError);
	assert.throws(() => parseAgentDefinition("/x/a.md", "---\nname: a\n---\nBody", "bundled"), DefinitionError);
	assert.throws(
		() => parseAgentDefinition("/x/a.md", "---\nname: a\ntools: []\n---\nBody", "bundled"),
		DefinitionError,
	);
	assert.throws(
		() => parseAgentDefinition("/x/a.md", "---\nname: a\ntools: [read]\n---\n   \n", "bundled"),
		DefinitionError,
	);
});

test("discoverAgents finds bundled definitions and user overrides win by name", () => {
	const dirs = tempDirs();
	writeAgent(dirs.bundledDir, "scout.md", "---\nname: scout\ntools: [read]\n---\nBundled scout.");
	writeAgent(dirs.bundledDir, "worker.md", "---\nname: worker\ntools: [bash]\n---\nBundled worker.");
	writeAgent(dirs.userDir, "scout.md", "---\nname: scout\ntools: [read, grep]\n---\nUser scout.");

	const { agents, problems } = discoverAgents(dirs);
	assert.equal(problems.size, 0);
	assert.equal(agents.size, 2);
	assert.equal(agents.get("scout")?.source, "user");
	assert.deepEqual(agents.get("scout")?.tools, ["read", "grep"]);
	assert.equal(agents.get("scout")?.systemPrompt, "User scout.");
	assert.equal(agents.get("worker")?.source, "bundled");
});

test("discoverAgents isolates corrupt definitions and keeps the rest loadable", () => {
	const dirs = tempDirs();
	writeAgent(dirs.bundledDir, "good.md", "---\nname: good\ntools: [read]\n---\nFine.");
	writeAgent(dirs.bundledDir, "broken.md", "no frontmatter here");

	const { agents, problems } = discoverAgents(dirs);
	assert.equal(agents.size, 1);
	assert.ok(agents.has("good"));
	assert.match(problems.get("broken.md") ?? "", /frontmatter/);
});

test("discoverAgents is fresh per call (mid-session edits take effect)", () => {
	const dirs = tempDirs();
	writeAgent(dirs.userDir, "late.md", "---\nname: late\ntools: [read]\n---\nBefore.");
	assert.equal(discoverAgents(dirs).agents.get("late")?.systemPrompt, "Before.");
	writeAgent(dirs.userDir, "late.md", "---\nname: late\ntools: [read]\n---\nAfter.");
	assert.equal(discoverAgents(dirs).agents.get("late")?.systemPrompt, "After.");
});

test("resolveAgent returns the definition and reports unknown names with valid options", () => {
	const dirs = tempDirs();
	writeAgent(dirs.bundledDir, "scout.md", "---\nname: scout\ntools: [read]\n---\nS.");
	const discovery = discoverAgents(dirs);
	assert.equal(resolveAgent(discovery, "scout").name, "scout");
	assert.throws(() => resolveAgent(discovery, "nope"), (error: unknown) => {
		assert.ok(error instanceof UnknownAgentError);
		assert.match(error.message, /Unknown agent "nope"/);
		assert.match(error.message, /scout/);
		return true;
	});
});

test("resolveAgent surfaces the parse error for a corrupt requested definition", () => {
	const dirs = tempDirs();
	writeAgent(dirs.bundledDir, "broken.md", "---\nname: broken\n---\nmissing tools");
	const discovery = discoverAgents(dirs);
	assert.throws(() => resolveAgent(discovery, "broken"), (error: unknown) => {
		assert.ok(error instanceof UnknownAgentError);
		assert.match(error.message, /"tools" is required/);
		return true;
	});
});
