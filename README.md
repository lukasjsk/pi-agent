# Pi Agent Configuration

Reusable configuration artifacts for [Pi](https://github.com/badlogic/pi-mono), the coding agent. The repository contains a bounded development workflow, two TypeScript extensions, and an interactive theme. Based on https://github.com/adrianapan/pikit.

## Contents

| Path | Purpose |
| --- | --- |
| [`agents/`](agents) | User-level workflow agents: read-only `explorer`, approval-aware `planner`, `implementer`, and `reviewer`. |
| [`prompts/`](prompts) | `/analyze-and-plan` plans a task with explorer and planner agents; `/implement-and-review` executes an approved task and reviews it. |
| [`extensions/subagent/`](extensions/subagent) | A `subagent` tool extension that runs isolated Pi processes in single, parallel, or chained modes, including agent discovery and model fallback. |
| [`extensions/footer/`](extensions/footer) | A configurable two-row status footer with model, usage, context, Git, Copilot quota, and other display segments. |
| [`themes/slop.json`](themes/slop.json) | The `slop` interactive color theme. |

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

## Development workflow

Run `/analyze-and-plan <task>` to delegate read-only reconnaissance and planning. It stops for approval; execute the approved work with `/implement-and-review <task>`. The agents are intentionally scoped as follows:

1. **Explorer** gathers concise implementation context without modifying files.
2. **Planner** produces a minimal plan and marks material decisions with `## REQUIRES_APPROVAL`.
3. **Implementer** carries out only the approved plan and runs focused verification.
4. **Reviewer** checks relevant changes against the approved task and plan.

The workflow prompts use the `subagent` extension and user-level agent definitions, so install both `agents/`, `prompts/`, and `extensions/subagent/` to use it.

## Notes

- The footer extension is self-contained TypeScript but expects Pi's extension runtime packages; it is not a standalone Node package.
- `extensions/subagent/README.md` documents the extension's modes, security model, agent format, and fallback behavior in depth.
- Review agent prompts and extension code before installing them into a shared or untrusted environment.

## License

No license has been specified for this configuration collection.


