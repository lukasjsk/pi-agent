// multiplexer-cli.test.ts — the shared, multiplexer-agnostic CLI plumbing for
// pane adapters: the never-throwing invoker over a stubbed CliRunner, and the
// JSON / string guards the adapters use for their command replies.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliRunner } from "../cli.ts";
import { asNonEmptyString, createCliInvoker, parseJson } from "./multiplexer-cli.ts";

/** A CliRunner stub that records argv and replays one queued result. */
function stubRunner(result: { stdout: string; stderr: string; code: number } | Error): {
	runner: CliRunner;
	calls: { bin: string; args: readonly string[] }[];
} {
	const calls: { bin: string; args: readonly string[] }[] = [];
	return {
		calls,
		runner: {
			async run(bin, args, _signal) {
				calls.push({ bin, args });
				if (result instanceof Error) throw result;
				return result;
			},
		},
	};
}

test("createCliInvoker resolves the stdout and exit code of a successful run", async () => {
	const { runner, calls } = stubRunner({ stdout: '{"pane":"p9"}', stderr: "", code: 0 });
	const invoke = createCliInvoker("/opt/herdr-app", runner);
	assert.deepEqual(await invoke(["do", "pane.split"]), { stdout: '{"pane":"p9"}', code: 0 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "/opt/herdr-app");
	assert.deepEqual(calls[0].args, ["do", "pane.split"]);
});

test("createCliInvoker resolves a non-zero exit code as a result, not a failure", async () => {
	const invoke = createCliInvoker("herdr-app", stubRunner({ stdout: "", stderr: "no pane", code: 1 }).runner);
	assert.deepEqual(await invoke(["ls"]), { stdout: "", code: 1 });
});

test("createCliInvoker resolves undefined when the runner throws", async () => {
	const invoke = createCliInvoker("herdr", stubRunner(new Error("runner exploded")).runner);
	assert.equal(await invoke(["pane", "close", "w1:p2"]), undefined);
});

test("parseJson parses valid JSON and resolves undefined on bad JSON", () => {
	assert.deepEqual(parseJson('{"pane":"p9"}'), { pane: "p9" });
	assert.equal(parseJson("not json at all"), undefined);
	assert.equal(parseJson(""), undefined);
});

test("asNonEmptyString narrows to a non-empty string and rejects everything else", () => {
	assert.equal(asNonEmptyString("p9"), "p9");
	assert.equal(asNonEmptyString(""), undefined);
	assert.equal(asNonEmptyString(42), undefined);
	assert.equal(asNonEmptyString(null), undefined);
	assert.equal(asNonEmptyString(undefined), undefined);
	assert.equal(asNonEmptyString({ pane: "p9" }), undefined);
});
