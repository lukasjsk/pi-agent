# Research: Pi platform capabilities for running subagent sessions

Context pointer for [lukasjsk/pi-agent#13](https://github.com/lukasjsk/pi-agent/issues/13)
(map: [#12](https://github.com/lukasjsk/pi-agent/issues/12)).
Findings from the installed pi docs at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (primary source).
Citations are `doc.md` paths relative to that directory.

## 1. Execution model: two supported routes

### A. In-process via SDK (same Node process)

`createAgentSession()` from `@earendil-works/pi-coding-agent` builds a full child
`AgentSession` in the caller's process (sdk.md "Quick Start", "Core Concepts").

- Fully isolated message history: pass `sessionManager: SessionManager.inMemory()`
  (no persistence) — child never touches a session file (sdk.md "Session Management").
- Per-child configuration at creation: `model`, `thinkingLevel`, `tools`,
  `excludeTools`, `noTools`, `customTools`, `resourceLoader`, `cwd`, `agentDir`
  (sdk.md "Options Reference", "Complete Example").
- Streaming: `session.subscribe(event => ...)` — `message_update` (text/thinking
  deltas), `tool_execution_start/update/end`, `turn_start/turn_end`,
  `agent_start/agent_end` (sdk.md "Events").
- Abort: `session.abort()`; `session.dispose()` for cleanup (sdk.md "AgentSession").
- System prompt override: `DefaultResourceLoader({ systemPromptOverride: () => "..." })`
  (sdk.md "System Prompt"). This is how a child gets its agent role prompt.
- Direct state access: `session.agent.state` (messages, model, tools, systemPrompt);
  `session.setModel(model)`, `session.setThinkingLevel(level)` (sdk.md "Agent and AgentState").
- SDK doc explicitly lists "Build custom tools that spawn sub-agents" as a use case
  (sdk.md top).

An extension running inside pi's Node process can `import` the same package
("Available Imports", extensions.md) — so an extension's registered tool can
create SDK child sessions directly, no subprocess needed.

### B. Subprocess via CLI / RPC

- `pi --mode rpc --no-session` — headless JSONL protocol over stdin/stdout;
  commands `prompt`/`steer`, events streamed as JSON lines (rpc.md).
- CLI flags (usage.md "Command Line"): `--model <pattern>` (supports
  `provider/id` and `:<thinking>` shorthand, e.g. `pi --model sonnet:high "..."`),
  `--thinking <level>`, `--no-session`, `--exclude-tools <list>` / `-xt`,
  `--no-tools` / `-nt`, `--system-prompt <text>` (context files and skills still
  appended), `--append-system-prompt`, `--no-skills`, `--no-context-files`.
- RPC gives process isolation at the cost of a protocol client (rpc.md).

## 2. Model selection & fallback

- `ModelRuntime.create()` owns catalogs + auth; `modelRuntime.getAvailable()`
  returns only models with valid authentication (sdk.md "Model", "API Keys and OAuth").
  This is the availability pre-check for a fallback list.
- `getModel(provider, id)` / `modelRuntime.getModel(providerId, modelId)` resolve
  without an auth check; `resolveCliModel({ cliModel: "provider/id:high", modelRuntime })`
  matches CLI parsing including thinking shorthand (sdk.md "Model").
- No built-in ordered-fallback: the caller checks availability and picks; at session
  restore time pi itself only emits a single `modelFallbackMessage` when the session
  model couldn't be restored (sdk.md "Return Value"). Runtime-failure retry across a
  candidate list would be extension logic (catch error → next candidate → new session),
  as the deprecated extension did with subprocess exit codes / stop reasons.
- `pi.setModel(model)` (extension API) returns `false` when the provider has no
  auth configured (extensions.md "pi.setModel").

## 3. Thinking level

- Per-session parameter: `createAgentSession({ thinkingLevel })`,
  `session.setThinkingLevel(level)`, `pi.setThinkingLevel(level)`.
- Levels: `off | minimal | low | medium | high | xhigh | max` (usage.md, sdk.md).
- **Clamping is built in**: "Level is clamped to model capabilities (non-reasoning
  models always use 'off')" (extensions.md "pi.getThinkingLevel() /
  pi.setThinkingLevel(level)"). So "fallback to default" is partly platform-native:
  an unsupported level degrades instead of erroring.
- Changes emit the `thinking_level_select` event (extensions.md "Model Events").
- Model changes can change/clamp thinking level (`model_select` → `thinking_level_select`).

## 4. Tool restriction

- `createAgentSession({ tools: [...] })` allowlist; built-in names:
  `read, bash, powershell, edit, write, grep, find, ls`; default built-ins:
  `read, bash, edit, write` (sdk.md "Tools").
- `excludeTools` disables specific built-in, extension, or custom tools **after**
  any `tools` allowlist is applied (sdk.md "Tools") — this is the mechanism to keep a
  child from calling the `subagent` tool itself (no nested spawning).
- `noTools: "all"` / `noTools: "builtin"` (sdk.md "Tools").
- `customTools: [defineTool({...})]` adds tools only the child has; if `tools` is
  passed, custom tool names must be included in it (sdk.md "Custom Tools").
- Runtime toggling: `pi.setActiveTools(names)` (extensions.md "pi.getActiveTools() /
  pi.getAllTools() / pi.setActiveTools(names)").
- `promptSnippet` / `promptGuidelines` let a custom tool insert itself into the
  child's system prompt guidance (extensions.md "Custom Tools").

## 5. Streaming & TUI presentation (parent side)

- The subagent surface is a **custom tool** (`pi.registerTool`), and custom tools get:
  - `execute(toolCallId, params, signal, onUpdate, ctx)` — `onUpdate(partialResult)`
    streams progress into the tool call's live rendering (extensions.md "Tool Definition").
  - `renderCall(args, theme, context)` and `renderResult(result, options, theme,
    context)` — full custom TUI rendering of the call and the final result, including
    `options.expanded`-style views (extensions.md "Tool Definition", "Custom UI").
  - `details` on the tool result: for rendering and for branch-aware state
    reconstruction at `session_start` (extensions.md "State Management").
  - `usage` on the tool result: nested LLM usage is persisted and folded into footer,
    `/session`, and RPC session totals (extensions.md "Usage accounting").
- `ctx.ui` from the parent extension: `setStatus`, `setWidget`, `notify`, and
  `custom()` for full TUI components (extensions.md "ExtensionContext").
- SDK child sessions emit the full event stream (sdk.md "Events"), so the extension
  can relay any child progress into `onUpdate`/`renderCall` in the parent TUI.
- Output truncation helpers for tool results: `truncateHead/Tail/Line`,
  `DEFAULT_MAX_BYTES` (50 KB), `DEFAULT_MAX_LINES` (2000) (extensions.md "Output Truncation").
- `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer` give
  TUI-rendered, session-persisted, **non-LLM-context** artifacts (extensions.md
  "pi.appendEntry") — an option for rendering child results/handovers in the transcript.

## 6. Nested interaction (child asking the user)

- Interactive UI (`ctx.ui.select/confirm/input/editor/custom`) belongs to the
  session's own TUI. A child run via **SDK in-process** has no TUI of its own — its
  extension ctx would be non-interactive, so a child cannot render its own question
  UI; the parent extension would have to relay (which matches the map's
  "non-interactive children" decision).
- A **subprocess** child in `--mode rpc` has `ctx.hasUI: true` but its UI goes to its
  own headless channel (rpc.md "Extension UI Protocol"), not the user's terminal —
  nested TUI rendering into the parent terminal is not a documented capability.
- Practical conclusion: the only supported way for a child's question to reach the
  user is (a) the child emits it in its final structured output and the orchestrator
  relays, or (b) the extension surfaces it in the parent TUI via `ctx.ui` while the
  child is running (the extension is the relay either way).
- Guard for any UI code in a loaded extension: `ctx.mode === "tui"` and
  `ctx.hasUI` (extensions.md "ctx.mode", "ctx.hasUI").

## 7. Skills in children

- Skill discovery is per-session via the `ResourceLoader`. Default locations
  (skills.md "Locations"): global `~/.pi/agent/skills/`, `~/.agents/skills/`;
  project `.pi/skills/` and `.agents/skills/` in cwd + ancestors (project skills only
  after the project is trusted).
- SDK child: `DefaultResourceLoader` with `cwd`/`agentDir` gives the same discovery;
  `skillsOverride: (current) => ({ skills, diagnostics })` filters/augments the set
  (sdk.md "Skills") — the mechanism for per-spawn or per-agent skill preselection.
- `--no-skills` disables discovery; `--skill <path>` is additive (skills.md).
- How skills work (skills.md "How Skills Work"): names+descriptions are injected into
  the system prompt; the agent loads full SKILL.md on demand via `read` when the task
  matches ("progressive disclosure"). So a worker "leveraging different skills based
  on the type of work" is native behavior — the child needs `read` (or `bash`) plus
  the skills in its prompt; no special platform support required.
- Frontmatter options relevant to a worker: `disable-model-invocation` (hide from
  prompt, `/skill:name` only) and `allowed-tools` (experimental).
- CLI-style forced invocation: `/skill:name` commands (skills.md "Skill Commands").

## 8. Parent→child context transfer

- The parent extension has `ctx.sessionManager.buildContextEntries()` — the active
  branch entries **with compaction applied** (extensions.md
  "ctx.sessionManager"). This is the building block for a bounded,
  compaction-aware parent transcript to pass into the child's prompt.
- A child created with `systemPromptOverride` and `SessionManager.inMemory()`
  receives **none** of the parent's conversation, AGENTS.md context, or skills unless
  the extension passes them (prompt text, `agentsFilesOverride`, `skillsOverride`) —
  full isolation is the default; everything shared is explicit.

## 9. Load-bearing summary for the decision tickets

| Decision (ticket) | Platform fact that shapes it |
| --- | --- |
| Execution model | Both routes are first-class. SDK in-process gives direct config, events, abort, state; subprocess/RPC gives process isolation but a protocol client and weaker tool-scope control. |
| Config schema & semantics | Model list + availability check (`getAvailable()`), thinking with native clamping, `tools`/`excludeTools`/`noTools`/`customTools` are all real knobs; ordered model fallback is **not** built in — it is extension logic. |
| Invocation interface | Custom-tool `onUpdate` + `renderCall`/`renderResult` + `details` + nested `usage` are the streaming/sizing substrate; `pi.appendEntry` is an option for transcript artifacts. |
| Handover & output protocol | `buildContextEntries()` for parent transcripts; child isolation is total by default; structured output is the only question-relay path to the user. |
| Worker skills | Skills resolve per child session; `skillsOverride` for preselection; on-demand loading via `read` is the native worker behavior. |
