const FORBIDDEN_EXECUTABLES = new Set(["grep", "egrep", "fgrep"]);

/**
 * Detect direct invocations of grep and its compatibility names in a shell command.
 *
 * This deliberately recognizes command words, rather than arbitrary text, so commands
 * such as `echo grep` and searches for the literal word "grep" remain valid. Shell
 * constructs that evaluate a separate command string (for example `bash -c 'grep ...'`)
 * are outside this lightweight check.
 */
export function invokesForbiddenGrep(command: string): boolean {
	const executableName = (word: string | undefined) =>
		word?.replace(/^['"]|['"]$/g, "").replace(/^.*\//, "");

	// Treat each pipeline/list member as a command. This avoids false positives such
	// as `echo grep`, where grep is an argument rather than an executable.
	for (const segment of command.split(/[;|&()\n]+/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		let index = 0;

		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;

		let executable = executableName(words[index]);
		if (executable === "command") executable = executableName(words[++index]);
		if (executable === "sudo") {
			// Skip common sudo options, then inspect the command it launches.
			while (words[++index]?.startsWith("-")) {
				if (["-u", "-g", "-h", "-p", "-r", "-t", "-C"].includes(words[index])) index++;
			}
			executable = executableName(words[index]);
		}
		if (executable === "env") {
			while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[++index] ?? "")) {}
			executable = executableName(words[index]);
		}

		if (FORBIDDEN_EXECUTABLES.has(executable ?? "")) return true;
	}

	return false;
}

/** Guidance that makes the common `rg … | grep -v …` mistake directly actionable. */
export function ripgrepReplacementGuidance(): string {
	return (
		"Blocked: `grep`, `egrep`, and `fgrep` are forbidden in bash commands. " +
		"Do not pipe `rg` into `grep` (including `grep -v`). Keep the search in one `rg` command: " +
		"use `--glob '!directory/**'` for file or path exclusions, for example " +
		"`rg --line-number --color=never 'pattern' path --glob '!prompts/**'`."
	);
}
