# Research: child usage/cost capture and footer reflection

Context pointer for [lukasjsk/pi-agent#34](https://github.com/lukasjsk/pi-agent/issues/34)
(map: [#12](https://github.com/lukasjsk/pi-agent/issues/12), parent [#30](https://github.com/lukasjsk/pi-agent/issues/30)).

Subject: the `subagents` extension (`extensions/subagents/`) and how a spawned child
session's token usage and cost can be captured and surfaced.

Primary sources, in order:

- Installed pi docs: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
  (cited as `docs/<file>.md`).
- Installed pi source/type declarations under the same package root (cited as
  `dist/...` and `node_modules/@earendil-works/pi-ai/...` from that root).
- This repo, cited by repo-relative path.

Version note: `@earendil-works/pi-coding-agent` as installed (package root
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`); `AgentToolResult`
and `AgentEvent` come from `@earendil-works/pi-agent-core` and `Usage` /
`ToolResultMessage` from `@earendil-works/pi-ai`, both bundled under that root's
`node_modules/`.

## 1. Tool-result usage flow: does returning child `Usage` make the footer reflect it?

**Short answer:** returning accumulated child `Usage` from the tool result makes
the platform's built-in footer, `/session`, and RPC session totals reflect subagent
cost automatically — but *this repo replaces the built-in footer*, so the footer the
user actually sees (`extensions/footer/`) does **not** pick it up without a footer change.

### 1.1 How a tool's `usage` reaches the session

- A custom tool's `execute()` may return `usage` on its result:
  `AgentToolResult.usage` — "Usage from the final tool execution itself, if
  available" (`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:322`,
  same field on the agent-loop's `AgentToolResult` at `:66`). The docs show it on a
  tool result and state the semantics: "If a tool makes nested LLM calls, return
  their combined `Usage` as `usage`. Pi persists it on the tool result and includes
  it in footer, `/session`, and RPC session totals." (`docs/extensions.md:2002`
  example, `docs/extensions.md:2015` statement).
- `usage` is an optional field of the pi-ai `Usage` interface (`input`, `output`,
  `cacheRead`, `cacheWrite`, `totalTokens`, and `cost.{input,output,cacheRead,cacheWrite,total}`)
  — `node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-284`.
- `tool_result` extension handlers can inspect or replace the value: the handler
  result supports `usage` (`docs/extensions.md:851`, `docs/extensions.md:860-873`;
  `ToolResultEvent.usage` at `dist/core/extensions/types.d.ts:731-732`,
  `ToolResultEventResult.usage` at `dist/core/extensions/types.d.ts:839`).
- Pi turns the executed tool result into a tool-result message that carries the
  usage: `createToolResultMessage()` sets `usage: finalized.result.usage`
  (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:550`), and
  `ToolResultMessage.usage` is a first-class field — "Usage from the tool execution
  itself, if available. Not part of main LLM context accounting."
  (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:336`). That message is
  emitted via `message_start`/`message_end` (`agent-loop.js:557-558`) and persisted
  as a session entry.

Handler-chain safety: even though this repo's footer registers a `tool_result`
handler (`extensions/footer/index.ts:142`), a handler that returns `undefined` does
not clear the tool's own usage. `emitToolResult` only marks the event modified when
a handler returns a field, and otherwise returns `undefined`
(`dist/core/extensions/runner.js:693-`), and the agent loop merges with
`usage: afterResult.usage ?? result.usage`
(`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:509`).

### 1.2 Where session totals are computed (exactly what each surface reads)

There are two independent aggregation paths, both keyed off the persisted
`toolResult` message `usage`:

1. **Built-in footer** — `FooterComponent.render()`
   (`dist/modes/interactive/components/footer.js:78-95`):
   - assistant messages → `addUsageToTotals(usageTotals, entry.message.usage)` (`:82`)
   - tool results → `entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage` → `addUsageToTotals` (`:87-88`)
   - branch summaries / compactions → `entry.usage` (`:90-91`)
   - the cost string is `$${usageTotals.cost.toFixed(3)}` (`:129-131`)
   - it iterates `session.sessionManager.getEntries()` (all session entries).
2. **`AgentSession.getSessionStats()`** (`dist/core/agent-session.d.ts:641`;
   `dist/core/agent-session.js:2656-2705`): same three buckets — tool-result
   `message.usage` at `:2676-2678`, assistant `usage` at `:2686`, cost at `:2704`.
   This is what `/session` uses (`dist/modes/interactive/interactive-mode.js:5195`)
   and what RPC `get_session_stats` returns (`dist/modes/rpc/rpc-mode.js:469`;
   documented at `docs/rpc.md:554-595`, "`tokens` and `cost` include assistant
   messages, **usage reported by tools**, and compaction/branch-summary generation
   across the full session" — `docs/rpc.md:593`).
3. **`/session` cost breakdown** — `getUsageCostBreakdown(entries)`
   (`dist/core/usage-totals.js:18-48`) buckets tool-result usage under the key
   `"Tools/summaries"` (`:27-28`); used at `interactive-mode.js:5202`.

`addUsageToTotals` adds `usage.cost.total` into `totals.cost`
(`dist/core/usage-totals.js:10-16`; `UsageTotals` type at
`dist/core/usage-totals.d.ts:4-10`). So a returned tool `usage` — including only
`cost.total` and the four token counts — is exactly what both aggregators sum.

### 1.3 The catch for this repo

The repo's footer extension calls `ctx.ui.setFooter(...)`
(`extensions/footer/index.ts:249`), which "replaces built-in footer entirely"
(`docs/extensions.md:2620-2624`, `docs/tui.md:842-855`). Therefore:

- **Built-in footer / `/session` / RPC** would reflect subagent cost for free once
  `extensions/subagents/index.ts:251` returns `usage`.
- **The displayed footer** is the repo's own component and reads its own
  `calculateUsage()` (`extensions/footer/usage.ts`), which today does **not** count
  tool-result usage at all (see §4). So yes, footer-extension work is required for
  the *visible* footer.

## 2. Accumulation: the most reliable way to total a child run

**Recommendation: use the child `AgentSession`'s own `getSessionStats()` after the
run.** It is the platform's authoritative aggregation and mirrors `/session` and RPC
byte-for-byte: assistant message `usage` + tool-result `usage` + compaction/branch
summary `usage` (`dist/core/agent-session.js:2656-2705`, `dist/core/agent-session.d.ts:641`).
Returning that single object (or its `cost` + token fields) as the tool result's
`usage` makes the child's whole cost count once. Summing `session.messages` yourself
(assistant + `toolResult` `usage`) is equivalent; `getSessionStats()` is less code
and stays correct if the platform adds buckets.

Alternatives and their limits:

- **`message_end` subscription** (extension event at `docs/extensions.md:615-644`;
  event type `dist/core/extensions/types.d.ts:603-605`): each finalised message's
  `usage` is available. It is the right hook for **incremental/live** accumulation,
  but it fires once per message and would need to special-case the
  `toolResult` messages too (to fold nested tool usage) and the terminal
  error/abort message. `session.getSessionStats()` already does this and is simpler
  for the final total.
- **`message_update`**: partial stream only (see §3); do not use it for totals.
- **`turn_end`** carries `event.message` + `event.toolResults`
  (`docs/extensions.md:601-613`) — a coarser incremental point, same caveats.

### 2.1 Completed runs

Fully captured: assistant messages are appended at `message_end`
(`agent-loop.js:238/251`), tool results at `message_end` (`agent-loop.js:558`), and
`getSessionStats()` sums both. `runSubagent` already returns before
`session.dispose()` (`extensions/subagents/spawn.ts:191-228`), so the stat call
belongs in the `try` (before `return`) and in the `catch`, i.e. before the `finally`
disposes the session (`spawn.ts:229`).

### 2.2 Failed runs

The agent loop appends the failed assistant message (stop reason `"error"`) and
emits `message_end` (`agent-loop.js:115`, `:238`, `:251`; the loop returns early at
`agent-loop.js:124-126`). `getSessionStats()` does **not** filter on `stopReason`,
so the failed turn's usage (whatever the provider reported) is counted. The current
`runSubagent` failure path already reaches the `catch` with the session still alive
(`spawn.ts:206-224`), so a stats read there captures it.

### 2.3 Aborted runs (Esc) — is partial usage lost?

Partially, and provider-dependently.

- On abort the stream is finalised and `message_end` still fires with a final
  assistant message whose `stopReason` is set to `"aborted"`
  (`agent-loop.js:238-251`; provider abort assignment e.g.
  `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:626`).
- **Anthropic-style**: `message_start` sets input/cache usage immediately
  (`anthropic-messages.js:409-417`), and `message_delta` updates output tokens as
  they arrive (`anthropic-messages.js:572-592`). So input/cache are retained and
  output is whatever deltas arrived — partial but non-zero.
- **OpenAI-compatible**: usage is only read from the final usage chunk
  (`include_usage` is requested at
  `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:595` and
  consumed at `:378-379`). Aborting mid-stream before that chunk leaves `usage`
  zero. Same shape in `openai-responses.js` / `openai-codex-responses.js`
  (usage is applied by their stream processors, not on abort).
- Consequence: **partial usage on abort is not guaranteed** — it is best-effort.
  `getSessionStats()` after the abort returns exactly what survived, so it is the
  best available number, but it can undercount. Surface it as approximate and do not
  present an aborted child's cost as exact.
- Note a policy mismatch: the repo's footer deliberately excludes
  `stopReason === "error" || "aborted"` (`extensions/footer/usage.ts:42`), while
  `getSessionStats()` includes them. If a child's aborted usage is returned as the
  tool result's `usage`, `/session` and RPC will count it but the repo footer will
  not (it never counts tool-result usage anyway — §4).

## 3. Live availability during streaming

**Yes, per-message usage is available during streaming, but its content is
provider-dependent and may read zero until the stream ends.**

- The `message_update` event carries the partial assistant message plus the delta
  event: extension `MessageUpdateEvent { message; assistantMessageEvent }`
  (`dist/core/extensions/types.d.ts:597-601`), and the SDK's `AgentEvent`
  `{ type: "message_update"; message; assistantMessageEvent }`
  (`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:392-395`).
  The partial `AssistantMessage` includes `usage`.
- RPC projects the partial message's usage as a top-level `usage` field
  (`dist/modes/json-event.js` `toJsonEvent`), and the docs warn: "The top-level
  `usage` field contains the latest cumulative provider-reported usage. It may
  remain zero until completion when a provider does not report usage during
  streaming." (`docs/rpc.md:977-984`).
- Granularity: one cumulative usage snapshot per assistant message, updated on each
  `message_update`. Latency is provider-dependent:
  - Anthropic reports input/cache at `message_start` and output per `message_delta`
    → usable live cost from early in the message.
  - OpenAI-compatible providers report usage only in the final usage chunk → live
    value is 0 until completion.
- The authoritative per-message value is at `message_end`; treat `message_update`
  as a live estimate only.
- In this repo, `renderSubagentResult` already reads `result.usage`
  (`extensions/subagents/render.ts:37`, `:118`) and formats it
  (`formatTokens`, `render.ts:79-85`), but the executor's `onUpdate` partials never
  attach `usage` (`extensions/subagents/index.ts:210`), so the live token line is
  always absent today. Attaching `message_update.message.usage` to the partial
  result in `runOnce`'s subscription (`extensions/subagents/spawn.ts:168-178`) would
  light it up without any platform change.

## 4. This repo's footer: what it reads and what would change

Files named in the ticket: `extensions/footer/segments/cost.ts`,
`extensions/footer/usage.ts`, and `extensions/footer/copilot-usage.ts`. Note
`extensions/footer/segments/usage.ts` **does not exist** — the usage aggregator is
`extensions/footer/usage.ts`.

### 4.1 What each reads today

- **`extensions/footer/usage.ts`** — `calculateUsage(branch)` returns
  `{ usageStats, subagentCosts }`:
  - `usageStats`: reduces **assistant** messages only, skipping
    `stopReason === "error" || "aborted"` (`usage.ts:38-51`). It **never reads
    `toolResult` `message.usage`**.
  - `subagentCosts`: scans `toolResult` messages with `toolName === "subagent"` and
    reads `message.details?.results[]` → `result.agent` + `result.usage.cost`
    (`usage.ts:53-62`). That is the **deprecated** `subagent` extension's
    `SubagentDetails` shape (`results: SingleResult[]`, each `SingleResult.usage` —
    `deprecated/extensions/subagent/index.ts:165,181`). The new `subagents`
    extension returns `details = { status, ...SubagentResult }`
    (`extensions/subagents/index.ts:251`) where `SubagentResult` has **no `results`
    array and no usage field** (`extensions/subagents/spawn.ts:26-41`). So the new
    extension's subagent cost renders as zero.
  - Breakdown is restricted to the four workflow agents
    `explorer|planner|implementer|reviewer` (`usage.ts:27-32`, filter at `:59`;
    `types.ts` `SubagentCosts`), not `worker`/`scout`.
- **`extensions/footer/segments/cost.ts`** — computes
  `subagentTotal = Σ ctx.subagentCosts` and `totalCost = ctx.usageStats.cost + subagentTotal`
  (`cost.ts:18-19`), renders `O:$…` for the orchestrator plus `E/P/I/R` labels
  (`cost.ts:22-35`; label table at `:22-27`). Its `subagentCosts` input comes entirely from the stale
  `details.results[]` path above. `costColor` / `formatCost` are its local
  helpers (`cost.ts:5-13`).
- **`extensions/footer/index.ts`** — wires `calculateUsage` over
  `postCompactionEntries(ctx.sessionManager.getBranch())` (`index.ts:181-185`), so
  a compaction resets footer token/cost totals by design
  (`extensions/footer/compaction.ts`, `postCompactionEntries`). Also re-renders on
  a `subagent` tool-result `message_end` (`index.ts:158-162`).
- **`extensions/footer/segments/copilot.ts`** and
  **`extensions/footer/copilot-usage.ts`** — GitHub Copilot OAuth quota only
  (`copilot-usage.ts:35-55`, rendered in the model segment at `copilot.ts:29-39`);
  unrelated to subagent cost.

### 4.2 Reusable cost-formatting helpers

- The repo has no shared exported cost formatter; `cost.ts` keeps `formatCost` /
  `costColor` private (`cost.ts:5-13`) and `render.ts` keeps a private `formatTokens`
  (`extensions/subagents/render.ts:79`).
- Pi's built-in footer exports `formatTokens` and `formatCwdForFooter`
  (`dist/modes/interactive/components/footer.js:20`, `:31`) — not a public package
  export API (the extension import surface is `@earendil-works/pi-coding-agent`, per
  `docs/extensions.md` "Available Imports"), so prefer a small local helper or lift
  the existing `formatTokens` from `render.ts`.

### 4.3 What change would make the footer show subagent costs

Two viable edits, in increasing scope:

1. **Minimal / platform-aligned (recommended).** In `extensions/footer/usage.ts`,
   fold tool-result usage into `usageStats` alongside assistant usage — i.e. add a
   branch for `event.message.role === "toolResult" && event.message.usage` that adds
   `usage.cost.total` and the token counts, mirroring `getSessionStats()`
   (`dist/core/agent-session.js:2670-2687`) and the built-in footer
   (`footer.js:87-88`). This makes the footer reflect *any* tool's nested usage,
   subagents included, the moment `extensions/subagents/index.ts:251` returns
   `usage` — one line of extension change plus the return-value change in
   `subagents`. Then the stale `details.results[]` scan (`usage.ts:53-62`) and the
   `E/P/I/R` labels can be retired or kept for the deprecated extension.
2. **Structured / per-child breakdown.** If the footer should show *which* child
   cost what (the PLANNED_FEATURES goal, §6), have `runSubagent` put the accumulated
   stats into `SubagentResult` (e.g. a `usage` field) and have `usage.ts` read the
   new `details.usage` (+ `details.agent`) instead of `details.results[]`. Totals
   can still come from the platform tool-result `usage` (option 1), with the details
   field used only for the breakdown, to avoid double counting.

One caveat for either option: the footer aggregator uses
`sessionManager.getBranch()` + `postCompactionEntries` (`index.ts:181-185`), while
`getSessionStats()`/RPC use all `getEntries()`. Subagent cost incurred before a
compaction is therefore retained by `/session` but dropped from the footer — an
existing intentional split (RELEASE_LOG "footer now … counts only session activity
since the latest compaction").

## 5. Nested scout usage and double counting

Setup: a `worker` child gets the restricted `scout` tool injected
(`extensions/subagents/index.ts:87-101`, `:195`, `:307`), whose executor is the same
`createSubagentExecutor` with `fixedAgent="scout"`. A nested scout runs in its own
isolated in-memory `AgentSession` (`SessionManager.inMemory(cwd)` at
`extensions/subagents/spawn.ts:157`; isolation contract at `spawn.ts:1-12`), which is
`dispose()`d at `spawn.ts:229`.

**Is a nested scout's usage folded into the worker's session?** Only if the scout
tool *returns* `usage`. The scout's cost appears to the worker exactly as the
`scout` tool's `AgentToolResult.usage`, which the agent loop persists as a
`toolResult` message inside the worker's session (`agent-loop.js:550`). So:

- If `runSubagent` accumulates via `workerSession.getSessionStats()`, the scout cost
  **is** folded in — `getSessionStats()` counts `toolResult` `message.usage`
  (`agent-session.js:2676-2678`).
- If `runSubagent` instead sums only assistant-message usage, the scout cost is
  **omitted** from the worker's total.

**Avoiding double counting.** The safety property is structural: child sessions are
`SessionManager.inMemory(...)` and never merged into the parent's session
(`spawn.ts:1-12`, `:157`). The orchestrator's session only ever contains the
worker's top-level `subagent` tool result — the nested `scout` tool result lives in
the worker's own in-memory session, invisible to the orchestrator and to
`getSessionStats()` of the parent. Therefore:

- Each session aggregates its **own** full stats once (assistant usage + its own
  tool-result usage bundles, which already include any nested child cost) and reports
  that single total upward via its tool result's `usage`.
- Both the top-level `subagent` tool and the worker's `scout` tool go through the
  same executor, so one change to the return value
  (`extensions/subagents/index.ts:251`) covers both levels.
- The parent must **not** separately re-add the nested scout cost — it cannot see it,
  and re-deriving it from child events would double count. One aggregation site per
  session is the rule.

Net result with the recommended design: orchestrator footer = orchestrator usage +
worker tool-result usage (worker = its assistant usage + scout tool-result usage),
each dollar counted once.

## 6. Recommendation (load-bearing summary)

| Question | Answer |
| --- | --- |
| Does returning child `Usage` auto-reflect in built-in footer, `/session`, RPC? | Yes. `toolResult` `message.usage` is summed by `FooterComponent.render` (`footer.js:87-88`), `getSessionStats()` (`agent-session.js:2676-2678`), and `getUsageCostBreakdown` (`usage-totals.js:27-28`). |
| Does it auto-reflect in *this repo's* footer? | No. The repo replaces the built-in footer (`extensions/footer/index.ts:249`) and its `calculateUsage` never reads tool-result `usage` (`extensions/footer/usage.ts:38-62`), and only recognises the deprecated `details.results[]` shape. |
| Best accumulation API | `childSession.getSessionStats()` after the run (mirrors `/session` + RPC); incremental live value from `message_update.message.usage`. |
| Aborted partial usage | Best-effort, provider-dependent; Anthropic retains input/cache + received output, OpenAI-compatible may report nothing. Not guaranteed. |
| Double counting | Structurally impossible across sessions (in-memory isolated children); fold nested cost once via the child's own stats, return one total upward. |

**Footer code change required: yes** — for the visible footer.

- `extensions/subagents/index.ts` (~line 251): return `usage` on the tool result
  (accumulated from `session.getSessionStats()` / the child's messages); this alone
  fixes `/session`, RPC, and the built-in footer.
- `extensions/footer/usage.ts`: add a `toolResult` `message.usage` branch to
  `usageStats` (mirroring `getSessionStats`), and replace the deprecated
  `details.results[]` scan (`usage.ts:53-62`) with the new `subagents` details shape
  for the per-child breakdown.
- `extensions/footer/segments/cost.ts`: unchanged logic (`usageStats.cost +
  Σ subagentCosts`), but its breakdown labels are hard-coded to the deprecated
  workflow agents (`cost.ts:22-28`) and would need to reflect `worker`/`scout` if a
  per-child breakdown is wanted.
- `extensions/subagents/render.ts` already reads `result.usage` (`render.ts:118`);
  attaching `usage` to `onUpdate` partials (`spawn.ts:168-178`) enables the live
  token line.

## 7. Uncertainty and contradicted evidence

- **Doc vs. type comment on tool-result usage.** `docs/extensions.md:2015` says
  tool usage is included in footer, `/session`, and RPC totals, while the type
  comment says "Not used for main LLM context accounting"
  (`pi-agent-core/dist/types.d.ts:322`, `pi-ai/dist/types.d.ts:336`). These are
  consistent: it is excluded from *context-window* accounting but included in
  *cost/token totals* — confirmed in code by `getSessionStats()`
  (`agent-session.js:2676-2678`) and the built-in footer (`footer.js:87-88`).
- **`extensions/footer/segments/usage.ts` does not exist**; the ticket path is
  wrong. The aggregator is `extensions/footer/usage.ts`.
- **Aborted-run usage is provider-specific.** The claim "partial usage on abort is
  lost" is true for OpenAI-compatible providers (usage only in the final chunk) and
  false for Anthropic (input/cache at `message_start`, output per `message_delta`).
  Neither is verified by an end-to-end test here; both are read from provider stream
  handlers.
- **Compaction divergence.** The repo footer resets totals after a compaction
  (`extensions/footer/index.ts:181`, `compaction.ts` `postCompactionEntries`), while
  `/session`/RPC aggregate all entries. Subagent cost from before a compaction will
  show in `/session` but not the footer.
- **Live cost can read `$0.000`** for much of an OpenAI-compatible child run
  (`docs/rpc.md:983`), which may look like a bug but is provider behaviour.
