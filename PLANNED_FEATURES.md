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
- A third bundled subagent, `researcher` (live-web research). Read-only against the workspace (read/grep/find/ls) with **no `bash`**; its web surface is a set of purpose-built `firecrawl_*` tools (search/scrape/map/crawl/research/developer) injected into the child via the existing `childTools` path — each wraps one firecrawl CLI subcommand via `execFile` (no shell), so no arbitrary commands. Returns a compressed, source-cited report (`Summary`/`Findings`/`Sources`/`Gaps`). Definition: `extensions/subagents/agents/researcher.md`; tools: `extensions/subagents/firecrawl.ts`.
- The earlier "needed to clarify" items are resolved in the spec (map #12): handovers via self-contained task briefs (§R6), structured result contract with open questions and decision points relayed to the user by the orchestrator (§R7), and plan persistence left to the prompt layer (§R6.3, §2).
- Better UI for subagents (map #12 → map #30, spec §R11 "TUI observability", fully implemented): while a child runs, its row is framed by a border in the role/status color (self-rendered shell) with a two-line header — role · task excerpt, then model · effective thinking · elapsed · running tokens · live cost — recent tool-call summary rows (`status marker · tool name · primary target`), and the last raw content lines of its generated text (per-line cap, `…` marker); collapsed shows the recent tail, expanded everything including the full settled tool-call list. The footer reflects subagent costs and the per-agent breakdown; failed fallback attempts' usage folds into the child's total.
- Footer reflects subagent costs (map #12, ticket #34, research doc §6): subagent tool results return the child's total session usage, the custom footer folds tool-result usage into its totals, and the cost segment shows a per-child breakdown — orchestrator `O:` first, then bundled agents in fixed order (`S:`/`R:`/`W:`), then user-defined agents by initial letter.
- Scout can explore git history token-efficiently (spec §R12). Two purpose-built tools are injected into scout children over the same `customTools` path as the researcher's firecrawl set — `git_history` (one compact line per commit, `--follow` through renames, `--max-count` default 30, optional compressed `(N files, +I/-D)` stats) and `git_show` (`--stat` by default, patch only on request). Both cap output at 32 KB on a line boundary with a narrowing hint, run `git` via `execFile` with no shell, and reject leading `-`/control characters in positionals. Implementation: `extensions/subagents/git-history.ts`, shared runner seam `extensions/subagents/cli.ts`.

## Planned

- Create new `/analyze-and-plan` and `/implement-and-review` prompts built on the new subagents extension.
- Integrate workflow with Jira — read stories/bugs/tasks as part of the initial context.
- Integrate workflow with Confluence — read documents as part of the initial context.
- `researcher` might have access to Confluence and Jira to search for similar stories.
