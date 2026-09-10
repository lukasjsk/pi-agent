// Agent definition parsing and discovery for the subagents extension.
// Pure module: no pi imports, so it is unit-testable without mocking the platform.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentSource = "bundled" | "user";

export interface AgentDefinition {
	/** Spawn identifier (frontmatter `name`). */
	name: string;
	/** When to use this agent; feeds the subagent tool description (frontmatter `description`). */
	description: string;
	/** Required tool allowlist applied at child session creation (frontmatter `tools`). */
	tools: string[];
	/** The markdown body — the agent's system prompt. */
	systemPrompt: string;
	filePath: string;
	source: AgentSource;
}

export class DefinitionError extends Error {}

/**
 * Split a markdown document into YAML frontmatter fields and body.
 * Minimal YAML subset sufficient for the closed schema: `key: value` scalars
 * (quotes stripped), inline arrays `[a, b]`, and block sequences (`- item`).
 * Returns undefined when the document has no frontmatter block.
 */
export function splitFrontmatter(contents: string): { fields: Record<string, string | string[]>; body: string } | undefined {
	const normalized = contents.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return undefined;
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) return undefined;
	const frontmatter = normalized.slice(4, end);
	let body = normalized.slice(end + 4);
	if (body.startsWith("\n")) body = body.slice(1);

	const fields: Record<string, string | string[]> = {};
	let currentKey: string | undefined;
	for (const line of frontmatter.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("- ") && currentKey) {
			const existing = fields[currentKey];
			if (Array.isArray(existing)) existing.push(parseScalar(trimmed.slice(2)));
			continue;
		}
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1).trim();
		currentKey = key;
		if (raw === "") {
			fields[key] = []; // block sequence items (if any) append below
		} else if (raw.startsWith("[") && raw.endsWith("]")) {
			fields[key] = parseInlineArray(raw);
		} else {
			fields[key] = parseScalar(raw);
		}
	}
	return { fields, body };
}

function parseScalar(raw: string): string {
	let value = raw.trim();
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		value = value.slice(1, -1);
	}
	return value;
}

function parseInlineArray(raw: string): string[] {
	const inner = raw.slice(1, -1);
	if (!inner.trim()) return [];
	return inner
		.split(",")
		.map((item) => parseScalar(item))
		.filter((item) => item.length > 0);
}

/** Parse one agent definition file's contents. Throws DefinitionError on invalid definitions. */
export function parseAgentDefinition(filePath: string, contents: string, source: AgentSource): AgentDefinition {
	const split = splitFrontmatter(contents);
	if (!split) {
		throw new DefinitionError(`${filePath}: agent definition must start with YAML frontmatter (---)`);
	}
	const name = typeof split.fields.name === "string" ? split.fields.name.trim() : "";
	if (!name) throw new DefinitionError(`${filePath}: "name" is required`);
	const tools = split.fields.tools;
	if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== "string" || !t)) {
		throw new DefinitionError(`${filePath}: "tools" is required and must be a non-empty array of tool names`);
	}
	const systemPrompt = split.body.trim();
	if (!systemPrompt) throw new DefinitionError(`${filePath}: definition body (system prompt) is empty`);
	const description = typeof split.fields.description === "string" ? split.fields.description.trim() : "";
	return { name, description, tools, systemPrompt, filePath, source };
}

export interface DiscoveryDirs {
	/** Directory of definitions shipped inside the extension. */
	bundledDir: string;
	/** Directory of user-level definitions (~/.pi/agent/agents) that override bundled ones by name. */
	userDir: string;
}

export interface AgentDiscovery {
	/** Successfully parsed definitions by name; user-level entries replace bundled ones. */
	agents: Map<string, AgentDefinition>;
	/** Parse failures keyed by file basename, so a corrupt definition fails only its own spawn. */
	problems: Map<string, string>;
}

/**
 * Discover agent definitions fresh on every call (mid-session edits take effect).
 * A corrupt file never breaks discovery of the others.
 */
export function discoverAgents(dirs: DiscoveryDirs): AgentDiscovery {
	const agents = new Map<string, AgentDefinition>();
	const problems = new Map<string, string>();

	for (const [dir, source] of [
		[dirs.bundledDir, "bundled"] as const,
		[dirs.userDir, "user"] as const,
	]) {
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
		} catch {
			continue; // directory absent — no definitions there
		}
		for (const file of files) {
			const filePath = join(dir, file);
			try {
				const def = parseAgentDefinition(filePath, readFileSync(filePath, "utf8"), source);
				agents.set(def.name, def);
				problems.delete(file);
			} catch (error) {
				problems.set(file, error instanceof Error ? error.message : String(error));
				agents.delete(basenameToName(file));
			}
		}
	}
	return { agents, problems };
}

function basenameToName(file: string): string {
	return file.replace(/\.md$/, "");
}

export class UnknownAgentError extends Error {}

/** Resolve an agent name against a discovery result. Throws UnknownAgentError with valid names. */
export function resolveAgent(discovery: AgentDiscovery, name: string): AgentDefinition {
	const def = discovery.agents.get(name);
	if (def) return def;
	const problem = discovery.problems.get(`${name}.md`);
	if (problem) throw new UnknownAgentError(`Agent "${name}" failed to load:\n${problem}`);
	const valid = [...discovery.agents.keys()].sort();
	throw new UnknownAgentError(
		`Unknown agent "${name}". Valid agents: ${valid.length ? valid.join(", ") : "(none)"}`,
	);
}
