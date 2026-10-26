// Pane event protocol (ADR 0001) — the wire contract between the orchestrator's
// pane event server and the pane viewer. Newline-delimited JSON over a local unix
// socket; the orchestrator (in-process extension) is the server, the viewer is the
// client. The pane is a display-only mirror: this stream is a pure projection of
// the events the spawn already relays, and nothing on it ever feeds back into the
// run.

import type { SubagentActivity, SubagentStatus } from "../spawn.ts";

/** The pane stays open this long after the run settles, counting down visibly. */
export const PANE_CLOSE_DELAY_MS = 15_000;

/** Relay cap for the child's report preview shown in the pane after settle. */
export const PANE_REPORT_PREVIEW_CHARS = 4096;

export interface PaneHelloEvent {
	type: "hello";
	/** The agent definition's name (worker, scout, researcher, user-defined). */
	agent: string;
	spawnId: string;
	/** Head of the task brief, for orientation only. */
	taskPreview?: string;
}

/** A snapshot of the child's live activity (same shape the tool call's live relay uses). */
export interface PaneActivityEvent {
	type: "activity";
	progress: string;
	toolCalls: readonly { toolCallId: string; toolName: string; summary: string; status: "running" | "done" | "error" }[];
	contentLines: readonly string[];
	model?: string;
	effectiveThinkingLevel?: string;
	tokens?: { input: number; output: number };
	/** The child model's context window in tokens, when known. */
	contextWindow?: number;
	cost?: number;
}

export interface PaneSettledEvent {
	type: "settled";
	status: SubagentStatus;
	modelUsed?: string;
	/** Total child cost in USD across all attempts (the settled usage). */
	cost?: number;
	totalTokens?: number;
	/** Head of the child's final report for display (relay-capped). */
	reportPreview?: string;
	diagnostics: readonly string[];
	/** How long the viewer keeps the pane open after this event, counting down. */
	closeDelayMs: number;
}

export type PaneEvent = PaneHelloEvent | PaneActivityEvent | PaneSettledEvent;

export function encodePaneEvent(event: PaneEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** One decoded protocol line; malformed lines are dropped by callers. */
export function decodePaneEvent(line: string): PaneEvent | undefined {
	try {
		const value = JSON.parse(line) as PaneEvent;
		if (value && typeof value === "object" && "type" in value) return value;
		return undefined;
	} catch {
		return undefined;
	}
}

/** Head-capped report preview for the settled event: the report's summary leads. */
export function reportPreview(report: string | undefined, cap: number = PANE_REPORT_PREVIEW_CHARS): string | undefined {
	if (!report) return undefined;
	if (report.length <= cap) return report;
	return `${report.slice(0, cap)}…`;
}
