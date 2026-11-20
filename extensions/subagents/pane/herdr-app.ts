// herdr-app.ts — ADR 0001 Herdr desktop-app pane adapter. The app owns spaces,
// tabs, and panes; the terminals themselves run in herdr-core (`hc`). Inside an
// app terminal the core injects HC_TERMINAL_ID, not a pane id, so the adapter
// resolves the anchor pane from `herdr-app ls`, then splits it with
// `herdr-app do pane.split --argv …`. The app closes a pane when its program
// exits, so the viewer needs no close command; the manager's backstop close still
// runs for a pane whose viewer never attached.

import type { CliRunner } from "../cli.ts";
import { createExecFileRunner } from "../cli.ts";
import type {
	OpenedPane,
	OpenPaneRequest,
	PaneDirection,
	PaneMultiplexer,
} from "./multiplexer.ts";

/** The Herdr app env record: the core identifies this terminal, not a pane. */
export interface HerdrAppEnv {
	HC_TERMINAL_ID?: string;
	HC_TERMINAL_SOCKET?: string;
	HERDR_APP_BIN?: string;
	/** The TUI flag: when set, the TUI adapter wins and this one stays off. */
	HERDR_ENV?: string;
}

/**
 * Detect that the orchestrator runs in a Herdr app terminal. The app's terminals
 * carry HC_TERMINAL_ID; the TUI carries HERDR_ENV=1 and HERDR_PANE_ID instead.
 * Pure function of the env record. Detection is only a hint: the app may be
 * closed, in which case `ls` fails and the pane is skipped.
 */
export function detectHerdrApp(
	env: HerdrAppEnv,
): { bin: string; terminalId: string } | undefined {
	if (env.HERDR_ENV === "1") return undefined; // the TUI adapter owns that environment
	if (!env.HC_TERMINAL_ID) return undefined;
	return { bin: env.HERDR_APP_BIN || "herdr-app", terminalId: env.HC_TERMINAL_ID };
}

/** argv for `herdr-app do pane.split` — split the target and start the viewer. */
export function appSplitArgs(
	paneId: string,
	direction: PaneDirection,
	viewerArgv: readonly string[],
): readonly string[] {
	return [
		"do",
		"pane.split",
		"--direction",
		direction,
		"--pane",
		paneId,
		"--argv",
		JSON.stringify(viewerArgv),
	];
}

/** argv for `herdr-app do pane.close`. */
export function appCloseArgs(paneId: string): readonly string[] {
	return ["do", "pane.close", "--pane", paneId];
}

/** argv for `herdr-app ls`, the anchor lookup. */
export function appListArgs(): readonly string[] {
	return ["ls"];
}

/**
 * Find this terminal's pane in `herdr-app ls` output. The layout is
 * spaces[].tabs[].terminals[] with `{ terminal, pane }` records. Only an exact
 * local terminal id matches; remote ids carry a `<machine>/` prefix and need a
 * `--machine` command, which this local-only adapter does not issue. Returns
 * undefined on malformed JSON or no match — the spawn then opens no pane.
 */
export function parseTerminalPaneId(stdout: string, terminalId: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const spaces = (value as { spaces?: unknown } | null)?.spaces;
	if (!Array.isArray(spaces)) return undefined;
	for (const space of spaces) {
		const tabs = (space as { tabs?: unknown } | null)?.tabs;
		if (!Array.isArray(tabs)) continue;
		for (const tab of tabs) {
			const terminals = (tab as { terminals?: unknown } | null)?.terminals;
			if (!Array.isArray(terminals)) continue;
			for (const terminal of terminals) {
				const record = terminal as { terminal?: unknown; pane?: unknown } | null;
				if (record?.terminal !== terminalId) continue;
				if (typeof record.pane === "string" && record.pane.length > 0) return record.pane;
			}
		}
	}
	return undefined;
}

/**
 * The new pane id from `herdr-app do pane.split` stdout: `{ "pane": "…",
 * "terminal": "…" }`. Returns undefined on malformed JSON, an error object, or a
 * missing/non-string pane field — the split then counts as failed.
 */
export function parseAppSplitPaneId(stdout: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const pane = (value as { pane?: unknown } | null)?.pane;
	return typeof pane === "string" && pane.length > 0 ? pane : undefined;
}

/**
 * The Herdr app adapter. `anchor` resolves the pane of the terminal the orchestrator
 * runs in; `open` splits that pane (or a sibling) and starts the viewer as the new
 * terminal's argv; `close` removes the pane. Every method resolves, never throws.
 */
export class HerdrAppMultiplexer implements PaneMultiplexer {
	readonly name = "herdr-app";
	private readonly bin: string;
	private readonly terminalId: string;
	private readonly runner: CliRunner;

	constructor(opts: { bin: string; terminalId: string; runner?: CliRunner }) {
		this.bin = opts.bin;
		this.terminalId = opts.terminalId;
		this.runner = opts.runner ?? createExecFileRunner(1 * 1024 * 1024);
	}

	/** The orchestrator's pane, found from its terminal address in `herdr-app ls`. */
	async anchor(): Promise<string | undefined> {
		const result = await this.invoke(appListArgs());
		if (!result || result.code !== 0) return undefined;
		return parseTerminalPaneId(result.stdout, this.terminalId);
	}

	/**
	 * Split the target pane and start the viewer as its argv. The app has no cwd
	 * argument on pane.split; the viewer uses absolute paths, so this is harmless.
	 * A successful split is reported as `viewerStarted: true`; a viewer that exits
	 * immediately closes its own pane (the app's normal terminal-exit behavior).
	 */
	async open(request: OpenPaneRequest): Promise<OpenedPane | undefined> {
		const result = await this.invoke(appSplitArgs(request.target, request.direction, request.viewer.argv));
		if (!result || result.code !== 0) return undefined;
		const paneId = parseAppSplitPaneId(result.stdout);
		if (paneId === undefined) return undefined;
		return { paneId, viewerStarted: true };
	}

	/** Close the pane (best-effort; a pane whose viewer exited is already gone). */
	async close(paneId: string): Promise<boolean> {
		return (await this.invoke(appCloseArgs(paneId)))?.code === 0;
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
