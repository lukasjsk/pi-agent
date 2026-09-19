// cli — the shared execFile seam for extension-injected CLI-backed tools.
//
// firecrawl (researcher) and git-history (scout) both run an external CLI and read its
// stdout without a shell. The runner is injectable so those modules are unit-testable
// without spawning a real process; this module holds the one non-injectable seam
// (node:child_process.execFile) and the subtle abort/error handling that goes with it.

import { execFile } from "node:child_process";

/** Injectable process runner so tests can stub a CLI. */
export interface CliRunner {
	run(
		bin: string,
		args: readonly string[],
		signal: AbortSignal | undefined,
	): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** execFile with no shell — argv tokens only, never a shell string — and a stdout buffer cap.
 *
 * `maxBuffer` bounds memory for a runaway command; callers that care about token cost truncate
 * the returned stdout to their own (much smaller) display cap afterwards, so the two caps are
 * deliberately separate: this one decides when the process is killed, the caller's decides how
 * much of the output reaches the model.
 */
export function createExecFileRunner(maxBuffer: number): CliRunner {
	return {
		async run(bin, args, signal) {
			return await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
				execFile(bin, [...args], { signal, maxBuffer }, (error, stdout, stderr) => {
					if (error) {
						const message = error.message || String(error);
						// On abort execFile reports a non-ExitError; report it as a failed run —
						// the caller also checks signal.aborted to phrase the result.
						const code = (error as NodeJS.ErrnoException & { code?: number }).code;
						resolve({
							stdout: String(stdout ?? ""),
							stderr: String(stderr ?? "") + (message ? `\n${message}` : ""),
							code: typeof code === "number" ? code : 1,
						});
						return;
					}
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
				});
			});
		},
	};
}