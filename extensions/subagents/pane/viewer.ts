// viewer.ts — the pane viewer (ADR 0001): the read-only live view of one
// subagent run inside a subagent pane. Launched by the orchestrator as
// `<bun> viewer.ts --socket <sockPath>` inside a fresh Herdr pane. This file is
// the thin I/O layer (socket, terminal, mouse, timers); all screen content is
// computed by the pure functions in frame.ts. The viewer is not a pi session
// and the pane is a display-only mirror: nothing here feeds back into the run.

import { execFile } from "node:child_process";
import { connect as netConnect, type Socket as NetSocket } from "node:net";
import { buildPaneHeader, paneBody, truncateToWidth, visibleSlice, type FrameState } from "./frame.ts";
import { decodePaneEvent, type PaneEvent } from "./protocol.ts";

/** Connect retry cadence: every 500 ms, up to 20 attempts (10 s total). The
 *  orchestrator may open the pane before the socket is bound, so late connects
 *  are normal. */
const CONNECT_RETRY_MS = 500;
const CONNECT_ATTEMPTS = 20;
/** Redraws are coalesced to at most one per this window (pending-flag timer). */
const REDRAW_COALESCE_MS = 50;
/** The activity line history buffer is capped here; the oldest lines drop. */
const LINES_CAP = 5000;
/** One mouse wheel notch scrolls this many lines. */
const WHEEL_STEP = 3;
/** The `herdr pane close` call must not hold the exit hostage past this. */
const CLOSE_TIMEOUT_MS = 5000;

/** `--socket <path>` or `--socket=<path>`; undefined when absent. */
function parseSocketPath(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--socket" && argv[i + 1]) return argv[i + 1];
		if (arg.startsWith("--socket=")) return arg.slice("--socket=".length);
	}
	return undefined;
}

/** Connect to the unix socket with the retry cadence above. */
function connectWithRetries(path: string): Promise<NetSocket> {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const tryConnect = () => {
			attempts++;
			const socket = netConnect(path);
			socket.once("connect", () => resolve(socket));
			socket.once("error", (error) => {
				socket.destroy();
				if (attempts >= CONNECT_ATTEMPTS) reject(error);
				else setTimeout(tryConnect, CONNECT_RETRY_MS);
			});
		};
		tryConnect();
	});
}

async function main(socketPath: string): Promise<void> {
	let socket: NetSocket;
	try {
		socket = await connectWithRetries(socketPath);
	} catch {
		console.error(`pane viewer: could not connect to ${socketPath}`);
		process.exit(1);
	}

	const isTTY = Boolean(process.stdout.isTTY);
	const state: FrameState = { width: process.stdout.columns ?? 80 };
	let offsetFromBottom = 0; // 0 = follow the tail
	let closed = false;
	let terminalOn = false;
	let countdownTimer: ReturnType<typeof setTimeout> | undefined;
	let redrawPending = false;
	let redrawTimer: ReturnType<typeof setTimeout> | undefined;
	const printed: string[] = []; // degrade mode: the body lines already printed

	/** Restore the terminal (mouse off, back to the main screen) and tear down
	 *  timers and the socket. Called before every exit path; idempotent. */
	function shutdown(): void {
		if (closed) return;
		closed = true;
		if (countdownTimer) clearTimeout(countdownTimer);
		if (redrawTimer) clearTimeout(redrawTimer);
		if (terminalOn) {
			process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l");
			terminalOn = false;
		}
		socket.destroy();
	}

	/** The body line buffer: the shared pane body (activity lines plus the
	 *  countdown line), capped — the relayed snapshot is cumulative, so the
	 *  latest snapshot already is the full history; the cap drops oldest lines. */
	function currentBody(): string[] {
		const lines = paneBody(state);
		return lines.length > LINES_CAP ? lines.slice(lines.length - LINES_CAP) : lines;
	}

	/** A full-screen redraw: the pane header stays pinned on row 0, row 1 is
	 *  blank, and the rows below show the visible slice of the body buffer. */
	function draw(): void {
		if (closed) return;
		const height = process.stdout.rows ?? 24;
		const width = process.stdout.columns ?? 80;
		state.width = width;
		const body = currentBody();
		const frame = [buildPaneHeader(state), "", ...visibleSlice(body, Math.max(0, height - 2), offsetFromBottom)];
		let out = "\x1b[H";
		for (let r = 0; r < height; r++) {
			const line = r < frame.length ? frame[r] : "";
			out += `\x1b[${r + 1};1H${truncateToWidth(line, width)}\x1b[K`;
		}
		out += "\x1b[J";
		process.stdout.write(out);
	}

	/** Coalesce redraws: at most one per window; the pending flag swallows
	 *  changes that land while a redraw is already scheduled. */
	function requestRedraw(): void {
		if (!isTTY || closed || redrawPending) return;
		redrawPending = true;
		redrawTimer = setTimeout(() => {
			redrawPending = false;
			draw();
		}, REDRAW_COALESCE_MS);
	}

	/** Degrade mode (no TTY): print each new line plainly, no terminal control.
	 *  New = the part of the body past the already-printed common prefix, so the
	 *  buffer swap at settle still surfaces the settled lines. */
	function degradedPrint(body: string[]): void {
		let common = 0;
		while (common < printed.length && common < body.length && printed[common] === body[common]) common++;
		for (let i = common; i < body.length; i++) {
			process.stdout.write(`${body[i]}\n`);
		}
		printed.length = 0;
		printed.push(...body);
	}

	/** React to a state change: refresh the body, redraw (or print), and — for
	 *  new activity before settle — return the view to the tail (follow). */
	function onFrameChange(followTail: boolean): void {
		if (followTail) offsetFromBottom = 0;
		if (isTTY) requestRedraw();
		else degradedPrint(currentBody());
	}

	/** Count the post-settle seconds down to 0, redrawing, then close the pane. */
	function startCountdown(closeDelayMs: number): void {
		let seconds = Math.ceil(closeDelayMs / 1000);
		const tick = (): void => {
			if (closed) return;
			state.countdownSeconds = seconds;
			onFrameChange(false);
			if (seconds === 0) {
				void finish();
				return;
			}
			seconds--;
			countdownTimer = setTimeout(tick, 1000);
		};
		tick();
	}

	/** Close the Herdr pane, then exit. Without HERDR_PANE_ID there is no pane
	 *  to close; the close attempt is guarded by a timeout so a stuck CLI can
	 *  never hold the exit. */
	async function finish(): Promise<void> {
		const paneId = process.env.HERDR_PANE_ID;
		if (paneId) {
			const bin = process.env.HERDR_BIN_PATH ?? "herdr";
			await new Promise<void>((resolve) => {
				let child: ReturnType<typeof execFile>;
				const guard = setTimeout(() => {
					if (child) child.kill();
					resolve();
				}, CLOSE_TIMEOUT_MS);
				child = execFile(bin, ["pane", "close", paneId], () => {
					clearTimeout(guard);
					resolve();
				});
			});
		}
		shutdown();
		process.exit(0);
	}

	function handleEvent(event: PaneEvent): void {
		if (event.type === "hello") {
			// The agent name lives in the pane label (the manager's rename); the
			// frame renders model/context/cost only. Redraw: the header gains task orientation.
			onFrameChange(false);
		} else if (event.type === "activity") {
			state.activity = event;
			// New activity before settle pulls the view back to the tail.
			onFrameChange(!state.settled);
		} else if (event.type === "settled") {
			if (state.settled) return; // settled arrives once; ignore duplicates
			state.settled = event;
			onFrameChange(false);
			startCountdown(event.closeDelayMs);
		}
	}

	// The event stream: newline-delimited JSON; undecodable lines are dropped.
	socket.setEncoding("utf8");
	let pending = "";
	socket.on("data", (chunk: string) => {
		pending += chunk;
		let newline: number;
		while ((newline = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			const event = decodePaneEvent(line);
			if (event) handleEvent(event);
		}
	});
	// A dead orchestrator must leave no orphaned viewer (ADR consequence): the
	// socket ending or erroring at any point before the countdown finishes exits.
	socket.on("close", () => {
		if (!closed) {
			shutdown();
			process.exit(0);
		}
	});
	socket.on("error", () => {
		if (!closed) {
			shutdown();
			process.exit(0);
		}
	});

	if (isTTY) {
		// Alternate screen + SGR mouse, once; shutdown() restores on every exit.
		process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
		terminalOn = true;
		process.on("SIGWINCH", () => requestRedraw());
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
			process.stdin.resume();
			// SGR mouse wheel: \x1b[<64;x;yM (up) and \x1b[<65;x;yM (down).
			let stdinBuf = "";
			process.stdin.on("data", (chunk: Buffer) => {
				stdinBuf += chunk.toString("utf8");
				const wheel = /\x1b\[<6[45];\d+;\d+M/g;
				let match: RegExpExecArray | null;
				let consumed = 0;
				while ((match = wheel.exec(stdinBuf))) {
					const up = match[0].includes("<64;"); // 64 = wheel up, 65 = wheel down
					offsetFromBottom = Math.max(0, offsetFromBottom + (up ? WHEEL_STEP : -WHEEL_STEP));
					consumed = wheel.lastIndex;
					requestRedraw();
				}
				stdinBuf = stdinBuf.slice(consumed);
			});
		}
		draw();
	} else {
		degradedPrint(currentBody());
	}
}

// Side effects only when run directly (the module stays import-safe for tests
// and tools): `bun viewer.ts --socket <sockPath>`.
if (import.meta.main) {
	const socketPath = parseSocketPath(process.argv.slice(2));
	if (!socketPath) {
		console.error("usage: bun viewer.ts --socket <sockPath>");
		process.exit(1);
	}
	main(socketPath).catch((error) => {
		console.error(`pane viewer: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
