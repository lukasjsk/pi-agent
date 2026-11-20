// command-line.ts — build one shell command line from argv for multiplexers whose
// "run" operation takes a command string (the Herdr TUI `pane run`). The viewer
// script and socket paths can contain spaces or shell signs, so every token is
// quoted as one double-quoted POSIX word. Adapters that start argv directly (the
// Herdr app's `pane.split --argv`) do not use this module.

/** Join argv into one command line, quoting every token. */
export function toCommandLine(argv: readonly string[]): string {
	return argv.map(quoteToken).join(" ");
}

/** Quote one token with double quotes; escape the characters a shell still reads. */
function quoteToken(token: string): string {
	return `"${token.replace(/(["\\$`])/g, "\\$1")}"`;
}
