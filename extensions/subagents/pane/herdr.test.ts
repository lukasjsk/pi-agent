// herdr.test.ts — ADR 0001 Herdr pane control, tested at the pure seams: env
// detection, placement, argv builders, split-JSON parsing, and the control class
// against a stubbed CliRunner.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliRunner } from "../cli.ts";
import {
	HerdrPaneControl,
	detectHerdr,
	paneCloseArgs,
	paneRenameArgs,
	paneRunArgs,
	paneSplitArgs,
	parseSplitPaneId,
	splitTarget,
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

test("detectHerdr detects inside Herdr and reads the binary path and main pane id", () => {
	assert.deepEqual(
		detectHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/opt/herdr/bin/herdr" }),
		{ detected: true, bin: "/opt/herdr/bin/herdr", mainPaneId: "w1:p1" },
	);
});

test("detectHerdr falls back to the PATH name 'herdr' without HERDR_BIN_PATH", () => {
	assert.deepEqual(detectHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" }), {
		detected: true,
		bin: "herdr",
		mainPaneId: "w1:p2",
	});
});

test("detectHerdr does not detect without HERDR_ENV === '1'", () => {
	assert.equal(detectHerdr({ HERDR_PANE_ID: "w1:p1" }), undefined);
	assert.equal(detectHerdr({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" }), undefined);
	assert.equal(detectHerdr({ HERDR_ENV: "1" }), undefined);
	assert.equal(detectHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "" }), undefined);
	assert.equal(detectHerdr({}), undefined);
});

test("splitTarget: the first spawn goes right of the main pane", () => {
	assert.deepEqual(splitTarget({ lastSubagentPaneId: undefined }, "w1:p1"), {
		paneId: "w1:p1",
		direction: "right",
	});
});

test("splitTarget: later spawns stack down of the last subagent pane", () => {
	assert.deepEqual(splitTarget({ lastSubagentPaneId: "w1:p3" }, "w1:p1"), {
		paneId: "w1:p3",
		direction: "down",
	});
});

test("splitTarget: after a failed open the state is unchanged, so the next spawn retargets the main pane right", () => {
	// The manager advances state only on successful splits, so a failed open leaves
	// the state undefined and the placement is identical to the first spawn.
	const state = { lastSubagentPaneId: undefined as string | undefined };
	assert.deepEqual(splitTarget(state, "w1:p1"), { paneId: "w1:p1", direction: "right" });
	assert.deepEqual(splitTarget(state, "w1:p1"), { paneId: "w1:p1", direction: "right" });
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

test("HerdrPaneControl.split runs the split argv via the injected runner and returns the new pane id", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7" } } }), stderr: "", code: 0 },
	]);
	const control = new HerdrPaneControl({ bin: "/opt/herdr/bin/herdr", runner });
	assert.equal(await control.split("w1:p1", "right", "/tmp/w"), "w1:p7");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "/opt/herdr/bin/herdr");
	assert.deepEqual(calls[0].args, ["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/tmp/w"]);
});

test("HerdrPaneControl.split returns undefined on non-zero exit, bad JSON, or a missing field — it never throws", async () => {
	const bad = (r: { stdout: string; stderr: string; code: number }) =>
		new HerdrPaneControl({ bin: "herdr", runner: fakeRunner([r]).runner });
	assert.equal(await bad({ stdout: "", stderr: "boom", code: 1 }).split("p", "right", "/"), undefined);
	assert.equal(await bad({ stdout: "not json", stderr: "", code: 0 }).split("p", "right", "/"), undefined);
	assert.equal(
		await bad({ stdout: JSON.stringify({ result: { pane: {} } }), stderr: "", code: 0 }).split("p", "right", "/"),
		undefined,
	);
	const throwing: CliRunner = { run: async () => {
		throw new Error("runner exploded");
	} };
	assert.equal(await new HerdrPaneControl({ bin: "herdr", runner: throwing }).split("p", "right", "/"), undefined);
});

test("HerdrPaneControl.run/rename/close report success only on exit code 0 and use the exact argv", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: "", stderr: "denied", code: 2 },
	]);
	const control = new HerdrPaneControl({ bin: "herdr", runner });
	assert.equal(await control.run("w1:p2", "pi pane-viewer --sock /s"), true);
	assert.equal(await control.rename("w1:p2", "scout"), true);
	assert.equal(await control.close("w1:p2"), true);
	assert.deepEqual(calls.map((c) => c.args), [
		["pane", "run", "w1:p2", "pi pane-viewer --sock /s"],
		["pane", "rename", "w1:p2", "scout"],
		["pane", "close", "w1:p2"],
	]);
	const failing = fakeRunner([{ stdout: "", stderr: "", code: 1 }]);
	assert.equal(await new HerdrPaneControl({ bin: "herdr", runner: failing.runner }).close("w1:p2"), false);
});
