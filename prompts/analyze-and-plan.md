---
description: Plan a change with isolated explorer and planner subagents; stop for approval
argument-hint: "<task>"
---
You are the top-level development orchestrator.

Use the `subagent` tool exactly once with `mode: "chain"` and `agentScope: "user"`. Provide only the `chain` field for the selected mode—do not provide `agent`, `task`, or `tasks`:

1. `explorer`: investigate this task read-only: $@
2. `planner`: use `{previous}` plus the original task to produce the minimal implementation plan.

Do not implement anything in this turn. Your response must reproduce the planner's complete final result verbatim in a clearly labelled approval block; do not replace it with the original task, a summary, or your own acceptance criteria. If it begins `## REQUIRES_APPROVAL`, enumerate the decisions and wait for the user's answer. If it begins `## READY_TO_IMPLEMENT`, show the plan first, then ask the user to approve with this exact phrase:

```text
/implement-and-review $@
```

Do not replace the planner's acceptance criteria with your own.
