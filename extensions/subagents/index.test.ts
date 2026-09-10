import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";

import { fakeSession, installPlatformMock, platformHooks, textDelta, toolStart } from "./pi-mock.ts";

// typebox is only resolvable under Pi's module aliases, not from this repo.
mock.module("typebox", () => ({
	Type: {
		Object: (properties: unknown) => ({ type: "object", properties }),
		String: (options: unknown = {}) => ({ type: "string", ...(options as object) }),
	},
}));

installPlatformMock();

const { createSubagentExecutor } = await import("./index.ts");
const { parseAgentDefinition, UnknownAgentError } = await import("./definitions.ts");

const scout = parseAgentDefinition(
	"/x/scout.md",
	"---\nname: scout\ndescription: explores\ntools: [read, grep]\n---\nExplore.",
	"bundled",
);

const deps = {
	resolveAgent: (name: string) => {
		if (name === "scout") return scout;
		throw new UnknownAgentError(`Unknown agent "${name}". Valid agents: scout`);
	},
	getModel: () => undefined,
	cwd: "/repo",
	agentDir: "/fake/agent-dir",
};

test("the executor resolves the agent and returns the child report with typed details", async () => {
	platformHooks.createAgentSession = async (options) => {
		assert.equal(options.cwd, "/repo");
		assert.equal(options.agentDir, "/fake/agent-dir");
		const session = fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "## Start Here\nREADME.md" }] }],
		});
		return { session };
	};

	const execute = createSubagentExecutor(deps);
	const result = await execute({ agent: "scout", task: "Recon the repo." }, undefined, undefined);

	assert.match(result.content[0].text, /## Start Here/);
	assert.equal(result.details.status, "completed");
});

test("an unknown agent name is a spawn error listing valid agents", async () => {
	const execute = createSubagentExecutor(deps);
	await assert.rejects(execute({ agent: "wizard", task: "x" }, undefined, undefined), (error: unknown) => {
		assert.match(String(error), /Unknown agent "wizard"/);
		assert.match(String(error), /Valid agents: scout/);
		return true;
	});
});

test("progress flows through onUpdate prefixed with the agent role", async () => {
	const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: { status: string } }> = [];
	platformHooks.createAgentSession = async () => {
		const session = fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		});
		session.prompt = async () => {
			toolStart(session, "read");
			textDelta(session, "reading files");
		};
		return { session };
	};

	const execute = createSubagentExecutor(deps);
	await execute({ agent: "scout", task: "Recon." }, undefined, (partial) => updates.push(partial));

	assert.ok(updates.length >= 2);
	assert.ok(updates.every((u) => u.details.status === "running"));
	assert.match(updates[0].content[0].text, /^\[scout\] tools: read/);
});

test("a failed child surfaces status and diagnostics in the result", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			prompt: async () => {
				throw new Error("kaboom");
			},
		}),
	});

	const execute = createSubagentExecutor(deps);
	const result = await execute({ agent: "scout", task: "x" }, undefined, undefined);

	assert.equal(result.details.status, "failed");
	assert.match(result.content[0].text, /^\[failed\]/);
	assert.match(result.content[0].text, /kaboom/);
});

test("the session_start handler registers the subagent tool with a description built from discovery", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const registered: Array<Record<string, unknown>> = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: Record<string, unknown>) => {
			registered.push(tool);
		},
	};

	const { default: subagents } = await import("./index.ts");
	subagents(pi);
	await handlers.get("session_start")?.({}, { model: undefined, cwd: "/repo" });

	assert.equal(registered.length, 1);
	const tool = registered[0];
	assert.equal(tool.name, "subagent");
	assert.equal(tool.executionMode, "parallel");
	assert.match(String(tool.description), /scout: Exploration agent/);
	assert.match(String(tool.description), /worker: General-purpose implementation agent/);
});
