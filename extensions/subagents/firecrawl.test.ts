import assert from "node:assert/strict";
import test from "node:test";

import { installPlatformMock } from "./pi-mock.ts";
import { installTypeboxMock } from "../test/pi-mock.ts";

// typebox is only resolvable under Pi's module aliases, not from this repo; the shared
// superset stub is registered here and in index.test.ts so no suite's mock poisons another.
installTypeboxMock();
installPlatformMock();

const { buildFirecrawlArgs, createFirecrawlTools, FIREFCRAWL_TOOL_NAMES, FIREFCRAWL_BIN } = await import("./firecrawl.ts");

interface FirecrawlRunner {
	run(bin: string, args: readonly string[], signal: AbortSignal | undefined): Promise<{ stdout: string; stderr: string; code: number }>;
}

const { parseAgentDefinition } = await import("./definitions.ts");
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");

test("buildFirecrawlArgs maps each tool to the firecrawl argv", () => {
	assert.deepEqual(buildFirecrawlArgs("firecrawl_search", { query: "quantum error correction" }), ["search", "quantum error correction"]);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_search", { query: "x", options: ["--limit", "20"] }), ["search", "x", "--limit", "20"]);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_scrape", { urls: "https://a.example" }), ["scrape", "https://a.example"]);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_scrape", { urls: ["https://a.example", "https://b.example"] }), [
		"scrape",
		"https://a.example",
		"https://b.example",
	]);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_map", { url: "https://site.example" }), ["map", "https://site.example"]);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_crawl", { url: "https://site.example/docs" }), ["crawl", "https://site.example/docs"]);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_developer", { query: "pi-coding-agent registerTool" }), [
		"developer",
		"pi-coding-agent registerTool",
	]);
	assert.deepEqual(
		buildFirecrawlArgs("firecrawl_research", { subcommand: "search-papers", arg: "CRISPR off-target", options: ["--limit", "20"] }),
		["research", "search-papers", "CRISPR off-target", "--limit", "20"],
	);
	assert.deepEqual(buildFirecrawlArgs("firecrawl_research", { subcommand: "related-papers", arg: ["pmid:1", "pmcid:2"] }), [
		"research",
		"related-papers",
		"pmid:1",
		"pmcid:2",
	]);
});

test("buildFirecrawlArgs throws when a required primary argument is missing", () => {
	assert.throws(() => buildFirecrawlArgs("firecrawl_search", {}), /query is required/);
	assert.throws(() => buildFirecrawlArgs("firecrawl_map", {}), /url is required/);
	assert.throws(() => buildFirecrawlArgs("firecrawl_research", { arg: "x" }), /subcommand is required/);
});

test("buildFirecrawlArgs rejects an unknown tool name", () => {
	assert.throws(() => buildFirecrawlArgs("firecrawl_bogus" as never, {}), /unknown firecrawl tool/);
});

function stubRunner(result: { stdout?: string; stderr?: string; code?: number }): FirecrawlRunner & {
	calls: Array<{ bin: string; args: string[] }>;
} {
	const calls: Array<{ bin: string; args: string[] }> = [];
	return {
		calls,
		async run(bin, args) {
			calls.push({ bin, args: [...args] });
			return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
		},
	};
}

type Executable = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details: { command: string; exitCode: number; truncated: boolean } }>;
};

async function runTool(tools: Executable[], name: string, params: unknown, signal?: AbortSignal) {
	const tool = tools.find((t) => t.name === name)!;
	return await tool.execute("call-1", params, signal, undefined, undefined);
}

test("createFirecrawlTools exposes exactly the six firecrawl tools", () => {
	const tools = createFirecrawlTools(stubRunner({}));
	assert.deepEqual(tools.map((t) => t.name).sort(), [...FIREFCRAWL_TOOL_NAMES].sort());
});

test("a successful firecrawl call returns stdout with exit code 0", async () => {
	const runner = stubRunner({ stdout: "results here" });
	const tools = createFirecrawlTools(runner) as Executable[];
	const res = await runTool(tools, "firecrawl_search", { query: "hello" });
	assert.equal(res.details.exitCode, 0);
	assert.equal(res.details.command, "search");
	assert.equal(res.content[0].text, "results here");
	assert.equal(runner.calls[0].bin, FIREFCRAWL_BIN);
});

test("options are passed through as individual argv tokens (no shell)", async () => {
	const runner = stubRunner({ stdout: "ok" });
	const tools = createFirecrawlTools(runner) as Executable[];
	await runTool(tools, "firecrawl_map", { url: "https://x.example", options: ["--limit", "5", "--search", "docs"] });
	assert.deepEqual(runner.calls[0].args, ["map", "https://x.example", "--limit", "5", "--search", "docs"]);
});

test("a non-zero exit is surfaced as a failure with stderr", async () => {
	const runner = stubRunner({ stderr: "no auth", code: 1 });
	const tools = createFirecrawlTools(runner) as Executable[];
	const res = await runTool(tools, "firecrawl_scrape", { urls: "https://x.example" });
	assert.equal(res.details.exitCode, 1);
	assert.match(res.content[0].text!, /failed \(exit 1\)/);
	assert.match(res.content[0].text!, /no auth/);
});

test("an aborted signal short-circuits before the CLI runs", async () => {
	const runner = stubRunner({ stdout: "should not appear" });
	const tools = createFirecrawlTools(runner) as Executable[];
	const controller = new AbortController();
	controller.abort();
	const res = await runTool(tools, "firecrawl_search", { query: "x" }, controller.signal);
	assert.equal(res.details.exitCode, -1);
	assert.match(res.content[0].text!, /Cancelled/);
	assert.equal(runner.calls.length, 0);
});

test("the bundled researcher definition no longer allows bash", () => {
	const path = join(AGENTS_DIR, "researcher.md");
	const def = parseAgentDefinition(path, readFileSync(path, "utf8"), "bundled");
	assert.equal(def.tools.includes("bash"), false);
	assert.ok(def.tools.includes("read"), "researcher keeps read for saved source files");
});
