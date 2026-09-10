// subagents — orchestrator-side tool for spawning isolated subagent sessions.
// Tracer bullet (map #12 ticket #20): one tool, blocking, bundled worker/scout,
// unknown agent = spawn error, progress relayed via onUpdate.
// Later tickets add: full schema validation (#21), model fallback (#23), structured
// output contract (#22), transport/overflow (#24), concurrency + Esc semantics (#25 —
// done: SpawnScheduler cap/queue, queued-Esc drain), worker-side restricted tool (#26),
// TUI rendering (#27).

import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverAgents, resolveAgent, THINKING_LEVELS, type AgentDefinition, type AgentDiscovery } from "./definitions.ts";
import { runSubagent, type SubagentResult } from "./spawn.ts";
import { renderStructuredFields, type StructuredFooter } from "./report.ts";
import { resolveModelChain, type ModelRegistryLike } from "./models.ts";
import { OVERFLOW_CAP_BYTES, inContextBody, newSpawnId, overflowFilePath } from "./transport.ts";
import { DEFAULT_MAX_CONCURRENT, parseMaxConcurrent, SpawnScheduler } from "./concurrency.ts";
import { EMPTY_FOOTER } from "./report.ts";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to spawn." }),
	task: Type.String({
		description:
			"Self-contained brief for the subagent. This is the entire context the child receives — " +
			"include everything it needs (goal, relevant file paths, excerpts of prior results).",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Leave unset unless the user explicitly requests a specific model. When set, a "provider/model-id" ' +
				'(e.g. "github-copilot/gpt-5.6-terra") replaces the agent\'s configured model fallback list entirely.',
		}),
	),
	thinkingLevel: Type.Optional(
		Type.String({
			description: `Leave unset unless the user explicitly asks for a thinking level. ` +
				`When set, one of: ${THINKING_LEVELS.join(" | ")}; clamped to the model's capabilities by the platform.`,
		}),
	),
});

export type SubagentToolDetails =
	| { status: "running"; progress: string }
	| ({ status: SubagentResult["status"] } & SubagentResult);

export interface SubagentDeps {
	resolveAgent: (name: string) => AgentDefinition;
	getModel: () => unknown; // parent's current model (platform Model); undefined in tests
	getModelRegistry: () => ModelRegistryLike | undefined; // ctx.modelRegistry; undefined in tests
	cwd: string;
	agentDir: string;
	/** Root for §R8 overflow files (defaults to the OS temp dir). */
	overflowRoot: string;
	/** Parent session id for the overflow path; absent in tests. */
	getSessionId?: () => string | undefined;
	/** Extension-wide spawn cap + queue (§R8.3–R8.4). Shared across all parallel tool calls. */
	scheduler: SpawnScheduler;
}

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
		params: { agent: string; task: string; model?: string; thinkingLevel?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }) => void) | undefined,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }> {
		let definition: AgentDefinition;
		try {
			definition = deps.resolveAgent(params.agent);
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

		// Model fallback pipeline (§R4): resolve the ordered chain before spawning.
		let modelChain;
		let modelDiagnostics: string[] = [];
		try {
			const resolved = resolveModelChain({
				definitionModel: definition.model,
				overrideModel,
				parentModel: deps.getModel(),
				registry: deps.getModelRegistry(),
			});
			modelChain = resolved.chain;
			modelDiagnostics = resolved.diagnostics;
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}

		const result = await deps.scheduler.run(
			() =>
				runSubagent({
					definition,
					task: params.task,
					cwd: deps.cwd,
					agentDir: deps.agentDir,
					modelChain,
					modelDiagnostics,
					thinkingLevel: thinkingOverride as never,
					signal,
					onProgress: onUpdate
						? (text) => onUpdate({ content: [{ type: "text", text: `[${definition.name}] ${text}` }], details: { status: "running", progress: text } })
						: undefined,
				}),
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
		return { content: [{ type: "text", text }], details: { status: result.status, ...result } };
	};
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Extension-wide cap (§R8.3): one scheduler per session, shared by every parallel
		// subagent tool call. Config: ~/.pi/agent/configs/subagents.json { maxConcurrent }.
		const scheduler = new SpawnScheduler(loadMaxConcurrent());
		const executor = createSubagentExecutor({ ...makeDeps(ctx), scheduler });
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: toolDescription(discoverAgents(discoveryDirs())),
			parameters: SubagentParams,
			executionMode: "parallel",
			execute: (_toolCallId, params, signal, onUpdate) => executor(params, signal, onUpdate),
		});
	});
}

function makeDeps(ctx: ExtensionContext): SubagentDeps {
	return {
		resolveAgent: (name) => resolveAgent(discoverAgents(discoveryDirs()), name),
		getModel: () => ctx.model,
		getModelRegistry: () => ctx.modelRegistry as ModelRegistryLike | undefined,
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		overflowRoot: tmpdir(),
		getSessionId: () => ctx.sessionManager?.getSessionId(),
	};
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
