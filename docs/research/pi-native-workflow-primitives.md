# Research note: Pi-native persistence and child-isolation primitives

## Relevant files

- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md:1-400` — Session entry types, tree traversal, compaction-aware context construction, and `SessionManager` API.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md:1-160` — User-visible branch, tree, fork, clone, resume, and compaction semantics.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md:1-260` — Compaction and branch-summary behavior, extension hooks, and truncation rules.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/usage.md:200-215` — CLI tool-selection semantics.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:97-341` — Installed `SessionManager`, `CustomEntry`, `CustomMessageEntry`, and context APIs.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:198-236` — `buildContextEntries()` and `buildSessionContext()` implementation.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:754-878` — Append semantics for messages, custom entries, and custom messages.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:943-1070` — Branch traversal, leaf movement, and `branchWithSummary()`.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:604-644` — Active-tool registry and `setActiveToolsByName()`.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:650-816` — Exact tool-call inputs, tool-result details, and event mutation contracts.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:635-690` — Tool-result handler merge/persistence behavior.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:79-94,243-248` — `--tools`, `--exclude-tools`, `--no-tools`, and `--no-builtin-tools`.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js:340-350,573-580` — CLI options mapped into session creation.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/11-sessions.ts:1-55` — Persistent and in-memory session creation.
- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/13-session-runtime.ts:1-65` — Runtime session replacement and rebinding.
- `extensions/subagent/index.ts:179-220` — Previous subagent output lookup from the current session branch.
- `extensions/subagent/index.ts:268-276,375-458` — Temporary system-prompt file, child CLI invocation, tool selection, and JSON event capture.
- `extensions/subagent/index.ts:647-742` — Chain interpolation, sequential execution, failure stop, and output forwarding.
- `extensions/subagent/agents.ts:1-105` — Agent frontmatter parsing, including per-agent `tools`.
- `extensions/subagent/agents/scout.md:1-12` — Current scout tool set includes `bash`.
- `extensions/subagent/agents/worker.md:1-8` — Current worker has no `tools` allowlist and therefore receives defaults.

## Current behavior

### Verified facts

#### 1. SessionManager provides append-only, branch-aware persistence

`SessionManager` stores entries as a tree using `id` and `parentId`. The current leaf determines where the next append occurs. `branch(id)` only moves the leaf; it does not delete or modify existing entries. The next append becomes a child of that entry (`session-manager.d.ts:184-341`; `session-manager.js:943-1070`).

Relevant primitives:

- `getBranch(fromId?)` — returns the root-to-entry path.
- `getTree()` — returns the complete tree.
- `getEntries()` — returns all entries, excluding the session header.
- `appendMessage()` — persists regular `user`, `assistant`, and `toolResult` messages.
- `appendCustomEntry()` — persists extension state but excludes it from LLM context.
- `appendCustomMessageEntry()` — persists an extension message and includes it in LLM context.
- `branchWithSummary()` — moves the leaf and appends a `branch_summary` entry.

This is sufficient for branch-aware envelopes: an envelope can be persisted as metadata on a `toolResult` or as a custom session entry whose parent is the active leaf.

#### 2. `toolResult.details` is persisted metadata, not normal LLM content

A `ToolResultMessage` contains:

```ts
{
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ...;
  details?: any;
  isError: boolean;
}
```

`details` is tool-specific metadata (`docs/session-format.md`, “Base Message Types”). It is persisted with the session message, but it is not itself converted into LLM context.

The extension tool-result event exposes both the exact input and details:

```ts
interface ToolResultEventBase {
  toolCallId: string;
  input: Record<string, unknown>;
  content: ...;
  isError: boolean;
  usage?: Usage;
}

interface CustomToolResultEvent extends ToolResultEventBase {
  toolName: string;
  details: unknown;
}
```

`ToolResultEventResult` can replace `content`, `details`, `isError`, and `usage` (`extensions/types.d.ts:693-816`). The runner applies returned `details` to the current tool result before the result is persisted (`runner.js:635-690`).

Therefore:

- `content` is the model-visible tool result.
- `details` is the appropriate place for a structured Output Envelope, raw child messages, exact inputs, provenance, attempt number, and validation status.
- `details` should not be relied on as model-visible context.

The current `subagent` implementation already uses this mechanism: its return value includes `details: SubagentDetails`, and `getPreviousSubagentOutput()` reads the current branch’s persisted `subagent` `toolResult.details` (`extensions/subagent/index.ts:199-212`).

#### 3. Custom entries and custom messages have different semantics

`appendCustomEntry(customType, data)` creates a persistent extension-state entry that does **not** participate in LLM context (`session-format.md`, “CustomEntry”; `session-manager.js:820-831`).

`appendCustomMessageEntry(customType, content, display, details)` creates a persistent `custom_message` entry that **does** participate in LLM context. Its `details` remain extension metadata and are not sent to the model (`session-format.md`, “CustomMessageEntry”; `session-manager.js:866-878`).

This gives three distinct persistence channels:

| Channel | Persisted | In LLM context | Appropriate use |
|---|---:|---:|---|
| `toolResult.content` | Yes | Yes | Compact result visible to parent model |
| `toolResult.details` | Yes | No | Structured Output Envelope and exact execution record |
| `CustomEntry.data` | Yes | No | Extension state/indexes/checkpoints |
| `CustomMessage.content` | Yes | Yes | Deliberately injected downstream context |

`pi.sendMessage()` and `sendUserMessage()` are runtime message-delivery mechanisms, not child-session transfer mechanisms (`extensions/types.d.ts:905-917`).

#### 4. Tree navigation and compaction change active context, not raw history

`buildContextEntries()` walks only the current leaf-to-root path. If a compaction entry is on that path, older entries before `firstKeptEntryId` are omitted from the active context (`session-manager.js:198-236`).

`buildSessionContext()` converts the selected entries into LLM messages:

- regular `message` entries become their stored messages;
- compaction entries become compaction summaries;
- branch summaries become branch-summary messages;
- custom messages become LLM messages;
- plain custom entries are omitted.

Raw entries remain available through `getEntries()`, `getBranch()`, and `getTree()`. Thus, compaction can hide an envelope from future model context without removing it from persistent session history.

Branch summarization is similarly lossy from the model’s perspective: `/tree` can append a generated `branch_summary` at the new branch position (`sessions.md`, “Branch Summaries”; `compaction.md`, “Branch Summarization”). It is not a substitute for exact envelope storage.

Compaction serialization also truncates tool-result content to 2,000 characters during summary generation (`compaction.md`, “Message Serialization”). This makes `toolResult.content` unsuitable as the sole canonical record for exact child output. `details` is not described as being included in that serialized conversation and should be treated as metadata, not summarization input.

#### 5. Exact tool-call input is available to extensions before execution

`tool_call` events expose mutable `event.input`. The type declaration explicitly states that handlers can inspect and mutate arguments before execution, and later handlers observe earlier mutations (`extensions/types.d.ts:650-682`).

For custom tools:

```ts
interface CustomToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}
```

The same exact input is also available on `tool_result` events (`extensions/types.d.ts:693-725`).

This supports:

- validating the parent `subagent` call against an envelope contract;
- recording the exact normalized input in `toolResult.details`;
- blocking invalid delegation;
- performing one controlled repair attempt based on the original input and returned envelope.

However, parent-side extension handlers cannot directly observe the child process’s internal tool events. The current parent only receives child JSON events and stores child `Message` objects (`extensions/subagent/index.ts:415-458`). Child assistant messages include child tool-call blocks and their arguments, so those can be inspected after the fact.

#### 6. Child CLI tool selection applies to extension tools

The installed CLI documents:

- `--tools <list>` — allowlist for built-in, extension, and custom tools.
- `--exclude-tools <list>` — denylist for built-in, extension, and custom tools.
- `--no-tools` — disables all tools.
- `--no-builtin-tools` — disables built-ins while retaining extension/custom tools.

Sources: `docs/usage.md:209-215`, `dist/cli/args.js:79-94,243-248`, and `dist/main.js:340-350,573-580`.

Extension tools are registered into the same tool registry as built-in tools. `AgentSession.setActiveToolsByName()` enables only names present in the registry and rebuilds the system prompt (`agent-session.js:604-644`).

Consequences:

- `--tools read,grep,find,ls` excludes `subagent`, even if the subagent extension is loaded.
- `--exclude-tools subagent` disables the delegation tool while retaining other tools.
- `--no-tools` disables both built-ins and extension/custom tools.
- `--no-builtin-tools` does **not** create a no-delegation mode; it leaves extension tools enabled.

The current child invocation only adds `--tools` when the agent definition has a non-empty `tools` list (`extensions/subagent/index.ts:375-377`). Agents without an allowlist receive the default tool set. The current `worker.md` has no `tools` field, while `scout.md` explicitly includes `bash`.

#### 7. The current child process receives no prior session outputs automatically

The current extension invokes each child as:

```ts
["--mode", "json", "-p", "--no-session", "--model", model]
```

and appends the task as a single CLI argument (`extensions/subagent/index.ts:375-412`).

`--no-session` makes the child ephemeral. There is no use of `--session`, `--fork`, `SessionManager.open()`, or a child `sendMessage()` API. The child receives:

1. its configured system prompt, optionally through a temporary `--append-system-prompt` file;
2. the task string passed on the command line.

Chain prior output is transferred by string interpolation into the next task:

```ts
step.task
  .replace(/\{previous\}/g, previousOutput)
  .replace(/\{parent\}/g, parentOutput)
```

(`extensions/subagent/index.ts:647-736`).

`{parent}` resolves only to the last successful subagent result found in the **parent session’s current branch**, by reading `toolResult.details`. It is not a child-session inheritance primitive.

#### 8. The current chain has sequential output forwarding, but no contract-repair primitive

Chain mode:

- runs steps sequentially;
- forwards the previous step’s final assistant text through `{previous}`;
- can conditionally skip a step with `skipIfPreviousIncludes`;
- stops at the first failed child;
- returns the final result and all step details (`extensions/subagent/index.ts:647-742`).

There is no native envelope schema validation, no distinction between ordinary continuation and repair, and no built-in “retry once with contract-repair instructions” behavior.

The model-candidate retry loop in `runSingleAgent()` is different: it retries failed child processes across configured model candidates (`extensions/subagent/index.ts:351-374,469-520`). It is not a one-time semantic repair of an otherwise successful but invalid output.

#### 9. The current extension already uses temporary files, but only for prompts

`writePromptToTempFile()` writes an agent system prompt to a temporary file, passes it through `--append-system-prompt`, then deletes it (`extensions/subagent/index.ts:268-276,406-409,488-500`).

This file is transport plumbing, not canonical workflow state. The child’s canonical result currently exists in the parent tool result’s `details` and captured `messages`.

## Recommended mechanism

1. **Canonical Output Envelope:** persist it in the parent `subagent` tool result’s `details`. Include:
   - exact normalized `subagent` input;
   - workflow/run and step identifiers;
   - branch/leaf or parent tool-call provenance;
   - child invocation metadata;
   - raw child messages/tool calls;
   - parsed report;
   - validation outcome;
   - repair-attempt count;
   - final status.

   This is branch-aware because the tool-result message is appended to the active `SessionManager` branch and can be recovered with `getBranch()`.

2. **Human/model-visible summary:** put only a bounded, validated summary in `toolResult.content`. Do not make this the exact-record store because compaction serialization truncates tool-result content.

3. **Extension state/indexes:** use `ctx.appendEntry()` / `SessionManager.appendCustomEntry()` only for non-context extension indexes or run metadata. Do not use plain custom entries as the sole envelope store unless the implementation deliberately maintains a lookup keyed to the tool-result entry.

4. **Exact-input inspection:** use the parent `tool_call` handler to snapshot the `subagent` input before execution. Use the `tool_result` handler to attach or finalize the envelope in `details`. For child-level exact inputs, retain the child assistant messages captured from JSON mode; those contain child tool-call arguments.

5. **One contract-repair attempt:** implement this as an explicit bounded chain or parent-side state machine:
   - first child produces a candidate;
   - validate it against the envelope contract;
   - if invalid, invoke exactly one repair child with the candidate output embedded directly in the task;
   - validate the repair result;
   - finalize as valid or contract-failed.

   The existing chain `{previous}` mechanism can transport the candidate without a handoff file, but it does not perform validation by itself.

6. **Child isolation:** pass an explicit child allowlist with `--tools`. For read-only agents, use the smallest required set. Do not rely on absent `tools` frontmatter, because that means default tools.

7. **Delegation ban:** at minimum, exclude the exact extension tool name with `--exclude-tools subagent`, or use an allowlist that omits it. For a stronger ban, omit `bash` as well; tool selection alone cannot prevent a child with `bash` from manually launching `pi` as a shell command.

## Uncertainties

- The installed documentation and declarations verify that `toolResult.details` is persisted metadata, but do not promise that arbitrary large `details` payloads are immune to all future session-format changes. The envelope should remain JSON-serializable and bounded.
- The current parent process cannot intercept child extension events directly. Child tool-call inspection depends on the child’s JSON output retaining assistant tool-call messages; the current implementation captures `message_end` and `tool_result_end`, but does not independently verify every possible JSON event shape.
- `--exclude-tools subagent` is a tool-registry restriction, not a process sandbox. It prevents the extension tool call but does not prevent indirect delegation through `bash`, other custom tools, or a child-written script.
- Branch summaries and compaction preserve a usable summary, not exact historical context. Exact envelope retrieval should use raw session entries/details rather than `buildSessionContext()`.
- The current extension’s model fallback can execute multiple child attempts when configured candidates fail. This is separate from semantic contract repair and must be counted or disabled if the ticket requires a strict “one repair attempt” invariant.

## Implications for the decision tickets

- **Persistence decision:** Pi’s native session tree is sufficient; handoff files are not required as canonical state. Use the parent `toolResult` entry and its `details` as the durable envelope record.
- **Branch-awareness decision:** resolve prior outputs through the current branch (`getBranch()`), not by scanning all session entries or using the most recent global result. The existing `getPreviousSubagentOutput()` already follows this pattern.
- **Exact-input decision:** capture the parent tool input in `tool_call`; capture child tool inputs from retained child assistant messages. Do not infer exact inputs from rendered output text.
- **Contract-repair decision:** no native Pi primitive exists. Add explicit validation and a bounded second invocation; do not confuse it with model fallback.
- **Child-isolation decision:** explicit `--tools` allowlists are the safest current mechanism. `--no-tools` is only suitable for children that need no tools. `--exclude-tools subagent` is useful but is not a hard process-level security boundary.
- **Nested-delegation decision:** a true hard ban requires both tool exclusion and removal or restriction of shell/process-launch capabilities, or an extension-level policy enforced in every child process. The current `worker` configuration is unsafe for this requirement because it has no allowlist; `scout` is also unsafe because it explicitly includes `bash`.
- **Current implementation constraint:** `extensions/subagent/index.ts` currently uses `--no-session`, direct task interpolation, temporary prompt files, and `details`-based parent-output lookup. These are compatible with Pi-native persistence, but the default-tool behavior and unrestricted `bash` access must be addressed before claiming hard child isolation.

## Recommended starting point

Inspect `extensions/subagent/index.ts:375-458` and `:647-742` first, alongside `dist/core/session-manager.d.ts:211-341`. These sections define the existing child transport, branch-aware output lookup, chain semantics, and the native persistence primitives that the decision tickets need to preserve.
