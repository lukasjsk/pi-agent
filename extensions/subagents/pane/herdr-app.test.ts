// herdr-app.test.ts — ADR 0001 Herdr desktop-app adapter, tested at the pure
// seams: env detection, argv builders, `ls` / split JSON parsing, and the adapter
// against a stubbed CliRunner. The app has no pane rename; the viewer sets the
// terminal title so its pane header shows the agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliRunner } from "../cli.ts";
import {
	HerdrAppMultiplexer,
	appCloseArgs,
	appListArgs,
	appSplitArgs,
	detectHerdrApp,
	parseAppSplitPaneId,
	parseTerminalPaneId,
} from "./herdr-app.ts";

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

test("detectHerdrApp detects an app terminal from HC_TERMINAL_ID and falls back to 'herdr-app'", () => {
	assert.deepEqual(detectHerdrApp({ HC_TERMINAL_ID: "t8" }), { bin: "herdr-app", terminalId: "t8" });
	assert.deepEqual(detectHerdrApp({ HC_TERMINAL_ID: "t8", HERDR_APP_BIN: "/opt/herdr-app" }), {
		bin: "/opt/herdr-app",
		terminalId: "t8",
	});
});

test("detectHerdrApp does not detect without HC_TERMINAL_ID or inside the TUI", () => {
	assert.equal(detectHerdrApp({}), undefined);
	assert.equal(detectHerdrApp({ HC_TERMINAL_ID: "" }), undefined);
	assert.equal(detectHerdrApp({ HC_TERMINAL_ID: "t8", HERDR_ENV: "1" }), undefined);
});

test("appListArgs, appSplitArgs, and appCloseArgs build the exact argv", () => {
	assert.deepEqual(appListArgs(), ["ls"]);
	assert.deepEqual(appSplitArgs("p12", "right", viewer.argv), [
		"do",
		"pane.split",
		"--direction",
		"right",
		"--pane",
		"p12",
		"--argv",
		JSON.stringify(viewer.argv),
	]);
	assert.deepEqual(appSplitArgs("p13", "down", ["bun", "viewer.ts"]), [
		"do",
		"pane.split",
		"--direction",
		"down",
		"--pane",
		"p13",
		"--argv",
		'["bun","viewer.ts"]',
	]);
	assert.deepEqual(appCloseArgs("p12"), ["do", "pane.close", "--pane", "p12"]);
});

test("parseTerminalPaneId finds this terminal's pane in the nested ls layout", () => {
	const stdout = JSON.stringify({
		spaces: [
			{ tabs: [{ terminals: [{ terminal: "t1", pane: "p1" }] }] },
			{
				tabs: [
					{ terminals: [{ terminal: "t4", pane: "p4" }] },
					{ terminals: [{ terminal: "t8", pane: "p8" }] },
				],
			},
		],
	});
	assert.equal(parseTerminalPaneId(stdout, "t8"), "p8");
	assert.equal(parseTerminalPaneId(stdout, "t9"), undefined);
});

test("parseTerminalPaneId returns undefined on malformed JSON or a missing pane", () => {
	assert.equal(parseTerminalPaneId("not json", "t8"), undefined);
	assert.equal(parseTerminalPaneId(JSON.stringify({}), "t8"), undefined);
	assert.equal(parseTerminalPaneId(JSON.stringify({ spaces: {} }), "t8"), undefined);
	assert.equal(
		parseTerminalPaneId(JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t8" }] }] }] }), "t8"),
		undefined,
	);
});

test("parseAppSplitPaneId reads the pane from the app's split reply", () => {
	assert.equal(parseAppSplitPaneId(JSON.stringify({ pane: "p9", terminal: "t9" })), "p9");
	assert.equal(parseAppSplitPaneId(JSON.stringify({ error: "no pane" })), undefined);
	assert.equal(parseAppSplitPaneId(JSON.stringify({ pane: 9 })), undefined);
	assert.equal(parseAppSplitPaneId("not json"), undefined);
});

test("anchor runs 'herdr-app ls' and resolves the orchestrator pane", async () => {
	const { runner, calls } = fakeRunner([
		{
			stdout: JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t8", pane: "p8" }] }] }] }),
			stderr: "",
			code: 0,
		},
	]);
	const multiplexer = new HerdrAppMultiplexer({ bin: "/opt/herdr-app", terminalId: "t8", runner });
	assert.equal(await multiplexer.anchor(), "p8");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "/opt/herdr-app");
	assert.deepEqual(calls[0].args, ["ls"]);
});

test("anchor is undefined when ls fails, is malformed, or the runner throws", async () => {
	const failing = new HerdrAppMultiplexer({
		bin: "herdr-app",
		terminalId: "t8",
		runner: fakeRunner([{ stdout: "", stderr: "no window", code: 1 }]).runner,
	});
	assert.equal(await failing.anchor(), undefined);

	const malformed = new HerdrAppMultiplexer({
		bin: "herdr-app",
		terminalId: "t8",
		runner: fakeRunner([{ stdout: "not json", stderr: "", code: 0 }]).runner,
	});
	assert.equal(await malformed.anchor(), undefined);

	const throwing: CliRunner = {
		run: async () => {
			throw new Error("runner exploded");
		},
	};
	assert.equal(
		await new HerdrAppMultiplexer({ bin: "herdr-app", terminalId: "t8", runner: throwing }).anchor(),
		undefined,
	);
});

test("open splits the target pane with the viewer argv and reports the pane with an unknown viewer start", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: JSON.stringify({ pane: "p9", terminal: "t9" }), stderr: "", code: 0 },
	]);
	const multiplexer = new HerdrAppMultiplexer({ bin: "/opt/herdr-app", terminalId: "t8", runner });
	const opened = await multiplexer.open({
		target: "p8",
		direction: "right",
		cwd: "/repo",
		label: "worker",
		viewer,
	});
	assert.deepEqual(opened, { paneId: "p9", viewerStart: "unknown" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "/opt/herdr-app");
	assert.deepEqual(calls[0].args, appSplitArgs("p8", "right", viewer.argv));
});

test("open returns undefined when the split fails, the reply is malformed, or the runner throws", async () => {
	const failing = new HerdrAppMultiplexer({
		bin: "herdr-app",
		terminalId: "t8",
		runner: fakeRunner([{ stdout: JSON.stringify({ error: "no pane" }), stderr: "", code: 1 }]).runner,
	});
	assert.equal(
		await failing.open({ target: "p8", direction: "right", cwd: "/repo", label: "worker", viewer }),
		undefined,
	);

	const malformed = new HerdrAppMultiplexer({
		bin: "herdr-app",
		terminalId: "t8",
		runner: fakeRunner([{ stdout: "not json", stderr: "", code: 0 }]).runner,
	});
	assert.equal(
		await malformed.open({ target: "p8", direction: "right", cwd: "/repo", label: "worker", viewer }),
		undefined,
	);

	const throwing: CliRunner = {
		run: async () => {
			throw new Error("runner exploded");
		},
	};
	assert.equal(
		await new HerdrAppMultiplexer({ bin: "herdr-app", terminalId: "t8", runner: throwing }).open({
			target: "p8",
			direction: "right",
			cwd: "/repo",
			label: "worker",
			viewer,
		}),
		undefined,
	);
});

test("close reports success only on exit code 0 and uses the exact argv", async () => {
	const { runner, calls } = fakeRunner([
		{ stdout: "", stderr: "", code: 0 },
		{ stdout: JSON.stringify({ error: "no pane" }), stderr: "", code: 1 },
	]);
	const multiplexer = new HerdrAppMultiplexer({ bin: "/opt/herdr-app", terminalId: "t8", runner });
	assert.equal(await multiplexer.close("p9"), true);
	assert.deepEqual(calls[0].args, ["do", "pane.close", "--pane", "p9"]);
	assert.equal(await multiplexer.close("p9"), false);

	const throwing: CliRunner = {
		run: async () => {
			throw new Error("runner exploded");
		},
	};
	assert.equal(
		await new HerdrAppMultiplexer({ bin: "herdr-app", terminalId: "t8", runner: throwing }).close("p9"),
		false,
	);
});
