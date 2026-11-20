// herdr.ts — ADR 0001 Herdr TUI pane adapter: detect the Herdr TUI environment,
// provide the orchestrator's pane as the placement anchor, build the `herdr pane`
// argv (no shell, via the shared CliRunner seam), and run the best-effort split →
// rename → viewer chain. The pane is a display-only mirror, so no operation here
// may throw into the spawn path: failures resolve as "not done" and the manager
// decides what to log.

import type { CliRunner } from "../cli.ts";
import { createExecFileRunner } from "../cli.ts";
import { toCommandLine } from "./command-line.ts";
import type {
	OpenedPane,
	OpenPaneRequest,
	PaneDirection,
	PaneMultiplexer,
} from "./multiplexer.ts";

/** The Herdr TUI env record: the only env keys this adapter reads. */
export interface HerdrEnv {
	HERDR_ENV?: string;
	HERDR_PANE_ID?: string;
	HERDR_BIN_PATH?: string;
}

/**
 * Detect that the orchestrator runs inside the Herdr TUI. Detected when this pane's
 * own id is known AND the Herdr env flag is set; the binary path falls back to the
 * PATH name. Pure function of the env record.
 */
export function detectHerdrTui(
	env: HerdrEnv,
): { bin: string; mainPaneId: string } | undefined {
	if (!env.HERDR_PANE_ID || env.HERDR_ENV !== "1") return undefined;
	return { bin: env.HERDR_BIN_PATH || "herdr", mainPaneId: env.HERDR_PANE_ID };
}

/** argv for `herdr pane split` — the new pane opens beside/under the given pane. */
export function paneSplitArgs(paneId: string, direction: PaneDirection, cwd: string): readonly string[] {
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
 * The Herdr TUI adapter. `split`, `rename`, `run`, and `close` are public low-level
 * operations for tests; the manager uses only the PaneMultiplexer surface (`open`,
 * `close`, `anchor`). Every method resolves, never throws: split gives the new pane
 * id or undefined; the rest give a success boolean.
 */
export class HerdrTuiMultiplexer implements PaneMultiplexer {
	readonly name = "herdr-tui";
	private readonly bin: string;
	private readonly mainPaneId: string;
	private readonly runner: CliRunner;

	constructor(opts: { bin: string; mainPaneId: string; runner?: CliRunner }) {
		this.bin = opts.bin;
		this.mainPaneId = opts.mainPaneId;
		this.runner = opts.runner ?? createExecFileRunner(1 * 1024 * 1024);
	}

	/** The calling pane is the placement anchor; Herdr injects its id into the env. */
	async anchor(): Promise<string | undefined> {
		return this.mainPaneId;
	}

	/**
	 * Split, rename, then run the viewer. A failed split is undefined; a failed
	 * rename is a diagnostic; a failed viewer run returns a pane with
	 * `viewerStarted: false`, so the manager can keep the server live for a later
	 * viewer.
	 */
	async open(request: OpenPaneRequest): Promise<OpenedPane | undefined> {
		const paneId = await this.split(request.target, request.direction, request.cwd);
		if (paneId === undefined) return undefined;
		const diagnostics: string[] = [];
		if (!(await this.rename(paneId, request.label))) {
			diagnostics.push(`pane rename failed for ${request.label}; the pane keeps its default label`);
		}
		const viewerStarted = await this.run(paneId, toCommandLine(request.viewer.argv));
		if (!viewerStarted) {
			diagnostics.push(`pane viewer start failed for ${request.label}; the pane stays viewerless`);
		}
		return {
			paneId,
			viewerStarted,
			...(diagnostics.length > 0 ? { diagnostics } : {}),
		};
	}

	/** Split a pane; resolves to the new pane id, or undefined on any failure. */
	async split(paneId: string, direction: PaneDirection, cwd: string): Promise<string | undefined> {
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
