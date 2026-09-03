# Release Log

This log records notable functionality added to this configuration repository. Sections are headed by release dates; no release artifacts are published.

## 2026-09-03

### Added

- `/analyze-and-plan` now handles ambiguous tasks through sequential top-level `ask_user_question` clarifications. Its final action can continue analysis, automatically run the implementation-and-review workflow, or create a resolved implementation-ready handoff for later `/implement-and-review` execution. Synthesized planner output records `## User decisions` and `## Final action`. The existing `{parent}` handoff preserves those resolved constraints.
- A new `ask-user-question` extension that registers an `ask_user_question` tool, letting the agent pause execution and ask the user a single question through Pi's interactive TUI. It supports free-form text input, single-select option lists, and multi-select checklists (`multiSelect: true`); whenever options are provided, an "Other" entry is always available for custom answers. Results carry structured details (status, question, mode, answers) with dedicated call and result rendering, and pop-up-style tools serialize through a shared UI mutex so overlapping TUI prompts cannot collide.
- The `subagent` extension now creates a bounded handover for every completed agent attempt, stores it in the session’s tool-result details, and automatically supplies active-branch handovers to later subagents. The parent orchestrator can inspect the ledger with the new `handover` tool.

### Changed

- The `ask_user_question` extension's prompt guidance now instructs the agent to always use the tool when presenting two or more options or next-step choices, rendering decision points as interactive tool options rather than prose in its reply.
- The `footer` extension's context segment now shows the used context size in tokens next to the percentage (for example `23.1k/1M`), using a `k` suffix below 1M and `M` from 1M up.
- The `footer` extension now refreshes itself after compaction (manual `/compact` or automatic): the context segment shows the size of the rebuilt context (compaction summary plus kept messages) instead of the stale pre-compaction usage, and the tokens and cost segments reset to count only session activity since the latest compaction.
- Planner results now include a structured clarification-question contract and, after synthesis, stable `## User decisions` and `## Final action` sections. `/implement-and-review` treats handed-off decisions as binding constraints, while still accepting command arguments as additional user decisions.

### Fixed

- The `require-ripgrep` extension moved to an `extensions/require-ripgrep/` subdirectory with `index.ts` as its entry point. Its `rules.ts` helper module and `rules.test.ts` test file no longer sit directly in the extensions directory, so Pi stops trying to load them as standalone extensions and no longer reports "Extension does not export a valid factory function" errors for them.
- The `require-ripgrep` extension now explicitly prohibits `grep`, `egrep`, and `fgrep` in Bash pipelines, and its rejection guidance explains how to replace post-filtering with an `rg --glob` exclusion.
- Delegated Pi processes now exclude the `subagent` tool. Only the top-level orchestrator can start agent attempts; subagents cannot create nested subagents.

### Enhanced

- The `require-ripgrep` extension now appends a dedicated `## Bash search` section to the system prompt on every turn, so the ripgrep-only rule and `rg` flag semantics (pattern flag is `-e`; `-E` is encoding, not extended regex) are visible even before the model reaches for `grep`. Its detector also recognizes `grep`/`egrep`/`fgrep` in command-substitution and interpreter positions — `$(…)`, backticks, `xargs`, and `bash -c` strings — and its block guidance now includes the `rg` flag differences.

## 2026-07-27

### Fixed

- The `subagent` extension now requires an explicit invocation mode (`single`, `parallel`, or `chain`) and discards stale fields from other modes before validation. This prevents chained workflows such as `/analyze-and-plan` from failing when a provider retains fields from an earlier single or parallel tool-call shape.

## 2026-07-24

### Added

- A global `require-ripgrep` Pi extension that overrides the search tool metadata to advertise its ripgrep (`rg`) implementation and blocks direct `grep`, `egrep`, and `fgrep` invocations through Pi's `bash` tool, returning an actionable `rg` replacement message.

## 2026-07-23

### Added

- The footer cost breakdown now shows the top-level orchestrator's cost first as `O:$…`, followed by the costs of any workflow subagents.
- A reusable Pi agent configuration collection with installation instructions for agents, extensions, prompts, and themes.
- A bounded development workflow with `explorer`, `planner`, `implementer`, and `reviewer` agents, plus planning and implementation/review prompt templates.
- A `subagent` extension for isolated delegated Pi processes, supporting single-agent, parallel, and chained execution; live progress; usage reporting; cancellation; configurable agent scopes; and model fallback.
- A configurable two-row footer extension with model and Git details, context usage, token and cache metrics, cost reporting, GitHub Copilot quota information, path display, and customizable layout, colors, icons, and segment options.
- The `slop` interactive color theme.
