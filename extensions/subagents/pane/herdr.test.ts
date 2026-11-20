// herdr.test.ts — ADR 0001 Herdr TUI adapter, tested at the pure seams: env
// detection, argv builders, split-JSON parsing, and the adapter against a
// stubbed CliRunner. Placement policy lives in placement.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliRunner } from "../cli.ts";
import {
	HerdrTuiMultiplexer,
	detectHerdrTui,
	paneCloseArgs,
	paneRenameArgs,
	paneRunArgs,
	paneSplitArgs,
	parseSplitPaneId,
} from "./herdr.ts";

/** A CliRunner stub that records argv and replays queued results. */
function fakeRunner(results: { stdout: string; stderr: string; code: number }[]): {
	runner: CliRunner;
	calls: { bin: string; args: readonly string[] }[];
} {
	const calls: { bin: string; args: readonly string[] }[] = [];
	let i = 0;
	return {
		calls,
		runner: {
			async run(bin, args, _signal) {
				calls.push({ bin, args });
				return results[Math.min(i++, results.length - 1)] ?? { stdout: "", stderr: "", code: 0 };
			},
		},
	};
}

const viewer = { argv: ["/opt/bin/bun", "/repo/extensions/subagents/pane/viewer.ts", "--socket", "/tmp/a b.sock"] };

test("detectHerdrTui detects inside the TUI and reads the binary path and main pane id", () => {
	assert.deepEqual(
		detectHerdrTui({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/opt/herdr/bin/herdr" }),
		{ bin: "/opt/herdr/bin/herdr", mainPaneId: "w1:p1" },
	);
});

test("detectHerdrTui falls back to the PATH name 'herdr' without HERDR_BIN_PATH", () => {
	assert.deepEqual(detectHerdrTui({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" }), {
		bin: "herdr",
		mainPaneId: "w1:p2",
	});
});

test("detectHerdrTui does not detect without HERDR_ENV === '1'", () => {
	assert.equal(detectHerdrTui({ HERDR_PANE_ID: "w1:p1" }), undefined);
	assert.equal(detectHerdrTui({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" }), undefined);
	assert.equal(detectHerdrTui({ HERDR_ENV: "1" }), undefined);
	assert.equal(detectHerdrTui({ HERDR_ENV: "1", HERDR_PANE_ID: "" }), undefined);
	assert.equal(detectHerdrTui({}), undefined);
});

test("paneSplitArgs builds the exact argv after the binary (no shell)", () => {
	assert.deepEqual(paneSplitArgs("w1:p1", "right", "/home/u/repo"), [
		"pane",
		"split",
		"w1:p1",
		"--direction",
		"right",
		"--cwd",
		"/home/u/repo",
	]);
	assert.deepEqual(paneSplitArgs("w1:p2", "down", "/tmp"), [
		"pane",
		"split",
		"w1:p2",
		"--direction",
		"down",
		"--cwd",
		"/tmp",
	]);
});

test("paneRunArgs passes the command as a single argv token", () => {
	assert.deepEqual(paneRunArgs("w1:p3", "pi pane-viewer --sock /tmp/x.sock"), [
		"pane",
		"run",
		"w1:p3",
		"pi pane-viewer --sock /tmp/x.sock",
	]);
});

test("paneRenameArgs labels the pane with the agent name", () => {
	assert.deepEqual(paneRenameArgs("w1:p3", "worker"), ["pane", "rename", "w1:p3", "worker"]);
});

test("paneCloseArgs closes the pane", () => {
	assert.deepEqual(paneCloseArgs("w1:p3"), ["pane", "close", "w1:p3"]);
});

test("parseSplitPaneId reads .result.pane.pane_id from the split JSON", () => {
	const stdout = JSON.stringify({ result: { pane: { pane_id: "w1:p5" } } });
	assert.equal(parseSplitPaneId(stdout), "w1:p5");
});

test("parseSplitPaneId tolerates surrounding output and extra nested fields", () => {
	const stdout = `{
  "ok": true,
  "result": { "pane": { "pane_id": "w1:p9", "tab_id": "w1", "direction": "down" }, "echoed": "split" }
}
`;
	assert.equal(parseSplitPaneId(stdout), "w1:p9");
});

test("parseSplitPaneId returns undefined on malformed JSON or a missing/non-string pane_id", () => {
	assert.equal(parseSplitPaneId("not json at all"), undefined);
	assert.equal(parseSplitPaneId(JSON.stringify({ result: {} })), undefined);
	assert.equal(parseSplitPaneId(JSON.stringify({ result: { pane: {} } })), undefined);
	assert.equal(parseSplitPaneId(JSON.stringify({ result: { pane: { pane_id: 42 } } })), undefined);
	assert.equal(parseSplitPaneId(JSON.stringify({})), undefined);
	assert.equal(parseSplitPaneId(""), undefined);
});

test("anchor returns the injected main pane id", async () => {
	const multiplexer = new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1" });
	assert.equal(await multiplexer.anchor(), "w1:p1");
});

test("open runs split, rename, then the viewer as one quoted command line", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7" } } }), stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
	]);
	const multiplexer = new HerdrTuiMultiplexer({ bin: "/opt/herdr/bin/herdr", mainPaneId: "w1:p1", runner });
	const opened = await multiplexer.open({
		target: "w1:p1",
		direction: "right",
		cwd: "/tmp/w",
		label: "worker",
		viewer,
	});
	assert.deepEqual(opened, { paneId: "w1:p7", viewerStarted: true });
	assert.equal(calls.length, 3);
	assert.equal(calls[0].bin, "/opt/herdr/bin/herdr");
	assert.deepEqual(calls[0].args, ["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/tmp/w"]);
	assert.deepEqual(calls[1].args, ["pane", "rename", "w1:p7", "worker"]);
	assert.deepEqual(calls[2].args, [
		"pane",
		"run",
		"w1:p7",
		'"/opt/bin/bun" "/repo/extensions/subagents/pane/viewer.ts" "--socket" "/tmp/a b.sock"',
	]);
});

test("open returns undefined when the split fails: no rename and no viewer run", async () => {
	const { runner, calls } = fakeRunner([{ stdout: "", stderr: "boom", code: 1 }]);
	const multiplexer = new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner });
	const opened = await multiplexer.open({
		target: "w1:p1",
		direction: "right",
		cwd: "/tmp",
		label: "worker",
		viewer,
	});
	assert.equal(opened, undefined);
	assert.equal(calls.length, 1, "only the split was attempted");
});

test("open reports a failed rename as a diagnostic but still starts the viewer", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7" } } }), stderr: "", code: 0 },
		{ stdout: "", stderr: "denied", code: 2 },
		{ stdout: "", stderr: "", code: 0 },
	]);
	const multiplexer = new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner });
	const opened = await multiplexer.open({
		target: "w1:p1",
		direction: "right",
		cwd: "/tmp",
		label: "scout",
		viewer,
	});
	assert.equal(opened?.paneId, "w1:p7");
	assert.equal(opened?.viewerStarted, true);
	assert.equal(opened?.diagnostics?.length, 1);
	assert.match(String(opened?.diagnostics?.[0]), /rename failed/);
	assert.equal(calls.length, 3);
});

test("open reports a failed viewer run with viewerStarted false so the manager can keep the server live", async () => {
	const { runner } = fakeRunner([
		{ stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7" } } }), stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "no shell", code: 1 },
	]);
	const multiplexer = new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner });
	const opened = await multiplexer.open({
		target: "w1:p1",
		direction: "right",
		cwd: "/tmp",
		label: "worker",
		viewer,
	});
	assert.equal(opened?.paneId, "w1:p7");
	assert.equal(opened?.viewerStarted, false);
	assert.match(String(opened?.diagnostics?.[0]), /viewer start failed/);
});

test("split returns undefined on non-zero exit, bad JSON, or a missing field — it never throws", async () => {
	const bad = (r: { stdout: string; stderr: string; code: number }) =>
		new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner: fakeRunner([r]).runner });
	assert.equal(await bad({ stdout: "", stderr: "boom", code: 1 }).split("p", "right", "/"), undefined);
	assert.equal(await bad({ stdout: "not json", stderr: "", code: 0 }).split("p", "right", "/"), undefined);
	assert.equal(
		await bad({ stdout: JSON.stringify({ result: { pane: {} } }), stderr: "", code: 0 }).split("p", "right", "/"),
		undefined,
	);
	const throwing: CliRunner = {
		run: async () => {
			throw new Error("runner exploded");
		},
	};
	assert.equal(
		await new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner: throwing }).split("p", "right", "/"),
		undefined,
	);
});

test("run/rename/close report success only on exit code 0 and use the exact argv", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "denied", code: 2 },
	]);
	const multiplexer = new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner });
	assert.equal(await multiplexer.run("w1:p2", "pi pane-viewer --sock /s"), true);
	assert.equal(await multiplexer.rename("w1:p2", "scout"), true);
	assert.equal(await multiplexer.close("w1:p2"), true);
	assert.deepEqual(calls.map((c) => c.args), [
		["pane", "run", "w1:p2", "pi pane-viewer --sock /s"],
		["pane", "rename", "w1:p2", "scout"],
		["pane", "close", "w1:p2"],
	]);
	const failing = fakeRunner([{ stdout: "", stderr: "", code: 1 }]);
	assert.equal(
		await new HerdrTuiMultiplexer({ bin: "herdr", mainPaneId: "w1:p1", runner: failing.runner }).close("w1:p2"),
		false,
	);
});
