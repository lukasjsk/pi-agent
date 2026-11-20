# Subagent panes are display-only mirrors, not real sessions

When a supported pane multiplexer is detected, each subagent spawn opens a pane
(right of the orchestrator pane, concurrent siblings stacked down) that hosts a
bundled **pane viewer** process. Supported multiplexers are the Herdr TUI
(`HERDR_ENV=1` with `HERDR_PANE_ID`) and the Herdr desktop app (`HC_TERMINAL_ID`
from herdr-core). The viewer renders a live, scrollable view of the child run plus
a top status bar (model, context, cost) built from the footer extension's segments.
The subagent itself keeps running in-process inside the orchestrator via the pi SDK,
exactly as before the panes existed; the pane is a pure projection of the events the
spawn already relays, fed over a local socket.

## Considered options

- **Real pi TUI session per pane** — spawn the subagent as a genuine separate `pi`
  process in the pane and drive it with the multiplexer's agent prompt command.
  Rejected: it breaks the hard rule that children never load extensions (the pane
  footer would need them), forces the handoff to parse terminal output or use file
  handoff, and abandons the in-process machinery the extension already owns (model
  fallback chains, transient retries, structured output parsing, overflow
  transport).
- **In-process spawn + pane mirror (chosen)** — the spawn path stays the single
  source of truth; the pane is display-only and best-effort, so a multiplexer or
  viewer failure can never fail or delay a spawn.

## Multiplexer seam

The manager owns the shared policy: the per-spawn event server, placement, and the
close backstop. A `PaneMultiplexer` adapter owns only the multiplexer-specific
work: detection, the orchestrator anchor lookup, opening a pane with the viewer,
and closing a pane. The current adapters are:

- **Herdr TUI** (`pane/herdr.ts`) — anchor is `HERDR_PANE_ID`; `herdr pane split`
  creates the pane, `herdr pane rename` labels it, and `herdr pane run` starts the
  viewer as a command string.
- **Herdr app** (`pane/herdr-app.ts`) — anchor is found from `HC_TERMINAL_ID` in
  `herdr-app ls`; `herdr-app do pane.split --argv` splits the target pane and
  starts the viewer directly. The app has no pane rename, so the viewer sets the
  terminal title and the app's pane header reads it. The app closes a pane when its
  program exits, so the viewer needs no explicit close there.

A new multiplexer adds one adapter module and one branch in `pane/registry.ts`; the
manager, the spawn path, and the viewer stay unchanged.

## Consequences

- The main session's subagent row remains the canonical record; the pane is a
  convenience view that goes away after a 15-second countdown once the run
  settles. The manager (orchestrator process) owns the pane close, so the pane
  vanishes even when no viewer ever attached; the viewer's own close is a racy
  best-effort front end. In the Herdr app the viewer's process exit also closes
  the pane, so the manager's close is only the backstop for a viewer that never
  attached.
- The app adapter is local-only: it targets the pane of the local `HC_TERMINAL_ID`
  and does not issue `--machine` commands. Remote spaces and pane-less subagent
  terminals have no anchor, so the pane is skipped; the spawn is unaffected.
- The app's `pane.split` has no focus flag. The TUI adapter keeps the existing
  `herdr pane split` behavior. A future change can add focus preservation per
  adapter without touching the manager.
- The pane viewer is not a pi session: it runs the footer extension's segment
  functions (pure data-in/string-out units) directly, which is why those segments
  must stay importable outside the pi extension API.
- The pane viewer exits when its event socket closes, so a dead orchestrator
  leaves no orphaned viewers.
