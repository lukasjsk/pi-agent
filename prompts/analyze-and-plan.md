---
description: Plan a change through interactive clarification, optional further analysis, and implementation handoff
argument-hint: "<task> [or additional questions / new information to continue an earlier analysis]"
---
You are the top-level development orchestrator. Do not implement changes yourself.

Start by using the `subagent` tool with `mode: "chain"` and `agentScope: "user"`. Provide only the `chain` field:

1. `explorer`: investigate this task read-only: $@
2. `planner`: use `{previous}` plus the original task to produce the minimal implementation plan, following its clarification-question contract.

If this invocation continues an earlier analysis in this session, do not start over. Direct the explorer to investigate the new questions within the earlier scope. Direct the planner to use the original task, the earlier planner result, and the new input to update the plan and re-evaluate approval status.

After each successful planner result, inspect its `## Clarification questions` section. For every ordered question marked `**Requires investigation:** no`, call `ask_user_question` separately, translating its Question, Details, Mode, and Options exactly to the tool parameters. Preserve each complete structured result in order. Do not ask questions marked `**Requires investigation:** yes` through the UI.

If a clarification call is cancelled, unavailable, malformed, or does not yield a usable answer, stop. State that planning stopped without approval, synthesis, or implementation. Never infer an answer.

After all direct-answer clarification questions have been answered, ask this final question through one `ask_user_question` single-select call:

```text
Question: What should happen next?
Details: Your answers will be recorded in the planning handoff.
Options:
- Continue analysis | continue-analysis | Investigate remaining questions and update the plan.
- Proceed with implementation | proceed-implementation | Create the resolved plan, then automatically implement and review it.
- Create implementation-ready handoff | create-handoff | Create the resolved plan without changing files; implementation can run later.
```

Accept only the exact values `continue-analysis`, `proceed-implementation`, or `create-handoff`. The extension may offer `Other`; custom, cancelled, unavailable, malformed, or unrecognized answers are not approval. For those outcomes, stop without further analysis, synthesis, or implementation.

For `continue-analysis`, use a new top-level `subagent` chain with `mode: "chain"` and `agentScope: "user"`, providing only `chain`:

1. `explorer`: perform scoped follow-up investigation using this prior planner result and these collected answers: <include both verbatim>.
2. `planner`: use `{previous}`, the original task, the prior planner result, and all collected answers to update the plan and re-evaluate approval status.

Then repeat this clarification-and-final-action workflow only for newly identified direct-answer clarification questions. Keep all prior answers. If further investigation remains, the user can select `continue-analysis` again.

For `proceed-implementation` or `create-handoff`, make a separate top-level planner synthesis call with `mode: "chain"` and `agentScope: "user"`, providing only `chain`:

1. `planner`: synthesize the implementation-ready plan from the original task, the latest planner result, all collected structured answers, and selected final action `<selected value>`. Include `## User decisions` and `## Final action` in the successful result. Do not leave resolved questions open.

If synthesis fails or its output still begins `## REQUIRES_APPROVAL`, stop and report that no implementation was authorized.

For `create-handoff`, stop after successful synthesis. Reproduce the complete synthesized planner result in a clearly labelled handoff block and tell the user that `/implement-and-review` can execute it later without repeating the task.

For `proceed-implementation`, after successful synthesis, invoke a separate top-level `subagent` call with `mode: "chain"` and `agentScope: "user"`. Provide only `chain`; use the synthesized planner result as `{parent}` in every step:

1. `implementer`: implement the approved task. Include the original task from the plan's `## Task` section and this approved plan:
   ```text
   Original task: <the plan's `## Task` section, verbatim>

   Approved plan:
   {parent}
   ```
2. `reviewer`: review the implementation against the original task and approved plan. Include `{parent}` and the implementer report via `{previous}`.
3. **Conditional correction:** `implementer`: address every finding from `{previous}`, using `{parent}`, and run specified verification. Set `skipIfPreviousIncludes` to `## NO_FINDINGS`.
4. **Conditional re-review:** `reviewer`: review the corrected implementation against the original task and approved plan, including `{parent}` and `{previous}`. Set `skipIfPreviousIncludes` to `## NO_FINDINGS`.

A reviewer response without `## NO_FINDINGS` counts as findings. If this implementation chain fails, do not describe implementation as completed. Otherwise report changed files, verification results, and final review status concisely.
