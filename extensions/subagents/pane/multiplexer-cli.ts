// multiplexer-cli.ts — the shared, multiplexer-agnostic CLI plumbing for pane
// adapters: a never-throwing binary invocation over the CliRunner seam, and the
// JSON / string guards every adapter needs for its command replies. This module
// knows nothing about a specific multiplexer: argv building, reply shapes, and
// placement stay in the adapter modules (one module per multiplexer, ADR 0001).

import type { CliRunner } from "../cli.ts";
import { createExecFileRunner } from "../cli.ts";

/** One finished CLI invocation: the stdout it produced and its exit code. */
export interface CliResult {
	stdout: string;
	code: number;
}

/**
 * Invoke a binary, never throwing: a runner rejection resolves as undefined. The
 * default runner caps runaway stdout at 1 MiB (the adapters parse short JSON
 * replies, so the cap only bounds memory). Returns a function so an adapter can
 * hold one invoker per binary instead of repeating the runner try/catch.
 */
export function createCliInvoker(
	bin: string,
	runner?: CliRunner,
): (args: readonly string[]) => Promise<CliResult | undefined> {
	const effectiveRunner = runner ?? createExecFileRunner(1 * 1024 * 1024);
	return async (args) => {
		try {
			const result = await effectiveRunner.run(bin, args, undefined);
			return { stdout: result.stdout, code: result.code };
		} catch {
			return undefined;
		}
	};
}

/**
 * Parse stdout as JSON. Malformed JSON resolves as undefined, never throws —
 * the calling adapter then counts its command as failed (the pane is
 * best-effort, ADR 0001).
 */
export function parseJson(stdout: string): unknown | undefined {
	try {
		return JSON.parse(stdout);
	} catch {
		return undefined;
	}
}

/** A JSON field narrowed to a usable id: a non-empty string, else undefined. */
export function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
