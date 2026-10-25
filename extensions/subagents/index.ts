// subagents — orchestrator-side tool for spawning isolated subagent sessions.
// Tracer bullet (map #12 ticket #20): one tool, blocking, bundled worker/scout,
// unknown agent = spawn error, progress relayed via onUpdate.
// Later tickets add: full schema validation (#21), model fallback (#23), structured
// output contract (#22), transport/overflow (#24), concurrency + Esc semantics (#25 —
// done: SpawnScheduler cap/queue, queued-Esc drain), TUI rendering (#27).
// The former worker-side restricted scout tool (#26) was removed: children are leaves.

import { Type } from "typebox";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverAgents, resolveAgent, THINKING_LEVELS, type AgentDefinition, type AgentDiscovery, type AgentThinkingLevel } from "./definitions.ts";
import { loadAgentModelConfig } from "./config.ts";
import { createFirecrawlTools } from "./firecrawl.ts";
import { createGitTools } from "./git-history.ts";
import { runSubagent, type ChildUsage, type SubagentActivity, type SubagentResult, type SubagentToolCallSummary } from "./spawn.ts";
import { renderStructuredFields, type StructuredFooter } from "./report.ts";
import { resolveModelChain, type ModelRegistryLike } from "./models.ts";
import { OVERFLOW_CAP_BYTES, inContextBody, newSpawnId, overflowFilePath } from "./transport.ts";
import { DEFAULT_MAX_CONCURRENT, parseMaxConcurrent, SpawnScheduler } from "./concurrency.ts";
import { EMPTY_FOOTER } from "./report.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { detectHerdr, HerdrPaneControl, type HerdrEnv } from "./pane/herdr.ts";
import { SubagentPaneManager, type PaneRelay } from "./pane/manager.ts";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const taskParam = Type.String({
	description:
		"Self-contained brief for the subagent. This is the entire context the child receives — " +
		"include everything it needs (goal, relevant file paths, excerpts of prior results).",
});
const modelParam = Type.Optional(
	Type.String({
		description:
			'Leave unset unless the user explicitly requests a specific model. When set, a "provider/model-id" ' +
			'(e.g. "github-copilot/gpt-5.6-terra") replaces the agent\'s model fallback list (config file or parent model) entirely.',
	}),
);
const thinkingLevelParam = Type.Optional(
	Type.String({
		description: `Leave unset unless the user explicitly asks for a thinking level. ` +
			`When set, one of: ${THINKING_LEVELS.join(" | ")}; clamped to the model's capabilities by the platform.`,
	}),
);

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to spawn." }),
	task: taskParam,
	model: modelParam,
	thinkingLevel: thinkingLevelParam,
});

export type SubagentToolDetails =
	| {
			status: "running";
			progress: string;
			/** Live activity relay (GLOSSARY.md "Tool-call summary" / "Content line"); absent on the queued notice. */
			toolCalls?: readonly SubagentToolCallSummary[];
			contentLines?: readonly string[];
			model?: string;
			/** Effective thinking level after the platform's clamp (§R11.5 live payload). */
			effectiveThinkingLevel?: string;
			/** Running token totals; display-only (§R11.5). */
			tokens?: { input: number; output: number };
			/** Display-only live cost; the settled usage is the accounting source (§R11.6). */
			cost?: number;
	  }
	| ({ status: SubagentResult["status"] } & SubagentResult);

export interface SubagentDeps {
	resolveAgent: (name: string) => AgentDefinition;
	getModel: () => unknown; // parent's current model (platform Model); undefined in tests
	getModelRegistry: () => ModelRegistryLike | undefined; // ctx.modelRegistry; undefined in tests
	getParentThinkingLevel: () => AgentThinkingLevel | undefined; // ctx.thinkingLevel; undefined in tests
	cwd: string;
	agentDir: string;
	/** Root for §R8 overflow files (defaults to the OS temp dir). */
	overflowRoot: string;
	/** Parent session id for the overflow path; absent in tests. */
	getSessionId?: () => string | undefined;
	/** Extension-wide spawn cap + queue (§R8.3–R8.4). Shared across all parallel tool calls. */
	scheduler: SpawnScheduler;
	/** Custom tools injected into researcher child sessions: the firecrawl web-research tools
	 *  (replacing raw bash). Absent in tests unless wired explicitly. */
	researcherTools?: () => ToolDefinition[];
	/** Custom tools injected into scout child sessions: the git-history tools (§R12). Absent in
	 *  tests unless wired explicitly. */
	scoutTools?: () => ToolDefinition[];
	/** The subagent pane mirror (ADR 0001): opens one display-only Herdr pane per spawn.
	 *  Present only when the orchestrator runs inside Herdr; absent in tests unless wired. */
	pane?: {
		open(agent: string, spawnId: string, task?: string): PaneRelay | undefined;
	};
}

/** The researcher role name — the only definition whose children receive the firecrawl web-research tools. */
export const RESEARCHER_AGENT_NAME = "researcher";
/** The scout role name — the only definition whose children receive the git-history tools (§R12). */
export const SCOUT_AGENT_NAME = "scout";

/** Compose the tool result text: markdown body, structured fields, then extension-appended provenance.
 *
 * With `overflowPath` set, an oversized result keeps the structured fields, provenance, and
 * diagnostics fully in-context while the report body is truncated to fit §R8's cap, with the
 * overflow path referenced. Without it, the full text is returned (the executor decides whether
 * to overflow after measuring).
 */
export function renderResultText(result: SubagentResult, opts: { overflowPath?: string; capBytes?: number } = {}): string {
	const header = result.status === "completed" ? "" : `[${result.status}] `;
	const body = result.report || "(subagent returned no report text)";

	const fields = renderStructuredFields(result.footer);
	const provenance: string[] = [];
	if (result.modelUsed) {
		const fallback = result.fallbackFrom?.length ? ` (after fallback from ${result.fallbackFrom.join(", ")})` : "";
		provenance.push(`model: ${result.modelUsed}${fallback}`);
	}
	if (result.requestedThinkingLevel || result.effectiveThinkingLevel) {
		const requested = result.requestedThinkingLevel ?? "(none)";
		const effective = result.effectiveThinkingLevel ?? "(unknown)";
		provenance.push(`thinking level: requested ${requested}, effective ${effective}`);
	}
	const provenanceBlock = provenance.length
		? `Provenance (extension-appended):
${provenance.map((p) => `- ${p}`).join("\n")}`
		: "";
	const diagnosticsBlock = result.diagnostics.length
		? `Diagnostics:
${result.diagnostics.map((d) => `- ${d}`).join("\n")}`
		: "";
	const tail = [fields, provenanceBlock, diagnosticsBlock].filter(Boolean).join("\n\n");

	// §R8 overflow: when the full composition exceeds the cap and an overflow path is
	// available, keep the small relay-critical sections whole and truncate the body.
	if (opts.overflowPath) {
		const cap = opts.capBytes ?? OVERFLOW_CAP_BYTES;
		const nonBody = Buffer.byteLength(`${header}\n\n${tail}`, "utf8");
		const bodyOut = Buffer.byteLength(`${header}\n\n${body}${tail ? `\n\n${tail}` : ""}`, "utf8") > cap
			? inContextBody(body, nonBody, opts.overflowPath, cap)
			: body;
		return [`${header}${bodyOut}`, tail].filter(Boolean).join("\n\n");
	}
	return [`${header}${body}`, tail].filter(Boolean).join("\n\n");
}

/** Build the tool executor against injectable deps (keeps the unit under test free of discovery I/O). */
export function createSubagentExecutor(deps: SubagentDeps) {
	return async function execute(
		params: { agent?: string; task: string; model?: string; thinkingLevel?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }) => void) | undefined,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails; usage?: ChildUsage }> {
		let definition: AgentDefinition;
		try {
			definition = deps.resolveAgent(params.agent!);
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}

		const overrideModel = params.model?.trim() || undefined;
		const thinkingOverride = params.thinkingLevel?.trim() || undefined;
		if (thinkingOverride !== undefined && !THINKING_LEVELS.includes(thinkingOverride as never)) {
			throw new Error(
				`Invalid thinkingLevel "${thinkingOverride}". Valid levels: ${THINKING_LEVELS.join(" | ")}`,
			);
		}

		// Model config (~/.pi/agent/subagents.json): read fresh on every spawn, so edits take
		// effect immediately. Absent file → pure fallback; malformed file/entries warn and skip.
		const config = loadAgentModelConfig(`${deps.agentDir}/subagents.json`);

		// Model fallback pipeline (§R4): resolve the ordered chain before spawning.
		let modelChain;
		let modelDiagnostics: string[] = [];
		try {
			const resolved = resolveModelChain({
				configModel: config.models[definition.name],
				overrideModel,
				parentModel: deps.getModel(),
				registry: deps.getModelRegistry(),
			});
			modelChain = resolved.chain;
			modelDiagnostics = [...config.warnings, ...resolved.diagnostics];
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}

		// Children are leaves: no child receives a subagent tool, and none get the general
		// orchestrator tool. Roles that must forgo `bash` instead receive leaf capability tools:
		// the researcher the firecrawl web-research set, the scout the git-history set (§R12).
		let childTools: ToolDefinition[] | undefined;
		if (definition.name === RESEARCHER_AGENT_NAME) childTools = deps.researcherTools?.();
		else if (definition.name === SCOUT_AGENT_NAME) childTools = deps.scoutTools?.();

		// ADR 0001: inside Herdr the spawn's pane is a display-only mirror of these very
		// events. It opens when the run starts (never while queued), and every call is
		// guarded: a pane failure can never fail or delay the spawn.
		const spawnId = newSpawnId(definition.name);
		let paneRelay: PaneRelay | undefined;
		const pane = (fn: () => void): void => {
			try {
				fn();
			} catch {
				// The pane is best-effort (ADR 0001); the run is the single source of truth.
			}
		};

		const result = await deps.scheduler.run(
			async () => {
				pane(() => {
					paneRelay = deps.pane?.open(definition.name, spawnId, params.task);
				});
				try {
					// await: runSubagent is async — its rejections must reach this catch so
					// the pane settles (a bare `return` would bypass it).
					return await runSubagent({
						definition,
					task: params.task,
					cwd: deps.cwd,
					agentDir: deps.agentDir,
					modelChain,
					modelDiagnostics,
					thinkingLevel: thinkingOverride as never,
					parentThinkingLevel: deps.getParentThinkingLevel?.(),
					childTools,
						signal,
						onActivity: (activity: SubagentActivity) => {
							pane(() => paneRelay?.relay(activity));
							if (onUpdate)
								onUpdate({
									content: [{ type: "text", text: `[${definition.name}] ${activity.progress}` }],
									details: { status: "running", ...activity },
								});
						},
					});
				} catch (error) {
					// A spawn error after the pane opened would otherwise leak the pane open:
					// settle it failed so the backstop close runs, then rethrow to the caller.
					pane(() =>
						paneRelay?.settle({
							status: "failed",
							diagnostics: [error instanceof Error ? error.message : String(error)],
						}),
					);
					throw error;
				}
			},
			signal,
			// Esc while queued: nothing ran, so the partial report is empty. The entry
			// still returns a well-formed cancelled result (§R9.2), never a thrown error.
			() => ({
				status: "cancelled" as const,
				report: "",
				footer: { ...EMPTY_FOOTER },
				diagnostics: [...modelDiagnostics, ...definition.warnings, "cancelled while queued; nothing ran"],
				requestedThinkingLevel: thinkingOverride,
			}),
			// One-shot queued notice for the live rendering (§R10.5 queued state; #27 refines).
			onUpdate && !signal?.aborted
				? (ahead) =>
						onUpdate({
							content: [{ type: "text", text: `[${definition.name}] queued — ${ahead} spawn(s) ahead` }],
							details: { status: "running", progress: `queued — ${ahead} spawn(s) ahead` },
						})
				: undefined,
		);

		// ADR 0001: the pane settles with the run — the viewer shows the outcome, its
		// countdown starts, and it closes the pane itself. Guarded like every pane call.
		pane(() =>
			paneRelay?.settle({
				status: result.status,
				modelUsed: result.modelUsed,
				cost: result.usage?.cost.total,
				totalTokens: result.usage?.totalTokens,
				report: result.report,
				diagnostics: result.diagnostics,
			}),
		);

		// Result transport (§R8): the full payload always rides in details; an oversized
		// in-context result also overflows to a session-scoped temp file that is referenced
		// (not auto-cleaned) in place of the body.
		let overflowPath: string | undefined;
		const full = renderResultText(result);
		if (Buffer.byteLength(full, "utf8") > OVERFLOW_CAP_BYTES) {
			overflowPath = overflowFilePath({
				root: deps.overflowRoot,
				sessionId: deps.getSessionId?.(),
				spawnId: newSpawnId(definition.name),
			});
			await mkdir(dirname(overflowPath), { recursive: true });
			await writeFile(overflowPath, full, "utf8");
			result.overflowPath = overflowPath;
			result.diagnostics.push(`report overflowed to ${overflowPath} (in-context copy truncated, no auto-cleanup)`);
		}

		const text = renderResultText(result, { overflowPath });
		// usage rides the tool result: /session, RPC, and the footer sum it automatically
		// (built-in footer.js, agent-session.js getSessionStats — research doc §6).
		return { content: [{ type: "text", text }], details: { status: result.status, ...result }, usage: result.usage };
	};
}

/** The bundled pane viewer entry, next to this module. */
function paneViewerPath(): string {
	return `${dirname(fileURLToPath(import.meta.url))}/pane/viewer.ts`;
}

/** The JS runtime for the pane viewer: prefer bun. The viewer chain mixes `.ts`
 *  and `.js` import specifiers (the footer segments use the `.js` convention);
 *  bun resolves both, but node's native TS type stripping does not rewrite
 *  `.js` to `.ts` and crashes on them. Falls back to the current runtime when
 *  bun is not on PATH. */
function paneViewerRuntime(): string {
	if (process.platform !== "win32") {
		const found = spawnSync("which", ["bun"], { encoding: "utf8" });
		const bin = (found.stdout ?? "").trim().split("\n")[0];
		if (found.status === 0 && bin && existsSync(bin)) return bin;
	}
	return process.execPath;
}

/**
 * The per-session pane manager (ADR 0001): present only when the orchestrator runs
 * inside Herdr. The pane is a display-only mirror, so the manager's failures are
 * logged to stderr and never reach the spawn path.
 */
export function paneManagerFor(
	env: HerdrEnv,
	ctx: { cwd: string; getSessionId?: () => string | undefined },
): SubagentPaneManager | undefined {
	const detection = detectHerdr(env);
	if (!detection) return undefined;
	return new SubagentPaneManager({
		herdr: new HerdrPaneControl({ bin: detection.bin }),
		mainPaneId: detection.mainPaneId,
		cwd: ctx.cwd,
		sessionId: ctx.getSessionId?.(),
		socketRoot: tmpdir(),
		viewerCommand: (sockPath) => `"${paneViewerRuntime()}" "${paneViewerPath()}" --socket "${sockPath}"`,
		log: (message) => process.stderr.write(`[subagents] ${message}\n`),
	});
}

function toolDescription(discovery: AgentDiscovery): string {
	const names = [...discovery.agents.keys()].sort();
	if (names.length === 0) return "Delegate a task to a subagent. (No agent definitions found.)";
	const list = names
		.map((name) => {
			const def = discovery.agents.get(name)!;
			return `- ${name}: ${def.description || "(no description)"}`;
		})
		.join("\n");
	return (
		`Delegate a task to an isolated subagent and wait for its report. ` +
		`One call spawns one subagent; the call blocks until the subagent finishes. ` +
		`Write the task brief self-contained — the subagent sees nothing else from this conversation.\n\n` +
		`Available agents:\n${list}`
	);
}

const SUBAGENT_RENDERERS = { renderCall: renderSubagentCall, renderResult: renderSubagentResult } as const;

export default function (pi: ExtensionAPI) {
	// ADR 0001: the session-scoped pane manager, torn down at session_shutdown.
	let paneManager: SubagentPaneManager | undefined;
	pi.on("session_start", (_event, ctx) => {
		// Extension-wide cap (§R8.3): one scheduler per session, shared by every parallel
		// subagent tool call. Config: ~/.pi/agent/configs/subagents.json.
		const deps = makeDeps(ctx);
		deps.scheduler = new SpawnScheduler(loadMaxConcurrent());
		// ADR 0001: inside Herdr every spawn mirrors into a display-only subagent pane.
		paneManager = paneManagerFor(process.env, {
			cwd: ctx.cwd,
			getSessionId: () => ctx.sessionManager?.getSessionId(),
		});
		deps.pane = paneManager;
		const executor = createSubagentExecutor(deps);
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			renderShell: "self",
			description: toolDescription(discoverAgents(discoveryDirs())),
			parameters: SubagentParams,
			executionMode: "parallel",
			execute: (_toolCallId, params, signal, onUpdate) => executor(params, signal, onUpdate),
			...SUBAGENT_RENDERERS,
		});
	});
	pi.on("session_shutdown", () => {
		paneManager?.closeAll();
		paneManager = undefined;
	});
}

function makeDeps(ctx: ExtensionContext): SubagentDeps {
	const deps: SubagentDeps = {
		resolveAgent: (name) => resolveAgent(discoverAgents(discoveryDirs()), name),
		getModel: () => ctx.model,
		getModelRegistry: () => ctx.modelRegistry as ModelRegistryLike | undefined,
		getParentThinkingLevel: () => ctx.thinkingLevel as AgentThinkingLevel | undefined,
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		overflowRoot: tmpdir(),
		getSessionId: () => ctx.sessionManager?.getSessionId(),
		scheduler: undefined as never, // assigned by the factory right after makeDeps
	};
	// Firecrawl web-research tools for researcher children (design A: injected, no bash).
	deps.researcherTools = () => createFirecrawlTools();
	// Git-history tools for scout children (§R12): scout has no bash, and this is what keeps
	// "explore the history" from meaning "dump a raw log into the context budget".
	deps.scoutTools = () => createGitTools();
	return deps;
}

/** Bundled definitions live next to this module; user overrides in <agentDir>/agents. */
function discoveryDirs() {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	return {
		bundledDir: `${moduleDir}/agents`,
		userDir: `${getAgentDir()}/agents`,
	};
}

function loadMaxConcurrent(): number {
	const configPath = `${getAgentDir()}/configs/subagents.json`;
	let raw: string | undefined;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		raw = undefined;
	}
	return parseMaxConcurrent(raw) ?? DEFAULT_MAX_CONCURRENT;
}
