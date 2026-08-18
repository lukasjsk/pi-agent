# Release Log

This log records notable functionality added to this configuration repository. Versions are maintained for reference only; no release artifacts are published.

## Unreleased

### Added

- The `subagent` extension now creates a bounded handover for every completed agent attempt, stores it in the session’s tool-result details, and automatically supplies active-branch handovers to later subagents. The parent orchestrator can inspect the ledger with the new `handover` tool.

### Changed

- The `footer` extension now refreshes itself after compaction (manual `/compact` or automatic): the context segment shows the size of the rebuilt context (compaction summary plus kept messages) instead of the stale pre-compaction usage, and the tokens and cost segments reset to count only session activity since the latest compaction.
- `/analyze-and-plan` now closes with explicit next steps: approve a clean plan by running `/implement-and-review` without arguments, answer open decisions with `/implement-and-review {decisions}`, or continue the analysis by re-running `/analyze-and-plan` with additional questions or new information. Planner results now echo the original task in a `## Task` section, so `/implement-and-review` no longer requires the task to be re-stated and treats any arguments as user decisions.

### Fixed

- The `require-ripgrep` extension moved to an `extensions/require-ripgrep/` subdirectory with `index.ts` as its entry point. Its `rules.ts` helper module and `rules.test.ts` test file no longer sit directly in the extensions directory, so Pi stops trying to load them as standalone extensions and no longer reports "Extension does not export a valid factory function" errors for them.
- The `require-ripgrep` extension now explicitly prohibits `grep`, `egrep`, and `fgrep` in Bash pipelines, and its rejection guidance explains how to replace post-filtering with an `rg --glob` exclusion.
- Delegated Pi processes now exclude the `subagent` tool. Only the top-level orchestrator can start agent attempts; subagents cannot create nested subagents.

## v1.3

### Fixed

- The `subagent` extension now requires an explicit invocation mode (`single`, `parallel`, or `chain`) and discards stale fields from other modes before validation. This prevents chained workflows such as `/analyze-and-plan` from failing when a provider retains fields from an earlier single or parallel tool-call shape.

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
