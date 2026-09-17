# Spec: New Subagents Extension

Hand-off spec for implementing a new `subagents` extension for pi. Plan + requirements; decisions are locked on
[map #12](https://github.com/lukasjsk/pi-agent/issues/12) (tickets #13–#19, all resolved) — each section cites its ticket.
Domain language: see [CONTEXT.md](CONTEXT.md). Source task: [PLANNED_FEATURES.md](PLANNED_FEATURES.md) lines 4–6.

**Reference only (greenfield — no behavior inherited by default):** `deprecated/extensions/subagent/`.

---

## 1. Goal

A pi extension that lets the top-level interactive session (the **orchestrator**) delegate work to isolated,
non-interactive child agent sessions (**subagents**) via a general subagent-spawning tool, with `worker`, `scout`, and
`researcher` shipped as bundled agent definitions. Users can define their own agents on top.

## 2. Non-goals (out of scope)

- New `/analyze-and-plan` and `/implement-and-review` prompts — a separate effort built on this extension. That layer
  also owns "persist the plan for later" (ask the user; orchestrator writes files itself — no extension mechanism).
- Scout git-history exploration (token-efficient) — separate concern, potentially its own map.
- Orchestrator workflow policies — how the orchestrator decides what to delegate, review loops, question-presentation
  policy. Live in the prompt/workflow layer.
- Extensions inside children. Children never load extensions (hard rule, see §5).

## 3. Requirements

### R1 — Execution model (from #14)

1. Children are **SDK in-process** sessions created with `createAgentSession()` from
   `@earendil-works/pi-coding-agent` (an extension may import the package it runs inside).
2. Children are **ephemeral**: `SessionManager.inMemory()`, no session file. Opt-in debug-persistence mode
   (extension-wide setting) may persist child sessions for debugging.
3. Children are **fully isolated by default**: no parent conversation, no transcript sharing. Everything a child
   receives is explicit (§R6).
4. Children inherit merged settings, repo `AGENTS.md`, and user+project skills; **extensions are OFF** for all
   children.
5. Children are **non-interactive**: they cannot render question UI. Questions surface only via their structured
   output; the orchestrator relays them to the user.
6. Spawn depth is capped at **1 below the orchestrator**: orchestrator → worker → scout. Workers get a *restricted
   subagent tool* (scout-only) via `customTools` (§R8). No child ever receives a general subagent tool.
7. Children **inherit the orchestrator's cwd**, passed explicitly via `createAgentSession({ cwd })`. cwd is not a
   per-spawn override.
8. Esc cancels running children with a partial-result report (§R9).

### R2 — Agent definitions (from #15)

1. An **agent definition** is one markdown file: YAML frontmatter carries config, the body is the system prompt.
2. Frontmatter is a **closed set**; unknown fields are ignored with a warning:
   - `name` — spawn identifier (unique)
   - `description` — when to use it; feeds the subagent tool description so the orchestrator picks correctly
   - `tools` — **required** tool allowlist (array of tool names; see §R5)
   - `model` — ordered fallback list (see §R4); an entry may pin its thinking level via the
     `provider/model-id@level` suffix (e.g. `github-copilot/gpt-5.6-terra@max`) — unpinned entries
     use the agent's `thinkingLevel` default
   - `thinkingLevel` — default thinking level for unpinned chain entries (and the parent fallback);
     one of the platform levels; platform clamps to model capabilities
   - `skills` — `on` / `off`, **default `on`** (see §R10)
3. The markdown body is the agent's system prompt, applied via `systemPromptOverride` in `DefaultResourceLoader`.
4. **Bundled definitions** ship inside the extension: `worker`, `scout`, and `researcher` (§R3).
5. **User-level override:** a file in `~/.pi/agent/agents/*.md` whose `name` matches a bundled name **replaces** it.
   There are **no project-level definitions** (hermetic posture).
6. **Discovery is fresh on every spawn** — mid-session edits take effect immediately. A corrupt/invalid definition
   fails only its own spawn with a clear diagnostic; other agents are unaffected.
7. **Per-spawn overrides are limited to `model` and `thinkingLevel`.** `tools`, `skills`, and the prompt stay
   definition-pinned.

### R3 — Bundled agents (from #15, #18, #19)

Three bundled definitions, freshly designed (deprecated prompts are reference only):

**`scout`** — exploration; returns compressed context.
- `tools: [read, grep, find, ls]` — truly read-only, **no bash**.
- `skills: on`; `thinkingLevel: low` (default for the parent fallback entry). Model chain (user-tuned):
  local `local-qwen38/unsloth/Qwen3.8-27B-GGUF:Q4_K_M@medium` (llama-server, free) →
  `github-copilot/gpt-5.6-luna@xhigh` → the orchestrator's model.
- Report shape (fresh design, enforced by its prompt): Files Retrieved (exact `path:lines`) · Key Code (verbatim,
  within size budget) · Architecture (how pieces connect) · Start Here (which file first and why).
- **Zero re-exploration quality bar**: a worker consuming a scout report must never need to re-read the same files —
  every claim carries an exact `file:line` reference.

**`worker`** — general-purpose implementation work.
- `tools: [read, bash, edit, write, grep, find, ls]` + the restricted scout-spawning tool (injected via
  `customTools`, §R8).
- `skills: on` (see §R10 for leverage behavior).
- Model chain (user-tuned):
  `local-qwen38/unsloth/Qwen3.8-27B-GGUF:Q4_K_M@medium` → `github-copilot/gpt-5.6-luna@max` →
  the orchestrator's model (`thinkingLevel: medium` covers the parent fallback entry).
- Report shape (fresh design): what was done, files changed (paths + what), notes for the orchestrator.

**`researcher`** — live-web research; returns a compressed, source-cited report.
- `tools: [read, grep, find, ls]` — read-only against the workspace, **no bash**. Its live-web surface is not in the
  frontmatter allowlist: a set of purpose-built `firecrawl_*` tools (`firecrawl_search`, `firecrawl_scrape`,
  `firecrawl_map`, `firecrawl_crawl`, `firecrawl_research`, `firecrawl_developer`) is **injected via `customTools`**
  (the same path as the worker's scout tool, §R8/§R10.6) and appended to the child's tool list at session creation.
  Each tool wraps one firecrawl CLI subcommand via `execFile` (no shell): the subcommand + primary argument(s) are
  typed parameters, extra flags ride in an `options` string array of individual argv tokens, so a researcher cannot
  run arbitrary commands. Because these names never appear in the frontmatter `tools` list, §R5.2's unknown-name
  validation is untouched.
- `skills: on` (the firecrawl skills document the exact flags, carried in `options`); `thinkingLevel: medium`
  (default for the parent fallback entry). Model chain (user-tuned, same as scout):
  `local-qwen38/unsloth/Qwen3.8-27B-GGUF:Q4_K_M@medium` → `github-copilot/gpt-5.6-luna@xhigh` →
  the orchestrator's model.
- Report shape: Summary · Findings · Sources (URL + saved file path) · Gaps. **Zero re-fetch quality bar**: every
  claim carries a source URL.

All bundled prompts must: mandate the structured output contract (§R7), instruct **before/after provenance is
extension-appended** (never child-authored), and — for worker — carry the **skill selection guidance** (§R10).

### R4 — Model fallback (from #16)

An agent definition's `model` is an **ordered list**. Resolution pipeline:

1. **At spawn:** entries without valid auth are skipped (`modelRuntime.getAvailable()` pre-check); the child starts
   on the first usable model.
2. **Runtime failure** (provider error mid-task): transparently retry the same task on the **next** entry. Partial
   child progress is discarded; the retry is noted in the result diagnostics.
   - **Transient errors first (§R4.2a):** dropped streams/connections, timeouts, and provider overload are retried
     on the **same** entry (bounded — 2 retries, short backoff) *before* moving down the chain. This matters for
     single-entry chains (no `model` list → the parent's model), which have no next entry; and it avoids silently
     switching models on a blip. Spent usage folds into the child total (§R11.6); retries are noted in diagnostics.
     Non-transient failures (auth, bad request, context limits) skip straight to the next entry.
3. **The orchestrator's model is the final fallback, always:** the parent's current model is appended to the end of
   the resolved chain, deduped by ref id (a definition listing the parent's own model does not run it twice). Only a
   list whose entries were all skipped *and* whose parent model is unavailable is a spawn error, with per-candidate
   diagnostics (what was tried, why each failed).
4. **Per-spawn `model` override replaces the list entirely** — the override is definitive; no fallback net applies
   (no parent append either).
5. **Per-entry thinking pins:** an entry's `@level` wins over the definition's `thinkingLevel`; a per-spawn
   `thinkingLevel` param wins over both and rides the whole chain. Precedence: per-spawn > entry pin > definition.

### R5 — Tool scope & security (from #16)

1. `tools` is the allowlist applied at session creation (`createAgentSession({ tools })`).
2. **Unknown tool name → that agent's spawn fails** (fail fast) with a diagnostic listing the unknown names and the
   valid ones. (Platform built-ins: `read, bash, edit, write, grep, find, ls`.)
3. A user definition omitting `tools` **fails to load** (not silent defaults).
4. **No spawn gate**: no confirmation prompt; children are same-trust as the orchestrator session. Visibility comes
   from live TUI streaming (§R10.5) and Esc-cancel.
5. User-defined agents **never** receive a subagent tool, regardless of their `tools` list.

### R6 — Handover: context in, results out (from #18)

1. **Parent→child:** the `task` brief is the **entire** parent context. The orchestrator writes it self-contained
   (including excerpts of prior results or overflow-file paths). No transcript sharing; `buildContextEntries()`
   stays unused.
2. **Between children:** **explicit passing via the orchestrator only**. No automatic handover ledger. Large results
   forward cheaply as overflow-file paths (the receiving sibling has `read`).
3. **Persistence:** no extension mechanism. Overflow reports live in OS temp (§R9.3); anything the user wants kept,
   the orchestrator writes itself (prompt-layer concern).

### R7 — Structured output contract (from #18, #16)

Every child's final report:

1. **`result`** — markdown body, role-specific shape per the agent definition's prompt (§R3).
2. **JSON footer** — the report ends with a fenced ```json block:
   ```json
   {
     "openQuestions": [{ "question": "…", "whyItMatters": "…" }],
     "decisionPoints": [{ "decision": "…", "rationale": "…" }],
     "filesTouched": ["path/to/file.ts"]
   }
   ```
   Short strings only (no code in the footer — code lives in the markdown body, unescaped).
3. **Parsing:** the extension parses the footer. On parse failure the whole report becomes `result`, fields default
   to empty, and a warning is added to diagnostics. **The child is never failed for format alone.**
4. **Provenance (extension-appended, not child-authored):** model actually used, requested vs effective thinking
   level, fallback/`cancelled`/parse diagnostics.

### R8 — Orchestrator tool surface (from #17)

One registered tool, **blocking**, params:

| param | type | notes |
| --- | --- | --- |
| `agent` | string | agent name; unknown name = spawn error |
| `task` | string | the self-contained brief (entire parent context) |
| `model` | string, optional | replaces the definition's list (§R4.4) |
| `thinkingLevel` | string, optional | platform-clamped (§R4-thinking) |

1. **Blocking:** the call returns when its child finishes or is cancelled. Live progress streams into the tool call's
   rendering via `onUpdate`.
2. **One call = one subagent.** Parallel spawning = the orchestrator LLM issuing multiple calls in one message.
3. **Concurrency cap 4** (extension-wide, configurable). Excess spawns **queue** and start as slots free up.
4. **Esc** cancels running **and** queued children; each returns a partial-result report.
5. **Result transport:** in-context result capped at **10KB**; oversized reports **overflow** to
   `$TMPDIR/pi-subagents/<session-id>/<spawn-id>.md` (path referenced in the tool result; no auto-cleanup). The full
   payload also rides in the tool result's `details` for TUI rendering and branch-aware session replay. Nested usage
   accounting folds into session totals (platform).

### R9 — Failure semantics (from #17, #16)

1. A failing child **never cancels siblings**; siblings run to completion.
2. Every tool result carries its child's **status** (`completed` / `failed` / `cancelled`) plus diagnostics; the
   orchestrator decides on retries.
3. "Completed" vs "completed after fallback (model X)" is distinguishable in the result; exhausted fallback lists
   carry per-candidate failure info.
4. **Thinking level:** rides the platform clamp silently (unsupported level degrades; non-reasoning → `off`).
   Requested vs effective level is recorded in provenance (§R7.4); no TUI warning, no hard error. A fallback model
   switch re-clamps automatically.

### R10 — Skills, worker side, TUI

1. **Worker skill leverage (from #19): native self-selection.** The worker receives all inherited skills (user +
   project); names+descriptions inject into its prompt natively; it loads matching SKILL.md files on demand via
   `read` before working. The worker definition's prompt carries the selection guidance. No orchestrator
   preselection, no extension-side filtering (`skillsOverride` stays unused).
2. **`skills` field stays `on/off`, default on** (#15's closed set unchanged). A list-valued `skills` may be added
   **later, additively**.
3. **Bundled scout keeps `skills: on`.**
4. **Reporting:** each SKILL.md the worker actually loads surfaces as a footer `decisionPoint` (skill name + why it
   matched); quiet when none.
5. **TUI presentation:** superseded by **§R11 — TUI observability** (map #30), which holds the full contract;
   the live-view refinement of this item has been promoted there.
6. **Worker-side restricted tool (from #14, #17):** the same tool, injected via `customTools`, but with no `agent`
   parameter — it **always spawns the bundled `scout`**; params: `task` + optional `model`/`thinkingLevel`.
   Parallel scouts from a worker are allowed under the same global cap. User-defined agents are never spawnable by
   workers; depth stays 1.
7. **Researcher-side firecrawl tools:** the `researcher`'s children receive the `firecrawl_*` tool set via the same
   `customTools` injection (§R3). These are leaf capability tools (not a subagent spawner), so they do not affect
   spawn depth; a researcher never receives any subagent tool.

### R11 — TUI observability (map #30)

The full presentation and accounting contract for subagents in the orchestrator's TUI. Written off the
Decisions-so-far of map "observability for the subagents extension" (tickets #31–#36, #38, #35); supersedes #27's
original recommendation. Glossary: CONTEXT.md — **Tool-call summary**, **Content line**, **Nested scout**,
**Folded usage**.

1. **Framing (#33):** the row renders itself (`renderShell: "self"`) inside a `DynamicBorder` in a role/status
   color: role color while running (accent for worker, muted for scout), status color when settled
   (success/error/warning). No background tint. The border is constant across states; content truncates to
   terminal width.
2. **Live collapsed view (#31):** custom `renderCall`/`renderResult` per child tool call. The running row shows a
   **two-line header** — line 1: role · task excerpt; line 2: model (`provider/id`) · effective thinking level ·
   elapsed · running tokens · live cost (4-decimal; omitted until the first usage-bearing message settles). Below:
   the last **3** tool-call summary rows (`status marker · tool name · single primary target`: ✓ done, ✗ error,
   ◦ running; no args, no results), then the last **3** content lines (raw, per-line display cap 100 + `…`).
   The flat progress string is not part of the running row. Queued spawns render as one dim line
   (`… queued · role · n ahead`) with no rows.
3. **Expanded view (#32, as amended by #35):** expansion is the platform's global Ctrl+O (`options.expanded`); no
   per-row affordance. **Running expanded** shows the same structure with every relayed row: all 20 tool-call ring
   entries and all 10 content lines (per-line display cap 160) — the live *tail*, not a transcript.
   **Settled expanded** is a hybrid: report body, structured footer sections in fixed order ending with
   files-touched and the overflow-path line, provenance, and the full persisted tool-call list. Raw tool outputs
   are never shown.
4. **Nested scouts (#36):** a worker's scout spawn renders as an ordinary tool-call summary row among the worker's
   rows (collapsed and expanded — flattened). The scout's internal activity is never relayed to the orchestrator.
   Scout cost folds into the worker's total; no per-scout split, no depth marker. Depth-1 is an
   extension-enforced invariant, not per-row information.
5. **Payload contract (#35):** the tool result's `details` is a live/settled union, evolved additively — renderers
   tolerate absent fields, no migration for in-flight sessions.
   - **Live** (streamed via `onUpdate`, transient): `status: "running"` + activity — bounded progress tail
     (~330 chars; the queued notice pre-run), tool-call ring (max **20**), content lines (ring max **10**, relay
     cap **200 chars/line**, assistant text only), `model`, `effectiveThinkingLevel`, running `tokens`
     (`{input, output}`), display-only `cost`.
   - **Settled** (persisted — the replay source): `status`, `agent`, `report`, `footer`, `diagnostics`,
     provenance (`modelUsed`, requested/effective thinking), `overflowPath`, `usage` (total-across-attempts),
     `calls` — the **full** tool-call list, cap **1000** with an omission marker. Content lines are dropped at
     settle (the report supersedes them).
6. **Cost accounting (#34, #38):** a child's `getSessionStats()`, read once before dispose and returned once on
   the tool result, is the **single accounting source**; the live relay cost is display-only and never feeds
   accounting. The footer folds tool-result usage into its totals; the per-agent breakdown (orchestrator `O:`
   first, then bundled agents in the fixed order `S:`/`R:`/`W:`, then user-defined agents by initial letter in
   first-seen order) is an informational share of that total, never added on top. A cancelled
   child's partial usage counts as real spend — the footer's `stopReason: aborted/error` skip stays scoped to
   assistant messages; tool results are settled child-session totals and are always summed. A failed fallback
   attempt's usage folds into the returned total, noted in diagnostics. **Compaction divergence (intentional):**
   the footer aggregates post-compaction entries only, so pre-compaction subagent cost appears in `/session` and
   RPC but not the footer — consistent with every footer segment; `/session` is the whole-session source of truth.
7. **Narrow terminals (map fog, settled):** line-level truncation to terminal width only; every line (header,
   tool rows, content lines) truncates independently and the row reflows line-by-line. No special narrow-mode
   layout; sections never merge or drop.
8. **Implementation status:** shipped — the bordered self-shell framing, two-line header (thinking level,
   running tokens, 4-decimal cost), collapsed tool rows at 3, live payload thinking/tokens, the settled `calls`
   list (cap 1000, omission marker, content lines dropped at settle), and failed-retry usage folding are
   implemented and test-covered. The live relay cost stays display-only; the settled `usage` on the tool
   result is the single accounting source.

## 4. Implementation plan

Phased so each step is testable in isolation; platform references are to the pi docs under
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (citations collected on branch
`research/pi-platform-capabilities`).

1. **Definition layer** — frontmatter parse/validate (`tools` required, unknown fields warned), bundled
   `worker`/`scout` definitions, user-level override by name, fresh discovery per spawn, per-spawn failure
   isolation.
2. **Spawn core** — `createAgentSession()` child assembly: systemPromptOverride, cwd inheritance, in-memory session,
   tools allowlist + unknown-name fail-fast, extensions off, skill inheritance.
3. **Model fallback pipeline** — `getAvailable()` pre-check → first usable model; runtime-failure retry down the
   list; parent model always appended as final fallback (deduped); `ref@level` per-entry thinking pins;
   override-replaces-list.
4. **Orchestrator tool** — blocking execute, `onUpdate` progress relay from child events, statuses, 10KB cap +
   overflow files, `details` payload, Esc handling, concurrency cap 4 + queue.
5. **Output contract** — JSON footer parse with graceful degradation, provenance append, truncation.
6. **Worker-side restricted tool** — scout-only injection via `customTools`, depth enforcement.
7. **TUI observability** — implemented per §R11: bordered self-shell framing, two-line live header, 3-row
   collapsed tail, live payload thinking/tokens, settled `calls` list with omission marker, and failed-retry
   usage folding.
8. **Acceptance pass** — walk every requirement in §3 against the implementation; exercise parallel spawns, a
   runtime-failure fallback, an unparseable footer, an oversized report, Esc-cancel mid-run.

## 5. Open items (non-blocking)

- List-valued `skills` per role: deliberately deferred; additive later without breaking definitions (#19).
