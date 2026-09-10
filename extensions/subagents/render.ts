// TUI presentation of subagent tool calls (spec §R10.5, map #12 ticket #27).
// Collapsed: one status line per child — role · task excerpt · status · elapsed · usage.
// Expanded: the full structured report — result body, decision points, open questions,
// provenance, and diagnostics each visually separate. Pure rendering logic over the
// platform's Text component (aliased by the extension loader).

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentToolDetails } from "./index.ts";

type TextComponent = InstanceType<typeof Text>;

/** Details shape: running partials vs the settled full payload. */
export type RenderDetails =
	| { status: "running"; progress: string }
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

/** One-line task excerpt, newlines flattened. */
export function excerpt(task: string, max = 48): string {
	const flat = task.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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

/** Result rendering: live status line while streaming; structured report once settled. */
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

	// Streaming: one live status line; expanded shows more of the streamed child text.
	if (options.isPartial || details?.status === "running") {
		const progress = details?.status === "running" ? details.progress : "";
		const status = liveStatus(progress);
		let line = `${statusLine(status, theme)} ${theme.fg("dim", "·")} ${role}`;
		if (elapsed) line += theme.fg("dim", ` · ${elapsed}`);
		if (progress) line += theme.fg("dim", ` · ${excerpt(progress, options.expanded ? 160 : 60)}`);
		return new Text(line, 0, 0);
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
