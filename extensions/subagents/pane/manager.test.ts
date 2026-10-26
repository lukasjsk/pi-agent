// manager.test.ts — ADR 0001 subagent pane manager: the synchronous open path
// returns a live relay immediately; the Herdr pane chain (split → rename → run)
// is async and best-effort. The Herdr control is a plain fake (structural typing);
// the pane event server is real, in a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SubagentPaneManager, type PaneRelay } from "./manager.ts";
import { paneSocketPath } from "./server.ts";
import { decodePaneEvent, PANE_REPORT_PREVIEW_CHARS, type PaneEvent } from "./protocol.ts";

type Direction = "right" | "down";

/** Fake HerdrPaneControl: a plain object with the pane methods, recording every call. */
function fakeHerdr(over: { failSplit?: boolean; runFails?: boolean; renameFails?: boolean; splitDelayMs?: number } = {}) {
	const state = {
		splits: [] as { paneId: string; direction: Direction; cwd: string }[],
		renames: [] as { paneId: string; label: string }[],
		runs: [] as { paneId: string; command: string }[],
		closes: [] as string[],
		next: 1,
	};
	return {
		state,
		control: {
			async split(paneId: string, direction: Direction, cwd: string) {
				state.splits.push({ paneId, direction, cwd });
				if (over.splitDelayMs) await new Promise((resolve) => setTimeout(resolve, over.splitDelayMs));
				if (over.failSplit) return undefined;
				return `fake:p${state.next++}`;
			},
			async rename(paneId: string, label: string) {
				state.renames.push({ paneId, label });
				return !over.renameFails;
			},
			async run(paneId: string, command: string) {
				state.runs.push({ paneId, command });
				return !over.runFails;
			},
			async close(paneId: string) {
				state.closes.push(paneId);
				return true;
			},
		},
	};
}

function makeManager(root: string, herdr: unknown, over: Record<string, unknown> = {}) {
	return new SubagentPaneManager({
		herdr,
		mainPaneId: "w1:p1",
		cwd: "/home/u/repo",
		sessionId: "sess-1",
		socketRoot: root,
		viewerCommand: (sockPath) => `pi pane-viewer --sock ${sockPath}`,
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

test("open returns a live relay synchronously: the first spawn splits the main pane right, the second stacks down", async () => {
	const root = await makeTempRoot();
	const { control, state } = fakeHerdr();
	const manager = makeManager(root, control);

	const relay = manager.open("worker", "worker-ab12", "implement the feature");
	assert.ok(relay, "a detected manager always returns a relay");
	assert.equal(relay!.spawnId, "worker-ab12");

	await settleChain();
	assert.deepEqual(state.splits, [{ paneId: "w1:p1", direction: "right", cwd: "/home/u/repo" }]);
	const sockPath = paneSocketPath({ root, sessionId: "sess-1", spawnId: "worker-ab12" });
	assert.deepEqual(state.renames, [{ paneId: "fake:p1", label: "worker" }]);
	assert.deepEqual(state.runs, [{ paneId: "fake:p1", command: `pi pane-viewer --sock ${sockPath}` }]);

	const relay2 = manager.open("scout", "scout-cd34");
	await settleChain();
	assert.deepEqual(state.splits[1], { paneId: "fake:p1", direction: "down", cwd: "/home/u/repo" });

	relay!.stop();
	relay2!.stop();
	await rm(root, { recursive: true, force: true });
});

test("parallel spawns stack: the second split targets the first subagent pane, not the main pane", async () => {
	const root = await makeTempRoot();
	const { control, state } = fakeHerdr({ splitDelayMs: 30 });
	const manager = makeManager(root, control);
	// Two spawns open in the same tick — before any split has answered.
	manager.open("worker", "worker-ab12");
	manager.open("scout", "scout-cd34");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(state.splits.length, 2);
	assert.deepEqual(state.splits[0], { paneId: "w1:p1", direction: "right", cwd: "/home/u/repo" }, "first spawn: right of the main pane");
	assert.deepEqual(state.splits[1], { paneId: "fake:p1", direction: "down", cwd: "/home/u/repo" }, "second spawn: down of the first subagent pane");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a failed split falls back to splitting the main pane right, then the relay no-ops safely", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { control, state } = fakeHerdr({ failSplit: true });
	const manager = makeManager(root, control, { log: (m: string) => messages.push(m) });
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	// Both split attempts targeted the main pane right; no rename, no viewer run.
	assert.deepEqual(state.splits, [
		{ paneId: "w1:p1", direction: "right", cwd: "/home/u/repo" },
		{ paneId: "w1:p1", direction: "right", cwd: "/home/u/repo" },
	]);
	assert.equal(state.renames.length, 0);
	assert.equal(state.runs.length, 0);
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
	// A later spawn still targets the main pane right (state did not advance).
	manager.open("scout", "scout-cd34")!;
	await settleChain();
	assert.equal(state.splits[2].paneId, "w1:p1");
	assert.equal(state.splits[2].direction, "right");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a failing viewer run keeps the server live: a later viewer still gets the stream", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { control, state } = fakeHerdr({ runFails: true });
	const manager = makeManager(root, control, { log: (m: string) => messages.push(m) });
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	assert.equal(state.splits.length, 1); // the pane exists even though the viewer did not start
	assert.ok(messages.length >= 1, "the viewer failure is logged");
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
	const { control } = fakeHerdr();
	const manager = makeManager(root, control);
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
	const { control, state } = fakeHerdr({ failSplit: true });
	const manager = makeManager(root, control);
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
	assert.ok(state.splits.length === 2);
	await rm(root, { recursive: true, force: true });
});

test("closeAll stops every open server and unlinks their socket files", async () => {
	const root = await makeTempRoot();
	const { control } = fakeHerdr();
	const manager = makeManager(root, control);
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
	const { control, state } = fakeHerdr();
	const manager = makeManager(root, control); // closeDelayMs: 50
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
	const { control, state } = fakeHerdr();
	const manager = makeManager(root, control);
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
	const { control, state } = fakeHerdr();
	const manager = makeManager(root, control);
	const relay = manager.open("worker", "worker-ab12")!;
	await settleChain();
	relay.settle(settledPayload());
	relay.stop(); // the run was cancelled before the countdown ran out
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(state.closes.length, 0, "a stopped entry's backstop close is cancelled");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a viewerless pane (failed run) still closes after the settle countdown", async () => {
	const root = await makeTempRoot();
	const { control, state } = fakeHerdr({ runFails: true });
	const manager = makeManager(root, control);
	const relay = manager.open("worker", "worker-ab12")!;
	relay.settle(settledPayload()); // the run ended while the chain was still running
	await settleChain();
	assert.equal(state.runs.length, 1);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(state.closes, ["fake:p1"], "the viewerless pane is closed by the backstop");
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a failing rename is logged but the chain continues: the viewer still starts", async () => {
	const root = await makeTempRoot();
	const messages: string[] = [];
	const { control, state } = fakeHerdr({ renameFails: true });
	const manager = makeManager(root, control, { log: (m: string) => messages.push(m) });
	const relay = manager.open("scout", "scout-cd34")!;
	await settleChain();
	assert.equal(state.renames.length, 1);
	assert.ok(messages.length >= 1, "the rename failure is logged");
	assert.equal(state.runs.length, 1, "the viewer is started despite the rename failure");
	relay.stop();
	manager.closeAll();
	await rm(root, { recursive: true, force: true });
});

test("a spawn's relay and settle reach the pane, then the pane closes after the countdown", async () => {
	const root = await makeTempRoot();
	const { control } = fakeHerdr();
	const manager = makeManager(root, control); // closeDelayMs: 50
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
	const { control } = fakeHerdr();
	const manager = makeManager(root, control);
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
