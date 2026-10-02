# Research: Pi Durable as the workflow substrate

Context pointer for [lukasjsk/pi-agent#52](https://github.com/lukasjsk/pi-agent/issues/52)
(map: [#39](https://github.com/lukasjsk/pi-agent/issues/39)).

Findings from primary sources, all read locally on the charting box:

- `@earendil-works/pi-durable` v1.0.0 — package source at `/tmp/pi-durable/package`
  (`README.md`, `dist/**/*.d.ts`, `package.json`, `CHANGELOG.md`).
- The announcement article, <https://earendil.com/posts/pi-durable/> (text at
  `/tmp/sdlc/pi-durable.txt`).
- Prior research: `docs/research/pi-native-workflow-primitives.md` and
  `research/pi-platform-capabilities.md`.

Citations to `README.md:NN` and `dist/*.d.ts:NN` are relative to the package root.

## Summary

**Yes — Pi Durable is a viable and arguably preferable substrate for the state-machine SDLC engine, with three caveats:** (1) it ships **no TUI/terminal client and no built-in subagent, skills, or coding-agent interop** — those are things you build on top; (2) the whole package is self-declared **experimental ("The API changes without notice between releases", `README.md:5`)**, version 1.0.0, MIT; and (3) **bounded retry and contract-repair are not native primitives** — you implement them inside task phases/hooks with a memo counter.

The package gives you exactly the missing primitives the current pi-coding-agent `subagent` extension lacks: a durable **task state machine** (`defineTask`, phases, checkpoints, `waiting`/`policy`, ownership tree, background boundaries, memos, restart-surviving timers), **documents** (typed, versioned, fork-aware JSON committed atomically with the transcript — ideal for run state: current node, iteration count, accumulated findings), a **hook chain** that can express approval gates (memoized, crash-safe) and run-continuation, and a **multiplayer client model** (committed-state views/watches) that supersedes the terminal-pane notification approach. Interop is deliberately loose: it shares `pi-ai` and `chord` with the coding agent but reimplements extensions/tools/tasks from scratch.

## Findings

### 1. Tasks — the node/transition engine

Exact API:

- `dist/tasks.d.ts:2` — `export declare function defineTask<I, S extends { phase: string }, R, H extends object = object>(definition: TaskDefinition<I, S, R, H>): Task<I, S, R, H>;`
- `dist/types.d.ts:187-210` — `TaskDefinition`:
  ```ts
  export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
      readonly name: string;
      readonly version: number;
      initial(input: I): S;
      readonly phases: { readonly [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H> };
      abort(task, runtime, context): Promise<void>;
      migrate?(input, checkpoint, fromVersion): { input: I; checkpoint: S };
      readonly hooks?: H;
  };
  ```
- `PhaseHandler` (`dist/types.d.ts:116-118`): "Runs one checkpoint phase. It must commit a changed checkpoint or a terminal outcome through `runtime.commit()`; returning without durable progress faults the task." So **every phase is a durable checkpoint** — resume lands on the last committed phase.
- `NextTaskState` (`dist/types.d.ts:112-114`) is `running | waiting | terminal`; a `terminal` return is stored as `completing` while owned work is live (spec §5.5 referenced in-code).
- `TaskRuntime` (`dist/types.d.ts:132-183`): `commit(change → NextTaskState)`, `memo<T>(name)` / `memo(name, candidate)` (first-write-wins), `getTask`, `waitForTask`, `outcomes(ids)`, `conversation(id)`, `entry`, `context`, `now()`, `sleep(until)`, `report`, plus `registry`, `agent()`, `settings`, `models`, `env()`, `hooks`, `signal`.
- `TaskState` (`dist/types.d.ts:429-453`): `pending | running | waiting (with on + policy) | completing | terminal`; checkpoint carried on pending/running/waiting.
- `JoinPolicy = "failFast" | "allSettled"` (`dist/types.d.ts:225`).
- `TaskOptions` (`dist/types.d.ts:227-238`): `ownership` **required** (conversation or task), optional `conversationId`, `background` (conversation-owned only; excluded from idle waits/aborts).

**Can a task's phase machine be the workflow node/transition engine? Yes.** A phase map over a discriminated-union checkpoint is a literal state machine; you get branch (commit different `phase` values), loops (commit the same phase with bumped counters), fan-out + join (`{status:"waiting", on:[...], policy}` — `README.md:444-470`), and cleanup (`abort` runs bottom-up). The `Payment`/`Checkout` example (announcement, `/tmp/sdlc/pi-durable.txt:452-580`) is a working durable fan-out/fail-fast/abort/refund machine. **Bounded retry is not a primitive** — you store an `attempt` counter in the checkpoint and commit a terminal/loop transition yourself; the only built-in retry is provider-level (`settings.retry`, `ConversationRetryPolicy`, `dist/harness/types.d.ts:283-288`). Timers: `TaskRuntime.sleep(until)` plus the README's "timers that survive restarts" (announcement) — a background task can fire later.

### 2. Conversations — the subagent model

- `Conversation` handle: `dist/harness/types.d.ts:429-469` — `agent`, `configure`, `submit`, `reset`, `compact`, `commit`, `context`, `entries`, `fork`, `abort`, `waitForIdle`, `viewState`, `watch`.
- Submission model: `SubmissionDraft` = `{type:"input", content, whenBusy?: "steer"|"followUp"|"reject", requestId?} | {type:"write", entry}` (`dist/harness/types.d.ts:18-27`); `Submission` = `{id, status(), wait(), abort()}` (`:37-42`). Durable lifecycle `queued → placed → done/unanswered` (`dist/types.d.ts:330-383`).
- **A subagent is a conversation owned by a task** (the tool call): `tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })`, then `api.conversation(child).submit(...)` and `wait()` — shown verbatim in `README.md:397-442` and the announcement (`/tmp/sdlc/pi-durable.txt:411-455`). It "starts as a copy of this conversation's agent". `replay: "safe"` on the tool makes a crash-rerun find the same child via `tx.scanConversations({ownerTaskId})`.
- **No built-in subagent.** README's example table lists `22-subagent-foreground.ts` / `23-subagent-background.ts` as *examples*, and the announcement states: "Pi Durable has no built-in subagents, but they take a few lines of code to build" (`/tmp/sdlc/pi-durable.txt`, subagents section).
- Forks: `Conversation.fork(at, options)` (`dist/harness/types.d.ts:449`); "A fork sees its parent's entries up to `entryId`... keeps the parent's agent as of that entry" (`README.md:388-395`).
- Concurrency: one harness runs many conversations concurrently; both keep working (`/tmp/sdlc/pi-durable.txt`, "Many conversations at once"). Per-conversation agent config (`model`, `thinkingLevel`, `extensions`, `tools`, `instructions`, `cwd`) via `configure()`/`AgentState` (`dist/harness/types.d.ts:236-278`, `README.md:188-208`). Forked/task-owned conversations inherit the owner's agent.

### 3. Documents — durable workflow-run state

- `defineDoc` overloads: `dist/documents.d.ts:8-38` (singleton and `defineDocFamily` for keyed families; scopes `session`, `conversation`, `task`).
- Definition shape: `CommonDocDefinition` (`dist/types.d.ts:49-75`) — `kind`, `version`, `initial()`, `migrate?(value, fromVersion)`, `checkpointWhen?(value, ops, info)` (choose base vs delta commits).
- Semantics (`LatestConversationSemantics` / `RewindableConversationSemantics`, `dist/types.d.ts:29-48`): `history: "latest" | "rewindable"`; `fork: "current" | "initial" | "asOf"`. Conversation docs are the only ones with history/fork; session and task docs are latest-only.
- **Atomic with the transcript:** a commit "can append entries, edit documents, and create tasks together; either all of it is stored or none of it" (`README.md:78-100`, "Commit"). Document edits go through `tx.doc(token, ...)` (`dist/types.d.ts:614-640`).
- Reading/observing: `harness.snapshot`, `snapshotAsOf` (rewindable), `documentState`, `watchDoc` (`dist/types.d.ts:707-760`).

**Fitness:** strong. A conversation-scoped `{scope:"conversation", history:"latest", fork:"asOf"}` doc holding `{node, iteration, findings[]}` is committed atomically with each transition, is fork-aware (a review fork can start from the parent's state at the fork entry, `fork:"asOf"`), and is versioned via `migrate`. Caveat: values are JSON validated only structurally; there is no schema validation beyond the TypeScript generic — you own semantic validation.

### 4. Hooks

- Registration: `hook(task, handlers)` (`dist/harness/define.d.ts:12`), `HookRegistration` (`dist/harness/types.d.ts`). Handler maps keyed by task: `GenerationHooks` (`beforeRequest`, `afterResponse`, `onYield`, `afterTools`, `dist/harness/types.d.ts:518-533`), `ToolHooks` (`beforeTool`, `afterTool`, `:535-544`), `CompactionHooks` (`beforeCompact`, `:546-556`). `HookApi` = committed reads + the task's memos (`:510-516`).
- Chain semantics (verbatim, `README.md:367-386`): "Their hooks run as a chain, in the order the conversation selects the extensions, and each hook defines how its chain runs. `beforeTool` passes rewritten arguments down the chain, and the first `block` stops it. `afterTool` passes the result down the chain. `onYield` stops at the first hook that keeps the run going. Observers like `afterResponse` always run them all. A hook that throws is reported, and the chain continues, except in `beforeTool`, where a throw blocks the call."
- **Human approval gate: yes, and crash-safe.** The announcement's `Approval` hook uses `api.memo<boolean>("approval:deploy", ...)`; "After a restart, the hook finds the stored answer instead of asking again." A `beforeTool` returning `{ block }` stops the call.
- **Bounded contract-repair turn: partially.** `onYield` returning `{ continue: UserInput }` appends a user message and continues the run (bounded only by your own counter); `afterResponse` observes every terminal provider message before classification. There is no built-in "retry once with repair instructions" — implement it with an attempt counter in a memo/doc and a phase that decides. (This matches prior research: the coding-agent side has "no native Pi primitive... Add explicit validation and a bounded second invocation", `pi-native-workflow-primitives.md`.)

### 5. Clients / attach

- `Conversation.viewState()` → disposable read-only Chord state (`dist/harness/types.d.ts:466`); `watch()` → serialized exact-frame watch with bounded pending frames (`:468`, `README.md:259-287`): "A slow watch keeps at most 100 undelivered frames... A client that joins late or reconnects starts from the current view; nothing is replayed." Partial answers/tool output committed at most every 100 ms.
- `watchEvents(harness, id, context)` — experimental coding-agent-shaped events (`dist/harness/events.d.ts`, `README.md:351-365`).
- Steering: `whenBusy: "steer" | "followUp" | "reject"` (`README.md:289-307`) + `settings.steeringMode/followUpMode` (`QueueMode = "all" | "one-at-a-time"`, `dist/harness/types.d.ts`). `submission.abort()` withdraws a queued item; `Conversation.abort()` (Esc) withdraws queued inputs and aborts the task scope (`dist/harness/types.d.ts:461-464`).
- **What a client must render:** `ConversationView` (`dist/harness/view.d.ts:8-16`) — `conversation` record, `entries` (active transcript), and `docs` keyed by kind (`pi.agent`, `pi.live` [running generation + tool calls/output], `pi.inbox`, `pi.usage`). Plus optionally `taskGraph()` / `watchTaskGraph()` (`dist/harness/task-graph.d.ts`, `README.md:471-485`).
- **Viable replacement for the terminal-pane notification model? Yes as a substrate, no as a drop-in.** Every UI need is committed state and "any number of clients can attach... join late, and steer", but **no TUI/terminal client ships in this package** — the only TUI is the *vacation planner demo*, which lives in the coding-agent repo (`packages/coding-agent/src/experimental/vacation/main.ts`) and "borrows its TUI components from the Pi coding agent". One process owns storage; other clients attach to it (`README.md:519-525`).

### 6. Extensions / registry

- `defineExtension` / `defineTool` / `section` / `hook` / `wrapTool` / `wrapSection` (`dist/harness/define.d.ts`).
- `Extension` (`dist/harness/types.d.ts:194-205`): `name`, `tools?`, `sections?`, `hooks?`, `wraps?`, `tasks?`. Note: **`tasks` resolve by name for every task whichever conversations select the extension** — tasks are registry-global, unlike tools/hooks/sections which are per-conversation-selectable.
- Registry: `createRegistry()` (`dist/harness/registry.d.ts:6`), `Registry.install` "replace the installed extension with its name in place. Publishes at once", `uninstall` (`dist/harness/types.d.ts:225-233`). `BUILTIN_TASKS` "cannot be removed or replaced" (`dist/harness/registry.d.ts:3`).
- Tool replace/wrap: "A later extension's tool with the same name replaces an earlier one where both are selected, and `wrapTool()` decorates whichever tool won" (`README.md:145-176`).
- **Versioning a workflow package:** name the extension (e.g. `"sdlc"`), install it in the registry, and version the durable pieces — task `version` + `migrate` (`dist/types.d.ts:191,206`), doc `version` + `migrate` (`dist/types.d.ts:56-58`). Installing the same name replaces the code in place; conversations store only names, so after a restart they pick up the new install (`README.md:247-257`). Registry mutability is live ("new work uses the new state", `README.md:78-100`).

### 7. Storage / env — durability guarantees

- Backends (`README.md:519-554`; `package.json` exports): Memory, SQLite (`openNodeSqliteStorage`, node built-in `node:sqlite`), JSONL (append-only, `{fsync:true}` optional). Portable SQLite/JSONL cores run on Bun / Cloudflare Durable Objects given a `SqliteDatabase`/`FileSystem` facade.
- `Harness.open(storage, options, context)` (`dist/harness/harness.d.ts`); `harness.resume()` enables the scheduler (idempotent; `dist/harness/types.d.ts:472-490`).
- **Single-process ownership:** "One process owns a storage at a time; there is no cross-process locking" (`README.md`).
- **Exactly-once submissions:** `requestId` dedup — "A retried submission with the same `requestId` returns the existing submission instead of submitting twice"; `harness.submission(id)` reacquires after restart (`README.md:101-123`).
- **Replay-safe tools:** tool intent committed before `execute()`; on reopen a call reruns "only when it is declared `replay: "safe"`; otherwise the model gets an `interrupted` error result" (`README.md:145-176`, `dist/harness/tool.d.ts:16-20`).
- **Crash recovery:** SQLite WAL + `synchronous = NORMAL` — "commits survive process crashes; the newest may be lost on power or host failure" (`README.md`; `dist/storage/sqlite/node.d.ts`). `running` tasks reopen as `pending` (`README.md:471-485`); recovery invariants stated in `dist/harness/scheduler.d.ts:43-58`.
- **Environments:** `ExecutionEnv = FileSystem & Shell` (`dist/env/index.d.ts`); `HarnessOptions.env` builds one per tool call from the conversation's `cwd` (`dist/harness/types.d.ts`, `README.md:231-246`); ships `NodeExecutionEnv`.

### 8. Fit and gaps

- **TUI / terminal client: neither ships.** Confirmed by grep across the package's `.d.ts` and README. You must build the client (or reuse the coding agent's TUI components, as the demo does).
- **pi-coding-agent interop: essentially none.** The package shares `@earendil-works/pi-ai` and `@earendil-works/chord` (`package.json` deps) and reimplements conversations/tasks/tools/extensions itself. **No skills, no `AGENTS.md`/context-file handling, no agent-definition files, no `subagent` tool, and no reuse of coding-agent extensions.** The only bridge is that the coding agent is being experimentally rebuilt on durable (`packages/coding-agent/src/experimental/durable/main.ts`, `.../vacation/main.ts`, per the announcement) — not the other way around.
- **Standalone vs in-process:** the package is Node >= 22.19.0 (`package.json engines`) and runs standalone; the experimental examples run it *inside* a Pi coding-agent checkout, so embedding in the coding-agent process is done in practice but not a documented interop API.
- **Stability/licensing:** `README.md:5` "**Experimental.** The API changes without notice between releases"; `CHANGELOG.md` shows a single `[1.0.0] - 2026-10-01` release; `package.json` `license: "MIT"`, repo `github.com/earendil-works/pi`, `packages/durable`. Explicitly experimental: the header and the "Agent Events (Experimental)" section (`README.md:351`).
- **Not answered by the package:** no documented crash-recovery guarantee stronger than "newest commit may be lost on power/host failure"; no cross-process locking / leader election; no built-in workflow/scheduler abstraction above tasks; no human-approval UI primitive (only the memo-hook pattern).

### 9. Comparison

| Axis | pi-coding-agent extension + `subagent` tool | Pi Durable tasks/conversations/documents |
|---|---|---|
| State machine | None native; chain with `{previous}`/`skipIfPreviousIncludes` | `defineTask` phases + checkpoint (`dist/types.d.ts:187-210`); loop/branch by committing next phase |
| Persistence / resume | Session tree (`SessionManager`), append-only; `--no-session` children are ephemeral | Durable per-step checkpoints; `resume()`; requestId exactly-once; replay-safe tools (`README.md:101-123`) |
| Subagents | Built-in `subagent` extension via CLI subprocess / SDK | Not built-in; a task-owned conversation, "a few lines of code" (announcement) |
| Human gates | Parent TUI `ctx.ui` relay only; child questions must be relayed | Memoized `beforeTool` approval hook, crash-safe (announcement) |
| Observability | Tool `onUpdate`/`renderCall`/`renderResult`, `ctx.ui` widgets | Committed `viewState`/`watch`/`watchEvents`; `taskGraph` (`dist/harness/view.d.ts`, `task-graph.d.ts`) |
| Interactive sessions | Child has no own TUI; nested TUI unsupported | Child conversation is watcheable/steerable by any client; no TUI ships either |
| Dependency cost | Extends installed coding agent; skills/context files free | `pi-durable` + `pi-ai` + `chord` + TypeBox; you rebuild skills/agents |
| Maturity | Shipping pi 1.0 platform | 1.0.0, MIT, self-declared experimental (`README.md:5`) |

## Recommended mechanism

Build the workflow node/transition engine as a `defineTask` phase machine (`dist/types.d.ts:187-210`), one task per workflow node, with the run's state in a **conversation-scoped rewindable document** (`history:"latest"`, `fork:"asOf"`) holding `{node, iteration, findings}` committed atomically with each transition. Express review→implementation loops as phase transitions that bump the iteration counter in the checkpoint; express fan-out (scout/plan/review) as `waiting` with `on` + `policy: "failFast"`. Each subagent is a task-owned conversation created and driven from a `replay:"safe"` tool (pattern from `README.md:397-442`). Human approval/clarification gates are memoized `beforeTool`/`onYield` hooks (`api.memo`, crash-safe). Bounded contract-repair is a hook/task-phase counter, not a native feature. Expose the engine to UIs via `viewState`/`watch` and `taskGraph`. Version it as one registry extension named `"sdlc"` with per-task `version` + `migrate`. Keep it standalone (or embedded only if you accept the undocumented interop) and do **not** rely on it for skills/agent-definition files/coding-agent extensions — those are absent.

## Uncertainties

- **Interop is undocumented.** Whether a workflow package can meaningfully embed the pi coding-agent (reuse its skills/tools/agent files) is not answered by `pi-durable`'s types or README; the only evidence is the experimental `packages/coding-agent/src/experimental/durable` demo, which may itself be the pattern or may change.
- **API instability.** "Experimental. The API changes without notice" (`README.md:5`) — the `.d.ts` contract cannot be treated as frozen.
- **No built-in workflow-above-tasks abstraction and no built-in bounded retry.** The caller must decide whether to construct those on tasks/docs (recommended) or accept that the engine's retry/saga semantics are hand-rolled.
- **Durability ceiling.** SQLite `synchronous = NORMAL` can lose the newest commit on power/host failure; if the workflow requires stronger guarantees, choose JSONL `{fsync:true}` or a custom backend (the package ships a conformance suite).
- **No TUI/terminal client and no leader election.** Multiplayer works by clients attaching to one storage-owning process; horizontal scaling / failover is out of scope and unaddressed.
