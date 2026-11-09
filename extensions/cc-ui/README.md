# cc-ui

Claude Code style UI for pi: grouped one-line tool calls, syntax-highlighted diffs, an
activity spinner, collapsible thinking, colors from your terminal, and `❯` prompt markers.

## Provenance

Ported from [FammasMaz/pi-cc-tools](https://github.com/FammasMaz/pi-cc-tools)
(`pi-claude-code-ui` v1.0.102, MIT license, author FammasMaz). Files:

| File | Upstream | Change in this port |
| --- | --- | --- |
| `index.ts` | `extensions/index.ts` | Two type-level fixes for pi 1.4: `ToolGroupComponent.handleMouse` return type (pi 1.4 returns a wrapped dispatch result), and a documented `@ts-ignore` for the base class's new `private mouseLayout` field. No runtime behavior changed. |
| `spinner.ts` | `extensions/spinner.ts` | Unchanged, including the herdr lifecycle reporting (local unix socket, active only under `HERDR_ENV=1` when the official herdr integration is absent). |
| `theme-colors.ts` | `extensions/theme-colors.ts` | Unchanged. |
| `terminal-theme.ts` | `extensions/terminal-theme.ts` | Unchanged. |
| `bash-command.ts` | `extensions/bash-command.ts` | Unchanged. |
| `bash-file-edit.ts` | `extensions/bash-file-edit.ts` | Unchanged. |
| `settings-path.ts` | `extensions/settings-path.ts` | Rewritten: uses pi's `getAgentDir()` instead of a hand-rolled `PI_CODING_AGENT_DIR \|\| ~/.pi` fallback, which pointed at `~/.pi/settings.json` instead of pi's real `~/.pi/agent/settings.json`. |
| `package.json` | new | Declares the two pi extension entry points (`index.ts`, `spinner.ts`) and the runtime dependencies `diff` and `@shikijs/cli`. |

## Security review (performed before porting)

Full file-by-file audit of the upstream source:

- No network I/O except the opt-in herdr local socket (`HERDR_ENV=1` + socket env vars).
- No `eval`, `child_process`, dynamic imports other than the fixed `@shikijs/cli` package.
- Single file write: the user agent-dir `settings.json` (settings changed via commands).
- File reads limited to settings, files the agent itself edits (for display diffs, ≤1 MB),
  and terminal theme detection.
- All 16 pi-internal patches are render-only; none alter message content, tool args,
  tool result `content`, or session state. Tool `execute` calls pass through to pi's
  built-in tools verbatim; only the display-only `details` field is enriched. Verified in
  pi 1.4 source that `details` is excluded from provider payloads.

## Commands

| Command | What it does |
| --- | --- |
| `/cc-tools` | Show current tool settings |
| `/cc-tools outlines` · `transparent` · `default` | Tool row style |
| `/cc-tools group on` · `off` · `toggle` | Fold consecutive tool calls into one row |
| `/cc-tools thinking live` · `full` · `latest` | How finished thinking is shown |
| `/cc-tools detail on` · `off` · `toggle` | Higher preview limits (also `Ctrl+Shift+O`) |
| `/cc-theme terminal on` · `off` · `status` | Follow the terminal's colors, or restore the previous theme |
| `/cc-theme on` · `off` · `toggle` · `status` | Derive extension colors from the pi theme |
| `/cc-spinner verb <key>` · `status <key>` · `reset` · `preview` | Recolor the spinner |

## Notes

- `terminalTheme` defaults to **on**: pi is switched to its built-in `system` theme
  (colors from your terminal palette) on load. The previous theme is saved; restore it
  with `/cc-theme terminal off`.
- Settings live in `.pi/settings.json` (project) and the agent-dir `settings.json`.
- Requires a Nerd Font for file icons; diffs use shiki syntax highlighting.
- Typecheck: `npm run typecheck` in this directory (against the pi install symlinked in
  the repo root `node_modules`).
