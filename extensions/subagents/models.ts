// Model fallback pipeline (spec §R4): an agent definition's `model` is an ordered
// list resolved against the parent's model registry.
//   - Per-spawn override REPLACES the list entirely (definitive; no fallback net).
//   - List entries without a catalogue match or valid auth are skipped at spawn.
//   - Empty resolution is a spawn error with per-candidate diagnostics — never a
//     silent fallback to the orchestrator's model.
// Pure module — structural types only, no pi imports.

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
	/** Models to try in order; empty means "let the platform resolve from settings". */
	chain: ModelRef[];
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
		return { chain: [found], diagnostics: [] };
	}

	if (input.definitionModel && input.definitionModel.length > 0) {
		if (!input.registry) {
			throw new ModelResolutionError(
				`agent fallback list [${input.definitionModel.join(", ")}] cannot be resolved: no model registry available`,
			);
		}
		const available = new Set(input.registry.getAvailable().map((m) => refId(asModelRef(m)!)));
		const diagnostics: string[] = [];
		const chain: ModelRef[] = [];
		for (const entry of input.definitionModel) {
			const ref = parseModelRef(entry); // bad format fails the spawn (consistent with unknown tools)
			const found = asModelRef(input.registry.find(ref.provider, ref.id));
			if (!found) {
				diagnostics.push(`skipped ${refId(ref)} (not in the model catalogue)`);
				continue;
			}
			if (!available.has(refId(ref))) {
				diagnostics.push(`skipped ${refId(ref)} (no valid auth)`);
				continue;
			}
			chain.push(found); // the registry's full model object — the child needs reasoning/api/etc.
		}
		if (chain.length === 0) {
			throw new ModelResolutionError(
				`no usable model in the fallback list [${input.definitionModel.join(", ")}]:\n` +
					diagnostics.map((d) => `- ${d}`).join("\n"),
			);
		}
		return { chain, diagnostics };
	}

	// Neither list nor override: the parent's model, or the platform default.
	return { chain: parentModel ? [parentModel] : [], diagnostics: [] };
}
