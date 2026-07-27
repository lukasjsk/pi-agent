export interface Handover {
	version: 1;
	agent: string;
	task: string;
	markdown: string;
	createdAt: number;
}

export interface HandoverSource {
	agent: string;
	task: string;
	markdown: string;
	createdAt?: number;
}

const MAX_HANDOVER_BYTES = 12 * 1024;
const MAX_CONTEXT_BYTES = 36 * 1024;

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

	let end = Math.min(text.length, maxBytes);
	while (Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
	return `${text.slice(0, end)}\n\n[Handover truncated by the subagent extension.]`;
}

/** Create the durable, branch-aware record stored in a subagent tool result. */
export function createHandover(source: HandoverSource): Handover {
	return {
		version: 1,
		agent: source.agent,
		task: source.task,
		markdown: truncateUtf8(source.markdown || "(The subagent produced no final report.)", MAX_HANDOVER_BYTES),
		createdAt: source.createdAt ?? Date.now(),
	};
}

/**
 * Build the context prepended to each child task. The most recent handovers
 * win when the total context budget is reached, so implementation and review
 * reports are retained over older reconnaissance.
 */
export function formatHandoverContext(handovers: Handover[]): string {
	if (handovers.length === 0) return "";

	const sections: string[] = [];
	let used = 0;
	for (const handover of [...handovers].reverse()) {
		const section = [
			`## ${handover.agent} handover`,
			`Delegated task: ${handover.task}`,
			"",
			handover.markdown,
		].join("\n");
		const bytes = Buffer.byteLength(section, "utf8");
		if (sections.length > 0 && used + bytes > MAX_CONTEXT_BYTES) continue;
		sections.unshift(section);
		used += bytes;
	}

	return [
		"# Shared handover context",
		"The reports below are authoritative context from earlier agents. Use them before re-exploring; verify only facts that are stale, ambiguous, or essential to your assigned change.",
		"",
		sections.join("\n\n---\n\n"),
	].join("\n");
}

export function withHandoverContext(task: string, handovers: Handover[]): string {
	const context = formatHandoverContext(handovers);
	return context ? `${context}\n\n# Your assigned task\n${task}` : task;
}
