import {
  createGrepToolDefinition,
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { invokesForbiddenGrep, ripgrepReplacementGuidance } from "./rules.ts";

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
        "Never invoke grep, egrep, or fgrep in bash, including in a pipeline after rg. Keep the search in rg and express file or path exclusions with rg --glob '!directory/**'.",
      ],
    });
  });

  // `tool_call` runs after preflight but before the built-in bash tool executes.
  // Returning { block: true } makes Pi skip execution and gives the model a
  // readable corrective result it can act on in its next turn.
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    if (invokesForbiddenGrep(event.input.command)) {
      return { block: true, reason: ripgrepReplacementGuidance() };
    }
  });
}
