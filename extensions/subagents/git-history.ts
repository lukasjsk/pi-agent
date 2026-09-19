// git-history — purpose-built git-history tools injected into `scout` child sessions.
//
// Why: scout has no bash (spec §R3), so it cannot run git at all, and handing it bash would
// break both its read-only contract and the token-efficiency goal that made it read-only.
// Instead scout gets two leaf capability tools — `git_history` (compact commit list) and
// `git_show` (one commit) — over the same `customTools` injection path as the researcher's
// firecrawl set. They are NOT registered as top-level pi tools.
//
// Token cost is the design constraint, not git itself. So: one line per commit instead of
// porcelain, no patches unless explicitly requested, `--follow` when a path is given (that is
// what "the history of this file" actually means across renames), a default entry cap, and a
// hard byte cap with an explicit narrowing hint. Raw `git log -p` is exactly what this
// replaces.
//
// Safety: execFile with no shell, so there is no command surface — only `git <fixed-sub> …`.
// Every caller-supplied positional (ref, path, commit) rejects a leading `-` (option
// injection) and control characters, and pathspecs always follow `--`.
//
// Platform-light: both argv builders and the log parser are pure functions and the process
// runner is injectable, so the whole unit is testable without a repository or a real git.

import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExecFileRunner, type CliRunner } from "./cli.ts";

export const GIT_BIN = "git";

export const GIT_TOOL_NAMES = ["git_history", "git_show"] as const;
export type GitToolName = (typeof GIT_TOOL_NAMES)[number];

/** Process kill bound for a runaway git command; far above the display caps below. */
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Display caps — how much of git's output is allowed to reach the model. */
const HISTORY_CAP_BYTES = 32 * 1024;
const SHOW_CAP_BYTES = 32 * 1024;
export const DEFAULT_HISTORY_MAX_COUNT = 30;
export const MAX_HISTORY_MAX_COUNT = 100;
/** Per-subject cap; a pathological commit subject must not eat the budget. */
const SUBJECT_CAP_CHARS = 200;

/** Field separator in the machine-readable log format (ASCII unit separator). */
const RECORD_SEPARATOR = "\u001f";
const LOG_FORMAT = ["%h", "%ad", "%an", "%s"].join(RECORD_SEPARATOR);

const HISTORY_TRUNCATION_MARKER = `… [truncated at ${HISTORY_CAP_BYTES} bytes — narrow with maxCount, since, or path]`;
const SHOW_TRUNCATION_MARKER = `… [truncated at ${SHOW_CAP_BYTES} bytes — narrow with path, or drop includePatch]`;

/** Default runner: execFile with no shell. */
export const defaultGitRunner: CliRunner = createExecFileRunner(GIT_MAX_BUFFER_BYTES);

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function rawValue(params: Record<string, unknown>, key: string): unknown {
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value.trim() === "" ? undefined : value.trim();
}

/** A positional argv token (ref, path, commit): rejects a leading `-` (option injection). */
function positional(params: Record<string, unknown>, key: string): string | undefined {
	const value = rawValue(params, key);
	if (value === undefined) return undefined;
	if (value.startsWith("-")) throw new Error(`${key} must not start with "-"`);
	if (/[\u0000-\u001f]/.test(value)) throw new Error(`${key} must not contain control characters`);
	return value;
}

function requiredPositional(params: Record<string, unknown>, key: string): string {
	const value = positional(params, key);
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}

/** A value embedded in a single `--flag=value` token; no leading-dash risk, but no newlines. */
function embedded(params: Record<string, unknown>, key: string): string | undefined {
	const value = rawValue(params, key);
	if (value === undefined) return undefined;
	if (/[\u0000-\u001f]/.test(value)) throw new Error(`${key} must not contain control characters`);
	return value;
}

/** Positive integer, clamped to the hard cap; anything else is a caller bug worth surfacing. */
function resolveMaxCount(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_HISTORY_MAX_COUNT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`maxCount must be a positive integer (got ${JSON.stringify(value)})`);
	}
	return Math.min(value, MAX_HISTORY_MAX_COUNT);
}

// ---------------------------------------------------------------------------
// argv builders (pure)
// ---------------------------------------------------------------------------

/** `git --no-pager log …` — a compact, bounded, rename-aware commit list. */
export function buildGitHistoryArgs(params: Record<string, unknown>): string[] {
	const path = positional(params, "path");
	const ref = positional(params, "ref");
	const since = embedded(params, "since");
	const until = embedded(params, "until");

	const args = [
		"--no-pager",
		"log",
		`--pretty=format:${LOG_FORMAT}`,
		"--date=short",
		`--max-count=${resolveMaxCount(params.maxCount)}`,
	];
	if (params.includeMerges !== true) args.push("--no-merges");
	if (params.stats === true) args.push("--shortstat");
	if (path !== undefined) args.push("--follow");
	if (since !== undefined) args.push(`--since=${since}`);
	if (until !== undefined) args.push(`--until=${until}`);
	if (ref !== undefined) args.push(ref);
	args.push("--");
	if (path !== undefined) args.push(path);
	return args;
}

/** `git --no-pager show …` — one commit, summary by default, patch only on request. */
export function buildGitShowArgs(params: Record<string, unknown>): string[] {
	const commit = requiredPositional(params, "commit");
	const path = positional(params, "path");

	const args = ["--no-pager", "show", "--date=short", "--stat"];
	if (params.includePatch === true) args.push("--patch");
	args.push(commit, "--");
	if (path !== undefined) args.push(path);
	return args;
}

// ---------------------------------------------------------------------------
// log parsing + formatting (pure)
// ---------------------------------------------------------------------------

export interface GitHistoryEntry {
	/** Short hash (`%h`). */
	hash: string;
	/** Author date, `YYYY-MM-DD` (`--date=short`). */
	date: string;
	author: string;
	subject: string;
	/** Compressed shortstat, e.g. `(2 files, +3/-1)`; absent without `stats` or on merges. */
	changeSummary?: string;
}

const SHORTSTAT_PATTERN = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/** Compress git's `--shortstat` line (` 2 files changed, 3 insertions(+), 1 deletion(-)`). */
export function compressShortstat(line: string): string | undefined {
	const match = SHORTSTAT_PATTERN.exec(line);
	if (!match) return undefined;
	const files = Number(match[1]);
	const insertions = match[2] === undefined ? 0 : Number(match[2]);
	const deletions = match[3] === undefined ? 0 : Number(match[3]);
	const parts = [`${files} file${files === 1 ? "" : "s"}`];
	const delta: string[] = [];
	if (insertions > 0) delta.push(`+${insertions}`);
	if (deletions > 0) delta.push(`-${deletions}`);
	if (delta.length > 0) parts.push(delta.join("/"));
	return `(${parts.join(", ")})`;
}

function capText(value: string, cap: number): string {
	return value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
}

/** Parse the unit-separator log format into compact entries; shortstat lines attach backwards. */
export function parseGitHistory(stdout: string): GitHistoryEntry[] {
	const entries: GitHistoryEntry[] = [];
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "") continue;
		// `--shortstat` emits its line indented, after the commit it belongs to.
		if (line.startsWith(" ") || line.startsWith("\t")) {
			const summary = compressShortstat(line);
			if (summary !== undefined && entries.length > 0) entries[entries.length - 1].changeSummary = summary;
			continue;
		}
		const [hash, date, author, subject] = line.split(RECORD_SEPARATOR);
		if (!hash || date === undefined || author === undefined || subject === undefined) continue;
		entries.push({ hash, date, author, subject: capText(subject, SUBJECT_CAP_CHARS) });
	}
	return entries;
}

/** One line per commit — `hash date author: subject (N files, +I/-D)`. */
export function formatGitHistory(entries: GitHistoryEntry[]): string {
	if (entries.length === 0) return "No commits matched — the ref, path, or date filters may be too narrow.";
	return entries
		.map((e) => `${e.hash} ${e.date} ${e.author}: ${e.subject}${e.changeSummary ? ` ${e.changeSummary}` : ""}`)
		.join("\n");
}

/** Byte-capped truncation that never cuts mid-line; the marker names the narrowing knobs. */
export function truncateToLineBoundary(text: string, capBytes: number, marker: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= capBytes) return { text, truncated: false };
	const cut = Buffer.from(text, "utf8").subarray(0, capBytes).toString("utf8");
	const lastNewline = cut.lastIndexOf("\n");
	const body = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
	return { text: `${body.replace(/\uFFFD$/, "")}\n${marker}`, truncated: true };
}

/** Turn git's failure output into something a model can act on. */
export function describeGitFailure(subcommand: string, exitCode: number, stderr: string, stdout: string): string {
	const detail = stderr.trim() || stdout.trim();
	if (/not a git repository/i.test(detail)) return "Not a git repository — this workspace has no git history to explore.";
	if (/does not have any commits yet|no commits yet/i.test(detail)) return "This repository has no commits yet.";
	if (detail === "") return `git ${subcommand} failed (exit ${exitCode}) with no output.`;
	return `git ${subcommand} failed (exit ${exitCode}):\n${detail}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface GitToolSpec {
	name: GitToolName;
	subcommand: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	build: (params: Record<string, unknown>) => string[];
	/** Map successful stdout to the text that reaches the model. */
	finish: (stdout: string) => { text: string; truncated: boolean };
}

const maxCountParam = Type.Optional(
	Type.Number({ description: `Maximum commits to return (default ${DEFAULT_HISTORY_MAX_COUNT}, capped at ${MAX_HISTORY_MAX_COUNT}).` }),
);

const SPECS: GitToolSpec[] = [
	{
		name: "git_history",
		subcommand: "log",
		label: "git history",
		description:
			"List a commit history as compact one-line entries (short hash, date, author, subject). " +
			"Use this FIRST — it is the cheap way to find which commits matter. Pass `path` to follow one file's " +
			"history through renames; `stats` adds a compressed per-commit change summary. " +
			"Then use git_show to inspect a commit you found. Read-only.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Repo-relative path whose history to follow (tracks renames). Omit for whole-repo history." })),
			ref: Type.Optional(Type.String({ description: "Revision or range, e.g. HEAD, main, v1.2..HEAD. Defaults to HEAD." })),
			since: Type.Optional(Type.String({ description: "Only commits after this date, e.g. 2024-01-01 or \"3 months ago\"." })),
			until: Type.Optional(Type.String({ description: "Only commits before this date." })),
			maxCount: maxCountParam,
			includeMerges: Type.Optional(Type.Boolean({ description: "Include merge commits (excluded by default)." })),
			stats: Type.Optional(Type.Boolean({ description: "Add (N files, +I/-D) per commit. Slower: git computes diffs." })),
		}),
		build: buildGitHistoryArgs,
		finish: (stdout) => truncateToLineBoundary(formatGitHistory(parseGitHistory(stdout)), HISTORY_CAP_BYTES, HISTORY_TRUNCATION_MARKER),
	},
	{
		name: "git_show",
		subcommand: "show",
		label: "git show",
		description:
			"Show one commit: its message and a --stat file summary. Set includePatch to get the diff itself " +
			"(truncated at the byte cap). Omit `path` when you need rename detection — a path filter makes git report " +
			"a rename as an unrelated add/delete. Use after git_history identifies the interesting commit. Read-only.",
		parameters: Type.Object({
			commit: Type.String({ description: "Commit-ish to show: a hash from git_history, HEAD~3, a tag, or a branch." }),
			path: Type.Optional(Type.String({ description: "Limit the change summary and diff to this repo-relative path." })),
			includePatch: Type.Optional(Type.Boolean({ description: "Include the diff itself (truncated). Default false: summary only." })),
		}),
		build: buildGitShowArgs,
		finish: (stdout) => {
			const text = stdout.trim() === "" ? "No commit matched — check the revision and path." : stdout.replace(/\s+$/, "");
			return truncateToLineBoundary(text, SHOW_CAP_BYTES, SHOW_TRUNCATION_MARKER);
		},
	},
];

interface GitToolDetails {
	command: string;
	exitCode: number;
	truncated: boolean;
}

function resultText(content: string, details: GitToolDetails) {
	return { content: [{ type: "text" as const, text: content }], details };
}

/** Build the scout-side git tool set. The runner is injectable for tests. */
export function createGitTools(runner: CliRunner = defaultGitRunner): ToolDefinition[] {
	return SPECS.map((spec) =>
		defineTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters,
			execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
				const args = spec.build(params as Record<string, unknown>);
				const cancelled = (when: string) => resultText(when, { command: spec.subcommand, exitCode: -1, truncated: false });
				if (signal?.aborted) return cancelled("Cancelled before the git command ran.");

				const out = await runner.run(GIT_BIN, args, signal);
				if (signal?.aborted) return cancelled("Cancelled while the git command was running.");

				if (out.code !== 0) {
					return resultText(describeGitFailure(spec.subcommand, out.code, out.stderr, out.stdout), {
						command: spec.subcommand,
						exitCode: out.code,
						truncated: false,
					});
				}

				const { text, truncated } = spec.finish(out.stdout ?? "");
				return resultText(text, { command: spec.subcommand, exitCode: 0, truncated });
			},
		}) as ToolDefinition,
	);
}