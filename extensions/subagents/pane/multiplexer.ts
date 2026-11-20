// multiplexer.ts — the terminal-multiplexer seam for subagent panes (ADR 0001).
// The manager owns the per-spawn event server, the placement policy, and the close
// backstop; an adapter owns detection, the orchestrator anchor lookup, and the
// multiplexer-specific split/launch/close commands. Add a multiplexer by adding one
// adapter module and one line in registry.ts. A pane is a display-only mirror, so
// every adapter operation is best-effort: failures resolve as "not done", never as
// a thrown error into the spawn path.

/** Pane placement direction; the two directions every supported multiplexer has. */
export type PaneDirection = "right" | "down";

/** The viewer process as argv tokens; each adapter encodes it as its CLI needs. */
export interface ViewerProgram {
	argv: readonly string[];
}

/** One split request: the pane to split from and the viewer to run in the new pane. */
export interface OpenPaneRequest {
	/** Existing pane to split from (the orchestrator anchor or the last subagent pane). */
	target: string;
	direction: PaneDirection;
	/** Working directory for the new terminal, when the multiplexer supports one. */
	cwd: string;
	/** Human label for the pane (the agent definition's name). */
	label: string;
	viewer: ViewerProgram;
}

/**
 * Whether the adapter could observe the viewer process starting in the new
 * pane. "failed" only when the adapter knows the viewer did not start.
 */
export type ViewerStart = "started" | "failed" | "unknown";

/**
 * What an adapter reports after a split. `undefined` from open() means the split
 * itself failed; a result with `viewerStart: "failed"` means the pane exists but
 * the viewer did not start (the manager keeps the server live for a later
 * viewer); `"unknown"` means the adapter cannot observe the viewer (the Herdr
 * app starts it as the new pane's argv).
 */
export interface OpenedPane {
	paneId: string;
	/** "failed" when the pane exists but the viewer process did not start. */
	viewerStart: ViewerStart;
	/** Adapter-side failures the manager logs; never thrown into the spawn path. */
	diagnostics?: readonly string[];
}

/** One terminal multiplexer that can host subagent panes. */
export interface PaneMultiplexer {
	/** Stable adapter name, for logs and tests (herdr-tui, herdr-app). */
	readonly name: string;
	/** The orchestrator's own pane; undefined when it cannot be found. */
	anchor(): Promise<string | undefined>;
	/** Split a pane and start the viewer. Never throws. */
	open(request: OpenPaneRequest): Promise<OpenedPane | undefined>;
	/** Close a pane. Never throws; false means the close did not happen. */
	close(paneId: string): Promise<boolean>;
}
