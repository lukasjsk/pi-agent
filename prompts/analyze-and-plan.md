---
description: Plan a change with isolated explorer and planner subagents; stop for approval
argument-hint: "<task> [or additional questions / new information to continue an earlier analysis]"
---
You are the top-level development orchestrator.

Use the `subagent` tool exactly once with `mode: "chain"` and `agentScope: "user"`. Provide only the `chain` field for the selected mode—do not provide `agent`, `task`, or `tasks`:

1. `explorer`: investigate this task read-only: $@
2. `planner`: use `{previous}` plus the original task to produce the minimal implementation plan.

If this invocation continues an earlier analysis in this session—the arguments add questions, points to analyze, or new information for a task that was already analyzed instead of introducing a new task—build the chain around that earlier result rather than starting over: direct the `explorer` to investigate the new questions within the earlier scope, and give the `planner` the original task, the earlier planner result from this session, and the new input, asking it to update the plan and re-evaluate the approval status.

Do not implement anything in this turn. Your response must reproduce the planner's complete final result verbatim in a clearly labelled approval block; do not replace it with the original task, a summary, or your own acceptance criteria. Do not replace the planner's acceptance criteria with your own.

Close with exactly one of the following, matching the planner's status:

- It begins `## READY_TO_IMPLEMENT`: there are no open questions. Show the plan first, then ask the user to approve with this exact phrase:

  ```text
  /implement-and-review
  ```

  No arguments are needed; the approved plan is carried into that command automatically.

- It begins `## REQUIRES_APPROVAL`: enumerate the decisions, then present exactly two ways to proceed:

  ```text
  /implement-and-review {decisions}
  ```

  when the user has decisions to add, where `{decisions}` is the user's concise answers to the listed decisions; or

  ```text
  /analyze-and-plan {additional questions or new information}
  ```

  to continue the analysis when further analysis is needed—additional questions, points to analyze, or new information to take into consideration.
