// frame.ts — the pane viewer's pure frame builder (ADR 0001). The viewer's
// entire screen content is computed here from state; viewer.ts only does I/O
// (socket, terminal, mouse, timers). The pane is a display-only mirror:
// nothing in this module feeds back into the run.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { IconSet } from "../../footer/icons.ts";
import type { SegmentContext } from "../../footer/types.ts";
import { getDefaultColors } from "../../footer/theme.ts";
import { modelSegment } from "../../footer/segments/model.ts";
import { contextPctSegment } from "../../footer/segments/context.ts";
import { costSegment } from "../../footer/segments/cost.ts";
import type { PaneActivityEvent, PaneSettledEvent } from "./protocol.ts";

/** The full state the pane's screen content is computed from. */
export interface FrameState {
	/** Latest activity snapshot (coalesced server-side). */
	activity?: PaneActivityEvent;
	/** Set once; the run has settled. */
	settled?: PaneSettledEvent;
	/** Present while the post-settle countdown runs. */
	countdownSeconds?: number;
	width: number;
}

/**
 * The lines of a buffer to draw: the last `height` lines when following the
 * tail (offsetFromBottom 0). A positive offsetFromBottom shifts the window up
 * (scrollback); the window sticks at line 0 and never indexes below it.
 * Returns the available lines, never padded; total for non-negative input.
 */
export function visibleSlice(lines: string[], height: number, offsetFromBottom: number): string[] {
	const h = Math.max(0, Math.floor(height));
	if (h === 0 || lines.length === 0) return [];
	let bottom = lines.length - 1 - Math.max(0, Math.floor(offsetFromBottom));
	let top = bottom - h + 1;
	if (top < 0) {
		top = 0;
		bottom = Math.min(h - 1, lines.length - 1);
	}
	return lines.slice(top, bottom + 1);
}

/**
 * Minimal Theme for the pane header: the viewer is not a pi session, so named
 * theme colors all render as dim ANSI; hex colors are handled inline by
 * applyColor and never reach fg.
 */
function paneTheme(): Theme {
	return {
		fg: (_name: Parameters<Theme["fg"]>[0], text: string): string => `\x1b[2m${text}\x1b[0m`,
	} as unknown as Theme;
}

/** Split a "provider/id" model ref; a bare id has no provider. */
function parseModelRef(raw: string | undefined): SegmentContext["model"] {
	if (!raw) return undefined;
	const slash = raw.indexOf("/");
	if (slash < 0) return { id: raw };
	return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

/** The segment context for the pane header, built from the frame state. */
function buildSegmentContext(state: FrameState): SegmentContext {
	const tokens = state.activity?.tokens;
	const contextTokens = tokens?.input ?? 0;
	const contextWindow = state.activity?.contextWindow ?? 0;
	const contextPercent = contextWindow > 0 ? Math.min(100, (contextTokens / contextWindow) * 100) : 0;
	return {
		// The settled event is authoritative once it arrives: modelUsed reflects the
		// model that produced the report (which may differ after fallback), just as
		// settled.cost supersedes the live snapshot's cost.
		model: parseModelRef(state.settled?.modelUsed ?? state.activity?.model),
		thinkingLevel: state.activity?.effectiveThinkingLevel ?? "off",
		usageStats: {
			input: tokens?.input ?? 0,
			output: tokens?.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: state.settled?.cost ?? state.activity?.cost ?? 0,
		},
		subagentCosts: {},
		providerUsage: undefined,
		isLocalModel: false,
		usingSubscription: false,
		sessionId: undefined,
		sessionStartTime: 0,
		git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
		options: {},
		icons: {} as IconSet,
		width: state.width,
		colors: getDefaultColors(),
		theme: paneTheme(),
		contextTokens,
		contextWindow,
		contextPercent,
	};
}

/**
 * The pane header (GLOSSARY): the child's model, its context occupancy, and its
 * accumulated cost — the footer's segments rendered at the top of the pane.
 * Visible segments join with single spaces into one ANSI string.
 */
export function buildPaneHeader(state: FrameState): string {
	const ctx = buildSegmentContext(state);
	return [modelSegment, contextPctSegment, costSegment]
		.map((segment) => segment.render(ctx))
		.filter((rendered) => rendered.visible)
		.map((rendered) => rendered.content)
		.join(" ");
}

/** Status markers for tool-call summaries, mirroring the orchestrator TUI's rows. */
const TOOL_STATUS_MARKERS = { done: "✓", error: "✗", running: "◦" } as const;

/**
 * The scrollable body content, plain (no-ANSI) lines in order:
 *   - while not settled: one line per tool-call summary (oldest first), then the
 *     snapshot's content lines
 *   - once settled: the status line (plus the model used, when present), one
 *     diagnostic line each, then the report preview split on newlines
 */
export function activityLines(state: FrameState): string[] {
	const lines: string[] = [];
	if (state.settled) {
		const { status, modelUsed, diagnostics, reportPreview } = state.settled;
		lines.push(modelUsed ? `settled: ${status} · model: ${modelUsed}` : `settled: ${status}`);
		for (const diagnostic of diagnostics) lines.push(`· ${diagnostic}`);
		if (reportPreview) lines.push(...reportPreview.split("\n"));
		return lines;
	}
	const activity = state.activity;
	if (!activity) return lines;
	for (const call of activity.toolCalls) {
		lines.push(`${TOOL_STATUS_MARKERS[call.status]} ${call.toolName}${call.summary ? ` ${call.summary}` : ""}`);
	}
	lines.push(...activity.contentLines);
	return lines;
}

/**
 * The scrollable body buffer: the activity lines, plus the countdown line while
 * the post-settle countdown runs. The single home of the "closing in <n>s" line.
 */
export function paneBody(state: FrameState): string[] {
	const lines = activityLines(state);
	if (state.settled && state.countdownSeconds !== undefined) {
		lines.push(`closing in ${state.countdownSeconds}s`);
	}
	return lines;
}

/**
 * The full lines to draw top-to-bottom: the pane header, a blank line, then the
 * body buffer (activity lines plus the countdown line while it runs).
 */
export function buildFrame(state: FrameState): string[] {
	return [buildPaneHeader(state), "", ...paneBody(state)];
}

/** Length of the escape sequence starting at line[i] (line[i] === "\x1b"). */
function escapeLength(line: string, i: number): number {
	const next = line[i + 1] ?? "";
	if (next === "[") {
		// CSI: parameters, then a final byte in 0x40–0x7e.
		for (let j = i + 2; j < line.length; j++) {
			const code = line.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j - i + 1;
		}
		return line.length - i;
	}
	if (next === "]") {
		// OSC: ends at BEL or a ST (\x1b\\).
		for (let j = i + 2; j < line.length; j++) {
			if (line[j] === "\x07") return j - i + 1;
			if (line[j] === "\x1b" && line[j + 1] === "\\") return j - i + 2;
		}
		return line.length - i;
	}
	// Single-character escape (e.g. \x1b7 save cursor).
	return next ? 2 : 1;
}

/**
 * Cut a line to `width` terminal columns. ANSI escape sequences are zero-width
 * and never split: the cut lands between visible characters, and an escape that
 * would not fully fit is dropped with its (absent) text.
 */
export function truncateToWidth(line: string, width: number): string {
	if (width <= 0) return "";
	let count = 0;
	let i = 0;
	while (i < line.length && count < width) {
		if (line[i] === "\x1b") {
			i += escapeLength(line, i);
			continue;
		}
		count++;
		i++;
	}
	return line.slice(0, i);
}
