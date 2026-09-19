import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { join } from "node:path";

import { fakeSession, installPlatformMock, platformHooks, textDelta, toolStart } from "./pi-mock.ts";
import { installPiTuiMock, installTypeboxMock } from "../test/pi-mock.ts";

installTypeboxMock();
installPlatformMock();
installPiTuiMock();

const { createSubagentExecutor, renderResultText } = await import("./index.ts");
const { parseAgentDefinition, UnknownAgentError } = await import("./definitions.ts");
const { SpawnScheduler } = await import("./concurrency.ts");
const { createGitTools, GIT_TOOL_NAMES } = await import("./git-history.ts");

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
	overflowRoot: "/fake/tmp",
	scheduler: new SpawnScheduler(),
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

test("child usage rides the tool result from getSessionStats (research doc §6)", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stats: {
				tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, total: 360 },
				cost: 0.0123,
			},
		}),
	});

	const execute = createSubagentExecutor(deps);
	const result = await execute({ agent: "scout", task: "x" }, undefined, undefined);

	assert.deepEqual(result.usage, {
		input: 100,
		output: 50,
		cacheRead: 200,
		cacheWrite: 10,
		totalTokens: 360,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
	});
	// The details payload carries the agent name the footer attributes cost by.
	assert.equal((result.details as { agent?: string }).agent, "scout");
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

test("an oversized report overflows to a file and the in-context copy is truncated with its path (§R8)", async () => {
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const overflowRoot = await fs.mkdtemp(join(await os.tmpdir(), "subagents-test-"));
	try {
	const bigReport = `# Big report\n${"detail line\n".repeat(1500)}`; // well over 10KB
	platformHooks.createAgentSession = async () => {
		const session = fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: bigReport }] }],
		});
		return { session };
	};

	const execute = createSubagentExecutor({ ...deps, overflowRoot, getSessionId: () => "sess-abc" });
	const result = await execute({ agent: "scout", task: "Recon." }, undefined, undefined);

	const text = result.content[0].text;
	assert.ok(Buffer.byteLength(text, "utf8") <= 10 * 1024, "in-context text must respect the 10KB cap");
	const overflowPath = (result.details as { overflowPath?: string }).overflowPath;
	assert.ok(overflowPath, "details must carry the overflow path");
	assert.match(overflowPath!, /\/pi-subagents\/sess-abc\/scout-[0-9a-f]{8}\.md$/);
	assert.match(text, new RegExp(overflowPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(text, /full report saved to/);
	assert.ok(!text.includes("detail line\n".repeat(1400)), "body must be truncated in context");

	const file = await fs.readFile(overflowPath!, "utf8");
	assert.ok(file.includes("detail line\n".repeat(1000)), "the overflow file contains the FULL report");
	assert.ok(file.includes("Provenance (extension-appended):"));
	assert.match(result.content[0].text, /report overflowed to/);
	assert.equal((result.details as { report: string }).report, bigReport.trim(), "details carry the complete payload for replay");
	} finally {
		await fs.rm(overflowRoot, { recursive: true, force: true });
	}
});

test("a report under the cap arrives fully in-context with no overflow artifacts", async () => {
	platformHooks.createAgentSession = async () => {
		const session = fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "## Start Here\nREADME.md" }] }],
		});
		return { session };
	};

	const execute = createSubagentExecutor(deps);
	const result = await execute({ agent: "scout", task: "Recon." }, undefined, undefined);
	assert.equal((result.details as { overflowPath?: string }).overflowPath, undefined);
	assert.doesNotMatch(result.content[0].text, /report overflowed to|full report saved to/);
});

/** Deferred prompt gate: the fake child session's prompt hangs until released. */
function gatedPromptHook(): { releases: Array<() => void>; hook: (options: Record<string, unknown>) => Promise<{ session: unknown }> } {
	const releases: Array<() => void> = [];
	return {
		releases,
		hook: async () => ({
			session: fakeSession({
				prompt: () =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
					}),
			}),
		}),
	};
}

test("excess concurrent spawns queue and start as slots free (§R8.3)", async () => {
	const { releases, hook } = gatedPromptHook();
	platformHooks.createAgentSession = hook;
	const execute = createSubagentExecutor({ ...deps, scheduler: new SpawnScheduler(1) });

	const first = execute({ agent: "scout", task: "First." }, undefined, undefined);
	const second = execute({ agent: "scout", task: "Second." }, undefined, undefined);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(releases.length, 1, "cap 1 → only one child session created initially");

	releases[0]();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(releases.length, 2, "the queued spawn started once the slot freed");
	releases[1](); // let the second child finish
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.details.status, "completed");
	assert.equal(secondResult.details.status, "completed");
});

test("Esc while queued drains the queue with a cancelled result (§R8.4)", async () => {
	const { releases, hook } = gatedPromptHook();
	platformHooks.createAgentSession = hook;
	const execute = createSubagentExecutor({ ...deps, scheduler: new SpawnScheduler(1) });

	const controller = new AbortController();
	const first = execute({ agent: "scout", task: "First." }, undefined, undefined);
	const second = execute({ agent: "scout", task: "Second." }, controller.signal, undefined);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(releases.length, 1);

	controller.abort(); // Esc: the queued child never runs
	const secondResult = await second;
	assert.equal(secondResult.details.status, "cancelled");
	assert.match(secondResult.content[0].text, /\[cancelled\]/);
	assert.match(secondResult.content[0].text, /cancelled while queued; nothing ran/);

	releases[0](); // the running sibling is unaffected (§R9.1)
	const firstResult = await first;
	assert.equal(firstResult.details.status, "completed");
});

test("Esc cancels a running child with a partial result (§R8.4)", async () => {
	const { releases, hook } = gatedPromptHook();
	platformHooks.createAgentSession = hook;
	const execute = createSubagentExecutor(deps);

	const controller = new AbortController();
	const running = execute({ agent: "scout", task: "Long task." }, controller.signal, undefined);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(releases.length, 1);

	controller.abort();
	const result = await running;
	assert.equal(result.details.status, "cancelled");
	assert.match(result.content[0].text, /cancelled before completion; partial report returned/);
});

test("an agent-error child reports failed without affecting a completed sibling (§R9.2)", async () => {
	let call = 0;
	platformHooks.createAgentSession = async () => {
		call++;
		if (call === 1) {
			return {
				session: fakeSession({
					errorMessage: "stream setup error",
					messages: [],
				}),
			};
		}
		return {
			session: fakeSession({
				messages: [{ role: "assistant", content: [{ type: "text", text: "## Start Here\nREADME.md" }] }],
			}),
		};
	};
	const scheduler = new SpawnScheduler(4);
	const execute = createSubagentExecutor({ ...deps, scheduler });

	const [failed, completed] = await Promise.all([
		execute({ agent: "scout", task: "Fails." }, undefined, undefined),
		execute({ agent: "scout", task: "Works." }, undefined, undefined),
	]);
	assert.equal(failed.details.status, "failed");
	assert.match(failed.content[0].text, /\[failed\]/);
	assert.match(failed.content[0].text, /child run error: stream setup error/);
	assert.equal(completed.details.status, "completed");
	assert.equal(scheduler.runningCount, 0, "slots are released for both outcomes");
});

// ---- §R10.6 worker-side restricted scout tool ----

const { WORKER_AGENT_NAME, SCOUT_TOOL_NAME, createScoutTool } = await import("./index.ts");

const worker = parseAgentDefinition(
	"/x/worker.md",
	"---\nname: worker\ndescription: implements\ntools: [read, bash]\n---\nImplement.",
	"bundled",
);
const userAgent = parseAgentDefinition(
	"/home/user/custom.md",
	"---\nname: custom\ndescription: custom agent\ntools: [read]\nskills: off\n---\nCustom.",
	"user",
);
const depsWithChildTools = {
	...deps,
	resolveAgent: (name: string) => {
		if (name === "scout") return scout;
		if (name === "worker") return worker;
		if (name === "custom") return userAgent;
		throw new UnknownAgentError(`Unknown agent "${name}". Valid agents: scout, worker`);
	},
	childTools: () => [createScoutTool(depsWithChildTools)],
	scoutTools: () => createGitTools(),
} as typeof deps;

test("worker sessions receive the restricted scout tool via customTools (§R10.6)", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return {
			session: fakeSession({
				messages: [{ role: "assistant", content: [{ type: "text", text: "## Completed\ndone" }] }],
			}),
		};
	};

	const execute = createSubagentExecutor(depsWithChildTools);
	await execute({ agent: "worker", task: "Build it." }, undefined, undefined);

	const options = captured[0];
	const injected = (options.customTools as Array<{ name: string }>) ?? [];
	assert.equal(injected.length, 1);
	assert.equal(injected[0].name, SCOUT_TOOL_NAME);
	assert.ok((options.tools as string[]).includes(SCOUT_TOOL_NAME), "custom tool name is in the allowlist");
	assert.deepEqual((options.tools as string[]).slice(0, 2), ["read", "bash"]);
});

test("the worker-side tool has no agent parameter and always spawns the scout (§R10.6)", async () => {
	const scoutSessions: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		scoutSessions.push(options);
		return {
			session: fakeSession({
				messages: [{ role: "assistant", content: [{ type: "text", text: "## Start Here\nREADME.md:1" }] }],
			}),
		};
	};

	// The same tool object the worker session would receive via deps.childTools.
	const scoutTool = createScoutTool(depsWithChildTools) as unknown as {
		parameters: { properties: Record<string, unknown> };
		execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) =>
			Promise<{ content: Array<{ text: string }>; details: { status: string } }>;
	};

	const properties = scoutTool.parameters.properties as Record<string, unknown>;
	assert.ok("task" in properties);
	assert.equal("agent" in properties, false, "no agent parameter on the restricted tool");
	assert.equal("model" in properties, true);
	assert.equal("thinkingLevel" in properties, true);

	const result = await scoutTool.execute("call-1", { task: "Recon the repo." }, undefined, undefined);
	assert.match(result.content[0].text, /## Start Here/);
	assert.equal(result.details.status, "completed");
	assert.equal(scoutSessions.length, 1, "the tool spawned exactly the scout");
	const scoutSession = scoutSessions[0];
	const injected = (scoutSession.customTools as Array<{ name: string }> | undefined) ?? [];
	assert.deepEqual(injected.map((t) => t.name), [...GIT_TOOL_NAMES], "scouts get the git-history tools and never a subagent tool");
	assert.deepEqual(scoutSession.tools, ["read", "grep", ...GIT_TOOL_NAMES], "injected tool names are appended to the allowlist");
});

test("a scout never receives a subagent tool and user-defined agents get none (depth stays 1, §R10.6)", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return {
			session: fakeSession({
				messages: [{ role: "assistant", content: [{ type: "text", text: "report" }] }],
			}),
		};
	};

	const execute = createSubagentExecutor(depsWithChildTools);
	await execute({ agent: "scout", task: "Recon." }, undefined, undefined);
	await execute({ agent: "custom", task: "Do a thing." }, undefined, undefined);

	assert.equal(captured.length, 2);
	const scoutInjected = (captured[0].customTools as Array<{ name: string }> | undefined) ?? [];
	assert.deepEqual(scoutInjected.map((t) => t.name), [...GIT_TOOL_NAMES], "scout gets leaf git tools, never a subagent tool");
	assert.equal(captured[1].customTools, undefined, "user-defined agents get no injected tools");
});

test("parallel scouts from one worker share the global cap (§R10.6)", async () => {
	const { releases, hook } = gatedPromptHook();
	platformHooks.createAgentSession = hook;
	const tightDeps = { ...depsWithChildTools, scheduler: new SpawnScheduler(1) };
	const scoutTool = createScoutTool(tightDeps) as unknown as {
		execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<unknown>;
	};

	const first = scoutTool.execute("c1", { task: "Scout one." });
	const second = scoutTool.execute("c2", { task: "Scout two." });
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(releases.length, 1, "cap 1 → only one scout session created initially");

	releases[0]();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(releases.length, 2, "second scout started only after the first freed the slot");
	releases[1]();
	await Promise.all([first, second]);
});

test("the scout tool shares the deps object whose scheduler is assigned later (regression)", async () => {
	// Production wiring order: deps exists first, childTools closes over it, THEN the
	// scheduler is assigned. A spread-copy of deps broke this: worker-spawned scouts got
	// a scheduler-less deps and every call died with
	// 'Cannot read properties of undefined (reading \u2018run\u2019)'.
	const lateDeps = { ...deps, resolveAgent: depsWithChildTools.resolveAgent, scheduler: undefined as never } as typeof deps;
	lateDeps.childTools = () => [createScoutTool(lateDeps)];
	lateDeps.scheduler = new SpawnScheduler();

	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "## Start Here\nx" }] }],
		}),
	});

	const scoutTool = lateDeps.childTools()[0] as unknown as {
		execute: (id: string, params: unknown) => Promise<{ details: { status: string } }>;
	};
	const result = await scoutTool.execute("c1", { task: "Recon." }); // threw before the fix
	assert.equal(result.details.status, "completed");
	assert.equal(lateDeps.scheduler.runningCount, 0, "the shared scheduler's slot is released");
});

// ---- §R10.5 TUI presentation ----

const { excerpt, liveStatus, renderSubagentCall, renderSubagentResult } = await import("./render.ts");

const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as never as Parameters<typeof renderSubagentCall>[1];

const settledDetails = {
	status: "completed" as const,
	report: "## Start Here\nutil.ts:1",
	footer: {
		openQuestions: [{ question: "Which style?", whyItMatters: "affects the API" }],
		decisionPoints: [{ decision: "Used read-only tools", rationale: "scout is read-only" }],
		filesTouched: [],
	},
	diagnostics: ["no JSON footer on the report"],
	modelUsed: "github-copilot/gpt-5.6-terra",
	requestedThinkingLevel: "low",
	effectiveThinkingLevel: "low",
	fallbackFrom: ["local-qwen38/x"],
	overflowPath: "/tmp/pi-subagents/sess-1/scout-abc.md",
};

test("excerpt flattens and truncates", () => {
	assert.equal(excerpt("  a\n\nb  ", 10), "a b");
	assert.equal(excerpt("x".repeat(50), 48), `${"x".repeat(48)}…`);
});

test("liveStatus: queued notice vs running progress", () => {
	assert.equal(liveStatus("queued — 2 spawn(s) ahead"), "queued");
	assert.equal(liveStatus("tools: read · partial text"), "running");
	assert.equal(liveStatus(undefined), "running");
});

test("collapsed result is one status line with role, elapsed, usage, and counts", () => {
	const text = renderSubagentResult(
		{
			content: [{ type: "text", text: "body" }],
			details: settledDetails,
			usage: { input: 900, output: 300, cacheRead: 5000 },
		},
		{ expanded: false, isPartial: false },
		theme,
		{ state: { startedAt: Date.now() - 14_000 }, args: { agent: "scout", task: "Recon" } },
	).text;
	// strip ANSI for assertions
	const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plain, /^✓ completed · scout · 14s · 1\.2k tok/);
	assert.match(plain, /1 decision\(s\), 1 question\(s\), 1 diagnostic\(s\)/);
	assert.match(plain, /full report saved to \/tmp\/pi-subagents\/sess-1\/scout-abc\.md/);
	assert.doesNotMatch(plain, /## Start Here/, "collapsed does not include the report body");
});

test("live activity view: two-line header with model, thinking, tokens, cost, and rows", () => {
	const text = renderSubagentResult(
		{
			details: {
				status: "running",
				progress: "tools: read, bash · streamed tail",
				toolCalls: [
					{ toolCallId: "1", toolName: "read", summary: "src/util.ts", status: "done" },
					{ toolCallId: "2", toolName: "bash", summary: "bun test", status: "error" },
					{ toolCallId: "3", toolName: "edit", summary: "src/a.ts", status: "running" },
				],
				contentLines: ["reading files", "editing now"],
				model: "github-copilot/gpt-5.6-terra",
				effectiveThinkingLevel: "high",
				tokens: { input: 900, output: 300 },
				cost: 0.0123,
			},
		},
		{ expanded: false, isPartial: true },
		theme,
		{ state: { startedAt: Date.now() - 3_000 }, args: { agent: "worker", task: "T" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	const lines = text.split("\n");
	// Two-line header (§R11.2): line 1 (role · task excerpt) renders via renderSubagentCall;
	// line 2 is model · effective thinking · elapsed · running tokens · live cost (4-decimal).
	// The flat progress tail is suppressed once richer rows exist.
	assert.match(lines[0], /^◦ running · github-copilot\/gpt-5\.6-terra · high · 3s · 1\.2k tok · \$0\.0123$/);
	assert.doesNotMatch(text, /streamed tail/);
	assert.doesNotMatch(lines[0], /worker/, "the role lives on line 1, not the result header");
	// One tool-call summary row per call, status marker + name + primary target.
	assert.match(lines[1], /^  ✓ read src\/util\.ts$/);
	assert.match(lines[2], /^  ✗ bash bun test$/);
	assert.match(lines[3], /^  ◦ edit src\/a\.ts$/);
	// Content lines: raw lines, shown after the tool rows.
	assert.match(lines[4], /^  reading files$/);
	assert.match(lines[5], /^  editing now$/);
	assert.equal(lines.length, 6);
});

test("live activity view collapsed caps: 3 tool rows and 3 content lines; expanded shows all", () => {
	const toolCalls = Array.from({ length: 8 }, (_, i) => ({
		toolCallId: String(i),
		toolName: "read",
		summary: `f${i}.ts`,
		status: "done" as const,
	}));
	const contentLines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
	const details = { status: "running" as const, progress: "", toolCalls, contentLines };
	const ctx = { state: {}, args: { agent: "worker", task: "T" } };

	const collapsed = renderSubagentResult(
		{ details },
		{ expanded: false, isPartial: true },
		theme,
		ctx,
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	const cLines = collapsed.split("\n");
	assert.match(cLines[1], /f5\.ts$/, "collapsed shows the last 3 tool rows");
	assert.match(cLines[3], /f7\.ts$/);
	assert.doesNotMatch(collapsed, /f4\.ts/);
	assert.match(cLines[4], /line 5$/, "collapsed shows the last 3 content lines");
	assert.match(cLines[6], /line 7$/);
	assert.doesNotMatch(collapsed, /line 4/);

	const expanded = renderSubagentResult(
		{ details },
		{ expanded: true, isPartial: true },
		theme,
		ctx,
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(expanded, /✓ read f0\.ts/, "expanded shows every relayed tool row");
	assert.match(expanded, /  line 0/);
});

test("content lines are capped raw with an ellipsis marker; cost hidden while zero", () => {
	const text = renderSubagentResult(
		{
			details: {
				status: "running",
				progress: "",
				toolCalls: [],
				contentLines: ["x".repeat(150)],
				model: "p/m",
				cost: 0,
			},
		},
		{ expanded: false, isPartial: true },
		theme,
		{ state: {}, args: { agent: "scout", task: "T" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(text, /  x{100}…$/, "per-line cap with … marker, raw text otherwise");
	assert.doesNotMatch(text, /\$/, "no cost line until usage has been seen");
});

test("partial results render a live status line; queued state is visible with its role", () => {
	const running = renderSubagentResult(
		{ details: { status: "running", progress: "tools: read · some streamed tail" } },
		{ expanded: false, isPartial: true },
		theme,
		{ state: { startedAt: Date.now() - 3_000 }, args: { agent: "worker", task: "T" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	// Running: no progress tail and no role — the role lives on the renderCall line.
	assert.match(running, /^◦ running · 3s$/);

	const queued = renderSubagentResult(
		{ details: { status: "running", progress: "queued — 2 spawn(s) ahead" } },
		{ expanded: false, isPartial: true },
		theme,
		{ state: {}, args: { agent: "worker", task: "T" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(queued, /… queued · worker/);
});

test("expanded result renders body, decision points, open questions, provenance distinctly", () => {
	const text = renderSubagentResult(
		{ content: [{ type: "text", text: "in-context body" }], details: settledDetails, usage: { input: 900, output: 300 } },
		{ expanded: true, isPartial: false },
		theme,
		{ state: { startedAt: Date.now() - 14_000 }, args: { agent: "scout", task: "Recon" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(text, /## Start Here\nutil\.ts:1/, "full report body from details");
	assert.match(text, /Decision points\n  • Used read-only tools — scout is read-only/);
	assert.match(text, /Open questions\n  \? Which style\? — affects the API/);
	assert.match(text, /· model: github-copilot\/gpt-5\.6-terra/);
	assert.match(text, /after fallback from local-qwen38\/x/);
	assert.doesNotMatch(text, /Tool calls/, "no calls section when details carries none");
});

test("expanded settled shows the full persisted tool-call list with an omission marker (§R11.3, §R11.5)", () => {
	const calls = Array.from({ length: 4 }, (_, i) => ({
		toolCallId: String(i),
		toolName: "read",
		summary: `f${i}.ts`,
		status: "done" as const,
	}));
	const text = renderSubagentResult(
		{ details: { ...settledDetails, calls, callsOmitted: 2 } },
		{ expanded: true, isPartial: false },
		theme,
		{ state: { startedAt: Date.now() - 14_000 }, args: { agent: "scout", task: "Recon" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(text, /Tool calls\n  … 2 earlier call\(s\) omitted\n  ✓ read f0\.ts\n  ✓ read f1\.ts\n  ✓ read f2\.ts\n  ✓ read f3\.ts$/m);
	// Content lines are dropped at settle — the report supersedes them.
	assert.doesNotMatch(text, /contentLines/);
});

test("the settled row shifts the frame to the status color and keeps it constant (§R11.1)", () => {
	const state: Record<string, unknown> = {};
	renderSubagentCall({ agent: "worker", task: "T" }, theme, { state });
	assert.equal(state.border, "accent", "worker runs in the accent color");

	const state2: Record<string, unknown> = {};
	renderSubagentCall({ agent: "scout", task: "T" }, theme, { state: state2 });
	assert.equal(state2.border, "muted", "scout runs muted");
	renderSubagentResult(
		{ details: { ...settledDetails, status: "failed" } },
		{ expanded: false, isPartial: false },
		theme,
		{ state: state2, args: { agent: "scout", task: "T" } },
	);
	assert.equal(state2.border, "error", "settled rows shift to the status color");
});

test("renderCall is the static role · task-excerpt header plus the frame's top rule, and seeds elapsed timing", () => {
	const state: Record<string, unknown> = {};
	const first = renderSubagentCall({ agent: "scout", task: "Recon the repo." }, theme, { state });
	assert.match(first.text.replace(/\x1b\[[0-9;]*m/g, ""), /^scout · "Recon the repo\."$/);
	assert.equal(typeof state.startedAt, "number", "elapsed timing seeded on first call render");
	const rendered = first.render(80);
	assert.equal(rendered.length, 2, "top rule + header line");
	assert.match(rendered[0], /^─+$/, "top border rule");
	assert.equal(rendered[1], 'scout · "Recon the repo."');
});

test("failed and cancelled statuses render with distinct markers and diagnostics", () => {
	const failed = renderSubagentResult(
		{ details: { ...settledDetails, status: "failed", report: "" } },
		{ expanded: false, isPartial: false },
		theme,
		{ state: {}, args: { agent: "scout", task: "x" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(failed, /^✗ failed · scout/);

	const cancelled = renderSubagentResult(
		{ details: { ...settledDetails, status: "cancelled", report: "partial" } },
		{ expanded: false, isPartial: false },
		theme,
		{ state: {}, args: { agent: "scout", task: "x" } },
	).text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(cancelled, /^⊘ cancelled · scout/);
});
