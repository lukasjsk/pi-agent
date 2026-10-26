// server.ts — ADR 0001 pane event server: one local unix socket per spawn that
// projects the events the spawn already relays to the pane viewer. Activity events
// are snapshots and coalesce to the latest (throttled flush, at most one per
// flush window); the settled event flushes immediately and arms the auto-close
// countdown. A bind failure leaves the server silently inactive — the pane is
// best-effort and can never fail or delay a spawn.

import { mkdir, rm, unlink } from "node:fs/promises";
import { createServer, Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { SubagentActivity } from "../spawn.ts";
import {
	encodePaneEvent,
	PANE_CLOSE_DELAY_MS,
	type PaneActivityEvent,
	type PaneEvent,
	type PaneHelloEvent,
	type PaneSettledEvent,
} from "./protocol.ts";

/**
 * Session-scoped pane socket path (mirrors transport.ts's overflowFilePath naming):
 * <root>/pi-subagent-panes/<session-id|unknown>/<spawn-id>.sock.
 */
export function paneSocketPath(opts: { root: string; sessionId?: string; spawnId: string }): string {
	return join(opts.root, "pi-subagent-panes", opts.sessionId || "unknown", `${opts.spawnId}.sock`);
}

export interface PaneEventServerOptions {
	socketPath: string;
	agent: string;
	spawnId: string;
	/** Head of the task brief, for orientation only (hello event). */
	taskPreview?: string;
	/** Max gap between activity flushes; activity snapshots coalesce (default 250ms). */
	flushIntervalMs?: number;
	/** How long the pane stays open after settle (default PANE_CLOSE_DELAY_MS). */
	closeDelayMs?: number;
}

/** Map the spawn's live activity snapshot into the wire event (adds the type tag). */
function toActivityEvent(activity: SubagentActivity): PaneActivityEvent {
	return {
		type: "activity",
		progress: activity.progress,
		toolCalls: activity.toolCalls,
		contentLines: activity.contentLines,
		...(activity.model !== undefined ? { model: activity.model } : {}),
		...(activity.effectiveThinkingLevel !== undefined
			? { effectiveThinkingLevel: activity.effectiveThinkingLevel }
			: {}),
		...(activity.tokens !== undefined ? { tokens: activity.tokens } : {}),
		...(activity.contextWindow !== undefined ? { contextWindow: activity.contextWindow } : {}),
		...(activity.cost !== undefined ? { cost: activity.cost } : {}),
	};
}

/**
 * The per-spawn pane event server. Every public method is fire-and-forget:
 * relay/settle/stop never throw, a bind failure leaves the server silently
 * inactive, and every later call on an inactive server is a no-op.
 */
export class PaneEventServer {
	/** Live viewer connections (read-only observation point for tests and the manager). */
	connectedClients = 0;
	/** True once the run settled (the manager's backstop close consults this). */
	get settled(): boolean {
		return this.settledEvent !== undefined;
	}

	private readonly server: Server;
	private readonly clients = new Set<Socket>();
	private readonly hello: PaneHelloEvent;
	private readonly flushIntervalMs: number;
	private readonly closeDelayMs: number;
	private active = false;
	/** Activity snapshots coalesce: only the latest is retained, not a queue. */
	private latestActivity: PaneActivityEvent | undefined;
	private settledEvent: PaneSettledEvent | undefined;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private closeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: PaneEventServerOptions) {
		this.hello = {
			type: "hello",
			agent: opts.agent,
			spawnId: opts.spawnId,
			...(opts.taskPreview !== undefined ? { taskPreview: opts.taskPreview } : {}),
		};
		this.flushIntervalMs = opts.flushIntervalMs ?? 250;
		this.closeDelayMs = opts.closeDelayMs ?? PANE_CLOSE_DELAY_MS;
		this.server = createServer((socket) => this.handleClient(socket));
		this.server.on("error", () => {
			// Bind failed (e.g. EADDRINUSE): stay silently inactive.
			this.active = false;
		});
	}

	/** Synchronous: schedules the bind. A failed bind leaves the server inactive. */
	start(): void {
		if (this.active) return;
		this.active = true;
		// A stale socket file from a dead process would block the bind; remove it.
		rm(this.opts.socketPath)
			.then(() => this.bind())
			.catch(() => this.bind());
	}

	/**
	 * Store the latest activity snapshot (coalescing) and flush it to all clients at
	 * most once per flush window. A relay with no pending flush schedules the next
	 * flush; relays while a flush is pending only replace the snapshot.
	 */
	relay(activity: SubagentActivity): void {
		if (!this.active || this.settledEvent) return; // the run is over: relay is a no-op
		this.latestActivity = toActivityEvent(activity);
		if (this.flushTimer) return; // a pending flush will send this latest snapshot
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			const event = this.latestActivity;
			if (event) this.clients.forEach((socket) => this.write(socket, event));
		}, this.flushIntervalMs);
	}

	/**
	 * The run ended: retain the settled event, flush hello + latest activity +
	 * settled to all clients immediately, and arm the auto-close countdown that
	 * then stops the server (the pane viewer keeps the pane open closeDelayMs).
	 */
	settle(event: PaneSettledEvent): void {
		if (!this.active || this.settledEvent) return;
		this.settledEvent = event;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.clients.forEach((socket) => {
			this.write(socket, this.hello);
			if (this.latestActivity) this.write(socket, this.latestActivity);
			this.write(socket, event);
		});
		this.closeTimer = setTimeout(() => this.stop(), this.closeDelayMs);
	}

	/** Idempotent: cancels pending work, destroys clients and the server, unlinks the socket. */
	stop(): void {
		this.active = false;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.closeTimer) {
			clearTimeout(this.closeTimer);
			this.closeTimer = undefined;
		}
		this.clients.forEach((socket) => socket.destroy());
		this.clients.clear();
		this.connectedClients = 0;
		if (this.server.listening) this.server.close();
		unlink(this.opts.socketPath).catch(() => undefined);
	}

	private bind(): void {
		if (!this.active) return; // stopped between the stale-file cleanup and the bind
		mkdir(dirname(this.opts.socketPath), { recursive: true })
			.then(() => this.server.listen(this.opts.socketPath))
			.catch(() => {
				this.active = false;
			});
	}

	private handleClient(socket: Socket): void {
		this.clients.add(socket);
		this.connectedClients = this.clients.size;
		socket.on("error", () => undefined); // never crash on a vanished viewer
		socket.on("close", () => {
			this.clients.delete(socket);
			this.connectedClients = this.clients.size;
		});
		// A late viewer gets the retained state: hello first, then whatever is kept.
		this.write(socket, this.hello);
		if (this.latestActivity) this.write(socket, this.latestActivity);
		if (this.settledEvent) this.write(socket, this.settledEvent);
	}

	private write(socket: Socket, event: PaneEvent): void {
		socket.write(encodePaneEvent(event));
	}
}
