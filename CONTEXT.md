# Subagent Workflow

Domain language for the subagents extension: a pi extension that lets the top-level session delegate work to isolated child agent sessions.

## Language

**Orchestrator**:
The top-level interactive pi session that spawns subagents, sequences them, and presents their results and questions to the user. The only session the user talks to.
_Avoid_: parent agent, main agent, controller

**Subagent**:
A child pi agent session spawned via the subagent tool: isolated context, ephemeral, non-interactive, running a fixed role (worker or scout).
_Avoid_: child agent, task agent, delegate

**Worker**:
The general-purpose subagent that performs implementation work and applies skills according to the type of task. May spawn scouts.
_Avoid_: implementer, doer

**Scout**:
The exploration subagent that reconnoiters the workspace and returns a compressed report. A leaf: it cannot spawn further subagents.
_Avoid_: explorer, researcher (researcher is a planned future subagent for web research — different scope)

**Spawn**:
The act of starting a subagent session via the subagent tool, singly or in parallel.
_Avoid_: launch, invoke, fork

**Restricted subagent tool**:
The variant of the subagent tool injected into a worker session that can spawn only scouts, enforcing the spawn-depth limit without loading extensions.

**Spawn depth**:
How many subagent levels nest below the orchestrator. Capped at 1: orchestrator → worker → scout.

**Handover**:
The passing of context and results between the orchestrator and its subagents, and between subagents via the orchestrator.
_Avoid_: ledger, transcript sharing, context dump

**Structured output**:
The final report every subagent must produce: its result, open questions for the user, and decision points the orchestrator must relay.
_Avoid_: summary, report format
