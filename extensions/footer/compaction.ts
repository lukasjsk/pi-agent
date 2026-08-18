import { estimateTokens } from "@earendil-works/pi-coding-agent";

// Minimal structural shapes for compaction-aware stats. Pi's real SessionEntry and
// AgentMessage types are structurally assignable to these, which keeps this module
// decoupled from pi's exact message types (same approach as usage.ts).

/** Usage fields needed to derive a message's total context tokens. */
export interface BranchUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
}

/** Minimal session entry shape as returned by SessionManager.getBranch(). */
export interface BranchEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: BranchUsage;
  };
}

/** An LLM message in the active (compaction-applied) context. */
export interface ContextMessage {
  role: string;
  stopReason?: string;
  usage?: BranchUsage;
}

type EstimationMessage = Parameters<typeof estimateTokens>[0];

function estimateMessageTokens(message: ContextMessage): number {
  return estimateTokens(message as unknown as EstimationMessage);
}

/** Total context tokens for a usage record (native total when reported, components otherwise). */
function usageTokenCount(usage: BranchUsage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Index of the latest compaction entry on the branch, or -1 when never compacted. */
function findCompactionBoundary(branchEntries: readonly BranchEntry[]): number {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") return i;
  }
  return -1;
}

/** True for assistant entries that completed and reported non-zero context usage. */
function isUsableAssistantUsage(entry: BranchEntry): boolean {
  const message = entry.message;
  return entry.type === "message"
    && message?.role === "assistant"
    && message.stopReason !== "error"
    && message.stopReason !== "aborted"
    && message.usage !== undefined
    && usageTokenCount(message.usage) > 0;
}

/**
 * Entries that count toward session stats (token usage, cost, subagent costs).
 * A compaction resets these stats: only entries after the latest compaction entry
 * are returned, or all entries when the branch has never been compacted.
 */
export function postCompactionEntries(branchEntries: readonly BranchEntry[]): BranchEntry[] {
  const boundary = findCompactionBoundary(branchEntries);
  return boundary < 0 ? [...branchEntries] : branchEntries.slice(boundary + 1);
}

function estimateAll(messages: readonly ContextMessage[]): number {
  let estimated = 0;
  for (const message of messages) estimated += estimateMessageTokens(message);
  return estimated;
}

/**
 * Estimate the current LLM context size in tokens, accounting for compaction.
 *
 * Mirrors pi's own context accounting: the last assistant response that came after
 * the latest compaction, plus chars/4 estimates for any trailing messages. Right
 * after a compaction no such response exists yet, so the rebuilt context (summary
 * plus kept messages) is estimated instead of reusing the stale pre-compaction size.
 */
export function estimateCurrentContextTokens(
  branchEntries: readonly BranchEntry[],
  contextMessages: readonly ContextMessage[],
): number {
  const boundary = findCompactionBoundary(branchEntries);

  if (boundary >= 0 && !branchEntries.slice(boundary + 1).some(isUsableAssistantUsage)) {
    // No post-compaction response yet: estimate the rebuilt context from its contents.
    return estimateAll(contextMessages);
  }

  // Last usable assistant usage plus chars/4 estimates for trailing messages.
  for (let i = contextMessages.length - 1; i >= 0; i--) {
    const message = contextMessages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usageTokens = message.usage ? usageTokenCount(message.usage) : 0;
    if (usageTokens <= 0) continue;

    let trailingTokens = 0;
    for (let j = i + 1; j < contextMessages.length; j++) {
      trailingTokens += estimateMessageTokens(contextMessages[j]);
    }
    return usageTokens + trailingTokens;
  }

  return estimateAll(contextMessages);
}
