// Pure text digests for the live subagent view (CONTEXT.md "Tool-call summary").
// Kept free of any TUI imports so spawn-side relay code can use it without pulling
// in the platform's component layer.

/** One-line task excerpt, newlines flattened. */
export function excerpt(task: string, max = 48): string {
	const flat = task.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The call's single primary target, digested to one line: file path, command head,
 *  task excerpt, or URL — never the full arguments (CONTEXT.md "Tool-call summary"). */
export function toolCallSummary(toolName: string, args: unknown, max = 48): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
	let target: string | undefined;
	switch (toolName) {
		case "subagent":
		case "scout": {
			const role = str(a.agent);
			const task = str(a.task);
			target = task ? (role ? `${role}: ${excerpt(task, max - role.length - 2)}` : excerpt(task, max)) : undefined;
			break;
		}
		case "bash":
		case "powershell":
			target = str(a.command)?.split("\n")[0];
			break;
		case "grep":
			target = str(a.pattern);
			break;
		case "read":
		case "write":
		case "edit":
			target = str(a.file_path) ?? str(a.path) ?? str(a.filePath);
			break;
		case "find":
		case "ls":
			target = str(a.path) ?? str(a.pattern);
			break;
		case "git_history":
			// Prefer the followed file over the revision: that is what the call is about.
			target = str(a.path) ?? str(a.ref);
			break;
		case "git_show":
			target = str(a.commit) ?? str(a.path);
			break;
		default: {
			// Unknown/custom tool: first non-empty string argument as the primary target.
			const first = Object.values(a).find((v) => typeof v === "string" && v.trim()) as string | undefined;
			target = first ?? undefined;
		}
	}
	if (!target) return "";
	return excerpt(target, max);
}
