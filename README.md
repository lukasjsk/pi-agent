# Pi Agent Configuration

Reusable configuration artifacts for [Pi](https://github.com/badlogic/pi-mono), the coding agent. The repository contains TypeScript extensions and an interactive theme. Based on https://github.com/adrianapan/pikit.

## Contents

| Path | Purpose |
| --- | --- |
| [`extensions/subagents/`](extensions/subagents) | A `subagent` tool that lets the orchestrator delegate work to isolated, ephemeral child sessions. Ships bundled `worker` (implementation), `scout` (read-only exploration), and `researcher` (live-web research via injected `firecrawl_*` tools, no `bash`) agent definitions with model fallback, structured reports, a concurrency cap with queueing, Esc cancellation, and workers spawning read-only scouts at depth 1. Users can override or add agent definitions in `~/.pi/agent/agents/*.md`. Spec: [`SUBAGENTS_EXTENSION.md`](SUBAGENTS_EXTENSION.md). |
| [`extensions/footer/`](extensions/footer) | A configurable two-row status footer with model, usage, context, Git, Copilot quota, and other display segments. |
| [`extensions/ask-user-question.ts`](extensions/ask-user-question.ts) | An `ask_user_question` tool that pauses execution to ask the user a single question in the interactive TUI, with free-form text, single-select, or multi-select answers plus an "Other" custom input; its prompt guidance requires decision points and next-step choices (2+ options) to be rendered as tool options rather than prose. |
| [`extensions/require-ripgrep/`](extensions/require-ripgrep) | A guidance extension that steers searches toward `rg` (ripgrep) instead of `grep`. |
| [`themes/slop.json`](themes/slop.json) | The `slop` interactive color theme. |
| [`deprecated/`](deprecated) | Deprecated resources (agents, subagent extension, compact-and-new-session extension, and the analyze-and-plan / implement-and-review prompts), preserved for reference. See [`deprecated/DEPRECATED.md`](deprecated/DEPRECATED.md). |

## Install

Clone the repository, then link each resource into the corresponding directory in Pi's user configuration (`~/.pi/agent`). This repository is the source of truth for its own resources, while Pi configuration directories remain real directories so other tools can install their own resources without modifying this checkout.

```bash
git clone <repository-url> ~/src/pi-agent-config
cd ~/src/pi-agent-config

repo_root=$PWD
for category in agents extensions prompts themes; do
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

## Deprecated workflow

The previous bounded development workflow — the `/analyze-and-plan` and `/implement-and-review`
prompts, the top-level `agents/` (`explorer`, `planner`, `implementer`, `reviewer`), the
`subagent` extension, and the `/compact-and-new-session` extension — has been **deprecated** and
moved to [`deprecated/`](deprecated/DEPRECATED.md). They are no longer installed by the install
script above.

The replacement subagents extension is now implemented: [`extensions/subagents/`](extensions/subagents)
ships the `subagent` tool with `worker` and `scout` bundled agents. Remaining replacement work
(a `researcher` subagent and new `/analyze-and-plan` and `/implement-and-review` prompts built on
the extension) is tracked in [`PLANNED_FEATURES.md`](PLANNED_FEATURES.md).

## Notes

- Extensions are self-contained TypeScript but expect Pi's extension runtime packages; they are not standalone Node packages.
- The subagents extension reads an optional concurrency setting from `~/.pi/agent/configs/subagents.json` (`maxConcurrent`, default 4); agent definitions override by matching `name` in `~/.pi/agent/agents/*.md`.
- Review agent prompts and extension code before installing them into a shared or untrusted environment.

## License

No license has been specified for this configuration collection.


