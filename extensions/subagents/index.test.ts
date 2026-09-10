import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";

import { fakeSession, installPlatformMock, platformHooks, textDelta, toolStart } from "./pi-mock.ts";

// typebox is only resolvable under Pi's module aliases, not from this repo.
mock.module("typebox", () => ({
	Type: {
		Object: (properties: unknown) => ({ type: "object", properties }),
		String: (options: unknown = {}) => ({ type: "string", ...(options as object) }),
		Optional: (schema: unknown) => schema,
	},
}));

installPlatformMock();

const { createSubagentExecutor, renderResultText } = await import("./index.ts");
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
	getModelRegistry: () => ({
		find: (provider: string, id: string) => ({ provider, id }) as unknown, // every well-formed ref resolves
		getAvailable: () => [], // no auth pre-filter in this stub
	}),
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

test("a well-formed child report renders markdown body, structured fields, and provenance", async () => {
	const report = [
		"## Start Here",
		"README.md",
		"```json",
		'{ "openQuestions": [{ "question": "Auth scope?", "whyItMatters": "Blocks worker." }],',
		'  "decisionPoints": [{ "decision": "Read tests too", "rationale": "They pin behavior." }],',
		'  "filesTouched": ["src/a.ts"] }',
		"```",
	].join("\n");
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: report }] }],
			thinkingLevel: "low",
		}),
	});

	const execute = createSubagentExecutor(deps);
	const result = await execute({ agent: "scout", task: "Recon." }, undefined, undefined);
	const text = result.content[0].text;

	assert.match(text, /^## Start Here\nREADME\.md$/m, "markdown body first");
	assert.ok(!/```json/.test(text), "raw footer JSON is not double-reported");
	assert.match(text, /Open questions:\n- Auth scope\? — Blocks worker\./);
	assert.match(text, /Decision points:\n- Read tests too — They pin behavior\./);
	assert.match(text, /Files touched: src\/a\.ts/);
	assert.match(text, /Provenance \(extension-appended\):\n- model: test-provider\/test-model/);
	assert.match(text, /- thinking level: requested \(none\), effective low/);
});

test("a degraded footer keeps status completed and warns in diagnostics", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "body\n```json\n{bad}\n```" }] }],
		}),
	});

	const execute = createSubagentExecutor(deps);
	const result = await execute({ agent: "scout", task: "x" }, undefined, undefined);

	assert.equal(result.details.status, "completed");
	assert.match(result.content[0].text, /\[?completed|body/);
	assert.match(result.content[0].text, /Diagnostics:\n- unparseable JSON footer/);
});

test("a per-spawn model override reaches the child session (§R4.4)", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return { session: fakeSession({ messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }) };
	};

	const execute = createSubagentExecutor(deps);
	await execute({ agent: "scout", task: "x", model: "custom/override-model" }, undefined, undefined);

	assert.deepEqual(lastCaptured(captured).model, { provider: "custom", id: "override-model" });
});

test("a definition fallback list resolves through the registry with skip diagnostics in the result", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return { session: fakeSession({ messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }) };
	};
	const registryDeps = {
		...deps,
		resolveAgent: (name: string) => ({
			...scout,
			model: ["ghost/none", "b/usable"],
		}) as typeof scout,
		getModelRegistry: () => ({
			find: (provider: string, id: string) => (provider === "b" ? { provider, id } : undefined),
			getAvailable: () => [{ provider: "b", id: "usable" }],
		}),
	};

	const execute = createSubagentExecutor(registryDeps);
	const result = await execute({ agent: "scout", task: "x" }, undefined, undefined);

	assert.deepEqual(lastCaptured(captured).model, { provider: "b", id: "usable" });
	assert.match(result.content[0].text, /skipped ghost\/none \(not in the model catalogue\)/);
});

test("an override that the registry does not know is a spawn error", async () => {
	const noSuchModel = {
		...deps,
		getModelRegistry: () => ({ find: () => undefined, getAvailable: () => [] }),
	};
	const execute = createSubagentExecutor(noSuchModel);
	await assert.rejects(
		execute({ agent: "scout", task: "x", model: "ghost/missing" }, undefined, undefined),
		/model "ghost\/missing" not found in the model registry/,
	);
});

const lastCaptured = (captured: Array<Record<string, unknown>>) => captured[captured.length - 1];

test("an invalid thinkingLevel param fails the spawn fast", async () => {
	const execute = createSubagentExecutor(deps);
	await assert.rejects(
		execute({ agent: "scout", task: "x", thinkingLevel: "ultra" }, undefined, undefined),
		/Invalid thinkingLevel "ultra"/,
	);
});

test("provenance renders fallback origin when a retry occurred (§R9.3)", () => {
	const text = renderResultText({
		status: "completed",
		report: "done",
		footer: { openQuestions: [], decisionPoints: [], filesTouched: [] },
		diagnostics: [],
		modelUsed: "b/backup",
		fallbackFrom: ["a/primary"],
	});
	assert.match(text, /model: b\/backup \(after fallback from a\/primary\)/);
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
