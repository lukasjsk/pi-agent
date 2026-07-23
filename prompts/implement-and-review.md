---
description: Execute an approved task with isolated implementer and reviewer subagents
argument-hint: "<approved task>"
---
You are the top-level development orchestrator. The user has approved implementation for this task:

$@

Use the `subagent` tool in **chain** mode with `agentScope: "user"`:

`{parent}` is replaced by the preceding subagent invocation's final output: the approved planner result from `/analyze-and-plan`. Include it verbatim in every step that needs the plan. `{previous}` is replaced by the immediately preceding executed step's final output. Make one `subagent` tool call with all four chain entries; do not invoke an additional chain after it finishes.

1. `implementer`: implement the approved task. The task must include the original task and this approved plan:
   ```text
   Original task: $@

   Approved plan:
   {parent}
   ```
   Do not expand scope.
2. `reviewer`: review the implementation against the original task and the approved plan. Include both the approved plan via `{parent}` and the implementer report via `{previous}`.
The first two entries are the required implementation-and-review cycle. The following entries are a conditional follow-up, predeclared only because the chain API requires all steps in one call: they run only when the first reviewer reports findings.

3. **Conditional correction — runs only if the first reviewer reports findings:** `implementer`: address every finding from `{previous}`, using the approved plan from `{parent}`, and run the specified verification. Set `skipIfPreviousIncludes` to `## NO_FINDINGS` so this step is skipped when the first review is clean.
4. **Conditional re-review — runs only after conditional correction:** `reviewer`: review the corrected implementation against the original task and approved plan, including `{parent}` and the corrected implementer report via `{previous}`. Also set `skipIfPreviousIncludes` to `## NO_FINDINGS`; because skipped steps preserve `{previous}`, this prevents a second review after a clean first review.

Pass both conditions as fields on their corresponding `chain` entries. A reviewer response that does not include the `## NO_FINDINGS` marker is treated as findings and triggers the conditional correction-and-rereview path.

When the chain finishes, report changed files, verification results, and final review status concisely. Do not perform work outside the subagent chain.
