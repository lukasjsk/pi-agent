// Per-agent model config (~/.pi/agent/subagents.json).
// JSON object mapping agent name → ordered list of "provider/model-id[@level]" strings.
// An absent file is a silent no-op (the spawn falls back to the parent's model); a malformed
// file or a malformed entry warns and is skipped — the config never fails a spawn.
// Pure module — no pi imports.

import { readFileSync } from "node:fs";

export interface AgentModelConfig {
	/** Agent name → ordered model list; empty when the file is absent or unusable. */
	models: Record<string, string[]>;
	/** Parse/shape issues, surfaced as spawn diagnostics. */
	warnings: string[];
}

export function loadAgentModelConfig(configPath: string): AgentModelConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		return { models: {}, warnings: [] }; // file absent → pure fallback
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { models: {}, warnings: [`${configPath}: invalid JSON ignored (${message})`] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			models: {},
			warnings: [`${configPath}: top level must be an object mapping agent names to model lists; config ignored`],
		};
	}
	const models: Record<string, string[]> = {};
	const warnings: string[] = [];
	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
		) {
			models[name] = value;
			continue;
		}
		warnings.push(
			`${configPath}: entry for "${name}" must be a non-empty list of "provider/model-id[@level]" strings; ignored`,
		);
	}
	return { models, warnings };
}
