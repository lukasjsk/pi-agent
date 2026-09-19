import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installPlatformMock } from "./pi-mock.ts";
import { installTypeboxMock } from "../test/pi-mock.ts";

// typebox is only resolvable under Pi's module aliases, not from this repo; the shared
// superset stub is registered here and in index.test.ts so no suite's mock poisons another.
installTypeboxMock();
installPlatformMock();

const {
	buildGitHistoryArgs,
	buildGitShowArgs,
	compressShortstat,
	createGitTools,
	defaultGitRunner,
	describeGitFailure,
	formatGitHistory,
	GIT_BIN,
	GIT_TOOL_NAMES,
	parseGitHistory,
	truncateToLineBoundary,
} = await import("./git-history.ts");

const { parseAgentDefinition } = await import("./definitions.ts");

const US = "\u001f";
const LOG_FORMAT = ["%h", "%ad", "%an", "%s"].join(US);
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");

test("buildGitHistoryArgs produces a compact, bounded, rename-aware log argv", () => {
	assert.deepEqual(buildGitHistoryArgs({}), [
		"--no-pager",
		"log",
		`--pretty=format:${LOG_FORMAT}`,
		"--date=short",
		"--max-count=30",
		"--no-merges",
		"--",
	]);
});

test("buildGitHistoryArgs follows a path — the --follow option stays before the -- separator", () => {
	const args = buildGitHistoryArgs({ path: "src/parser.ts" });
	assert.deepEqual(args, [
		"--no-pager",
		"log",
		`--pretty=format:${LOG_FORMAT}`,
		"--date=short",
		"--max-count=30",
		"--no-merges",
		"--follow",
		"--",
		"src/parser.ts",
	]);
	assert.equal(args.indexOf("--follow") < args.indexOf("--"), true, "--follow must be an option, not a pathspec");
});

test("buildGitHistoryArgs carries ref/time/stats flags and drops --no-merges on request", () => {
	assert.deepEqual(
		buildGitHistoryArgs({ ref: "v1..HEAD", since: "2024-01-01", until: "2024-06-01", maxCount: 5, includeMerges: true, stats: true }),
		[
			"--no-pager",
			"log",
			`--pretty=format:${LOG_FORMAT}`,
			"--date=short",
			"--max-count=5",
			"--shortstat",
			"--since=2024-01-01",
			"--until=2024-06-01",
			"v1..HEAD",
			"--",
		],
	);
});

test("buildGitHistoryArgs clamps maxCount to the hard cap", () => {
	assert.ok(buildGitHistoryArgs({ maxCount: 500 }).includes("--max-count=100"));
	assert.ok(buildGitHistoryArgs({ maxCount: 1 }).includes("--max-count=1"));
});

test("buildGitHistoryArgs rejects a non-positive or fractional maxCount", () => {
	assert.throws(() => buildGitHistoryArgs({ maxCount: 0 }), /maxCount must be a positive integer/);
	assert.throws(() => buildGitHistoryArgs({ maxCount: 1.5 }), /maxCount must be a positive integer/);
	assert.throws(() => buildGitHistoryArgs({ maxCount: "20" }), /maxCount must be a positive integer/);
});

test("positional values never start with a dash (no option injection)", () => {
	assert.throws(() => buildGitHistoryArgs({ ref: "--output=/tmp/x" }), /ref must not start with "-"/);
	assert.throws(() => buildGitHistoryArgs({ path: "-foo.ts" }), /path must not start with "-"/);
	assert.throws(() => buildGitShowArgs({ commit: "--help" }), /commit must not start with "-"/);
	assert.throws(() => buildGitHistoryArgs({ ref: "HEAD\n--exec=rm" }), /control characters/);
});

test("buildGitShowArgs summarizes by default and adds the patch only on request", () => {
	assert.deepEqual(buildGitShowArgs({ commit: "abc123" }), ["--no-pager", "show", "--date=short", "--stat", "abc123", "--"]);
	assert.deepEqual(buildGitShowArgs({ commit: "abc123", path: "src/a.ts", includePatch: true }), [
		"--no-pager",
		"show",
		"--date=short",
		"--stat",
		"--patch",
		"abc123",
		"--",
		"src/a.ts",
	]);
	assert.throws(() => buildGitShowArgs({}), /commit is required/);
});

test("compressShortstat compresses git's change line", () => {
	assert.equal(compressShortstat(" 2 files changed, 3 insertions(+), 1 deletion(-)"), "(2 files, +3/-1)");
	assert.equal(compressShortstat(" 1 file changed, 3 insertions(+)"), "(1 file, +3)");
	assert.equal(compressShortstat(" 1 file changed, 4 deletions(-)"), "(1 file, -4)");
	assert.equal(compressShortstat(" 1 file changed, 0 insertions(+), 0 deletions(-)"), "(1 file)");
	assert.equal(compressShortstat("not a stat line"), undefined);
});

test("parseGitHistory attaches shortstat lines to the commit above them", () => {
	const stdout = [
		["a1b2c3d", "2024-05-12", "Alice", "Fix the parser"].join(US),
		" 2 files changed, 3 insertions(+), 1 deletion(-)",
		["b2c3d4e", "2024-05-11", "Bob", "Docs"].join(US),
	].join("\n");

	const entries = parseGitHistory(stdout);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], { hash: "a1b2c3d", date: "2024-05-12", author: "Alice", subject: "Fix the parser", changeSummary: "(2 files, +3/-1)" });
	assert.equal(entries[1].changeSummary, undefined);
});

test("parseGitHistory caps a pathological subject", () => {
	const entries = parseGitHistory(["a1b2c3d", "2024-05-12", "Alice", "x".repeat(500)].join(US));
	assert.equal(entries[0].subject.length, 200);
	assert.equal(entries[0].subject.endsWith("…"), true);
});

test("formatGitHistory is one line per commit and says so when nothing matched", () => {
	const entries = parseGitHistory([["a1b2c3d", "2024-05-12", "Alice", "Fix the parser"].join(US), " 1 file changed, 3 insertions(+)"].join("\n"));
	assert.equal(formatGitHistory(entries), "a1b2c3d 2024-05-12 Alice: Fix the parser (1 file, +3)");
	assert.match(formatGitHistory([]), /No commits matched/);
});

test("truncateToLineBoundary keeps output under the cap and cuts on a line boundary", () => {
	assert.deepEqual(truncateToLineBoundary("a\nb", 100, "MARK"), { text: "a\nb", truncated: false });

	const cut = truncateToLineBoundary("aaa\nbbb\nccc", 5, "MARK");
	assert.equal(cut.truncated, true);
	assert.equal(cut.text, "aaa\nMARK");
});

test("describeGitFailure names the common no-history cases plainly", () => {
	assert.match(describeGitFailure("log", 128, "fatal: not a git repository (or any of the parent directories): .git", ""), /^Not a git repository/);
	assert.match(describeGitFailure("log", 128, "fatal: your current branch 'main' does not have any commits yet", ""), /^This repository has no commits yet/);
	const generic = describeGitFailure("show", 128, "fatal: bad revision 'nope'", "");
	assert.match(generic, /git show failed \(exit 128\)/);
	assert.match(generic, /bad revision/);
});

interface StubResult {
	stdout?: string;
	stderr?: string;
	code?: number;
}

function stubRunner(result: StubResult): { calls: Array<{ bin: string; args: string[] }>; run: typeof defaultGitRunner.run } {
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

test("createGitTools exposes exactly the two git tools", () => {
	const tools = createGitTools(stubRunner({}));
	assert.deepEqual(tools.map((t) => t.name).sort(), [...GIT_TOOL_NAMES].sort());
});

test("a git_history call returns the formatted commit list", async () => {
	const stdout = [["a1b2c3d", "2024-05-12", "Alice", "Fix the parser"].join(US), " 2 files changed, 3 insertions(+), 1 deletion(-)"].join("\n");
	const runner = stubRunner({ stdout });
	const res = await runTool(createGitTools(runner) as Executable[], "git_history", { path: "src/a.ts" });
	assert.equal(res.details.command, "log");
	assert.equal(res.details.exitCode, 0);
	assert.equal(res.content[0].text, "a1b2c3d 2024-05-12 Alice: Fix the parser (2 files, +3/-1)");
	assert.equal(runner.calls[0].bin, GIT_BIN);
	assert.ok(runner.calls[0].args.includes("--follow"));
});

test("a git_show call passes the commit through as one argv token", async () => {
	const runner = stubRunner({ stdout: "commit abc123\n src/a.ts | 2 +-" });
	const res = await runTool(createGitTools(runner) as Executable[], "git_show", { commit: "abc123", path: "src/a.ts" });
	assert.equal(res.details.command, "show");
	assert.deepEqual(runner.calls[0].args, ["--no-pager", "show", "--date=short", "--stat", "abc123", "--", "src/a.ts"]);
	assert.match(res.content[0].text!, /commit abc123/);
});

test("a non-repo failure is reported as a plain sentence", async () => {
	const runner = stubRunner({ stderr: "fatal: not a git repository (or any of the parent directories): .git", code: 128 });
	const res = await runTool(createGitTools(runner) as Executable[], "git_history", {});
	assert.equal(res.details.exitCode, 128);
	assert.match(res.content[0].text!, /^Not a git repository/);
});

test("oversized git output is truncated at the line boundary with a narrowing hint", async () => {
	const runner = stubRunner({ stdout: `${"a".repeat(40 * 1024)}\n` });
	const res = await runTool(createGitTools(runner) as Executable[], "git_show", { commit: "abc123", includePatch: true });
	assert.equal(res.details.truncated, true);
	assert.match(res.content[0].text!, /truncated at \d+ bytes/);
	assert.match(res.content[0].text!, /drop includePatch/);
});

test("an aborted signal short-circuits before git runs", async () => {
	const runner = stubRunner({ stdout: "should not appear" });
	const controller = new AbortController();
	controller.abort();
	const res = await runTool(createGitTools(runner) as Executable[], "git_history", { path: "src/a.ts" }, controller.signal);
	assert.equal(res.details.exitCode, -1);
	assert.match(res.content[0].text!, /Cancelled/);
	assert.equal(runner.calls.length, 0);
});

test("the bundled scout definition has no bash and gets git tools by injection only", () => {
	const path = join(AGENTS_DIR, "scout.md");
	const def = parseAgentDefinition(path, readFileSync(path, "utf8"), "bundled");
	assert.deepEqual(def.tools, ["read", "grep", "find", "ls"], "scout stays truly read-only");
	for (const name of GIT_TOOL_NAMES) {
		assert.equal(def.tools.includes(name), false, `${name} is injected via customTools, not allowlisted`);
	}
});