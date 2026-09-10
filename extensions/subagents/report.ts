// Structured output contract (spec §R7): every child report is a markdown body
// plus a fenced JSON footer with relay-critical fields. Pure module — no pi imports.
//
// Graceful degradation: an unparseable or missing footer is a warning, never a
// spawn failure — the whole report becomes the result and all fields default empty.

export interface OpenQuestion {
	question: string;
	whyItMatters: string;
}

export interface DecisionPoint {
	decision: string;
	rationale: string;
}

export interface StructuredFooter {
	openQuestions: OpenQuestion[];
	decisionPoints: DecisionPoint[];
	filesTouched: string[];
}

export const EMPTY_FOOTER: StructuredFooter = { openQuestions: [], decisionPoints: [], filesTouched: [] };

export interface ParsedReport {
	/** The markdown body with the footer stripped (the whole report on degradation). */
	result: string;
	/** Parsed footer fields; empty arrays on degradation. */
	footer: StructuredFooter;
	/** Present when the footer was missing or unparseable. */
	warning?: string;
}

/** Matches a fenced ```json block that ends the report (allowing trailing whitespace). */
const FOOTER_RE = /\n?```json\s*\n([\s\S]*?)\n```\s*$/;

/** Parse the structured output footer off the end of a child's report. Never throws. */
export function parseStructuredReport(report: string): ParsedReport {
	const match = report.match(FOOTER_RE);
	if (!match) {
		return { result: report.trim(), footer: { ...EMPTY_FOOTER }, warning: "no JSON footer on the report" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch (error) {
		return {
			result: report.trim(),
			footer: { ...EMPTY_FOOTER },
			warning: `unparseable JSON footer (${error instanceof Error ? error.message : String(error)}); using the raw report`,
		};
	}
	const footer = normalizeFooter(parsed);
	if (typeof footer === "string") {
		return {
			result: report.trim(),
			footer: { ...EMPTY_FOOTER },
			warning: `unparseable JSON footer (${footer}); using the raw report`,
		};
	}
	return { result: report.slice(0, match.index ?? 0).trim(), footer };
}

/** Returns a StructuredFooter, or an error string describing the first shape violation. */
function normalizeFooter(parsed: unknown): StructuredFooter | string {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return "footer is not a JSON object";
	}
	const raw = parsed as Record<string, unknown>;
	const openQuestions = normalizePairs(raw.openQuestions, "openQuestions", "question", "whyItMatters");
	if (typeof openQuestions === "string") return openQuestions;
	const decisionPoints = normalizePairs(raw.decisionPoints, "decisionPoints", "decision", "rationale");
	if (typeof decisionPoints === "string") return decisionPoints;
	let filesTouched: string[];
	if (raw.filesTouched === undefined) {
		filesTouched = [];
	} else if (Array.isArray(raw.filesTouched) && raw.filesTouched.every((f) => typeof f === "string")) {
		filesTouched = raw.filesTouched.map((f) => (f as string).trim()).filter((f) => f);
	} else {
		return "filesTouched must be an array of strings";
	}
	return { openQuestions, decisionPoints, filesTouched };
}

function normalizePairs(
	value: unknown,
	field: string,
	leftKey: string,
	rightKey: string,
): { [K in typeof leftKey | typeof rightKey]: string }[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return `${field} must be an array`;
	const pairs: { [K: string]: string }[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return `${field} entries must be objects`;
		}
		const record = item as Record<string, unknown>;
		const left = record[leftKey];
		const right = record[rightKey];
		if (typeof left !== "string" || typeof right !== "string") {
			return `${field} entries need string "${leftKey}" and "${rightKey}"`;
		}
		pairs.push({ [leftKey]: left, [rightKey]: right });
	}
	return pairs as { [K in typeof leftKey | typeof rightKey]: string }[];
}

/** Render the footer fields as a compact section for the orchestrator's context (empty sections omitted). */
export function renderStructuredFields(footer: StructuredFooter): string {
	const sections: string[] = [];
	if (footer.openQuestions.length > 0) {
		sections.push(
			`Open questions:\n${footer.openQuestions.map((q) => `- ${q.question} — ${q.whyItMatters}`).join("\n")}`,
		);
	}
	if (footer.decisionPoints.length > 0) {
		sections.push(
			`Decision points:\n${footer.decisionPoints.map((d) => `- ${d.decision} — ${d.rationale}`).join("\n")}`,
		);
	}
	if (footer.filesTouched.length > 0) {
		sections.push(`Files touched: ${footer.filesTouched.join(", ")}`);
	}
	return sections.join("\n\n");
}
