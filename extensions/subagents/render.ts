// TUI presentation of subagent tool calls (spec §R11 "TUI observability", map #30).
// The row renders its own shell (`renderShell: "self"`): a DynamicBorder in a
// role/status color frames the whole row — role color while running (accent worker,
// muted scout), status color when settled — with no background tint, constant across
// states (§R11.1). Collapsed: line 1 of the two-line header is the static role ·
// task-excerpt (renderSubagentCall); line 2 (model · effective thinking · elapsed ·
// running tokens · live cost) plus recent tool-call summaries and the last three
// content lines stream in the result slot. Expanded shows every relayed row/line;
// settled expanded is the hybrid: report body, structured footer, provenance, and
// the full persisted tool-call list. Pure rendering logic over the platform's
// Text component and DynamicBorder.

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentToolDetails } from "./index.ts";
import { excerpt } from "./summary.ts";

/** Re-exported for existing importers; the digest helpers live in summary.ts. */
export { excerpt } from "./summary.ts";

type TextComponent = InstanceType<typeof Text>;

/** Details shape: running partials vs the settled full payload (§R11.5).
 *
 * The running branch carries the child's live activity relay: `toolCalls` are
 * per-call one-line summaries with status markers, `contentLines` the raw tail of
 * the child's visible generated text, `model`/`effectiveThinkingLevel`/`tokens` the
 * live provenance, `cost` the display-only accumulated cost. All optional so the
 * queued notice (nothing ran yet) can relay `progress` alone.
 */
export type RenderDetails =
	| {
			status: "running";
			progress: string;
			toolCalls?: readonly RenderToolCallSummary[];
			contentLines?: readonly string[];
			model?: string;
			effectiveThinkingLevel?: string;
			tokens?: { input: number; output: number };
			cost?: number;
	  }
	| ({
			status: "completed" | "failed" | "cancelled";
			report: string;
			footer: { openQuestions: { question: string; whyItMatters: string }[]; decisionPoints: { decision: string; rationale: string }[]; filesTouched: string[] };
			diagnostics: string[];
			modelUsed?: string;
			requestedThinkingLevel?: string;
			effectiveThinkingLevel?: string;
			fallbackFrom?: string[];
			overflowPath?: string;
			/** Full persisted tool-call list (§R11.5): cap 1000, oldest dropped. */
			calls?: readonly RenderToolCallSummary[];
			/** How many calls fell off the front of the cap (absent when none). */
			callsOmitted?: number;
	  });

export interface RenderUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
}

/** One tool call of a running child, digested to a single line (CONTEXT.md "Tool-call summary"). */
export interface RenderToolCallSummary {
	toolCallId: string;
	toolName: string;
	/** The call's single primary target: file path, command head, task excerpt, or URL. */
	summary: string;
	status: "running" | "done" | "error";
}

export interface RenderResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: RenderDetails;
	usage?: RenderUsage;
}

/** All statuses a spawn can visibly pass through (§R11.2). */
export type RenderStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

const STATUS_COLOR: Record<RenderStatus, Parameters<Theme["fg"]>[0]> = {
	queued: "muted",
	running: "accent",
	completed: "success",
	failed: "error",
	cancelled: "warning",
};

const STATUS_ICON: Record<RenderStatus, string> = {
	queued: "…",
	running: "◦",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
};

/** Per-line display cap for raw content lines (CONTEXT.md "Content line"). */
export function capLine(line: string, max = 100): string {
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Extract the child's role from the tool call args (both tool variants). */
export function roleOf(args: { agent?: string } | undefined): string {
	return args?.agent ?? "scout";
}

/** Detect the visible lifecycle state from a partial update's progress text. */
export function liveStatus(progress: string | undefined): RenderStatus {
	return progress?.startsWith("queued") ? "queued" : "running";
}

function statusLine(status: RenderStatus, theme: Theme): string {
	return theme.fg(STATUS_COLOR[status], `${STATUS_ICON[status]} ${status}`);
}

function formatTokens(usage: RenderUsage | undefined): string | undefined {
	if (!usage) return undefined;
	const total = (usage.input ?? 0) + (usage.output ?? 0);
	if (total <= 0) return undefined;
	const cached = usage.cacheRead && usage.cacheRead > 0 ? ` +${Math.round(usage.cacheRead / 100) / 10}k cached` : "";
	return `${(Math.round(total / 100) / 10).toFixed(1)}k tok${cached}`;
}

function formatElapsed(startedAt: number | undefined, endedAt?: number): string | undefined {
	if (!startedAt) return undefined;
	const ms = Math.max(0, (endedAt ?? Date.now()) - startedAt);
	if (ms < 1000) return "<1s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Frame color for the row (§R11.1): role color while running/queued — accent for the
 *  worker, muted for everything else — status color once settled. */
function borderKey(status: RenderStatus, role: string): Parameters<Theme["fg"]>[0] {
	if (status === "running" || status === "queued") return role === "worker" ? "accent" : "muted";
	return STATUS_COLOR[status];
}

/** Row-local shared state between the call and result slots (via context.state). */
interface RowFrameState {
	startedAt?: number;
	/** Current border color key; the result slot shifts it when the row settles. */
	border?: Parameters<Theme["fg"]>[0];
}

/** One framed row piece (self-shell, §R11.1): each logical line truncated to terminal
 *  width at render time (§R11.7 line-level truncation, never reflowed or merged). The
 *  border rules read the shared state's color at render time, so the running→settled
 *  shift lands on both edges even though the call slot renders before the result slot
 *  updates the state. `.text` carries the untruncated joined lines for tests. */
class FramedRow {
	readonly text: string;
	constructor(
		private readonly theme: Theme,
		private readonly state: RowFrameState,
		private readonly lines: (width: number) => string[],
		text: string,
	) {
		this.text = text;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const max = Math.max(1, width);
		return this.lines(max).map((line) => truncateToWidth(line, max));
	}
}

/** Horizontal rule in the row's current border color (the DynamicBorder contract, §R11.1). */
function borderRule(state: RowFrameState, theme: Theme, width: number): string {
	return new DynamicBorder((s: string) => theme.fg(state.border ?? "border", s)).render(width)[0] ?? "";
}

/** Header line for the tool call: the frame's top rule + line 1 of the two-line
 *  header: `role · "task excerpt"` (static for the row's lifetime, §R11.2). */
export function renderSubagentCall(
	args: { agent?: string; task: string } | undefined,
	theme: Theme,
	context: { state: Record<string, unknown>; lastComponent?: TextComponent },
): FramedRow {
	const state = context.state as RowFrameState;
	state.startedAt ??= Date.now();
	state.border ??= borderKey("running", roleOf(args));
	const line = theme.fg("toolTitle", theme.bold(roleOf(args))) + theme.fg("dim", ` · "${excerpt(args?.task ?? "")}"`);
	return new FramedRow(theme, state, (width) => [borderRule(state, theme, width), line], line);
}

/** Live collapsed view limits: recent tool rows and content lines shown (§R11.2). */
const LIVE_TOOL_ROWS = 3;
const LIVE_CONTENT_LINES = 3;

/** Result rendering: live activity view while streaming; structured report once settled. */
export function renderSubagentResult(
	result: RenderResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { state: Record<string, unknown>; args?: { agent?: string; task?: string } },
): FramedRow {
	const state = context.state as RowFrameState;
	const details = result.details;
	const elapsed = formatElapsed(state.startedAt as number | undefined);
	const tokens = formatTokens(result.usage);
	const role = roleOf(context.args);

	// Streaming: live activity view — header line, tool-call summary rows, content lines.
	// Expanded shows every relayed row/line; collapsed caps to the recent tail.
	if (options.isPartial || details?.status === "running") {
		const progress = details?.status === "running" ? details.progress : "";
		const status = liveStatus(progress);
		const live = details?.status === "running" ? details : undefined;
		const toolCalls = live?.toolCalls ?? [];
		const contentLines = live?.contentLines ?? [];
		state.border = borderKey(status, role);

		// §R11.2: the flat progress string is not part of the running row — it only
		// carries the queued notice (pre-run). Line 1 (role · task excerpt) renders
		// above via renderSubagentCall; line 2 carries the live provenance.
		const header: string[] = [statusLine(status, theme)];
		if (status === "queued") {
			header.push(theme.fg("toolTitle", roleOf(context.args)));
			if (progress) header.push(theme.fg("dim", excerpt(progress, options.expanded ? 160 : 60)));
		} else {
			if (live?.model) header.push(theme.fg("dim", live.model));
			if (live?.effectiveThinkingLevel) header.push(theme.fg("dim", live.effectiveThinkingLevel));
			if (elapsed) header.push(theme.fg("dim", elapsed));
			const runningTokens = formatTokens(
				live?.tokens ? { input: live.tokens.input, output: live.tokens.output } : undefined,
			);
			if (runningTokens) header.push(theme.fg("dim", runningTokens));
			if (live?.cost && live.cost > 0) header.push(theme.fg("dim", `$${live.cost.toFixed(4)}`));
		}

		const rows: string[] = [header.join(theme.fg("dim", " · "))];
		for (const call of options.expanded ? toolCalls : toolCalls.slice(-LIVE_TOOL_ROWS)) {
			rows.push(toolRow(call, theme));
		}
		const shown = options.expanded ? contentLines : contentLines.slice(-LIVE_CONTENT_LINES);
		for (const content of shown) {
			rows.push(`  ${theme.fg("toolOutput", capLine(content, options.expanded ? 160 : 100))}`);
		}
		return framed(state, theme, rows);
	}

	// Settled.
	const status = details?.status ?? "completed";
	state.border = borderKey(status, roleOf(context.args));
	const parts = [theme.fg(STATUS_COLOR[status], `${STATUS_ICON[status]} ${status}`), theme.fg("toolTitle", roleOf(context.args))];
	if (elapsed) parts.push(theme.fg("dim", elapsed));
	if (tokens) parts.push(theme.fg("dim", tokens));
	const rows = [parts.join(theme.fg("dim", " · "))];
	if (details && "fallbackFrom" in details && details.fallbackFrom?.length) {
		rows[0] += theme.fg("dim", ` (after fallback from ${details.fallbackFrom.join(", ")})`);
	}

	if (!options.expanded) {
		const counts: string[] = [];
		if (details && "footer" in details) {
			if (details.footer.decisionPoints.length) counts.push(`${details.footer.decisionPoints.length} decision(s)`);
			if (details.footer.openQuestions.length) counts.push(`${details.footer.openQuestions.length} question(s)`);
		}
		if (details && "diagnostics" in details && details.diagnostics.length) counts.push(`${details.diagnostics.length} diagnostic(s)`);
		if (counts.length) rows[0] += theme.fg("dim", ` · ${counts.join(", ")}`);
		if (details && "overflowPath" in details && details.overflowPath) {
			rows.push(theme.fg("warning", `full report saved to ${details.overflowPath}`));
		}
		return framed(state, theme, rows);
	}

	// Expanded: the structured report, each part visually separate (§R11.3).
	if (details && "report" in details && details.report) {
		rows.push("");
		rows.push(theme.fg("toolOutput", details.report));
	}
	if (details && "footer" in details && details.footer.decisionPoints.length) {
		rows.push("");
		rows.push(
			theme.fg("toolTitle", "Decision points") +
				"\n" +
				details.footer.decisionPoints
					.map((d) => theme.fg("text", `  • ${d.decision}`) + theme.fg("dim", ` — ${d.rationale}`))
					.join("\n"),
		);
	}
	if (details && "footer" in details && details.footer.openQuestions.length) {
		rows.push("");
		rows.push(
			theme.fg("toolTitle", "Open questions") +
				"\n" +
				details.footer.openQuestions
					.map((q) => theme.fg("text", `  ? ${q.question}`) + theme.fg("dim", ` — ${q.whyItMatters}`))
					.join("\n"),
		);
	}
	const provenance: string[] = [];
	if (details && "modelUsed" in details && details.modelUsed) provenance.push(`model: ${details.modelUsed}`);
	if (details && "requestedThinkingLevel" in details) {
		provenance.push(`thinking: requested ${details.requestedThinkingLevel ?? "(none)"}, effective ${details.effectiveThinkingLevel ?? "(unknown)"}`);
	}
	if (details && "diagnostics" in details) provenance.push(...details.diagnostics.map((d) => `note: ${d}`));
	if (provenance.length) {
		rows.push("");
		rows.push(theme.fg("dim", provenance.map((p) => `· ${p}`).join("\n")));
	}
	// The full persisted tool-call list, last section (§R11.3).
	const calls = details && "calls" in details ? details.calls : undefined;
	if (calls?.length) {
		const omitted = details && "callsOmitted" in details ? details.callsOmitted : undefined;
		const callRows: string[] = [];
		if (omitted) callRows.push(theme.fg("dim", `  … ${omitted} earlier call(s) omitted`));
		for (const call of calls) callRows.push(toolRow(call, theme));
		rows.push("");
		rows.push(theme.fg("toolTitle", "Tool calls") + "\n" + callRows.join("\n"));
	}
	return framed(state, theme, rows);
}

/** One tool-call summary row: status marker · tool name · single primary target. */
function toolRow(call: RenderToolCallSummary, theme: Theme): string {
	const icon = call.status === "running" ? STATUS_ICON.running : call.status === "error" ? STATUS_ICON.failed : STATUS_ICON.completed;
	const color = call.status === "running" ? STATUS_COLOR.running : call.status === "error" ? STATUS_COLOR.failed : STATUS_COLOR.completed;
	return `  ${theme.fg(color, icon)} ${theme.fg("toolTitle", call.toolName)}${call.summary ? theme.fg("dim", ` ${call.summary}`) : ""}`;
}

/** Wrap the row's lines with the frame's bottom rule (the top rule renders in renderSubagentCall). */
function framed(state: RowFrameState, theme: Theme, rows: string[]): FramedRow {
	return new FramedRow(theme, state, (width) => [...rows, borderRule(state, theme, width)], rows.join("\n"));
}