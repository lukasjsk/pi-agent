// Model fallback pipeline (spec §R4): an agent definition's `model` is an ordered
// list resolved against the parent's model registry.
//   - Per-spawn override REPLACES the list entirely (definitive; no fallback net).
//   - List entries without a catalogue match or valid auth are skipped at spawn.
//   - The parent's current model is ALWAYS appended as the final chain entry (deduped),
//     so an exhausted/unavailable list lands on the orchestrator's model, not an error.
//   - Entries may pin a per-entry thinking level: "provider/model-id@level" (e.g.
//     "github-copilot/gpt-5.6-terra@max"); unpinned entries use the agent's default level.
// Pure module — structural types only, no pi imports.

import { THINKING_LEVELS, type AgentThinkingLevel } from "./definitions.ts";

export interface ModelRef {
	provider: string;
	id: string;
}

/** The slice of the platform's ModelRegistry the pipeline needs (see ExtensionContext.modelRegistry). */
export interface ModelRegistryLike {
	find(provider: string, modelId: string): unknown;
	getAvailable(): readonly unknown[];
}

export class ModelResolutionError extends Error {}

/** "provider/model-id" → { provider, id } (first "/" splits; model ids may contain "/"). */
export function parseModelRef(ref: string): ModelRef {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) {
		throw new ModelResolutionError(
			`model "${ref}" is not a "provider/model-id" reference`,
		);
	}
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function refId(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/** One resolved chain entry: the registry's full model object plus an optional per-entry
 *  thinking-level pin from the "ref@level" entry syntax. */
export interface ChainEntry {
	model: ModelRef;
	/** From "ref@level" in the definition; the agent's default level applies when absent. */
	thinkingLevel?: AgentThinkingLevel;
}

/**
 * "provider/model-id[@level]" → a chain entry. The optional "@level" suffix pins the
 * thinking level for that entry alone (e.g. "github-copilot/gpt-5.6-terra@max").
 * Splits on the LAST "@" so model ids may legally contain one; an invalid level is a
 * spawn error (same class as a malformed ref).
 */
export function parseModelEntry(entry: string): ChainEntry {
	const at = entry.lastIndexOf("@");
	if (at === -1) return { model: parseModelRef(entry) };
	const level = entry.slice(at + 1).trim().toLowerCase();
	if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
		throw new ModelResolutionError(
			`model "${entry}" has invalid thinking level "@${level}". Valid levels: ${THINKING_LEVELS.join(" | ")}`,
		);
	}
	return { model: parseModelRef(entry.slice(0, at)), thinkingLevel: level as AgentThinkingLevel };
}

function asModelRef(value: unknown): ModelRef | undefined {
	if (
		value &&
		typeof value === "object" &&
		typeof (value as ModelRef).provider === "string" &&
		typeof (value as ModelRef).id === "string"
	) {
		return value as ModelRef;
	}
	return undefined;
}

export interface ResolveModelsInput {
	/** The definition's ordered fallback list (may be undefined). */
	definitionModel?: readonly string[];
	/** Per-spawn "provider/model-id" override — replaces the list entirely. */
	overrideModel?: string;
	/** The orchestrator's current model; the default when neither list nor override is given. */
	parentModel?: unknown;
	/** The platform registry; required whenever a list or override must be resolved. */
	registry?: ModelRegistryLike;
}

export interface ResolvedModels {
	/** Entries to try in order; empty means "let the platform resolve from settings". */
	chain: ChainEntry[];
	diagnostics: string[];
}

/**
 * Resolve the ordered model chain for one spawn (spec §R4).
 * Throws ModelResolutionError when an override is unusable or a non-empty list yields
 * nothing — per-candidate diagnostics included; never falls back silently.
 */
export function resolveModelChain(input: ResolveModelsInput): ResolvedModels {
	const parentModel = asModelRef(input.parentModel);

	// Per-spawn override: definitive, no fallback net (spec §R4.4).
	if (input.overrideModel !== undefined) {
		const override = parseModelRef(input.overrideModel);
		const found = asModelRef(input.registry?.find(override.provider, override.id));
		if (!found) {
			throw new ModelResolutionError(
				`model "${input.overrideModel}" not found in the model registry`,
			);
		}
		// No auth pre-check: the override is deliberate; a runtime failure surfaces as-is.
		return { chain: [{ model: found }], diagnostics: [] };
	}

	if (input.definitionModel && input.definitionModel.length > 0) {
		if (!input.registry) {
			throw new ModelResolutionError(
				`agent fallback list [${input.definitionModel.join(", ")}] cannot be resolved: no model registry available`,
			);
		}
		const available = new Set(input.registry.getAvailable().map((m) => refId(asModelRef(m)!)));
		const diagnostics: string[] = [];
		const chain: ChainEntry[] = [];
		for (const raw of input.definitionModel) {
			const entry = parseModelEntry(raw); // bad format/level fails the spawn (consistent with unknown tools)
			const ref = entry.model;
			const found = asModelRef(input.registry.find(ref.provider, ref.id));
			if (!found) {
				diagnostics.push(`skipped ${refId(ref)} (not in the model catalogue)`);
				continue;
			}
			if (!available.has(refId(ref))) {
				diagnostics.push(`skipped ${refId(ref)} (no valid auth)`);
				continue;
			}
			// Full model object — the child needs reasoning/api/etc.; the pin rides only when set.
			chain.push(entry.thinkingLevel !== undefined ? { model: found, thinkingLevel: entry.thinkingLevel } : { model: found });
		}

		// The orchestrator's model is the final fallback, always — deduped by ref id, so a
		// definition that lists the parent's own model does not run it twice.
		if (parentModel && !chain.some((e) => refId(e.model) === refId(parentModel))) {
			chain.push({ model: parentModel });
		}

		if (chain.length === 0) {
			throw new ModelResolutionError(
				`no usable model in the fallback list or the parent's model [${input.definitionModel.join(", ")}]:\n` +
					diagnostics.map((d) => `- ${d}`).join("\n"),
			);
		}
		return { chain, diagnostics };
	}

	// Neither list nor override: the parent's model, or the platform default.
	return { chain: parentModel ? [{ model: parentModel }] : [], diagnostics: [] };
}
