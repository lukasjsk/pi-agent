const FORBIDDEN_EXECUTABLES = new Set(["grep", "egrep", "fgrep"]);

/** Tokens that directly precede an executable without a wrapper (command position). */
const COMMAND_POSITION_PREV = new Set([
	"(",
	"$(",
	"`",
	"&&",
	"||",
	";",
	"if",
	"while",
	"until",
	"else",
	"then",
	"do",
	"!",
	"not",
	"time",
	"nohup",
	"xargs",
]);

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const bare = (word: string | undefined) => word?.replace(/^['"]|['"]$/g, "") ?? "";
const executableName = (word: string | undefined) => bare(word).replace(/^.*\//, "");
const isQuotedLiteral = (word: string) =>
	(word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"'));

/**
 * Detect direct invocations of grep and its compatibility names in a shell command.
 *
 * This recognizes command words rather than arbitrary text, so commands such as
 * `echo grep`, quoted patterns, and searches for the literal word "grep" remain
 * valid. In addition to the executable position of each pipeline segment, it
 * recognizes grep in command-substitution and interpreter positions: `$(grep …)`,
 * backticks, `xargs grep …`, and `bash -c 'grep …'`.
 */
export function invokesForbiddenGrep(command: string): boolean {
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

	// Catch command-substitution and interpreter positions that survive segmentation.
	const tokens = command.split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (isQuotedLiteral(token)) continue;

		// A token may open a command substitution anywhere: `grep …, $(grep …, x=$(grep …
		const substitutionStart = token.search(/[$`(]/);
		if (substitutionStart !== -1) {
			const substitutionWord = executableName(token.slice(substitutionStart).replace(/^[$`(]+/, ""));
			if (FORBIDDEN_EXECUTABLES.has(substitutionWord)) return true;
		}

		const name = executableName(token);
		if (!FORBIDDEN_EXECUTABLES.has(name)) continue;

		const prev = bare(tokens[i - 1]);
		if (COMMAND_POSITION_PREV.has(prev)) return true;

		// `bash -c 'grep …'` and friends: the shell runs a separate command string.
		if (prev === "-c" && SHELL_NAMES.has(executableName(tokens[i - 2]))) return true;
	}

	return false;
}

/** Guidance that makes the common `rg … | grep -v …` mistake directly actionable. */
export function ripgrepReplacementGuidance(): string {
	return (
		"Blocked: `grep`, `egrep`, and `fgrep` are forbidden in bash commands, including inside `$()` or backticks, " +
		"after `xargs`, and in `bash -c` strings. " +
		"Do not pipe `rg` into `grep` (including `grep -v`). Keep the search in one `rg` command: " +
		"use `--glob '!directory/**'` for file or path exclusions, for example " +
		"`rg --line-number --color=never 'pattern' path --glob '!prompts/**'. " +
		"Note that in `rg` the pattern flag is `-e`; `-E` selects the encoding and `-F` means fixed string."
	);
}
