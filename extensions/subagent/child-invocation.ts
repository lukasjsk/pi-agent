const PARENT_ONLY_TOOLS = ["subagent", "handover"];

/**
 * Build the command-line arguments for a delegated Pi process.
 *
 * A child is intentionally prevented from invoking the parent-only tools.
 * Only the parent Pi process is the workflow orchestrator and handover
 * reader; this keeps every agent attempt exactly one level below it.
 */
export function buildChildPiArgs(model: string, tools?: string[]): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", model];
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	args.push("--exclude-tools", PARENT_ONLY_TOOLS.join(","));
	return args;
}
