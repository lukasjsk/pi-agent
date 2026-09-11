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
import { toolCallSummary } from "./summary.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** One tool call of a running child, digested to a single line (CONTEXT.md "Tool-call summary"). */
export interface SubagentToolCallSummary {
	toolCallId: string;
	toolName: string;
	/** The call's single primary target: file path, command head, task excerpt, or URL. */
	summary: string;
	status: "running" | "done" | "error";
}

/** The child's live activity, relayed into the orchestrator's onUpdate (CONTEXT.md
 *  "Tool-call summary" / "Content line"). `progress` keeps the legacy flat digest
 *  (tool names + streamed tail) that drives the queued check and the partial
 *  content text; the structured fields drive the richer live rows. */
export interface SubagentActivity {
	progress: string;
	toolCalls: readonly SubagentToolCallSummary[];
	/** Raw, unwrapped lines of the child's visible generated text (assistant text only), tail-most last. */
	contentLines: readonly string[];
	/** The child's current model as "provider/id". */
	model?: string;
	/** Effective thinking level after the platform's clamp (§R11.5 live payload). */
	effectiveThinkingLevel?: string;
	/** Running token totals (assistant messages so far); display-only (§R11.5). */
	tokens?: { input: number; output: number };
	/** Best-effort accumulated child cost in USD; absent until the first usage-bearing message.
	 *  Display-only — the settled ChildUsage is the single accounting source (§R11.6). */
	cost?: number;
}

export type SubagentStatus = "completed" | "failed" | "cancelled";

/** pi-ai `Usage`-shaped totals from the child's getSessionStats(). Cost components other
 *  than `total` are unavailable at session granularity and are reported as 0. */
export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface SubagentResult {
	status: SubagentStatus;
	/** The agent definition's name; lets the footer attribute cost per child role. */
	agent: string;
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
	/** §R8: set when the report overflowed to a temp file referenced in the in-context result. */
	overflowPath?: string;
	/** Total child-session usage (assistant messages + nested tool results), from getSessionStats();
	 *  returned on the tool result so /session, RPC, and the footer reflect it (research doc §6).
	 *  Usage from failed fallback attempts folds in here (§R11.6). */
	usage?: ChildUsage;
	/** The child's full tool-call list for the settled expanded view (§R11.5): capped at
	 *  CALLS_CAP with the oldest dropped; callsOmitted counts what did not fit. */
	calls?: readonly SubagentToolCallSummary[];
	/** How many tool calls fell off the front of the cap (absent when none). */
	callsOmitted?: number;
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
	/** Live child activity relay into the tool call's rendering via onUpdate. */
	onActivity?: (activity: SubagentActivity) => void;
	/** Custom tools injected into the child session (§R10.6: worker → restricted scout tool).
	 *  Their names are appended to the tools allowlist per the SDK contract; only the caller
	 *  (orchestrator executor) decides which definitions get them — depth stays 1. */
	childTools?: ToolDefinition[];
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
/** Activity relay bounds: content lines kept per update and per-line payload cap (raw display
 *  caps are applied at render time, see CONTEXT.md "Content line"). */
const CONTENT_LINE_TAIL = 10;
const CONTENT_LINE_PAYLOAD_CAP = 200;
/** Tool-call summaries relayed per update (oldest dropped first). */
const TOOL_CALL_TAIL = 20;
/** Settled calls-list cap (§R11.5): the full list up to 1000, oldest dropped. */
const CALLS_CAP = 1000;

export async function runSubagent(options: SpawnRunOptions): Promise<SubagentResult> {
	const { definition, cwd, signal } = options;
	validateToolNames(definition);
	const agentDir = options.agentDir ?? getAgentDir();
	// Usage from failed fallback attempts folds into the returned total (§R11.6).
	let foldedUsage: ChildUsage | undefined;

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
			// The failed attempt's partial spend is real cost — fold it into the child's total
			// and note it in diagnostics (§R11.6).
			foldedUsage = mergeUsage(foldedUsage, result.usage);
			const failedOn = model ? refId(model) : "the platform default model";
			const nextOn = chain[attempt + 1] ? refId(chain[attempt + 1]!) : "the platform default model";
			const spent = result.usage?.cost.total;
			diagnostics.push(
				`runtime failure on ${failedOn}; partial progress discarded` +
					(spent ? ` ($${spent.toFixed(4)} of partial usage folded into the child's total)` : "") +
					`, retrying on ${nextOn}`,
			);
			fallbackFrom.push(model ? refId(model) : "platform default");
			continue;
		}

		return {
			...result,
			usage: mergeUsage(foldedUsage, result.usage),
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
	const { definition, task, cwd, signal, onActivity } = options;

	// §R10.6: injected custom tools ride alongside the definition's allowlist — the SDK
	// requires every custom tool name to be included in `tools` for it to be enabled.
	const injected = options.childTools ?? [];

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		tools: injected.length > 0 ? [...definition.tools, ...injected.map((tool) => tool.name)] : definition.tools,
		customTools: injected.length > 0 ? injected : undefined,
		model: model as Model | undefined,
		thinkingLevel, // platform clamps to model capabilities; re-clamps on fallback switch (§R9.4)
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
	});

	let streamed = "";
	const activity: string[] = [];
	const toolCalls: SubagentToolCallSummary[] = [];
	let costTotal = 0;
	let costSeen = false;
	let tokensIn = 0;
	let tokensOut = 0;
	let tokensSeen = false;

	/** Raw tail of the child's visible generated text (assistant text only — thinking
	 *  deltas never reach here since only text_delta is accumulated). */
	const contentLines = (): string[] =>
		streamed
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.slice(-CONTENT_LINE_TAIL)
			.map((line) => (line.length > CONTENT_LINE_PAYLOAD_CAP ? `${line.slice(0, CONTENT_LINE_PAYLOAD_CAP)}…` : line));

	const emitActivity = () => {
		if (!onActivity) return;
		const toolNames = activity.slice(-3).join(", ");
		const tail = streamed.slice(-PROGRESS_TAIL_CHARS);
		onActivity({
			progress: `${toolNames ? `tools: ${toolNames} · ` : ""}${tail}`,
			toolCalls: toolCalls.slice(-TOOL_CALL_TAIL).map((call) => ({ ...call })),
			contentLines: contentLines(),
			model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			effectiveThinkingLevel: effectiveThinkingLevel(session),
			tokens: tokensSeen ? { input: tokensIn, output: tokensOut } : undefined,
			cost: costSeen ? costTotal : undefined,
		});
	};
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			if (event.assistantMessageEvent.type === "text_delta") {
				streamed += event.assistantMessageEvent.delta;
				emitActivity();
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			activity.push(event.toolName);
			toolCalls.push({
				toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : `${event.toolName}#${toolCalls.length}`,
				toolName: event.toolName,
				summary: toolCallSummary(event.toolName, event.args),
				status: "running",
			});
			emitActivity();
			return;
		}
		if (event.type === "tool_execution_end") {
			// Match by id, falling back to the oldest still-running call of the same name
			// (mocked sessions may omit ids).
			const call =
				(typeof event.toolCallId === "string" && toolCalls.find((c) => c.toolCallId === event.toolCallId)) ||
				toolCalls.find((c) => c.toolName === event.toolName && c.status === "running");
			if (call) call.status = event.isError ? "error" : "done";
			emitActivity();
			return;
		}
		if (event.type === "message_end") {
			// Live relay (display-only, §R11.5–R11.6): assistant-message usage — the same
			// buckets the platform's getSessionStats() sums, minus nested tool results,
			// which ride scout tool results instead of message_end (research doc §2–§3).
			const usage = (
				event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined
			)?.usage;
			if (usage) {
				if (typeof usage.input === "number" && usage.input > 0) {
					tokensIn += usage.input;
					tokensSeen = true;
				}
				if (typeof usage.output === "number" && usage.output > 0) {
					tokensOut += usage.output;
					tokensSeen = true;
				}
				const total = usage.cost?.total;
				if (typeof total === "number" && total > 0) {
					costTotal += total;
					costSeen = true;
				}
				emitActivity();
			}
			return;
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
			agent: definition.name,
			report: parsed.result,
			footer: parsed.footer,
			diagnostics: attemptDiagnostics,
			modelUsed,
			requestedThinkingLevel: thinkingLevel,
			effectiveThinkingLevel: effectiveThinkingLevel(session),
			usage: childUsage(session),
			...settledCalls(toolCalls),
		};
	} catch (error) {
		attemptDiagnostics.push(`child failed: ${error instanceof Error ? error.message : String(error)}`);
		return {
			status: "failed",
			agent: definition.name,
			report: streamed,
			footer: { openQuestions: [], decisionPoints: [], filesTouched: [] },
			diagnostics: attemptDiagnostics,
			modelUsed: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			requestedThinkingLevel: thinkingLevel,
			effectiveThinkingLevel: effectiveThinkingLevel(session),
			usage: childUsage(session),
			...settledCalls(toolCalls),
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

/** Settled calls list (§R11.5): the full list up to CALLS_CAP, oldest dropped first; the
 *  omission count rides alongside so the renderer can draw the marker. Content lines are
 *  not carried — the report supersedes them at settle. */
function settledCalls(calls: readonly SubagentToolCallSummary[]): {
	calls: readonly SubagentToolCallSummary[];
	callsOmitted?: number;
} {
	const omitted = Math.max(0, calls.length - CALLS_CAP);
	return {
		calls: omitted > 0 ? calls.slice(omitted) : [...calls],
		callsOmitted: omitted > 0 ? omitted : undefined,
	};
}

/** Per-field usage sum; used to fold failed fallback attempts into the returned total (§R11.6). */
function mergeUsage(a: ChildUsage | undefined, b: ChildUsage | undefined): ChildUsage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/** Total child usage, read once after the run (before dispose); mirrors /session + RPC
 *  accounting (research doc §6). Absent on mocked sessions without getSessionStats(). */
function childUsage(session: {
	getSessionStats?: () => { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number };
}): ChildUsage | undefined {
	const stats = session.getSessionStats?.();
	if (!stats) return undefined;
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
	};
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
