# Subagent Workflow

Domain language for the subagents extension: a pi extension that lets the top-level session delegate work to isolated child agent sessions.

## Language

**Orchestrator**:
The top-level interactive pi session that spawns subagents, sequences them, and presents their results and questions to the user. The only session the user talks to.
_Avoid_: parent agent, main agent, controller

**Subagent**:
A child pi agent session spawned via the subagent tool: isolated context, ephemeral, non-interactive, running a fixed role (worker, scout, or researcher).
_Avoid_: child agent, task agent, delegate

**Worker**:
The general-purpose subagent that performs implementation work and applies skills according to the type of task. May spawn scouts.
_Avoid_: implementer, doer

**Scout**:
The exploration subagent that reconnoiters the workspace and returns a compressed report. A leaf: it cannot spawn further subagents.
_Avoid_: explorer

**Researcher**:
The web-research subagent that investigates a question against the live web and returns a compressed, source-cited report. Read-only against the workspace (no bash); its live-web capability is a set of injected `firecrawl_*` tools (not a frontmatter tool). A leaf: it cannot spawn further subagents.
_Avoid_: web agent, crawler (crawler is one firecrawl tool, not the role)

**Spawn**:
The act of starting a subagent session via the subagent tool, singly or in parallel.
_Avoid_: launch, invoke, fork

**Restricted subagent tool**:
The variant of the subagent tool injected into a worker session that can spawn only scouts, enforcing the spawn-depth limit without loading extensions.

**Spawn depth**:
How many subagent levels nest below the orchestrator. Capped at 1: orchestrator → worker → scout.

**Agent definition**:
A user-editable markdown file (YAML frontmatter + body) that defines a spawnable subagent role: config fields in frontmatter, the system prompt in the body. Bundled worker/scout/researcher defaults live in the extension; user-level files override by name.
_Avoid_: agent config, agent spec

**Model fallback**:
The ordered `model` list in an agent definition. At spawn the first entry with valid auth is used; on a runtime failure the task transparently moves to the next entry; exhausting the list fails the spawn with diagnostics. A per-spawn model override replaces the list entirely.
_Avoid_: model chain, retry policy, auto-downgrade

**Overflow report**:
A subagent result too large for the orchestrator's context. The in-context tool result is capped; the full report is written to a session-scoped temp file whose path is referenced in the tool result for the orchestrator to read.
_Avoid_: file dump, attachment

**Handover**:
The passing of context and results between the orchestrator and its subagents, and between subagents via the orchestrator.
_Avoid_: ledger, transcript sharing, context dump

**Tool-call summary**:
The one-line digest of a subagent's tool call shown in the collapsed row: tool name + a single primary target (file path, command head, task excerpt, or URL) + a status marker. Deliberately excludes full arguments and results — those live in the expanded view.
_Avoid_: tool log, call trace, activity entry (the payload record it renders from)

**Content line**:
A raw, unwrapped source line of a subagent's visible generated text (assistant text only; thinking/reasoning excluded). The collapsed row shows the last three; lines are shown raw — never markdown-stripped — with a per-line cap and `…` marker.
_Avoid_: output line, transcript tail, display line

**Nested scout**:
A scout spawned by a worker via the restricted subagent tool. Visible to the orchestrator only as the worker's tool-call summary row for the scout call; its internal activity is never relayed, and its usage folds into the worker's cost.
_Avoid_: grandchild spawn, second-level agent, scout-in-worker

**Folded usage**:
A child tool result's usage as the spawn's total cost across all attempts — including failed fallback retries and cancelled partial runs. The footer's per-agent breakdown is a share of that total, never additive.
_Avoid_: per-attempt usage, last-attempt usage, incremental usage

**Structured output**:
The final report every subagent must produce: a role-specific markdown `result` plus a fenced JSON footer with `openQuestions[]`, `decisionPoints[]`, and `filesTouched[]`. The extension parses the footer; on parse failure the report degrades to plain `result` with a warning, never failing the child for format. Extension-appended provenance (model used, requested vs effective thinking level, fallback diagnostics) rides alongside.
_Avoid_: summary, report format, JSON schema output
