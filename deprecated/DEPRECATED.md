# Deprecated resources

Everything in this directory is **deprecated** and has been removed from the active install
locations. The install script only links whatever lives under the top-level `agents/`,
`extensions/`, `prompts/`, and `themes/` directories, so nothing here is installed or used by
Pi. The files are preserved here for reference, review, and as a starting point for the
replacement work tracked in [`PLANNED_FEATURES.md`](../PLANNED_FEATURES.md).

## What was deprecated

| Path (now under `deprecated/`) | Was | Why it is deprecated |
| --- | --- | --- |
| `agents/` | User-level workflow agents: `explorer`, `planner`, `implementer`, `reviewer`. | Being replaced by the new configurable `subagent` extension (worker / scout / researcher), which discovers its own agents instead of relying on top-level user-level definitions. |
| `extensions/subagent/` | The `subagent` tool extension (single / parallel / chained modes, agent discovery, model fallback, handovers, parent-session transcript). | Being reworked into the new `subagent` extension with per-agent model, thinking-level, and tool configuration. |
| `extensions/compact-and-new-session/` | The `/compact-and-new-session` command. | Being superseded; kept for reference only. |
| `prompts/analyze-and-plan.md`, `prompts/implement-and-review.md` | The `/analyze-and-plan` and `/implement-and-review` workflow prompts. | Being replaced by new `/analyze-and-plan` and `/implement-and-review` prompts built on the new `subagent` extension. |

## If you previously installed these

The install script replaces only same-named resources. To stop using the deprecated resources
already linked into `~/.pi/agent`, remove the stale symlinks and restart Pi:

```bash
for target in \
  "$HOME/.pi/agent/agents" \
  "$HOME/.pi/agent/prompts" \
  "$HOME/.pi/agent/extensions/subagent" \
  "$HOME/.pi/agent/extensions/compact-and-new-session"; do
  [ -L "$target" ] && rm "$target"
done
```

> These were directory symlinks, so removing them does not touch the (now archived) source in
> this repository.

## Status

Nothing in this directory is loaded by Pi. It will be cleaned up once the replacement
subagents extension and prompts are complete.
