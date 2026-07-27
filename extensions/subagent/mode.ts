export type SubagentMode = "single" | "parallel" | "chain";

type ToolArguments = Record<string, unknown>;

const MODES = new Set<SubagentMode>(["single", "parallel", "chain"]);

function hasItems(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

/**
 * Select one subagent invocation mode and discard stale fields from the other
 * modes. Some providers retain earlier optional fields while constructing a
 * tool call; without this normalization, a valid chain can be rejected merely
 * because it also contains a leftover single or parallel field.
 */
export function normalizeSubagentArguments(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;

	const input = args as ToolArguments;
	const explicitMode = typeof input.mode === "string" && MODES.has(input.mode as SubagentMode)
		? (input.mode as SubagentMode)
		: undefined;
	const inferredMode: SubagentMode | undefined = hasItems(input.chain)
		? "chain"
		: hasItems(input.tasks)
			? "parallel"
			: typeof input.agent === "string" && typeof input.task === "string"
				? "single"
				: undefined;
	const mode = explicitMode ?? inferredMode;

	// Leave arguments that do not identify a usable mode untouched so normal
	// schema validation can report the malformed call to the model.
	if (!mode) return args;

	const normalized: ToolArguments = {
		mode,
		agentScope: input.agentScope,
		confirmProjectAgents: input.confirmProjectAgents,
	};

	if (mode === "single") {
		normalized.agent = input.agent;
		normalized.task = input.task;
		normalized.cwd = input.cwd;
	} else if (mode === "parallel") {
		normalized.tasks = input.tasks;
	} else {
		normalized.chain = input.chain;
	}

	return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}
