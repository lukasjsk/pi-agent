// manager.test.ts — ADR 0001 subagent pane manager: the synchronous open path
// returns a live relay immediately; the anchor lookup and multiplexer open chain
// are async and best-effort. The multiplexer adapter is a plain fake (structural
// typing); the pane event server is real, in a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentPaneManager } from "./manager.ts";
import type { OpenedPane, OpenPaneRequest, PaneDirection, PaneMultiplexer } from "./multiplexer.ts";
import { paneSocketPath } from "./server.ts";
import { decodePaneEvent, PANE_REPORT_PREVIEW_CHARS, type PaneEvent } from "./protocol.ts";

type OpenCall = {
	target: string;
	direction: PaneDirection;
	cwd: string;
	label: string;
	viewer: readonly string[];
};

type FakeMuxOptions = {
	failSplit?: boolean;
	viewerFails?: boolean;
	labelDiagnostic?: boolean;
	splitDelayMs?: number;
	anchor?: string | undefined;
	anchorThrows?: boolean;
	anchorResults?: Array<string | undefined>;
};

/** Fake multiplexer: records every adapter call, replays the requested failures. */
function fakeMux(over: FakeMuxOptions = {}): {
	state: {
		anchors: number;
		opens: OpenCall[];
		closes: string[];
	};
	multiplexer: PaneMultiplexer;
} {
	const state = { anchors: 0, opens: [] as OpenCall[], closes: [] as string[] };
	let next = 1;
	return {
		state,
		multiplexer: {
			name: "fake",
			async anchor() {
				state.anchors++;
				if (over.anchorThrows) throw new Error("anchor exploded");
				if (over.anchorResults) return over.anchorResults[Math.min(state.anchors - 1, over.anchorResults.length - 1)];
				return "anchor" in over ? over.anchor : "w1:p1";
			},
			async open(request: OpenPaneRequest): Promise<OpenedPane | undefined> {
				state.opens.push({
					target: request.target,
					direction: request.direction,
					cwd: request.cwd,
					label: request.label,
					viewer: [...request.viewer.argv],
				});
				if (over.splitDelayMs) await new Promise((resolve) => setTimeout(resolve, over.splitDelayMs));
				if (over.failSplit) return undefined;
				return {
					paneId: `fake:p${next++}`,
					viewerStart: over.viewerFails ? "failed" : "started",
					...(over.labelDiagnostic ? { diagnostics: ["pane rename failed for scout"] } : {}),
				};
			},
			async close(paneId: string) {
				state.closes.push(paneId);
				return true;
			},
		},
	};
}

function makeManager(root: string, multiplexer: PaneMultiplexer, over: Record<string, unknown> = {}) {
	return new SubagentPaneManager({
		multiplexer,
		cwd: "/home/u/repo",
		sessionId: "sess-1",
		socketRoot: root,
		viewerArgv: (sockPath) => ["pi", "pane-viewer", "--sock", sockPath],
		flushIntervalMs: 50,
		closeDelayMs: 50,
		...over,
	});
}

async function makeTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pane-manager-"));
}

/** Let the manager's fire-and-forget pane chain run to completion. */
async function settleChain(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
}

const activity = (progress: string) => ({ progress, toolCalls: [], contentLines: [progress] });

/** Minimal settled payload; the manager builds the wire event. */
const settledPayload = (over: Record<string, unknown> = {}) => ({
	status: "completed" as const,
	diagnostics: [],
	...over,
});

class Client {
	readonly events: PaneEvent[] = [];
	private readonly sock: Socket;

	constructor(sock: Socket) {
		this.sock = sock;
		let buffer = "";
		sock.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const event = decodePaneEvent(line);
				if (event) this.events.push(event);
			}
		});
	}

	async waitFor(predicate: (events: PaneEvent[]) => boolean, timeoutMs = 2000): Promise<void> {
		const start = Date.now();
		while (!predicate(this.events)) {
			if (Date.now() - start > timeoutMs) {
				throw new Error(`timed out waiting for events: ${JSON.stringify(this.events)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	/** Resolves when the server closes the connection (EOF). */
	waitForEnd(): Promise<void> {
		return new Promise((resolve) => this.sock.once("end", () => resolve()));
	}

	destroy(): void {
		this.sock.destroy();
	}
}

async function connectClient(path: string, timeoutMs = 2000): Promise<Client | undefined> {
	const start = Date.now();
	for (;;) {
		try {
			const sock = connect(path);
			const client = new Client(sock);
			await new Promise<void>((resolve, reject) => {
				sock.once("connect", () => resolve());
				sock.once("error", reject);
			});
			return client;
		} catch {
			if (Date.now() - start > timeoutMs) return undefined;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

test("open returns a live relay synchronously: the first spawn splits the anchor right, the second stacks down", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux();
	const manager = makeManager(root, multiplexer);

	const relay = manager.open("worker", "worker-ab12", "implement the feature");
	assert.ok(relay, "a detected manager always returns a relay");
	assert.equal(relay!.spawnId, "worker-ab12");

	await settleChain();
	const sockPath = paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" });
	assert.deepEqual(state.opens, [
		{
			target: "w1:p1",
			direction: "right",
			cwd: "/home/u/repo",
			label: "worker",
			viewer: ["pi", "pane-viewer", "--sock", sockPath],
		},
	]);
	assert.equal(state.anchors, 1, "the anchor is resolved once per session");

	const relay2 = manager.open("scout", "scout-cd34");
	await settleChain();
	assert.deepEqual(state.opens[1], {
		target: "fake:p1",
		direction: "down",
		cwd: "/home/u/repo",
		label: "scout",
		viewer: ["pi", "pane-viewer", "--sock", paneSocketPath({ root, sessionId: "sess-1", spawnId: "scout-cd34" })],
	});
	assert.equal(state.anchors, 1, "the cached anchor is reused");

	relay!.stop();
	relay2!.stop();
	await rm(root, { recursive: true, force: true });
});

test("parallel spawns stack: the second split targets the first subagent pane, not the anchor", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux({ splitDelayMs: 30 });
	const manager = makeManager(root, multiplexer);
	// Two spawns open in the same tick — before any split has answered.
	manager.open("worker", "worker-ab12");
	manager.open("scout", "scout-cd34");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(state.opens.length, 2);
	assert.deepEqual(
		{ target: state.opens[0].target, direction: state.opens[0].direction },
		{ target: "w1:p1", direction: "right" },
		"first spawn: right of the anchor",
	);
	assert.deepEqual(
		{ target: state.opens[1].target, direction: state.opens[1].direction },
		{ target: "fake:p1", direction: "down" },
		"second spawn: down of the first subagent pane",
	);
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a failed split falls back to splitting the anchor right, then the relay no-ops safely", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { multiplexer, state } = fakeMux({ failSplit: true });
	const manager = makeManager(root, multiplexer, { log: (m: string) => messages.push(m) });
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	// Both split attempts targeted the anchor right; no pane was recorded.
	assert.deepEqual(
		state.opens.map((o) => ({ target: o.target, direction: o.direction })),
		[
			{ target: "w1:p1", direction: "right" },
			{ target: "w1:p1", direction: "right" },
		],
	);
	assert.ok(messages.length >= 1, "the failure is logged");
	// The server is stopped: the spawn's relay calls are safe no-ops.
	relay.relay(activity("still safe"));
	relay.settle(settledPayload());
	relay.stop();
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
		200,
	);
	assert.equal(client, undefined, "no viewer can reach a skipped pane");
	// A later spawn still targets the anchor right (state did not advance). The
	// recovery lookup found the same anchor: unchanged means no third split.
	assert.equal(state.anchors, 2, "the anchor is looked up again after both splits fail");
	assert.equal(state.opens.length, 2, "no retry split: the fresh anchor was unchanged");
	manager.open("scout", "scout-cd34")!;
	await settleChain();
	const last = state.opens[state.opens.length - 1];
	assert.equal(last.target, "w1:p1");
	assert.equal(last.direction, "right");
	assert.equal(state.anchors, 4, "each failed chain resolves the anchor twice and clears the cache");
	assert.equal(state.opens.length, 4, "the second failed chain also stops after two splits");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a stale anchor recovers on the first spawn: the fresh anchor is retried right once", async () => {
	const root = await makeTempRoot();
	const anchors = ["stale", "fresh"];
	const opens: { target: string; direction: PaneDirection }[] = [];
	const closes: string[] = [];
	let anchorCalls = 0;
	let next = 1;
	const multiplexer: PaneMultiplexer = {
		name: "fake",
		async anchor() {
			// An app restart: the cached pane id is stale, the fresh lookup differs.
			return anchors[Math.min(anchorCalls++, anchors.length - 1)];
		},
		async open(request: OpenPaneRequest): Promise<OpenedPane | undefined> {
			opens.push({ target: request.target, direction: request.direction });
			if (request.target === "stale") return undefined; // the old pane id is gone
			return { paneId: `fresh:p${next++}`, viewerStart: "started" };
		},
		async close(paneId: string) {
			closes.push(paneId);
			return true;
		},
	};
	const manager = makeManager(root, multiplexer);
	manager.open("worker", "worker-ab12");
	await settleChain();
	assert.equal(anchorCalls, 2, "the anchor is resolved once, then looked up again after both splits failed");
	assert.deepEqual(
		opens,
		[
			{ target: "stale", direction: "right" },
			{ target: "stale", direction: "right" },
			{ target: "fresh", direction: "right" },
		],
		"three attempts: the placement split, the anchor-right fallback, the fresh-anchor retry",
	);
	const last = opens[opens.length - 1];
	assert.equal(last.target, "fresh");
	assert.equal(last.direction, "right");
	// The retry succeeded: the pane is recorded, so closeAll closes it.
	manager.closeAll();
	assert.deepEqual(closes, ["fresh:p1"], "the recovered pane is recorded and closed");
	await rm(root, { recursive: true, force: true });
});

test("an unavailable anchor skips the pane, stops the server, and is retried by the next spawn", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { multiplexer, state } = fakeMux({ anchorResults: [undefined, "w1:p1"] });
	const manager = makeManager(root, multiplexer, { log: (m: string) => messages.push(m) });

	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	assert.equal(state.anchors, 1);
	assert.equal(state.opens.length, 0, "no split without an anchor");
	assert.ok(messages.some((m) => /no fake anchor pane/.test(m)), "the missing anchor is logged");
	relay.settle(settledPayload());
	relay.relay(activity("safe"));
	relay.stop();
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
		200,
	);
	assert.equal(client, undefined, "the skipped pane has no server");

	// The failed lookup was not cached: the next spawn resolves the anchor and splits.
	manager.open("scout", "scout-cd34");
	await settleChain();
	assert.equal(state.anchors, 2);
	assert.equal(state.opens.length, 1);
	assert.equal(state.opens[0].target, "w1:p1");
	assert.equal(state.opens[0].direction, "right");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("an anchor lookup that throws is treated as unavailable, never as a spawn failure", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { multiplexer, state } = fakeMux({ anchorThrows: true });
	const manager = makeManager(root, multiplexer, { log: (m: string) => messages.push(m) });
	manager.open("worker", "worker-ab12");
	await settleChain();
	assert.equal(state.opens.length, 0);
	assert.ok(messages.length >= 1);
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a failing viewer keeps the server live: a later viewer still gets the stream", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { multiplexer, state } = fakeMux({ viewerFails: true, labelDiagnostic: false });
	const manager = makeManager(root, multiplexer, { log: (m: string) => messages.push(m) });
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	assert.equal(state.opens.length, 1); // the pane exists even though the viewer did not start
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
	);
	assert.ok(client, "the server is still live for a later-attaching viewer");
	await client.waitFor((events) => events.length >= 1);
	assert.equal(client.events[0].type, "hello");
	relay.relay(activity("viewerless but live"));
	await client.waitFor((events) => events.some((e) => e.type === "activity"));
	client.destroy();
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("settle sends a settled event whose reportPreview is capped at the relay cap", async () => {
	const root = await makeTempRoot();
	const { multiplexer } = fakeMux();
	const manager = makeManager(root, multiplexer);
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
	);
	assert.ok(client);
	await client.waitFor((events) => events.length >= 1);
	const report = "# report\n" + "y".repeat(PANE_REPORT_PREVIEW_CHARS * 3);
	relay.settle(settledPayload({ modelUsed: "anthropic/claude-x", cost: 1.25, totalTokens: 4321, report }));
	await client.waitFor((events) => events.some((e) => e.type === "settled"));
	const settled = client.events.find((e) => e.type === "settled") as {
		status: string;
		modelUsed?: string;
		cost?: number;
		totalTokens?: number;
		reportPreview?: string;
		diagnostics: string[];
		closeDelayMs: number;
	};
	assert.equal(settled.status, "completed");
	assert.equal(settled.modelUsed, "anthropic/claude-x");
	assert.equal(settled.cost, 1.25);
	assert.equal(settled.totalTokens, 4321);
	assert.equal(settled.closeDelayMs, 50); // from the manager's closeDelayMs option
	assert.ok(settled.reportPreview !== undefined);
	assert.equal(settled.reportPreview!.length, PANE_REPORT_PREVIEW_CHARS + 1); // capped head + ellipsis
	assert.ok(settled.reportPreview!.startsWith("# report\n"));
	assert.ok(settled.reportPreview!.endsWith("\u2026"));
	client.destroy();
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a relay settled after its server stopped cannot resurrect it", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux({ failSplit: true });
	const manager = makeManager(root, multiplexer);
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	relay.settle(settledPayload()); // the server already stopped (split failed)
	relay.relay(activity("after stop"));
	relay.stop();
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
		200,
	);
	assert.equal(client, undefined, "no socket was recreated by a post-stop settle");
	assert.ok(state.opens.length === 2);
	await rm(root, { recursive: true, force: true });
});

test("closeAll stops every open server and unlinks their socket files", async () => {
	const root = await makeTempRoot();
	const { multiplexer } = fakeMux();
	const manager = makeManager(root, multiplexer);
	const relay1 = manager.open("worker", "worker-ab12")!;
	const relay2 = manager.open("scout", "scout-cd34")!;
	await settleChain();
	const path1 = paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" });
	const path2 = paneSocketPath({ root, sessionId: "sess-1", spawnId: "scout-cd34" });
	const client = await connectClient(path1);
	assert.ok(client);
	await client.waitFor((events) => events.length >= 1);
	manager.closeAll();
	manager.closeAll(); // idempotent
	// closeAll destroys the client connection and unlinks the sockets.
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.ok(!existsSync(path1), "first socket unlinked");
	assert.ok(!existsSync(path2), "second socket unlinked");
	client.destroy();
	void relay1;
	void relay2;
	await rm(root, { recursive: true, force: true });
});

test("settle closes the pane itself after the countdown: the manager owns the pane close (ADR 0001)", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux();
	const manager = makeManager(root, multiplexer); // closeDelayMs: 50
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	assert.equal(state.closes.length, 0, "no close before settle");
	relay.settle(settledPayload());
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(state.closes, ["fake:p1"], "the backstop closed the pane after the countdown");
	assert.ok(!existsSync(paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" })), "the server stopped too");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("closeAll closes every open pane, not just its servers (session_shutdown)", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux();
	const manager = makeManager(root, multiplexer);
	manager.open("worker", "worker-ab12");
	manager.open("scout", "scout-cd34");
	await settleChain();
	assert.equal(state.closes.length, 0);
	manager.closeAll();
	assert.deepEqual(state.closes.sort(), ["fake:p1", "fake:p2"], "every open pane is closed");
	await rm(root, { recursive: true, force: true });
});

test("a relay stopped before settle never closes a pane later", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux();
	const manager = makeManager(root, multiplexer);
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	relay.settle(settledPayload());
	relay.stop(); // the run was cancelled before the countdown ran out
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(state.closes.length, 0, "a stopped entry's backstop close is cancelled");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a viewerless pane (failed viewer start) still closes after the settle countdown", async () => {
	const root = await makeTempRoot();
	const { multiplexer, state } = fakeMux({ viewerFails: true });
	const manager = makeManager(root, multiplexer);
	const relay = manager.open("worker", "worker-ab12")!;
	relay.settle(settledPayload()); // the run ended while the chain was still running
	await settleChain();
	assert.equal(state.opens.length, 1);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(state.closes, ["fake:p1"], "the viewerless pane is closed by the backstop");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("an adapter diagnostic (failed pane label) is logged and the chain still succeeds", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { multiplexer, state } = fakeMux({ labelDiagnostic: true });
	const manager = makeManager(root, multiplexer, { log: (m: string) => messages.push(m) });
	const relay = manager.open("scout", "scout-cd34")!;
	await settleChain();
	assert.equal(state.opens.length, 1);
	assert.ok(messages.some((m) => /rename failed/.test(m)), "the adapter diagnostic is logged");
	relay.stop();
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a spawn's relay and settle reach the pane, then the pane closes after the countdown", async () => {
	const root = await makeTempRoot();
	const { multiplexer } = fakeMux();
	const manager = makeManager(root, multiplexer); // closeDelayMs: 50
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
	);
	assert.ok(client);
	await client.waitFor((events) => events.length >= 1);
	relay.relay(activity("doing work"));
	await client.waitFor((events) => events.some((e) => e.type === "activity"));
	relay.settle(settledPayload({ report: "all done" }));
	await client.waitFor((events) => events.some((e) => e.type === "settled"));
	const settled = client.events.find((e) => e.type === "settled") as {
		reportPreview?: string;
		closeDelayMs: number;
	};
	assert.equal(settled.reportPreview, "all done"); // short reports pass through uncapped
	assert.equal(settled.closeDelayMs, 50);
	// The countdown closes the pane: the viewer's socket ends and the file vanishes.
	const eof = client.waitForEnd();
	await eof;
	const sockPath = paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" });
	assert.ok(!existsSync(sockPath), "socket unlinked after the close countdown");
	await rm(root, { recursive: true, force: true });
});

test("open truncates the task preview to 200 characters in the hello event", async () => {
	const root = await makeTempRoot();
	const { multiplexer } = fakeMux();
	const manager = makeManager(root, multiplexer);
	const longTask = `t${"x".repeat(500)}`;
	const relay = manager.open("worker", "worker-ab12", longTask)!;
	await settleChain();
	const client = await connectClient(
		paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" }),
	);
	assert.ok(client);
	await client.waitFor((events) => events.length >= 1);
	assert.equal(client.events[0].type, "hello");
	assert.equal((client.events[0] as { taskPreview?: string }).taskPreview, `t${"x".repeat(199)}`);
	client.destroy();
	relay.stop();
	await rm(root, { recursive: true, force: true });
});
