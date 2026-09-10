// Child subagent session assembly and execution (SDK in-process, per spec §R1).
// Isolation guarantees enforced here:
//   - SessionManager.inMemory()  → ephemeral, no session file
//   - DefaultResourceLoader({ noExtensions: true }) → children never load extensions (hard rule)
//   - systemPromptOverride       → the definition body is the child's entire role prompt;
//                                  the child receives none of the parent's conversation
//   - tools                      → the definition's allowlist; unknown names fail the spawn fast
//   - cwd                        → inherited from the orchestrator, not a per-spawn override
//   - thinkingLevel              → the definition's requested level; the platform clamps to model capabilities
//   - skills                     → definition-controlled (skills: off → noSkills); context files stay ON (§R1.4)

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type Model,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentThinkingLevel } from "./definitions.ts";
import { parseStructuredReport, type StructuredFooter } from "./report.ts";

export type SubagentStatus = "completed" | "failed" | "cancelled";

export interface SubagentResult {
	status: SubagentStatus;
	/** The child's final report text (partial on cancel, streamed-so-far on failure). */
	report: string;
	/** Parsed structured-output footer (§R7); empty fields on degradation. */
	footer: StructuredFooter;
	diagnostics: string[];
	/** model actually used, "provider/id" — provenance is extension-collected, never child-authored. */
	modelUsed?: string;
	/** Requested thinking level (definition or per-spawn override), if one was set. */
	requestedThinkingLevel?: AgentThinkingLevel;
	/** Effective level after the platform's clamp to model capabilities, if the child session reports it. */
	effectiveThinkingLevel?: string;
}

export interface SpawnRunOptions {
	definition: AgentDefinition;
	/** The self-contained brief — the entire parent→child context (spec §R6.1). */
	task: string;
	cwd: string;
	/** Override for tests; defaults to getAgentDir(). */
	agentDir?: string;
	/** Model for the child; undefined lets the platform resolve from settings (fallback pipeline is ticket #23). */
	model?: Model;
	signal?: AbortSignal;
	/** Progress relay into the tool call's live rendering via onUpdate. */
	onProgress?: (text: string) => void;
}

/** Platform built-in tool names (sdk.md "Tools"). */
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

/** Unknown tool name → that agent's spawn fails fast (spec §R5.2). Throws before any session is created. */
export function validateToolNames(definition: AgentDefinition): void {
	const unknown = definition.tools.filter((t) => !BUILTIN_TOOL_NAMES.has(t));
	if (unknown.length > 0) {
		throw new Error(
			`Agent "${definition.name}" has unknown tool name(s): ${unknown.join(", ")}. ` +
				`Valid built-in tools: ${[...BUILTIN_TOOL_NAMES].join(", ")}`,
		);
	}
}

const PROGRESS_TAIL_CHARS = 300;

export async function runSubagent(options: SpawnRunOptions): Promise<SubagentResult> {
	const { definition, task, cwd, signal, onProgress } = options;
	validateToolNames(definition);
	const agentDir = options.agentDir ?? getAgentDir();

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true, // hard rule: children never load extensions (spec §R1.4)
		noThemes: true,
		noPromptTemplates: true,
		noSkills: !definition.skills, // skills: off → child skips skill discovery (spec §R2.2)
		systemPromptOverride: () => definition.systemPrompt,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		tools: definition.tools,
		model: options.model,
		thinkingLevel: definition.thinkingLevel, // platform clamps to model capabilities (spec §R2.2)
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
	});

	// Definition-level warnings (unknown fields, etc.) ride the spawn's diagnostics.
	const diagnostics: string[] = [...definition.warnings];
	let streamed = "";
	const activity: string[] = [];
	const emitProgress = () => {
		if (!onProgress) return;
		const toolNames = activity.slice(-3).join(", ");
		const tail = streamed.slice(-PROGRESS_TAIL_CHARS);
		onProgress(`${toolNames ? `tools: ${toolNames} · ` : ""}${tail}`);
	};

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			if (event.assistantMessageEvent.type === "text_delta") {
				streamed += event.assistantMessageEvent.delta;
				emitProgress();
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			activity.push(event.toolName);
			emitProgress();
		}
	});

	const onAbort = () => {
		void session.abort();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.prompt(task);

		const errorMessage = session.agent.state.errorMessage;
		if (errorMessage) {
			diagnostics.push(`child run error: ${errorMessage}`);
		}
		const aborted = signal?.aborted === true;
		if (aborted) {
			diagnostics.push("cancelled before completion; partial report returned");
		}
		const modelUsed = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		const rawReport = extractFinalText(session) || streamed;
		// Structured output contract (§R7): parse the footer off the report; degradation is a
		// warning in diagnostics — a child is never failed for format alone.
		const parsed = parseStructuredReport(rawReport);
		if (parsed.warning) diagnostics.push(parsed.warning);
		const status: SubagentStatus = aborted ? "cancelled" : errorMessage ? "failed" : "completed";
		return {
			status,
			report: parsed.result,
			footer: parsed.footer,
			diagnostics,
			modelUsed,
			requestedThinkingLevel: definition.thinkingLevel,
			effectiveThinkingLevel: effectiveThinkingLevel(session),
		};
	} catch (error) {
		diagnostics.push(`child failed: ${error instanceof Error ? error.message : String(error)}`);
		return {
			status: "failed",
			report: streamed,
			footer: { openQuestions: [], decisionPoints: [], filesTouched: [] },
			diagnostics,
			modelUsed: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			requestedThinkingLevel: definition.thinkingLevel,
			effectiveThinkingLevel: effectiveThinkingLevel(session),
		};
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}

/** The session's thinking level is post-clamp (effective); absent on mocked/partial sessions. */
function effectiveThinkingLevel(session: { thinkingLevel?: unknown }): string | undefined {
	return typeof session.thinkingLevel === "string" ? session.thinkingLevel : undefined;
}

/** The last assistant message with non-empty text is the child's report. */
function extractFinalText(session: { messages: unknown[] }): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		const text = textFromContent(message.content);
		if (text.trim()) return text;
	}
	return "";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && (block as { type?: string }).type === "text"
				? String((block as { text?: string }).text ?? "")
				: "",
		)
		.join("");
}
