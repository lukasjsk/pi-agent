// subagents — orchestrator-side tool for spawning isolated subagent sessions.
// Tracer bullet (map #12 ticket #20): one tool, blocking, bundled worker/scout,
// unknown agent = spawn error, progress relayed via onUpdate.
// Later tickets add: full schema validation (#21), model fallback (#23), structured
// output contract (#22), transport/overflow (#24), concurrency + Esc semantics (#25),
// worker-side restricted tool (#26), TUI rendering (#27).

import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, resolveAgent, THINKING_LEVELS, type AgentDefinition, type AgentDiscovery } from "./definitions.ts";
import { runSubagent, type SubagentResult } from "./spawn.ts";
import { renderStructuredFields, type StructuredFooter } from "./report.ts";
import { resolveModelChain, type ModelRegistryLike } from "./models.ts";

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
}

/** Compose the tool result text: markdown body, structured fields, then extension-appended provenance. */
export function renderResultText(result: SubagentResult): string {
	const header = result.status === "completed" ? "" : `[${result.status}] `;
	const parts: string[] = [];
	const body = result.report || "(subagent returned no report text)";
	parts.push(`${header}${body}`);

	const fields = renderStructuredFields(result.footer);
	if (fields) parts.push(fields);

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
	if (provenance.length > 0) {
		parts.push(`Provenance (extension-appended):
${provenance.map((p) => `- ${p}`).join("\n")}`);
	}

	if (result.diagnostics.length > 0) {
		parts.push(`Diagnostics:
${result.diagnostics.map((d) => `- ${d}`).join("\n")}`);
	}
	return parts.join("\n\n");
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

		const result = await runSubagent({
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
		});

		const text = renderResultText(result);
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
		const executor = createSubagentExecutor(makeDeps(ctx));
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
