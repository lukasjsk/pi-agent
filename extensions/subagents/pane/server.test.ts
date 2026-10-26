// server.test.ts — ADR 0001 pane event server, tested with real unix sockets in a
// temp dir: hello-on-connect, activity coalescing, settle + late clients, stop
// semantics. Timers are kept small (50ms) so the suite stays fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PaneEventServer, paneSocketPath } from "./server.ts";
import { decodePaneEvent, type PaneEvent } from "./protocol.ts";

/** A test pane viewer: connects to the socket and decodes events in arrival order. */
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

	/** Poll until the predicate holds or the timeout expires (test failure). */
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
	end(): Promise<void> {
		return new Promise((resolve) => this.sock.once("end", () => resolve()));
	}

	destroy(): void {
		this.sock.destroy();
	}
}

/**
 * Connect a Client. The bind happens asynchronously inside start(), so the socket
 * file may not exist yet: retry briefly until the connect succeeds. The data
 * listener is attached before the socket is established, so the hello is never lost.
 */
async function connectClient(path: string, timeoutMs = 2000): Promise<Client> {
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
		} catch (error) {
			if (Date.now() - start > timeoutMs) throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

async function makeTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pane-server-"));
}

/** A minimal SubagentActivity snapshot; activity events coalesce to the latest. */
function activity(progress: string) {
	return { progress, toolCalls: [], contentLines: [progress] };
}

function makeServer(root: string, over: Record<string, unknown> = {}): { server: PaneEventServer; path: string } {
	const path = paneSocketPath({ root, spawnId: "worker-ab12" });
	const server = new PaneEventServer({ socketPath: path, agent: "worker", spawnId: "worker-ab12", ...over });
	server.start();
	return { server, path };
}

test("paneSocketPath is session-scoped and degrades to 'unknown' without a session id", () => {
	assert.equal(
		paneSocketPath({ root: "/tmp/x", sessionId: "sess-1", spawnId: "worker-ab12" }),
		"/tmp/x/pi-subagent-panes/sess-1/worker-ab12.sock",
	);
	assert.equal(
		paneSocketPath({ root: "/tmp/x", spawnId: "worker-ab12" }),
		"/tmp/x/pi-subagent-panes/unknown/worker-ab12.sock",
	);
});

test("a connecting pane viewer receives the hello event first", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { taskPreview: "recon the repo" });
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	assert.equal(client.events[0].type, "hello");
	assert.deepEqual(client.events[0], { type: "hello", agent: "worker", spawnId: "worker-ab12", taskPreview: "recon the repo" });
	assert.equal(server.connectedClients, 1);
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("start() removes a stale socket file left by a dead process, so a viewer can connect", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root);
	// makeServer already started; use a second server for the stale-file case.
	const stalePath = paneSocketPath({ root, spawnId: "scout-dead" });
	await mkdir(dirname(stalePath), { recursive: true });
	await writeFile(stalePath, "stale");
	const stale = new PaneEventServer({ socketPath: stalePath, agent: "scout", spawnId: "scout-dead" });
	stale.start();
	const client = await connectClient(stalePath);
	await client.waitFor((events) => events.length >= 1);
	assert.equal(client.events[0].type, "hello");
	client.destroy();
	stale.stop();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("relaying several activities within one flush window sends at most one — the latest", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50 });
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	server.relay(activity("first"));
	server.relay(activity("second"));
	server.relay(activity("third"));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const activities = client.events.filter((event) => event.type === "activity");
	assert.ok(activities.length <= 1, `expected at most one flushed activity, got ${activities.length}`);
	assert.equal(activities.length, 1);
	assert.equal(activities[0].progress, "third");
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("the activity relay maps the child model's context window into the wire event", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50 });
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	server.relay({ progress: "x", toolCalls: [], contentLines: [], tokens: { input: 900, output: 300 }, contextWindow: 200_000 });
	await new Promise((resolve) => setTimeout(resolve, 200));
	const activityEvents = client.events.filter((event) => event.type === "activity");
	assert.equal(activityEvents.length, 1);
	assert.equal((activityEvents[0] as { contextWindow?: number }).contextWindow, 200_000);
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

/** A minimal settled event; closeDelayMs is the viewer's countdown. */
function settled(status: "completed" | "failed" | "cancelled" = "completed") {
	return {
		type: "settled",
		status,
		diagnostics: [],
		closeDelayMs: 50,
	};
}

test("settle flushes hello, latest activity, then settled immediately to connected clients", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50, closeDelayMs: 50 });
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	server.relay(activity("working"));
	server.settle(settled());
	await client.waitFor((events) => events.some((e) => e.type === "settled"));
	// The settle flush replays hello + latest activity + settled in order.
	assert.equal(client.events[0].type, "hello");
	const settledIndex = client.events.findIndex((e) => e.type === "settled");
	const lastActivityBeforeSettle = client.events
		.slice(0, settledIndex)
		.filter((e) => e.type === "activity")
		.pop();
	assert.equal(lastActivityBeforeSettle?.progress, "working");
	assert.equal(client.events[settledIndex].type, "settled");
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("a viewer connecting after settle receives hello, the latest activity, then settled", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50, closeDelayMs: 15_000 });
	server.relay(activity("late-join"));
	server.settle(settled("failed"));
	const client = await connectClient(path);
	await client.waitFor((events) => events.some((e) => e.type === "settled"));
	assert.equal(client.events[0].type, "hello");
	const activityIndex = client.events.findIndex((e) => e.type === "activity");
	const settledIndex = client.events.findIndex((e) => e.type === "settled");
	assert.ok(activityIndex > 0 && settledIndex > activityIndex, "order hello, activity, settled");
	assert.equal(client.events[activityIndex].progress, "late-join");
	assert.equal(client.events[settledIndex].type, "settled");
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("settle arms the close delay, after which the server stops and clients see EOF", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50, closeDelayMs: 50 });
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	server.settle(settled());
	await client.end();
	assert.equal(server.connectedClients, 0);
	assert.ok(!existsSync(path), "socket file unlinked after the close delay");
	await rm(root, { recursive: true, force: true });
});

test("relays after settle are no-ops: no further activity events reach clients", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50, closeDelayMs: 15_000 });
	server.settle(settled());
	const client = await connectClient(path);
	await client.waitFor((events) => events.some((e) => e.type === "settled"));
	server.relay(activity("too late"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(client.events.every((e) => e.type !== "activity"), "no activity after settle");
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("a bind failure leaves the server silently inactive — no throw, no relay, no socket file", async () => {
	const root = await makeTempRoot();
	// A path beyond the unix socket path limit cannot bind: mkdir and listen both fail.
	const badPath = join(root, "pi-subagent-panes", "unknown", `${"x".repeat(200)}.sock`);
	const server = new PaneEventServer({ socketPath: badPath, agent: "worker", spawnId: "worker-ab12" });
	server.start(); // must not throw
	await new Promise((resolve) => setTimeout(resolve, 30)); // let the failed bind settle
	server.relay(activity("nowhere")); // no-op, must not throw
	assert.equal(server.connectedClients, 0);
	assert.ok(!existsSync(badPath), "no socket file created for an inactive server");
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("stop() ends client connections, unlinks the socket file, and is idempotent", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root);
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	const eof = client.end();
	server.stop();
	server.stop(); // idempotent: a second stop must not throw or change state
	await eof;
	assert.equal(server.connectedClients, 0);
	await new Promise((resolve) => setTimeout(resolve, 20)); // let the unlink settle
	assert.ok(!existsSync(path), "socket file unlinked by stop()");
	// Calls after stop are safe no-ops.
	server.relay(activity("post-stop"));
	server.settle(settled());
	server.stop();
	await rm(root, { recursive: true, force: true });
});

test("relays after a flush window elapses flush the new latest snapshot", async () => {
	const root = await makeTempRoot();
	const { server, path } = makeServer(root, { flushIntervalMs: 50 });
	const client = await connectClient(path);
	await client.waitFor((events) => events.length >= 1);
	server.relay(activity("first"));
	await client.waitFor((events) => events.some((e) => e.type === "activity"));
	server.relay(activity("after-window"));
	await client.waitFor((events) => events.filter((e) => e.type === "activity").length >= 2);
	const activities = client.events.filter((event) => event.type === "activity");
	assert.equal(activities[activities.length - 1].progress, "after-window");
	client.destroy();
	server.stop();
	await rm(root, { recursive: true, force: true });
});
