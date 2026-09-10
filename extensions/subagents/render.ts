// TUI presentation of subagent tool calls (spec §R10.5, map #12 ticket #27; live view per
// CONTEXT.md "Tool-call summary" and "Content line").
// Collapsed: one status line per child — role · task excerpt · status · elapsed · usage —
// with recent tool calls as one-line summaries and the last three content lines.
// Expanded: all relayed tool rows and content lines; the full structured report once
// settled — result body, decision points, open questions, provenance, and diagnostics
// each visually separate. Pure rendering logic over the platform's Text component.

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentToolDetails } from "./index.ts";
import { excerpt } from "./summary.ts";

/** Re-exported for existing importers; the digest helpers live in summary.ts. */
export { excerpt } from "./summary.ts";

type TextComponent = InstanceType<typeof Text>;

/** Details shape: running partials vs the settled full payload.
 *
 * The running branch carries the child's live activity relay (see CONTEXT.md):
 * `toolCalls` are per-call one-line summaries with status markers, `contentLines`
 * the raw tail of the child's visible generated text, `model`/`cost` the child's
 * current model and best-effort accumulated cost. All optional so the queued
 * notice (nothing ran yet) can relay `progress` alone.
 */
export type RenderDetails =
	| {
			status: "running";
			progress: string;
			toolCalls?: readonly RenderToolCallSummary[];
			contentLines?: readonly string[];
			model?: string;
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

/** All statuses a spawn can visibly pass through (§R10.5). */
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

/** Header line for the tool call: `role · "task excerpt"` (static for the row's lifetime). */
export function renderSubagentCall(
	args: { agent?: string; task: string } | undefined,
	theme: Theme,
	context: { state: Record<string, unknown>; lastComponent?: TextComponent },
): TextComponent {
	context.state.startedAt ??= Date.now();
	const component = context.lastComponent ?? new Text("", 0, 0);
	component.setText(theme.fg("toolTitle", theme.bold(roleOf(args))) + theme.fg("dim", ` · "${excerpt(args?.task ?? "")}"`));
	return component;
}

/** Live collapsed view limits: recent tool rows and content lines shown. */
const LIVE_TOOL_ROWS = 5;
const LIVE_CONTENT_LINES = 3;

/** Result rendering: live activity view while streaming; structured report once settled. */
export function renderSubagentResult(
	result: RenderResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { state: Record<string, unknown>; args?: { agent?: string; task?: string } },
): TextComponent {
	const details = result.details;
	const role = theme.fg("toolTitle", roleOf(context.args));
	const elapsed = formatElapsed(context.state.startedAt as number | undefined);
	const tokens = formatTokens(result.usage);

	// Streaming: live activity view — status line, tool-call summary rows, content lines.
	// Expanded shows every relayed row/line; collapsed caps to the recent tail.
	if (options.isPartial || details?.status === "running") {
		const progress = details?.status === "running" ? details.progress : "";
		const status = liveStatus(progress);
		const live = details?.status === "running" ? details : undefined;
		const toolCalls = live?.toolCalls ?? [];
		const contentLines = live?.contentLines ?? [];

		let line = `${statusLine(status, theme)} ${theme.fg("dim", "·")} ${role}`;
		if (elapsed) line += theme.fg("dim", ` · ${elapsed}`);
		if (live?.model) line += theme.fg("dim", ` · ${live.model}`);
		if (live?.cost && live.cost > 0) line += theme.fg("dim", ` · $${live.cost.toFixed(3)}`);
		// The progress tail duplicates the content lines; only show it while nothing
		// richer has arrived (queued notice, no activity yet).
		if (progress && toolCalls.length === 0 && contentLines.length === 0) {
			line += theme.fg("dim", ` · ${excerpt(progress, options.expanded ? 160 : 60)}`);
		}

		const rows: string[] = [line];
		for (const call of options.expanded ? toolCalls : toolCalls.slice(-LIVE_TOOL_ROWS)) {
			const icon = call.status === "running" ? STATUS_ICON.running : call.status === "error" ? STATUS_ICON.failed : STATUS_ICON.completed;
			const color = call.status === "running" ? STATUS_COLOR.running : call.status === "error" ? STATUS_COLOR.failed : STATUS_COLOR.completed;
			rows.push(`  ${theme.fg(color, icon)} ${theme.fg("toolTitle", call.toolName)}${call.summary ? theme.fg("dim", ` ${call.summary}`) : ""}`);
		}
		const shown = options.expanded ? contentLines : contentLines.slice(-LIVE_CONTENT_LINES);
		for (const content of shown) {
			rows.push(`  ${theme.fg("toolOutput", capLine(content, options.expanded ? 160 : 100))}`);
		}
		return new Text(rows.join("\n"), 0, 0);
	}

	// Settled.
	const status = details?.status ?? "completed";
	const parts = [theme.fg(STATUS_COLOR[status], `${STATUS_ICON[status]} ${status}`), role];
	if (elapsed) parts.push(theme.fg("dim", elapsed));
	if (tokens) parts.push(theme.fg("dim", tokens));
	let text = parts.join(theme.fg("dim", " · "));
	if (details && "fallbackFrom" in details && details.fallbackFrom?.length) {
		text += theme.fg("dim", ` (after fallback from ${details.fallbackFrom.join(", ")})`);
	}

	if (!options.expanded) {
		const counts: string[] = [];
		if (details && "footer" in details) {
			if (details.footer.decisionPoints.length) counts.push(`${details.footer.decisionPoints.length} decision(s)`);
			if (details.footer.openQuestions.length) counts.push(`${details.footer.openQuestions.length} question(s)`);
		}
		if (details && "diagnostics" in details && details.diagnostics.length) counts.push(`${details.diagnostics.length} diagnostic(s)`);
		if (counts.length) text += theme.fg("dim", ` · ${counts.join(", ")}`);
		if (details && "overflowPath" in details && details.overflowPath) {
			text += `\n${theme.fg("warning", `full report saved to ${details.overflowPath}`)}`;
		}
		return new Text(text, 0, 0);
	}

	// Expanded: the structured report, each part visually separate (§R10.5).
	const sections: string[] = [text];
	const report = details && "report" in details ? details.report : "";
	if (report) sections.push(theme.fg("toolOutput", report));
	if (details && "footer" in details && details.footer.decisionPoints.length) {
		sections.push(
			theme.fg("toolTitle", "Decision points") +
				"\n" +
				details.footer.decisionPoints
					.map((d) => theme.fg("text", `  • ${d.decision}`) + theme.fg("dim", ` — ${d.rationale}`))
					.join("\n"),
		);
	}
	if (details && "footer" in details && details.footer.openQuestions.length) {
		sections.push(
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
	if (provenance.length) sections.push(theme.fg("dim", provenance.map((p) => `· ${p}`).join("\n")));
	return new Text(sections.join("\n\n"), 0, 0);
}
