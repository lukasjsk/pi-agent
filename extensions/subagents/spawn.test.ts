import assert from "node:assert/strict";
import test from "node:test";

import { fakeSession, installPlatformMock, platformHooks, textDelta, toolStart, type FakeSession } from "./pi-mock.ts";

installPlatformMock();

const { runSubagent, validateToolNames } = await import("./spawn.ts");
const { parseAgentDefinition } = await import("./definitions.ts");

const scout = parseAgentDefinition(
	"/x/scout.md",
	"---\nname: scout\ndescription: explores\ntools: [read, grep]\n---\nExplore and report.",
	"bundled",
);

function lastCaptured(captured: Array<Record<string, unknown>>): Record<string, unknown> {
	assert.ok(captured.length > 0, "expected createAgentSession to be called");
	return captured[captured.length - 1];
}

const baseOptions = {
	definition: scout,
	task: "Map the auth flow.",
	cwd: "/repo",
	agentDir: "/fake/agent-dir",
};

test("assembles an isolated in-process child per the spec's isolation rules", async () => {
	const captured: Array<Record<string, unknown>> = [];
	const loaders: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		const loader = options.resourceLoader as { options: Record<string, unknown> };
		loaders.push(loader.options);
		const session = fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "## Files Retrieved\n- a.ts:1-2" }] }],
		});
		session.prompt = async () => {
			toolStart(session, "grep");
			textDelta(session, "Working… ");
			textDelta(session, "done.");
		};
		return { session };
	};

	const result = await runSubagent(baseOptions);

	const opts = lastCaptured(captured);
	assert.deepEqual(opts.tools, ["read", "grep"]);
	assert.equal(opts.cwd, "/repo");
	assert.equal(opts.agentDir, "/fake/agent-dir");
	assert.deepEqual(opts.sessionManager, { kind: "inMemory", cwd: "/repo" });
	assert.deepEqual(opts.model, undefined); // no model option → platform resolves from settings

	const loaderOptions = loaders[loaders.length - 1];
	assert.equal(loaderOptions.noExtensions, true, "children never load extensions");
	assert.equal(loaderOptions.noThemes, true);
	assert.equal(loaderOptions.noPromptTemplates, true);
	assert.equal(loaderOptions.cwd, "/repo");
	const systemPrompt = loaderOptions.systemPromptOverride as (base: string | undefined) => string | undefined;
	assert.equal(systemPrompt(undefined), "Explore and report.");

	assert.equal(result.status, "completed");
	assert.equal(result.report, "## Files Retrieved\n- a.ts:1-2");
	assert.equal(result.modelUsed, "test-provider/test-model");
	assert.deepEqual(
		result.diagnostics.filter((d) => !/footer/.test(d)),
		[],
		"no diagnostics beyond the missing-footer warning",
	);
});

test("a well-formed footer is parsed into typed fields and stripped from the report", async () => {
	const report = [
		"## Key Code",
		"- `a.ts:1-2` — entry point",
		"```json",
		'{ "openQuestions": [{ "question": "Q?", "whyItMatters": "W." }],',
		'  "decisionPoints": [{ "decision": "D", "rationale": "R" }],',
		'  "filesTouched": ["src/a.ts"] }',
		"```",
	].join("\n");
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: report }] }],
		}),
	});

	const result = await runSubagent(baseOptions);

	assert.equal(result.status, "completed");
	assert.equal(result.report, "## Key Code\n- `a.ts:1-2` — entry point");
	assert.deepEqual(result.footer.openQuestions, [{ question: "Q?", whyItMatters: "W." }]);
	assert.deepEqual(result.footer.filesTouched, ["src/a.ts"]);
	assert.deepEqual(result.diagnostics, []);
});

test("an unparseable footer degrades to plain result with a warning; status stays completed", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "body\n```json\n{oops}\n```" }] }],
		}),
	});

	const result = await runSubagent(baseOptions);

	assert.equal(result.status, "completed");
	assert.match(result.report, /\{oops\}/);
	assert.deepEqual(result.footer, { openQuestions: [], decisionPoints: [], filesTouched: [] });
	assert.ok(result.diagnostics.some((d) => /unparseable JSON footer/.test(d)));
});

test("a missing footer degrades with a warning", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "plain report" }] }],
		}),
	});

	const result = await runSubagent(baseOptions);

	assert.equal(result.status, "completed");
	assert.equal(result.report, "plain report");
	assert.ok(result.diagnostics.some((d) => /no JSON footer/.test(d)));
});

test("provenance records requested vs effective thinking level, extension-collected", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return { session: fakeSession({ thinkingLevel: "off" }) }; // clamped: model cannot think
	};

	const result = await runSubagent({ ...baseOptions, definition: { ...scout, thinkingLevel: "high" } });

	assert.equal(result.requestedThinkingLevel, "high");
	assert.equal(result.effectiveThinkingLevel, "off");
});

test("passes the requested model through to the child", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return { session: fakeSession() };
	};
	const model = { provider: "anthropic", id: "claude-opus-4-5" };
	await runSubagent({ ...baseOptions, modelChain: [model] });
	assert.deepEqual(lastCaptured(captured).model, model);
});

test("a runtime failure on the first chain entry retries the same task on the next (§R4.2)", async () => {
	const capturedModels: Array<unknown> = [];
	platformHooks.createAgentSession = async (options) => {
		capturedModels.push(options.model);
		const isPrimary = (options.model as { id: string }).id === "primary";
		return {
			session: fakeSession(
				isPrimary
					? { errorMessage: "all retries exhausted", messages: [], model: { provider: "a", id: "primary" } }
					: {
						messages: [{ role: "assistant", content: [{ type: "text", text: "report from fallback" }] }],
						model: { provider: "b", id: "backup" },
					},
			),
		};
	};

	const result = await runSubagent({
		...baseOptions,
		modelChain: [
			{ provider: "a", id: "primary" },
			{ provider: "b", id: "backup" },
		],
	});

	assert.deepEqual(capturedModels, [
		{ provider: "a", id: "primary" },
		{ provider: "b", id: "backup" },
	]);
	assert.equal(result.status, "completed");
	assert.equal(result.report, "report from fallback");
	assert.equal(result.modelUsed, "b/backup");
	assert.deepEqual(result.fallbackFrom, ["a/primary"]);
	assert.ok(
		result.diagnostics.some((d) => /runtime failure on a\/primary.*retrying on b\/backup/.test(d)),
		"fallback transition is noted in diagnostics",
	);
	assert.ok(result.diagnostics.some((d) => /all retries exhausted/.test(d)), "per-candidate failure info kept");
});

test("an exhausted chain returns a failed result with per-candidate info — no silent fallback (§R4.3)", async () => {
	const attempts: string[] = [];
	platformHooks.createAgentSession = async (options) => {
		attempts.push((options.model as { id: string }).id);
		const id = (options.model as { id: string }).id;
		return { session: fakeSession({ errorMessage: `provider ${id} down`, model: { provider: id === "one" ? "a" : "b", id } }) };
	};

	const result = await runSubagent({
		...baseOptions,
		modelChain: [
			{ provider: "a", id: "one" },
			{ provider: "b", id: "two" },
		],
	});

	assert.deepEqual(attempts, ["one", "two"], "each chain entry was tried once");
	assert.equal(result.status, "failed");
	assert.equal(result.modelUsed, "b/two");
	assert.deepEqual(result.fallbackFrom, ["a/one"]);
	assert.ok(result.diagnostics.some((d) => /provider one down/.test(d)));
	assert.ok(result.diagnostics.some((d) => /provider two down/.test(d)));
	assert.ok(result.diagnostics.some((d) => /runtime failure on a\/one.*retrying on b\/two/.test(d)));
});

test("a cancelled child does not trigger a fallback retry", async () => {
	let createCalls = 0;
	const controller = new AbortController();
	platformHooks.createAgentSession = async () => {
		createCalls++;
		return {
			session: fakeSession({
				prompt: async (s) => {
					textDelta(s, "partial");
					while (!s.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
				},
			}),
		};
	};

	const run = runSubagent({
		...baseOptions,
		modelChain: [
			{ provider: "a", id: "one" },
			{ provider: "b", id: "two" },
		],
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 20);
	const result = await run;

	assert.equal(result.status, "cancelled");
	assert.equal(createCalls, 1, "no second attempt after cancellation");
	assert.equal(result.fallbackFrom, undefined);
});

test("a per-spawn thinkingLevel override rides the run and provenance", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return { session: fakeSession() };
	};
	const result = await runSubagent({ ...baseOptions, thinkingLevel: "high" });
	assert.equal(lastCaptured(captured).thinkingLevel, "high");
	assert.equal(result.requestedThinkingLevel, "high");
});

test("passes the definition's thinkingLevel to the child session", async () => {
	const captured: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		captured.push(options);
		return { session: fakeSession() };
	};
	await runSubagent({ ...baseOptions, definition: { ...scout, thinkingLevel: "high" } });
	assert.equal(lastCaptured(captured).thinkingLevel, "high");
});

test("skills: off disables skill discovery in the child", async () => {
	const loaders: Array<Record<string, unknown>> = [];
	platformHooks.createAgentSession = async (options) => {
		loaders.push((options.resourceLoader as { options: Record<string, unknown> }).options);
		return { session: fakeSession() };
	};
	await runSubagent({ ...baseOptions, definition: { ...scout, skills: false } });
	assert.equal(loaders[loaders.length - 1].noSkills, true);
	await runSubagent(baseOptions); // default: skills on
	assert.equal(loaders[loaders.length - 1].noSkills, false);
});

test("definition warnings ride the spawn's diagnostics", async () => {
	platformHooks.createAgentSession = async () => ({ session: fakeSession() });
	const warned = { ...scout, warnings: ["/x/scout.md: unknown frontmatter field \"foo\" ignored"] };
	const result = await runSubagent(baseOptions);
	assert.deepEqual(
		result.diagnostics.filter((d) => !/footer/.test(d)),
		[],
		"clean definition: no diagnostics beyond the missing-footer warning",
	);
	const result2 = await runSubagent({ ...baseOptions, definition: warned });
	assert.deepEqual(
		result2.diagnostics.filter((d) => !/footer/.test(d)),
		warned.warnings,
	);
});

test("relays child activity as progress", async () => {
	const progress: string[] = [];
	platformHooks.createAgentSession = async () => {
		const session = fakeSession({
			messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
		});
		session.prompt = async () => {
			toolStart(session, "grep");
			textDelta(session, "x".repeat(400));
		};
		return { session };
	};

	await runSubagent({ ...baseOptions, onProgress: (text) => progress.push(text) });

	assert.ok(progress.length >= 2);
	assert.match(progress[0], /tools: grep/);
	assert.ok(progress[progress.length - 1].length <= 330, "progress text is a bounded tail");
});

test("uses the last non-empty assistant message as the report", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "intermediate" }] },
				{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
				{ role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "final report" }] },
			],
		}),
	});
	const result = await runSubagent(baseOptions);
	assert.equal(result.report, "final report");
});

test("abort during the run returns a cancelled partial result", async () => {
	const controller = new AbortController();
	const sessions: FakeSession[] = [];
	platformHooks.createAgentSession = async () => {
		const session = fakeSession({
			prompt: async (s) => {
				textDelta(s, "partial progress");
				while (!s.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
			},
		});
		sessions.push(session);
		return { session };
	};

	const run = runSubagent({ ...baseOptions, signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	const result = await run;

	assert.equal(result.status, "cancelled");
	assert.equal(result.report, "partial progress");
	assert.ok(result.diagnostics.some((d) => /cancelled/.test(d)));
	assert.equal(sessions[0].abortCount, 1, "child session was aborted");
});

test("a thrown prompt error fails the spawn without throwing to the caller", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({
			messages: [],
			prompt: async () => {
				throw new Error("provider exploded");
			},
		}),
	});
	const result = await runSubagent(baseOptions);
	assert.equal(result.status, "failed");
	assert.ok(result.diagnostics.some((d) => /provider exploded/.test(d)));
});

test("an error message on settled state fails the spawn", async () => {
	platformHooks.createAgentSession = async () => ({
		session: fakeSession({ errorMessage: "all retries exhausted" }),
	});
	const result = await runSubagent(baseOptions);
	assert.equal(result.status, "failed");
	assert.ok(result.diagnostics.some((d) => /all retries exhausted/.test(d)));
});

test("unknown tool names fail the spawn before any session is created", async () => {
	let createCalls = 0;
	platformHooks.createAgentSession = async () => {
		createCalls++;
		return { session: fakeSession() };
	};

	assert.throws(() => validateToolNames({ ...scout, tools: ["read", "deploy", "teleport"] }), (error: unknown) => {
		assert.match(String(error), /unknown tool name\(s\): deploy, teleport/);
		assert.match(String(error), /read, bash, powershell, edit, write, grep, find, ls/);
		return true;
	});
	await assert.rejects(
		runSubagent({ ...baseOptions, definition: { ...scout, tools: ["read", "deploy"] } }),
		/unknown tool name\(s\): deploy/,
	);
	assert.equal(createCalls, 0, "no child session was created");
});

test("the child session is disposed after the run", async () => {
	const sessions: FakeSession[] = [];
	platformHooks.createAgentSession = async () => {
		const session = fakeSession();
		sessions.push(session);
		return { session };
	};
	await runSubagent(baseOptions);
	assert.equal(sessions[0].disposed, true);
});
