# Pi Agent Configuration

Reusable configuration artifacts for [Pi](https://github.com/badlogic/pi-mono), the coding agent. The repository contains TypeScript extensions and an interactive theme. Based on https://github.com/adrianapan/pikit.

## Contents

| Path | Purpose |
| --- | --- |
| [`extensions/subagents/`](extensions/subagents) | A `subagent` tool that lets the orchestrator delegate work to isolated, ephemeral child sessions. Ships bundled `worker` (implementation), `scout` (read-only exploration, with injected `git_history`/`git_show` tools), and `researcher` (live-web research via injected `firecrawl_*` tools, no `bash`) agent definitions with per-agent model fallback configured in `~/.pi/agent/subagents.json`, structured reports, a concurrency cap with queueing, and Esc cancellation. Children are leaves — no subagent tool is injected into any child. Users can override or add agent definitions in `~/.pi/agent/agents/*.md`. Spec: [`SUBAGENTS_EXTENSION.md`](SUBAGENTS_EXTENSION.md). |
| [`AGENTS.md`](AGENTS.md) | Project instructions for agents that work in this repository: prefer ASD-STE100 Simplified Technical English for agent-facing text, with the conditions that call for it and the cases where it does not apply. |
| [`GLOSSARY.md`](GLOSSARY.md) | The domain language (ubiquitous-language glossary) for the subagents extension: orchestrator, subagent, worker, scout, researcher, and the other terms the extension's docs and source comments cite. Named for the convention the Matt Pocock skills read (`GLOSSARY.md`, or `GLOSSARY-MAP.md` in a multi-context repo). |
| [`extensions/footer/`](extensions/footer) | A configurable two-row status footer with model, usage, context, Git, Copilot quota, and other display segments. |
| [`extensions/ask-user-question/index.ts`](extensions/ask-user-question/index.ts) | An `ask_user_question` tool that pauses execution to ask the user a single question in the interactive TUI, with free-form text, single-select, or multi-select answers plus an "Other" custom input; its prompt guidance requires decision points and next-step choices (2+ options) to be rendered as tool options rather than prose. |
| [`extensions/require-ripgrep/`](extensions/require-ripgrep) | A guidance extension that steers searches toward `rg` (ripgrep) instead of `grep`. |
| [`themes/slop.json`](themes/slop.json) | The `slop` interactive color theme. |
| [`skills/unslop/SKILL.md`](skills/unslop/SKILL.md) | The `unslop` skill that cuts AI tells from writing: a numbered rule set covering content, language, style, communication artifacts, filler, jargon, and plain speech. User-invoked only (`disable-model-invocation: true`). |
| [`deprecated/`](deprecated) | Deprecated resources (agents, subagent extension, compact-and-new-session extension, and the analyze-and-plan / implement-and-review prompts), preserved for reference. See [`deprecated/DEPRECATED.md`](deprecated/DEPRECATED.md). |
| [`skills-lock.json`](skills-lock.json) | Lockfile for project-level agent skills ([`mattpocock/skills`](https://github.com/mattpocock/skills)) managed by the [`skills`](https://github.com/vercel-labs/skills) CLI (skills.sh). Restore the pinned skills with `npx skills experimental_install`. |

## Install

Clone the repository, then link each resource into the corresponding directory in Pi's user configuration (`~/.pi/agent`). This repository is the source of truth for its own resources, while Pi configuration directories remain real directories so other tools can install their own resources without modifying this checkout.

```bash
git clone <repository-url> ~/src/pi-agent-config
cd ~/src/pi-agent-config

repo_root=$PWD
for category in agents extensions prompts themes skills; do
  config_dir="$HOME/.pi/agent/$category"

  # Migrate an old directory symlink without touching a real config directory.
  if [ -L "$config_dir" ]; then
    rm "$config_dir"
  fi
  mkdir -p "$config_dir"

  # Replace only resources supplied by this repository; preserve all others.
  for source in "$repo_root/$category"/*; do
    [ -e "$source" ] || continue
    target="$config_dir/$(basename "$source")"
    rm -rf "$target"
    ln -s "$source" "$target"
  done
done
```

> The command replaces only same-named resources from this repository (for example, `extensions/footer`), not the whole Pi resource directory. Back up local changes to those same-named resources first.

Restart Pi after installing or changing extensions. Select the theme with Pi's theme picker.

### Per-agent model config (optional)

By default, subagents run on the orchestrator's current model. To give agents their own model
fallback chains, create `~/.pi/agent/subagents.json` mapping agent names to ordered model lists
(`provider/model-id`, with an optional `@level` thinking-level pin):

```json
{
  "worker": ["github-copilot/gpt-5.6-terra@max"],
  "scout": ["local-qwen38/unsloth/Qwen3.8-27B-GGUF:Q4_K_M@medium", "github-copilot/gpt-5.6-luna@xhigh"]
}
```

Unlisted agents keep the default. For listed agents, the orchestrator's model is always the
final fallback. The file is re-read on every spawn; a malformed file or entry warns and is
skipped, never failing a spawn. Spec: [SUBAGENTS_EXTENSION.md §R13](SUBAGENTS_EXTENSION.md#r13--model-config-file-amendment-no-ticket).

To restore the pinned project skills (listed in `skills-lock.json`), run in the repository root:

```bash
npx skills experimental_install
```


### Orchestrator preference (optional)

The subagents extension is designed for a delegating main agent, but that is a matter of
intent, not capability — keeping the top-level agent's write tools is deliberate, so it can
handle a simple task directly or act on an explicit user request without a per-invocation
override. There is no tool-restriction recipe to apply here (and none is recommended).

Express the preference as a soft instruction in your `AGENTS.md` instead, for example:

> Prefer delegating substantial work to subagents — `scout` for exploration, `worker` for
> implementation, `researcher` for live-web research — and synthesize their reports. Do simple
> tasks directly when that is clearly cheaper, and always follow an explicit request to do the
> work yourself.

The instruction shapes behavior without blocking any tool. If you ever do want a hard,
capability-level restriction, that remains available through Pi's `defaultTools` setting (extension tool names are valid entries); it is simply not the default this repo ships.

## Deprecated workflow

The previous bounded development workflow — the `/analyze-and-plan` and `/implement-and-review`
prompts, the top-level `agents/` (`explorer`, `planner`, `implementer`, `reviewer`), the
`subagent` extension, and the `/compact-and-new-session` extension — has been **deprecated** and
moved to [`deprecated/`](deprecated/DEPRECATED.md). They are no longer installed by the install
script above.

The replacement subagents extension is now implemented: [`extensions/subagents/`](extensions/subagents)
ships the `subagent` tool with `worker`, `scout` (plus injected git-history tools), and `researcher`
(injected `firecrawl_*` tools) bundled agents. Remaining replacement work (new `/analyze-and-plan` and
`/implement-and-review` prompts built on the extension) is tracked in [`PLANNED_FEATURES.md`](PLANNED_FEATURES.md).

## Notes

- Extensions are self-contained TypeScript but expect Pi's extension runtime packages; they are not standalone Node packages.
- The subagents extension reads an optional concurrency setting from `~/.pi/agent/configs/subagents.json` (`maxConcurrent`, default 4); per-agent model fallback lists live in `~/.pi/agent/subagents.json`; agent definitions override by matching `name` in `~/.pi/agent/agents/*.md`.
- Review agent prompts and extension code before installing them into a shared or untrusted environment.

## License

No license has been specified for this configuration collection.


