# Release Log

This log records notable functionality added to this configuration repository. Versions are maintained for reference only; no release artifacts are published.

## v1.2

### Added

- A global `require-ripgrep` Pi extension that overrides the search tool metadata to advertise its ripgrep (`rg`) implementation and blocks direct `grep`, `egrep`, and `fgrep` invocations through Pi's `bash` tool, returning an actionable `rg` replacement message.

## v1.1

### Added

- The footer cost breakdown now shows the top-level orchestrator's cost first as `O:$…`, followed by the costs of any workflow subagents.

## v1

### Added

- A reusable Pi agent configuration collection with installation instructions for agents, extensions, prompts, and themes.
- A bounded development workflow with `explorer`, `planner`, `implementer`, and `reviewer` agents, plus planning and implementation/review prompt templates.
- A `subagent` extension for isolated delegated Pi processes, supporting single-agent, parallel, and chained execution; live progress; usage reporting; cancellation; configurable agent scopes; and model fallback.
- A configurable two-row footer extension with model and Git details, context usage, token and cache metrics, cost reporting, GitHub Copilot quota information, path display, and customizable layout, colors, icons, and segment options.
- The `slop` interactive color theme.
