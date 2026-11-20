// manager.ts — ADR 0001 subagent pane manager: the single place the spawn path
// meets the panes. open() synchronously creates the per-spawn event server and
// returns a PaneRelay the spawn relays into; opening the pane itself (anchor
// lookup → split → viewer start) is an async, fire-and-forget, best-effort chain
// whose failures never propagate into the spawn — at worst the pane is skipped or
// left for a later viewer. The multiplexer-specific commands live behind the
// PaneMultiplexer seam; this module owns only the shared server, placement, and
// close policy.

import type { SubagentActivity, SubagentStatus } from "../spawn.ts";
import type { PaneDirection, PaneMultiplexer, ViewerProgram } from "./multiplexer.ts";
import { splitTarget } from "./placement.ts";
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
	/** The detected multiplexer adapter (a structural stub is accepted — tests do). */
	multiplexer: PaneMultiplexer;
	/** Working directory new panes open in. */
	cwd: string;
	/** Session scoping for the socket paths; missing degrades to "unknown". */
	sessionId?: string;
	/** Root dir the session-scoped pane sockets live under. */
	socketRoot: string;
	/** The pane viewer argv, built from the socket path; adapters encode it. */
	viewerArgv: (sockPath: string) => readonly string[];
	flushIntervalMs?: number;
	/** Pane auto-close countdown after settle (default PANE_CLOSE_DELAY_MS). */
	closeDelayMs?: number;
	/** Best-effort log sink for pane failures; the spawn path never sees them. */
	log?: (message: string) => void;
}

/**
 * One manager per orchestrator session. open() never throws and always returns a
 * live relay while a multiplexer is detected: the server is created synchronously
 * and the pane chain runs behind it.
 */
export class SubagentPaneManager {
	private readonly opts: SubagentPaneManagerOptions;
	/** Placement state: the last subagent pane whose split SUCCEEDED. */
	private lastSubagentPaneId: string | undefined;
	/** The anchor lookup result; a failed lookup is retried on the next spawn. */
	private anchorPaneId: string | undefined;
	private readonly openPanes = new Set<OpenPaneEntry>();
	/**
	 * FIFO queue serializing the pane chains: placement reads lastSubagentPaneId
	 * between the async adapter calls, so two parallel spawns must not both target
	 * the stale state — splits run strictly one at a time, in spawn order.
	 */
	private placementQueue: Promise<void> = Promise.resolve();

	constructor(opts: SubagentPaneManagerOptions) {
		this.opts = opts;
	}

	/**
	 * Open the subagent pane for a spawn. The returned relay is live immediately;
	 * the anchor lookup and split/viewer chain are fire-and-forget and never delay
	 * the spawn. Placement: first spawn right of the orchestrator pane, later
	 * spawns down of the last opened subagent pane; a failed split falls back to
	 * one anchor right split, and if that fails too the server stops (the relay
	 * no-ops).
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

		// Enqueue: this spawn's chain starts only after the previous spawn's chain
		// finished, so parallel spawns stack instead of fanning out beside the anchor
		// pane. A chain never rejects (every step is best-effort), the catch is a
		// belt-and-braces guard so one bad chain can never jam the queue.
		this.placementQueue = this.placementQueue
			.then(() => this.openPane(agent, sockPath, entry))
			.catch(() => this.stopEntry(entry));
		return relay;
	}

	/** Stop every open pane event server and close every open pane (session_shutdown). */
	closeAll(): void {
		this.openPanes.forEach((entry) => {
			if (entry.paneId) {
				void this.opts.multiplexer.close(entry.paneId).catch(() => undefined);
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
				void this.opts.multiplexer.close(paneId).then(
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

	/**
	 * The orchestrator's own pane. A failed lookup is not cached: a later spawn
	 * retries, so an app that was still opening can still host later panes.
	 */
	private async resolveAnchor(): Promise<string | undefined> {
		if (this.anchorPaneId) return this.anchorPaneId;
		const anchor = await this.opts.multiplexer.anchor().catch(() => undefined);
		if (anchor) this.anchorPaneId = anchor;
		return anchor;
	}

	/** The best-effort pane chain: anchor → split → start the viewer. */
	private async openPane(agent: string, sockPath: string, entry: OpenPaneEntry): Promise<void> {
		const log = this.opts.log;
		const anchor = await this.resolveAnchor();
		if (anchor === undefined) {
			log?.(`pane open failed for ${agent}: no ${this.opts.multiplexer.name} anchor pane; skipping the pane`);
			this.stopEntry(entry);
			return;
		}

		const viewer: ViewerProgram = { argv: this.opts.viewerArgv(sockPath) };
		const target = splitTarget({ lastSubagentPaneId: this.lastSubagentPaneId }, anchor);
		let opened = await this.openAt(target.paneId, target.direction, agent, viewer);
		if (opened === undefined) {
			// Placement target failed: one last-ditch split of the anchor pane right.
			opened = await this.openAt(anchor, "right", agent, viewer);
		}
		if (opened === undefined) {
			// No pane at all: the server stops and the relay no-ops. The spawn is
			// untouched. Drop the cached anchor because a stale one (an app restart
			// changes pane ids) may be the cause; the next spawn resolves it again.
			this.anchorPaneId = undefined;
			log?.(`pane open failed for ${agent}; skipping the pane`);
			this.stopEntry(entry);
			return;
		}
		// Placement state advances on successful splits only.
		entry.paneId = opened.paneId;
		this.lastSubagentPaneId = opened.paneId;
		for (const message of opened.diagnostics ?? []) log?.(message);
		if (!opened.viewerStarted) {
			// The pane exists but has no viewer. While the run is still live, keep
			// the server alive so a viewer that attaches later still gets the stream;
			// once settled, the backstop close has to happen (no viewer will come).
			if (entry.server.settled) this.schedulePaneClose(entry);
		}
	}

	/** One adapter call, guarded so a misbehaving adapter can never jam the queue. */
	private async openAt(
		target: string,
		direction: PaneDirection,
		agent: string,
		viewer: ViewerProgram,
	): Promise<Awaited<ReturnType<PaneMultiplexer["open"]>>> {
		try {
			return await this.opts.multiplexer.open({
				target,
				direction,
				cwd: this.opts.cwd,
				label: agent,
				viewer,
			});
		} catch {
			return undefined;
		}
	}
}

/** One open pane: its event server, the split pane id (once known), its close timer. */
interface OpenPaneEntry {
	server: PaneEventServer;
	paneId: string | undefined;
	closeTimer: ReturnType<typeof setTimeout> | undefined;
}
