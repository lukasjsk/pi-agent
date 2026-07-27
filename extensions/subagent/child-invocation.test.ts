import assert from "node:assert/strict";
import test from "node:test";
import { buildChildPiArgs } from "./child-invocation.ts";

test("child agents cannot invoke the subagent tool", () => {
	const args = buildChildPiArgs("github-copilot/gpt-5.6-terra");

	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"github-copilot/gpt-5.6-terra",
		"--exclude-tools",
		"subagent,handover",
	]);
});

test("the nested-subagent exclusion is retained with an agent tool allowlist", () => {
	const args = buildChildPiArgs("github-copilot/gpt-5.6-terra", ["read", "bash"]);

	assert.deepEqual(args.slice(-2), ["--exclude-tools", "subagent,handover"]);
	assert.ok(args.includes("--tools"));
});
