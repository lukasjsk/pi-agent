// manager.ts — ADR 0001 subagent pane manager: the single place the spawn path
// meets the panes. open() synchronously creates the per-spawn event server and
// returns a PaneRelay the spawn relays into; opening the Herdr pane itself
// (split → rename → run the viewer) is an async, fire-and-forget, best-effort
// chain whose failures never propagate into the spawn — at worst the pane is
// skipped or left for a later viewer.

import type { SubagentActivity, SubagentStatus } from "../spawn.ts";
import { splitTarget, type HerdrPaneOps } from "./herdr.ts";
import { PANE_CLOSE_DELAY_MS, reportPreview, type PaneSettledEvent } from "./protocol.ts";
import { PaneEventServer, paneSocketPath } from "./server.ts";

/** The relay surface the spawn path talks to: all methods are fire-and-forget no-throws. */
export interface PaneRelay {
	spawnId: string;
	/** Relay one live activity snapshot (coalesced server-side); no-op once stopped. */
	relay(activity: SubagentActivity): void;
	/** The run settled; the pane shows the result and closes after its countdown. */
	settle(payload: PaneSettlePayload): void;
	/** Stop the pane event server (no-op if already stopped). */
	stop(): void;
}

/** What the spawn hands to settle; the manager builds the wire event. */
export interface PaneSettlePayload {
	status: SubagentStatus;
	modelUsed?: string;
	cost?: number;
	totalTokens?: number;
	report?: string;
	diagnostics: readonly string[];
}

export interface SubagentPaneManagerOptions {
	/** The Herdr pane operations (a structural stub is accepted — tests do). */
	herdr: HerdrPaneOps;
	/** The orchestrator's own pane: the placement anchor. */
	mainPaneId: string;
	/** Working directory new panes open in. */
	cwd: string;
	/** Session scoping for the socket paths; missing degrades to "unknown". */
	sessionId?: string;
	/** Root dir the session-scoped pane sockets live under. */
	socketRoot: string;
	/** The pane viewer command line, built from the socket path. */
	viewerCommand: (sockPath: string) => string;
	flushIntervalMs?: number;
	/** Pane auto-close countdown after settle (default PANE_CLOSE_DELAY_MS). */
	closeDelayMs?: number;
	/** Best-effort log sink for pane failures; the spawn path never sees them. */
	log?: (message: string) => void;
}

/**
 * One manager per orchestrator session. open() never throws and always returns a
 * live relay while Herdr is detected: the server is created synchronously and the
 * pane chain runs behind it.
 */
export class SubagentPaneManager {
	private readonly opts: SubagentPaneManagerOptions;
	/** Placement state: the last subagent pane whose split SUCCEEDED. */
	private lastSubagentPaneId: string | undefined;
	private readonly openPanes = new Set<OpenPaneEntry>();

	constructor(opts: SubagentPaneManagerOptions) {
		this.opts = opts;
	}

	/**
	 * Open the subagent pane for a spawn. The returned relay is live immediately;
	 * the Herdr split/rename/run chain is fire-and-forget and never delays the
	 * spawn. Placement: first spawn right of the main pane, later spawns down of
	 * the last opened subagent pane; a failed split falls back to one main-pane
	 * right split, and if that fails too the server stops (the relay no-ops).
	 */
	open(agent: string, spawnId: string, task?: string): PaneRelay | undefined {
		const sockPath = paneSocketPath({ root: this.opts.socketRoot, sessionId: this.opts.sessionId, spawnId });
		const server = new PaneEventServer({
			socketPath: sockPath,
			agent,
			spawnId,
			taskPreview: task ? task.slice(0, 200) : undefined,
			flushIntervalMs: this.opts.flushIntervalMs,
			closeDelayMs: this.opts.closeDelayMs,
		});
		server.start();
		const entry: OpenPaneEntry = { server, paneId: undefined, closeTimer: undefined };
		this.openPanes.add(entry);

		const relay: PaneRelay = {
			spawnId,
			relay: (activity) => server.relay(activity),
			settle: (payload) => {
				server.settle({
					type: "settled",
					status: payload.status,
					...(payload.modelUsed !== undefined ? { modelUsed: payload.modelUsed } : {}),
					...(payload.cost !== undefined ? { cost: payload.cost } : {}),
					...(payload.totalTokens !== undefined ? { totalTokens: payload.totalTokens } : {}),
					...(reportPreview(payload.report) !== undefined
						? { reportPreview: reportPreview(payload.report) }
						: {}),
					diagnostics: payload.diagnostics,
					closeDelayMs: this.opts.closeDelayMs ?? PANE_CLOSE_DELAY_MS,
				} satisfies PaneSettledEvent);
				// The manager owns the pane close: the viewer's own close is a racy
				// best-effort front end, this backstop is what guarantees the pane
				// goes away (ADR 0001), even when no viewer ever attached.
				this.schedulePaneClose(entry);
			},
			stop: () => this.stopEntry(entry),
		};

		void this.openPane(agent, sockPath, entry);
		return relay;
	}

	/** Stop every open pane event server and close every open pane (session_shutdown). */
	closeAll(): void {
		this.openPanes.forEach((entry) => {
			if (entry.paneId) {
				void this.opts.herdr.close(entry.paneId).catch(() => undefined);
				this.clearPlacement(entry.paneId);
			}
			this.stopEntry(entry);
		});
		this.openPanes.clear();
	}

	/**
	 * Arm the backstop pane close: after the settle countdown the manager closes
	 * the pane itself and stops the entry. Idempotent per entry; a stopped entry
	 * never closes. Best-effort: a failed close is logged, never thrown.
	 */
	private schedulePaneClose(entry: OpenPaneEntry): void {
		if (entry.closeTimer || !entry.paneId) return;
		const delay = this.opts.closeDelayMs ?? PANE_CLOSE_DELAY_MS;
		const paneId = entry.paneId;
		entry.closeTimer = setTimeout(() => {
			entry.closeTimer = undefined;
			if (paneId) {
				// Fire-and-forget: the close is best-effort; placement state and the
				// server do not wait on it.
				void this.opts.herdr.close(paneId).then(
					(ok) => {
						if (!ok) this.opts.log?.(`pane close failed for ${paneId}`);
					},
					() => this.opts.log?.(`pane close failed for ${paneId}`),
				);
			}
			this.clearPlacement(paneId);
			this.stopEntry(entry);
		}, delay);
		(entry.closeTimer as { unref?: () => void }).unref?.();
	}

	/** The placement state may not point at a pane that is going away. */
	private clearPlacement(paneId: string | undefined): void {
		if (paneId !== undefined && this.lastSubagentPaneId === paneId) this.lastSubagentPaneId = undefined;
	}

	private stopEntry(entry: OpenPaneEntry): void {
		if (!this.openPanes.delete(entry)) return; // already stopped
		if (entry.closeTimer) {
			clearTimeout(entry.closeTimer);
			entry.closeTimer = undefined;
		}
		entry.server.stop();
	}

	/** The best-effort pane chain: split → rename → run the pane viewer. */
	private async openPane(agent: string, sockPath: string, entry: OpenPaneEntry): Promise<void> {
		const log = this.opts.log;
		const target = splitTarget({ lastSubagentPaneId: this.lastSubagentPaneId }, this.opts.mainPaneId);
		let paneId = await this.opts.herdr.split(target.paneId, target.direction, this.opts.cwd);
		if (paneId === undefined) {
			// Placement target failed: one last-ditch split of the main pane right.
			paneId = await this.opts.herdr.split(this.opts.mainPaneId, "right", this.opts.cwd);
		}
		if (paneId === undefined) {
			// No pane at all: the server stops and the relay no-ops. The spawn is untouched.
			log?.(`pane open failed for ${agent}; skipping the pane`);
			this.stopEntry(entry);
			return;
		}
		// Placement state advances on successful splits only.
		entry.paneId = paneId;
		this.lastSubagentPaneId = paneId;
		if (!(await this.opts.herdr.rename(paneId, agent))) {
			log?.(`pane rename failed for ${agent}; the pane keeps its default label`);
		}
		if (!(await this.opts.herdr.run(paneId, this.opts.viewerCommand(sockPath)))) {
			// The pane exists but has no viewer. While the run is still live, keep
			// the server alive so a viewer that attaches later still gets the stream;
			// once settled, the backstop close has to happen (no viewer will come).
			log?.(`pane viewer start failed for ${agent}; the pane stays viewerless`);
			if (entry.server.settled) this.schedulePaneClose(entry);
		}
	}
}

/** One open pane: its event server, the split pane id (once known), its close timer. */
interface OpenPaneEntry {
	server: PaneEventServer;
	paneId: string | undefined;
	closeTimer: ReturnType<typeof setTimeout> | undefined;
}
