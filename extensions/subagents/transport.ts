// transport.ts — result transport per spec §R8: the in-context tool result is
// capped at 10KB; oversized reports overflow to a session-scoped temp file whose
// path is referenced in the result (no auto-cleanup); the full payload rides in
// the tool result's details for TUI rendering and session replay.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** In-context result cap (spec §R8.5): 10KB ≈ 2.5k tokens. */
export const OVERFLOW_CAP_BYTES = 10 * 1024;

/** Byte length with a UTF-8 head cut that never splits a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let cut = maxBytes;
	while (cut > 0) {
		// Never land between the two halves of a surrogate pair.
		const code = text.charCodeAt(cut);
		if (code >= 0xdc00 && code <= 0xdfff) {
			cut--;
			continue;
		}
		if (Buffer.byteLength(text.slice(0, cut), "utf8") <= maxBytes) break;
		cut--;
	}
	return text.slice(0, cut);
}

/**
 * Session-scoped overflow path per §R8: <root>/pi-subagents/<session-id>/<spawn-id>.md.
 * A missing session id degrades to "unknown" (the file is still written and referenced).
 */
export function overflowFilePath(input: { root: string; sessionId?: string; spawnId: string }): string {
	return join(input.root, "pi-subagents", input.sessionId || "unknown", `${input.spawnId}.md`);
}

/** Spawn id for file naming: agent name plus a random suffix for uniqueness. */
export function newSpawnId(agentName: string): string {
	return `${agentName}-${randomUUID().slice(0, 8)}`;
}

/**
 * The marker appended to a truncated in-context body. Deliberately short so the
 * body keeps as much of the 10KB budget as possible.
 */
export function overflowMarker(path: string): string {
	return `\n\n[report truncated — in-context result capped; full report saved to ${path}]`;
}

/**
 * In-context body for an oversized report: the head of the report that fits the
 * remaining budget after reserving room for the structured fields, provenance,
 * diagnostics, and the overflow marker. If even that leaves no useful budget,
 * the body is dropped entirely in favor of the marker.
 */
export function inContextBody(fullBody: string, nonBodyBytes: number, overflowPath: string, cap = OVERFLOW_CAP_BYTES): string {
	const marker = overflowMarker(overflowPath);
	const budget = cap - nonBodyBytes - Buffer.byteLength(marker, "utf8");
	if (budget < 512) return marker;
	return `${truncateUtf8(fullBody, budget)}${marker}`;
}