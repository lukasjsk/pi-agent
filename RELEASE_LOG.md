# Release Log

This log records notable functionality added to this configuration repository. Sections are headed by release dates; no release artifacts are published.

## 2026-09-11

### Added

- The subagents extension's TUI rows now render their own shell per spec §R11 (SUBAGENTS_EXTENSION.md): each subagent/scout row is framed by a border in the role color while running (worker accent, scout muted) shifting to the status color when settled, with no background tint and line-level truncation to terminal width. The live row shows a two-line header — role · task excerpt, then model · effective thinking level · elapsed · running tokens · live cost (4-decimal) — with the last 3 tool-call summary rows and last 3 content lines collapsed (all expanded). The settled expanded view appends the full persisted tool-call list (capped at 1000 with an omission marker); content lines are dropped at settle. A failed fallback attempt's partial usage folds into the child's returned usage total and is noted in diagnostics.

## 2026-09-10

### Added

- A new `subagents` extension that replaces the deprecated `subagent` extension (spec: `SUBAGENTS_EXTENSION.md`). It registers a single blocking `subagent` tool on the orchestrator; each call spawns an isolated, ephemeral, non-interactive child session whose entire context is the self-contained `task` brief. Bundled agent definitions ship with the extension: `worker` (general implementation work, self-selects skills, can spawn read-only scouts at depth 1 via an injected restricted tool) and `scout` (read-only exploration returning a compressed report with exact `file:line` references).
- Agent definitions are markdown files with a closed frontmatter set (`name`, `description`, required `tools` allowlist, ordered `model` fallback list, `thinkingLevel`, `skills` on/off). Bundled definitions live inside the extension; a same-named file in `~/.pi/agent/agents/*.md` overrides one. Discovery is fresh on every spawn, and a corrupt definition fails only its own spawn.
- Model fallback: at spawn, entries without valid auth are skipped; a runtime provider failure transparently retries the task on the next entry in the list; an exhausted list fails the spawn with per-candidate diagnostics. A per-spawn `model` or `thinkingLevel` override replaces the definition's list/level entirely, with the thinking level clamped by the platform.
- Structured output contract: every child report ends with a fenced JSON footer (`openQuestions`, `decisionPoints`, `filesTouched`) that the extension parses with graceful degradation (unparseable footers never fail the child). Extension-appended provenance records the model actually used, requested vs effective thinking level, and fallback/cancellation/parse diagnostics.
- Result transport: in-context results are capped at 10KB; oversized reports overflow to a session-scoped temp file (`$TMPDIR/pi-subagents/<session-id>/<spawn-id>.md`) whose path is referenced in the truncated in-context copy, with the full payload also available in the tool result's details.
- A per-session `SpawnScheduler` enforces a concurrency cap (default 4, configurable via `~/.pi/agent/configs/subagents.json`) and queues excess spawns. Esc cancels running and queued children, each returning a partial-result report. A failing child never cancels its siblings.
- Custom TUI rendering for subagent tool calls: collapsed status line per child (role, task excerpt, status, elapsed, usage) with the child's streamed output relayed live while running, and the final structured report (result body, decision points, open questions) rendered distinctly.
- Live subagent activity view: while a child runs, its tool call is relayed as one-line summaries (`status marker · tool name · single primary target` — file path, command head, task excerpt, or URL; recent five collapsed, all expanded), the last three raw content lines of its visible generated text (per-line capped with an ellipsis marker), the child's current model, and a best-effort accumulated cost once the first usage-bearing message settles. Thinking output is never shown.
- Subagent cost accounting in the footer: each subagent tool result now returns the child's total session usage (`getSessionStats()`-derived: input/output/cache tokens and cost, including nested scout spawns), so `/session`, RPC, the built-in footer, and this repo's custom footer all reflect child spend automatically. The custom footer folds tool-result usage into its totals (skipping only errored/aborted assistant messages) and shows a per-child cost breakdown keyed by agent name (`W:`/`S:` for the bundled agents, initial letter for user-defined); child costs are shares of the total, never added on top.

## 2026-09-03

### Added

- `/analyze-and-plan` now handles ambiguous tasks through sequential top-level `ask_user_question` clarifications. Its final action can continue analysis, automatically run the implementation-and-review workflow, or create a resolved implementation-ready handoff for later `/implement-and-review` execution. Synthesized planner output records `## User decisions` and `## Final action`. The existing `{parent}` handoff preserves those resolved constraints.
- A new `ask-user-question` extension that registers an `ask_user_question` tool, letting the agent pause execution and ask the user a single question through Pi's interactive TUI. It supports free-form text input, single-select option lists, and multi-select checklists (`multiSelect: true`); whenever options are provided, an "Other" entry is always available for custom answers. Results carry structured details (status, question, mode, answers) with dedicated call and result rendering, and pop-up-style tools serialize through a shared UI mutex so overlapping TUI prompts cannot collide.
- The `subagent` extension now creates a bounded handover for every completed agent attempt, stores it in the session’s tool-result details, and automatically supplies active-branch handovers to later subagents. The parent orchestrator can inspect the ledger with the new `handover` tool.
- Every delegated subagent now receives a bounded (36 KiB), compaction-aware reference transcript of the active parent-session conversation before its handover ledger and assigned task. This gives `/analyze-and-plan` (and all other subagent workflows) the previous conversation context it previously lacked: the canonical compaction summary is always preserved when present, then the newest active messages are retained within the byte budget, with an omission marker where older context is dropped. Truncation is UTF-8-safe and never splits a surrogate pair.

### Changed

- The `ask_user_question` extension's prompt guidance now instructs the agent to always use the tool when presenting two or more options or next-step choices, rendering decision points as interactive tool options rather than prose in its reply.
- The `footer` extension's context segment now shows the used context size in tokens next to the percentage (for example `23.1k/1M`), using a `k` suffix below 1M and `M` from 1M up.
- The `footer` extension now refreshes itself after compaction (manual `/compact` or automatic): the context segment shows the size of the rebuilt context (compaction summary plus kept messages) instead of the stale pre-compaction usage, and the tokens and cost segments reset to count only session activity since the latest compaction.
- Planner results now include a structured clarification-question contract and, after synthesis, stable `## User decisions` and `## Final action` sections. `/implement-and-review` treats handed-off decisions as binding constraints, while still accepting command arguments as additional user decisions.
- `/analyze-and-plan` now reproduces the complete planner result verbatim in the conversation before asking clarification or final-action questions, so the proposed plan is visible before anything is answered.
- The `/analyze-and-plan` final-action question now reads `Ready to proceed with implementation?`. Ready-to-implement plans omit the analysis action, and the follow-up option for non-ready plans is labelled `No, analyse with new information`.

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
