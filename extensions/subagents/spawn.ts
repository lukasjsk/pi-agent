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
import { refId, type ModelRef } from "./models.ts";

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
	/** Resolved chain (§R4); empty/undefined lets the platform resolve from settings.
	 *  On a runtime failure the next entry retries the same task (partial progress discarded). */
	modelChain?: readonly (ModelRef | undefined)[];
	/** Skip notes from chain resolution (unauthed/uncatalogued entries). */
	modelDiagnostics?: string[];
	/** Requested thinking level (per-spawn override ?? definition); the platform clamps per model. */
	thinkingLevel?: AgentThinkingLevel;
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
	const { definition, cwd, signal } = options;
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

	const thinkingLevel = options.thinkingLevel ?? definition.thinkingLevel;
	const diagnostics: string[] = [...(options.modelDiagnostics ?? []), ...definition.warnings];
	const fallbackFrom: string[] = [];

	// One attempt per chain entry; an empty chain is a single platform-default attempt.
	const chain: readonly (ModelRef | undefined)[] =
		options.modelChain && options.modelChain.length > 0 ? options.modelChain : [undefined];

	for (let attempt = 0; attempt < chain.length; attempt++) {
		const model = chain[attempt];
		const result = await runOnce({ options, agentDir, loader, model, thinkingLevel });
		for (const d of result.diagnostics) {
			if (!diagnostics.includes(d)) diagnostics.push(d); // retry attempts repeat footer warnings; keep once
		}
		const hasNext = attempt < chain.length - 1;

		if (result.status === "failed" && hasNext) {
			// Runtime failure mid-task: discard partial progress, retry on the next entry (§R4.2).
			const failedOn = model ? refId(model) : "the platform default model";
			const nextOn = chain[attempt + 1] ? refId(chain[attempt + 1]!) : "the platform default model";
			diagnostics.push(`runtime failure on ${failedOn}; partial progress discarded, retrying on ${nextOn}`);
			fallbackFrom.push(model ? refId(model) : "platform default");
			continue;
		}

		return {
			...result,
			diagnostics,
			fallbackFrom: fallbackFrom.length > 0 ? fallbackFrom : undefined,
		};
	}
	throw new Error("unreachable: model chain loop must return");
}

interface RunOnceArgs {
	options: SpawnRunOptions;
	agentDir: string;
	loader: DefaultResourceLoader;
	model: ModelRef | undefined;
	thinkingLevel: AgentThinkingLevel | undefined;
}

/** One attempt: a fresh isolated child session on one model. */
async function runOnce(args: RunOnceArgs): Promise<SubagentResult> {
	const { options, agentDir, loader, model, thinkingLevel } = args;
	const { definition, task, cwd, signal, onProgress } = options;

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		tools: definition.tools,
		model: model as Model | undefined,
		thinkingLevel, // platform clamps to model capabilities; re-clamps on fallback switch (§R9.4)
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
	});

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

	const attemptDiagnostics: string[] = [];
	try {
		await session.prompt(task);

		const errorMessage = session.agent.state.errorMessage;
		if (errorMessage) {
			attemptDiagnostics.push(`child run error: ${errorMessage}`);
		}
		const aborted = signal?.aborted === true;
		if (aborted) {
			attemptDiagnostics.push("cancelled before completion; partial report returned");
		}
		const modelUsed = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		const rawReport = extractFinalText(session) || streamed;
		// Structured output contract (§R7): parse the footer off the report; degradation is a
		// warning in diagnostics — a child is never failed for format alone.
		const parsed = parseStructuredReport(rawReport);
		if (parsed.warning) attemptDiagnostics.push(parsed.warning);
		const status: SubagentStatus = aborted ? "cancelled" : errorMessage ? "failed" : "completed";
		return {
			status,
			report: parsed.result,
			footer: parsed.footer,
			diagnostics: attemptDiagnostics,
			modelUsed,
			requestedThinkingLevel: thinkingLevel,
			effectiveThinkingLevel: effectiveThinkingLevel(session),
		};
	} catch (error) {
		attemptDiagnostics.push(`child failed: ${error instanceof Error ? error.message : String(error)}`);
		return {
			status: "failed",
			report: streamed,
			footer: { openQuestions: [], decisionPoints: [], filesTouched: [] },
			diagnostics: attemptDiagnostics,
			modelUsed: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			requestedThinkingLevel: thinkingLevel,
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
