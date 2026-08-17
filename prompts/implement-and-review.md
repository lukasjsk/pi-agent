---
description: Execute an approved task with isolated implementer and reviewer subagents
argument-hint: "[decisions]"
---
You are the top-level development orchestrator. The user has approved implementation of the task analyzed by `/analyze-and-plan` earlier in this session.

The approved plan is the planner result from that invocation; it is supplied to the chain via `{parent}` and contains the original task in its `## Task` section. If the plan has no `## Task` section, take the original task from the `/analyze-and-plan` invocation earlier in this session. If arguments were provided ($@), they are the user's decisions or additional constraints for the plan's open questions—not the original task—and they are binding where they resolve a listed decision. If no arguments were provided, implement the plan as written. If the arguments merely restate the original task, treat them as a restatement, not new decisions.

If no approved plan from `/analyze-and-plan` exists earlier in this session, stop and ask the user to run `/analyze-and-plan <task>` first.

Use the `subagent` tool exactly once with `mode: "chain"` and `agentScope: "user"`. Provide only the `chain` field for the selected mode—do not provide `agent`, `task`, or `tasks`:

`{parent}` is replaced by the preceding subagent invocation's final output: the approved planner result from `/analyze-and-plan`. Include it verbatim in every step that needs the plan. `{previous}` is replaced by the immediately preceding executed step's final output. Make one `subagent` tool call with all four chain entries; do not invoke an additional chain after it finishes.

1. `implementer`: implement the approved task. The task must include the original task from the plan's `## Task` section and this approved plan, plus the user's decisions when arguments were provided:
   ```text
   Original task: <the plan's `## Task` section, verbatim>

   Approved plan:
   {parent}

   User decisions:
   $@
   ```
   Omit the `User decisions` section when no arguments were provided. Do not expand scope.
2. `reviewer`: review the implementation against the original task, the approved plan, and any user decisions. Include the approved plan via `{parent}`, the user's decisions when provided, and the implementer report via `{previous}`.
The first two entries are the required implementation-and-review cycle. The following entries are a conditional follow-up, predeclared only because the chain API requires all steps in one call: they run only when the first reviewer reports findings.

3. **Conditional correction — runs only if the first reviewer reports findings:** `implementer`: address every finding from `{previous}`, using the approved plan from `{parent}`, and run the specified verification. Set `skipIfPreviousIncludes` to `## NO_FINDINGS` so this step is skipped when the first review is clean.
4. **Conditional re-review — runs only after conditional correction:** `reviewer`: review the corrected implementation against the original task and approved plan, including `{parent}` and the corrected implementer report via `{previous}`. Also set `skipIfPreviousIncludes` to `## NO_FINDINGS`; because skipped steps preserve `{previous}`, this prevents a second review after a clean first review.

Pass both conditions as fields on their corresponding `chain` entries. A reviewer response that does not include the `## NO_FINDINGS` marker is treated as findings and triggers the conditional correction-and-rereview path.

When the chain finishes, report changed files, verification results, and final review status concisely. Do not perform work outside the subagent chain.
