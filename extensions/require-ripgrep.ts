import {
  createGrepToolDefinition,
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const BLOCKED_MESSAGE =
  "Blocked: `grep` is forbidden in bash commands. Use `rg` (ripgrep) instead. " +
  "For example: `rg --line-number --color=never 'pattern' path`.";

/**
 * Detect direct invocations of grep and its compatibility names in a shell command.
 *
 * This deliberately recognizes only command words, rather than arbitrary text, so
 * commands such as `echo grep` and searches for the literal word "grep" remain
 * valid. Shell constructs that evaluate a separate command string (for example
 * `bash -c 'grep ...'`) are outside this lightweight check.
 */
function invokesForbiddenGrep(command: string): boolean {
  const executableName = (word: string | undefined) =>
    word?.replace(/^['"]|['"]$/g, "").replace(/^.*\//, "");

  // Treat each pipeline/list member as a command. This avoids false positives
  // such as `echo grep`, where grep is an argument rather than an executable.
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

    if (["grep", "egrep", "fgrep"].includes(executable ?? "")) return true;
  }

  return false;
}

export default function (pi: ExtensionAPI) {
  // Pi's built-in `grep` already runs ripgrep. Override its public definition so
  // the tool advertises that fact while retaining Pi's validated schema, output
  // details, truncation, and built-in rendering.
  pi.on("session_start", (_event, ctx) => {
    const builtin = createGrepToolDefinition(ctx.cwd);
    pi.registerTool({
      ...builtin,
      label: "ripgrep",
      description:
        "Search file contents with ripgrep (rg). Returns matching lines with file paths and line numbers. " +
        "Respects .gitignore and truncates output safely.",
      promptSnippet: "Search file contents with ripgrep (rg); respects .gitignore",
      promptGuidelines: [
        "Use the grep tool for content searches; it executes ripgrep (rg), not GNU grep.",
      ],
    });
  });

  // `tool_call` runs after preflight but before the built-in bash tool executes.
  // Returning { block: true } makes Pi skip execution and gives the model a
  // readable corrective result it can act on in its next turn.
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    if (invokesForbiddenGrep(event.input.command)) {
      return { block: true, reason: BLOCKED_MESSAGE };
    }
  });
}
