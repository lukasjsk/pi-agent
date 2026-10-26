# Subagent panes are display-only mirrors, not real sessions

When Herdr is detected, each subagent spawn opens a Herdr pane (right of the main
pane, concurrent siblings stacked down) that hosts a bundled **pane viewer** process.
The viewer renders a live, scrollable view of the child run plus a top status bar
(model, context, cost) built from the footer extension's segments. The subagent
itself keeps running in-process inside the orchestrator via the pi SDK, exactly as
before the panes existed; the pane is a pure projection of the events the spawn
already relays, fed over a local socket.

## Considered options

- **Real pi TUI session per pane** — spawn the subagent as a genuine separate `pi`
  process in the pane and drive it with `herdr agent prompt`. Rejected: it breaks the
  hard rule that children never load extensions (the pane footer would need them),
  forces the handoff to parse terminal output or use file handoff, and abandons the
  in-process machinery the extension already owns (model fallback chains, transient
  retries, structured output parsing, overflow transport).
- **In-process spawn + pane mirror (chosen)** — the spawn path stays the single
  source of truth; the pane is display-only and best-effort, so a Herdr or viewer
  failure can never fail or delay a spawn.

## Consequences

- The main session's subagent row remains the canonical record; the pane is a
  convenience view that goes away after a 15-second countdown once the run
  settles. The manager (orchestrator process) owns the pane close — it issues
  `herdr pane close` after the countdown, so the pane vanishes even when no
  viewer ever attached; the viewer's own close is a racy best-effort front end.
- The pane viewer is not a pi session: it runs the footer extension's segment
  functions (pure data-in/string-out units) directly, which is why those segments
  must stay importable outside the pi extension API.
- The pane viewer exits when its event socket closes, so a dead orchestrator
  leaves no orphaned viewers.
