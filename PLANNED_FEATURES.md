# Planned features

## Done

- Deprecate "agents", "subagent" extension, "compact-and-new-session" extension and both prompts in "prompts" directory.
- New `subagents` extension (spec in [SUBAGENTS_EXTENSION.md](SUBAGENTS_EXTENSION.md), built per map #12 tickets #20–#27), shipping two bundled agents:
  - `worker` — general subagent that does implementation work and leverages skills by self-selecting the ones matching its task.
  - `scout` — read-only exploration subagent. Worker or top-level orchestrator can spawn it (depth capped at 1).
- Make subagents configurable:
  - model selection with ordered fallback (per-definition `model` list, per-spawn override)
  - thinking level selection with platform clamp (per-definition `thinkingLevel`, per-spawn override)
  - per-definition `tools` allowlist (required, fail-fast on unknown names)
  - session-wide concurrency cap + queue via `~/.pi/agent/configs/subagents.json`
- The earlier "needed to clarify" items are resolved in the spec (map #12): handovers via self-contained task briefs (§R6), structured result contract with open questions and decision points relayed to the user by the orchestrator (§R7), and plan persistence left to the prompt layer (§R6.3, §2).

## Planned

- `researcher` subagent — not needed for now; works like scout but researches the internet using firecrawl tools instead of exploring the workspace. Just another agent definition — no extension changes needed to slot it in.
- Create new `/analyze-and-plan` and `/implement-and-review` prompts built on the new subagents extension.
- Integrate workflow with Jira — read stories/bugs/tasks as part of the initial context.
- Integrate workflow with Confluence — read documents as part of the initial context.
- `researcher` might have access to Confluence and Jira to search for similar stories.
- Scout should be able to explore git history of files for additional context (needs an implementation that does not burn through tokens).
- Better UI for subagents: tool calls in rows, generated text readable, collapsible. Showing which model is currently used for subagent and associated cost (if available). Better styling (wrapped in the box maybe?)
- Fix footer to display costs that would reflect our new subagents extension.
