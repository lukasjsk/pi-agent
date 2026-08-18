import assert from "node:assert/strict";
import test from "node:test";

import type { BranchEntry, BranchUsage } from "./compaction.ts";
import { mockPiCodingAgent } from "./pi-mock.ts";

// pi-coding-agent is not resolvable from this repository; mock the only runtime
// dependency with pi's chars/4 heuristic so expected values match the real estimator.
mockPiCodingAgent();

const { estimateCurrentContextTokens, postCompactionEntries } = await import("./compaction.ts");
const { estimateTokens } = await import("@earendil-works/pi-coding-agent");

/** Apply the (mocked) pi estimator to the minimal fixtures used in these tests. */
const est = (message: unknown): number =>
  estimateTokens(message as unknown as Parameters<typeof estimateTokens>[0]);

let sequence = 0;

const usage = (input: number): BranchUsage => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

const assistantEntry = (input: number, stopReason = "stop"): BranchEntry => ({
  type: "message",
  id: `assistant-${++sequence}`,
  message: { role: "assistant", stopReason, usage: usage(input) },
});

const userEntry = (): BranchEntry => ({
  type: "message",
  id: `user-${++sequence}`,
  message: { role: "user" },
});

const compactionEntry = (summary: string): BranchEntry => ({
  type: "compaction",
  id: `compaction-${++sequence}`,
  summary,
  firstKeptEntryId: "",
  tokensBefore: 0,
});

const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistantMessage = (text: string, input?: number) => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text }],
  ...(input !== undefined ? { usage: usage(input) } : {}),
});
const summaryMessage = (summary: string) => ({ role: "compactionSummary", summary });

test("postCompactionEntries keeps every entry when the branch was never compacted", () => {
  const branch = [userEntry(), assistantEntry(100)];
  assert.deepEqual(postCompactionEntries(branch), branch);
});

test("postCompactionEntries only counts entries after the latest compaction", () => {
  const post = assistantEntry(10);
  const branch = [userEntry(), assistantEntry(100_000), compactionEntry("summary"), post];

  assert.deepEqual(postCompactionEntries(branch), [post]);
});

test("estimateCurrentContextTokens uses the last assistant usage plus trailing estimates", () => {
  const branch = [userEntry(), assistantEntry(1000)];
  const trailing = userMessage("a follow-up question after the last assistant response");
  const contextMessages = [userMessage("hello"), assistantMessage("answer", 1000), trailing];

  assert.equal(
    estimateCurrentContextTokens(branch, contextMessages),
    1000 + est(trailing),
  );
});

test("estimateCurrentContextTokens estimates the rebuilt context right after a compaction", () => {
  const branch = [userEntry(), assistantEntry(100_000), compactionEntry("summary")];
  const summary = summaryMessage("a structured summary of the compacted conversation");
  const kept = userMessage("a recent user message that survived the compaction");
  const contextMessages = [summary, kept];

  const actual = estimateCurrentContextTokens(branch, contextMessages);

  assert.equal(actual, est(summary) + est(kept));
  assert.ok(actual < 100_000, "post-compaction size must not reuse stale pre-compaction usage");
});

test("estimateCurrentContextTokens prefers post-compaction usage over stale pre-compaction usage", () => {
  const branch = [userEntry(), assistantEntry(100_000), compactionEntry("summary"), assistantEntry(50_000)];
  const contextMessages = [
    summaryMessage("summary"),
    userMessage("kept message"),
    assistantMessage("post-compaction answer", 50_000),
  ];

  assert.equal(estimateCurrentContextTokens(branch, contextMessages), 50_000);
});

test("estimateCurrentContextTokens falls back to estimation when no post-compaction usage is usable", () => {
  const branch = [
    userEntry(),
    assistantEntry(100_000),
    compactionEntry("summary"),
    assistantEntry(0, "aborted"),
  ];
  const contextMessages = [
    summaryMessage("summary"),
    assistantMessage("aborted answer"),
  ];

  assert.equal(
    estimateCurrentContextTokens(branch, contextMessages),
    est(contextMessages[0]) + est(contextMessages[1]),
  );
});

test("estimateCurrentContextTokens estimates all messages when no assistant responded yet", () => {
  const branch = [userEntry()];
  const contextMessages = [userMessage("hello world, just starting")];

  assert.equal(estimateCurrentContextTokens(branch, contextMessages), est(contextMessages[0]));
});
