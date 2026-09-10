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
import { discoverAgents, resolveAgent, type AgentDefinition, type AgentDiscovery } from "./definitions.ts";
import { runSubagent, type SubagentResult } from "./spawn.ts";

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to spawn." }),
	task: Type.String({
		description:
			"Self-contained brief for the subagent. This is the entire context the child receives — " +
			"include everything it needs (goal, relevant file paths, excerpts of prior results).",
	}),
});

export type SubagentToolDetails =
	| { status: "running"; progress: string }
	| ({ status: SubagentResult["status"] } & SubagentResult);

export interface SubagentDeps {
	resolveAgent: (name: string) => AgentDefinition;
	getModel: () => unknown; // parent's current model (platform Model); unknown in tests
	cwd: string;
	agentDir: string;
}

/** Build the tool executor against injectable deps (keeps the unit under test free of discovery I/O). */
export function createSubagentExecutor(deps: SubagentDeps) {
	return async function execute(
		params: { agent: string; task: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }) => void) | undefined,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }> {
		let definition: AgentDefinition;
		try {
			definition = deps.resolveAgent(params.agent);
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}

		const result = await runSubagent({
			definition,
			task: params.task,
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			model: deps.getModel() as never,
			signal,
			onProgress: onUpdate
				? (text) => onUpdate({ content: [{ type: "text", text: `[${definition.name}] ${text}` }], details: { status: "running", progress: text } })
				: undefined,
		});

		const header = result.status === "completed" ? "" : `[${result.status}] `;
		const diagnostics = result.diagnostics.length
			? `\n\nDiagnostics:\n${result.diagnostics.map((d) => `- ${d}`).join("\n")}`
			: "";
		const text = `${header}${result.report || "(subagent returned no report text)"}${diagnostics}`;
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
