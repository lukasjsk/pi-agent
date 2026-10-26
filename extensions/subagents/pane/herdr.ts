// herdr.ts — ADR 0001 Herdr pane control: detect the Herdr environment, place the
// subagent panes, build the `herdr pane` argv (no shell, via the shared CliRunner
// seam), and run the four best-effort pane operations. The pane is a display-only
// mirror, so no operation here may throw into the spawn path: failures resolve as
// "not done" and the manager decides what to log.

import type { CliRunner } from "../cli.ts";
import { createExecFileRunner } from "../cli.ts";

/** The Herdr env record: the only env keys the extension reads inside Herdr. */
export interface HerdrEnv {
	HERDR_ENV?: string;
	HERDR_PANE_ID?: string;
	HERDR_BIN_PATH?: string;
}

/**
 * Detect that the orchestrator runs inside Herdr. Detected when this pane's own id
 * is known AND the Herdr env flag is set; the binary path falls back to the PATH
 * name. Pure function of the env record.
 */
export function detectHerdr(
	env: HerdrEnv,
): { detected: boolean; bin: string; mainPaneId: string } | undefined {
	if (!env.HERDR_PANE_ID || env.HERDR_ENV !== "1") return undefined;
	return { detected: true, bin: env.HERDR_BIN_PATH || "herdr", mainPaneId: env.HERDR_PANE_ID };
}

/**
 * Pane placement (GLOSSARY.md "Subagent pane"): the first spawn goes right of the
 * main pane; concurrent siblings stack vertically underneath the last opened
 * subagent pane. Pure function of the manager's placement state, which advances
 * only on successful splits.
 */
export function splitTarget(
	state: { lastSubagentPaneId: string | undefined },
	mainPaneId: string,
): { paneId: string; direction: "right" | "down" } {
	if (state.lastSubagentPaneId === undefined) return { paneId: mainPaneId, direction: "right" };
	return { paneId: state.lastSubagentPaneId, direction: "down" };
}

/** argv for `herdr pane split` — the new pane opens beside/under the given pane. */
export function paneSplitArgs(paneId: string, direction: "right" | "down", cwd: string): readonly string[] {
	return ["pane", "split", paneId, "--direction", direction, "--cwd", cwd];
}

/** argv for `herdr pane run` — one command string, passed as a single token (no shell). */
export function paneRunArgs(paneId: string, command: string): readonly string[] {
	return ["pane", "run", paneId, command];
}

/** argv for `herdr pane rename` — the label is the agent definition's name. */
export function paneRenameArgs(paneId: string, label: string): readonly string[] {
	return ["pane", "rename", paneId, label];
}

/** argv for `herdr pane close`. */
export function paneCloseArgs(paneId: string): readonly string[] {
	return ["pane", "close", paneId];
}

/**
 * The new pane id from `herdr pane split` stdout: `.result.pane.pane_id`. Returns
 * undefined on malformed JSON or a missing/non-string field — the split then counts
 * as failed and the pane stays skipped (the pane is best-effort, ADR 0001).
 */
export function parseSplitPaneId(stdout: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const pane = (value as { result?: { pane?: { pane_id?: unknown } } } | null)?.result?.pane;
	const paneId = pane?.pane_id;
	return typeof paneId === "string" && paneId.length > 0 ? paneId : undefined;
}

/**
 * The four best-effort `herdr pane` operations, in structural form: the manager
 * and its tests depend on this shape, not the class. Every method resolves
 * (never throws): split gives the new pane id or undefined; the rest give a
 * success boolean.
 */
export interface HerdrPaneOps {
	split(paneId: string, direction: "right" | "down", cwd: string): Promise<string | undefined>;
	run(paneId: string, command: string): Promise<boolean>;
	rename(paneId: string, label: string): Promise<boolean>;
	close(paneId: string): Promise<boolean>;
}

/** This layer swallows every failure — the manager decides what to log. */
export class HerdrPaneControl implements HerdrPaneOps {
	private readonly bin: string;
	private readonly runner: CliRunner;

	constructor(opts: { bin: string; runner?: CliRunner }) {
		this.bin = opts.bin;
		this.runner = opts.runner ?? createExecFileRunner(1 * 1024 * 1024);
	}

	/** Split a pane; resolves to the new pane id, or undefined on any failure. */
	async split(paneId: string, direction: "right" | "down", cwd: string): Promise<string | undefined> {
		const result = await this.invoke(paneSplitArgs(paneId, direction, cwd));
		if (!result || result.code !== 0) return undefined;
		return parseSplitPaneId(result.stdout);
	}

	/** Run one command string in the pane. */
	async run(paneId: string, command: string): Promise<boolean> {
		return (await this.invoke(paneRunArgs(paneId, command)))?.code === 0;
	}

	/** Label the pane. */
	async rename(paneId: string, label: string): Promise<boolean> {
		return (await this.invoke(paneRenameArgs(paneId, label)))?.code === 0;
	}

	/** Close the pane. */
	async close(paneId: string): Promise<boolean> {
		return (await this.invoke(paneCloseArgs(paneId)))?.code === 0;
	}

	private async invoke(args: readonly string[]): Promise<{ stdout: string; code: number } | undefined> {
		try {
			const result = await this.runner.run(this.bin, args, undefined);
			return { stdout: result.stdout, code: result.code };
		} catch {
			return undefined;
		}
	}
}
