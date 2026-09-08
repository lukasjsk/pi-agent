const MAX_PARENT_CONTEXT_BYTES = 36 * 1024;
const OMITTED_MARKER = "[Earlier parent-session messages omitted by the subagent extension.]";
const TRUNCATED_MARKER = "\n[Message truncated by the subagent extension.]";

interface ContextMessage {
	role?: string;
	content?: unknown;
	summary?: unknown;
}

function utf8Prefix(text: string, maxBytes: number): string {
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;

	// Never split a UTF-16 surrogate pair. Node encodes a lone surrogate as a
	// replacement character, so byte-length checking alone is not sufficient.
	if (
		end > 0 &&
		end < text.length &&
		text.charCodeAt(end - 1) >= 0xd800 &&
		text.charCodeAt(end - 1) <= 0xdbff &&
		text.charCodeAt(end) >= 0xdc00 &&
		text.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return text.slice(0, end);
}

function truncateUtf8(text: string, maxBytes: number, marker = TRUNCATED_MARKER): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(marker, "utf8") >= maxBytes) return utf8Prefix(text, maxBytes);
	const contentBudget = maxBytes - Buffer.byteLength(marker, "utf8");
	return `${utf8Prefix(text, contentBudget)}${marker}`;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => {
			if (part?.type === "text") return part.text ?? "";
			if (part?.type === "toolCall") return `Tool call: ${part.name ?? "unknown"}\n${JSON.stringify(part.arguments ?? {})}`;
			if (part?.type === "toolResult") return `Tool result: ${typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "")}`;
			return typeof part === "string" ? part : "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatMessage(message: ContextMessage): string | null {
	const role = message.role;
	if (role === "compactionSummary" || role === "branchSummary") {
		const summary = typeof message.summary === "string" ? message.summary : contentText(message.content);
		return summary ? `## Compaction summary\n${summary}` : null;
	}
	const text = contentText(message.content);
	if (!text) return null;
	const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "toolResult" ? "Tool result" : "Tool";
	return `## ${label}\n${text}`;
}

/**
 * Format Pi's already rebuilt active context for a delegated child. Callers
 * must pass messages from buildContextEntries() via sessionEntryToContextMessages(),
 * which ensures a compaction summary replaces its pre-compaction transcript.
 */
export function formatParentContext(messages: readonly ContextMessage[]): string {
	const sections = messages.map(formatMessage).filter((section): section is string => section !== null);
	if (sections.length === 0) return "";

	const header = [
		"# Parent session context",
		"The following is bounded reference context from the parent session. Use it to understand the assigned task; follow the assigned task and current instructions if they conflict.",
	].join("\n");
	const headerBytes = Buffer.byteLength(`${header}\n\n`, "utf8");
	const omittedBytes = Buffer.byteLength(`\n\n${OMITTED_MARKER}`, "utf8");
	let remaining = MAX_PARENT_CONTEXT_BYTES - headerBytes - omittedBytes;
	const retained: string[] = [];
	let omitted = false;

	// Compaction summaries encode all older discarded context, so preserve them
	// before retaining the newest post-compaction messages.
	const summaryIndex = sections.findIndex((section) => section.startsWith("## Compaction summary\n"));
	if (summaryIndex >= 0) {
		const summary = sections[summaryIndex];
		const kept = truncateUtf8(summary, Math.max(0, remaining));
		if (kept !== summary) omitted = true;
		if (kept) {
			retained.push(kept);
			remaining -= Buffer.byteLength(kept, "utf8");
		}
	}

	for (let index = sections.length - 1; index >= 0; index--) {
		if (index === summaryIndex) continue;
		const section = sections[index];
		const separatorBytes = retained.length > 0 ? 2 : 0;
		const bytes = Buffer.byteLength(section, "utf8") + separatorBytes;
		if (bytes <= remaining) {
			retained.unshift(section);
			remaining -= bytes;
		} else {
			// Preserve a useful prefix of the newest message that cannot wholly fit.
			// Older messages will be marked as omitted below.
			const partial = truncateUtf8(section, Math.max(0, remaining - separatorBytes));
			if (partial) {
				retained.unshift(partial);
				remaining -= Buffer.byteLength(partial, "utf8") + separatorBytes;
			}
			omitted = true;
		}
	}

	// Summary must remain first even when newer messages were prepended above.
	if (summaryIndex >= 0 && retained.length > 1) {
		const summary = retained.find((section) => section.startsWith("## Compaction summary\n"));
		if (summary) {
			retained.splice(retained.indexOf(summary), 1);
			retained.unshift(summary);
		}
	}
	const body = retained.join("\n\n");
	return `${header}\n\n${body}${omitted ? `\n\n${OMITTED_MARKER}` : ""}`;
}

/** Prepend parent-session reference context ahead of handovers and the task. */
export function withParentContext(task: string, parentContext: string): string {
	return parentContext ? `${parentContext}\n\n${task}` : task;
}

export { MAX_PARENT_CONTEXT_BYTES };
