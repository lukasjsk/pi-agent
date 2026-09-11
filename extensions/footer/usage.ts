import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { SubagentCosts, UsageStats } from "./types.js";

type UsageShape = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

type SessionMessageEvent = {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: UsageShape;
    toolName?: string;
    details?: {
      agent?: string;
      status?: string;
      usage?: { cost?: { total?: number } };
    };
  };
};

/** Labels for the footer's per-child cost breakdown; other agents fall back to their initial. */
const AGENT_LABELS: Record<string, string> = {
  worker: "W",
  scout: "S",
};

function sumUsage(acc: UsageStats, usage: UsageShape): UsageStats {
  return {
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    cacheRead: acc.cacheRead + usage.cacheRead,
    cacheWrite: acc.cacheWrite + usage.cacheWrite,
    cost: acc.cost + usage.cost.total,
  };
}

export function calculateUsage(branch: readonly SessionMessageEvent[]): {
  usageStats: UsageStats;
  subagentCosts: SubagentCosts;
} {
  const usageStats = branch.reduce<UsageStats>((acc, event) => {
    if (event.type !== "message") return acc;
    const message = event.message;
    if (!message?.usage) return acc;

    // Assistant messages: skip failed/aborted runs (no meaningful usage).
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") return acc;
      return sumUsage(acc, message.usage as UsageShape);
    }
    // Tool results (subagent children, incl. nested scout spawns): the platform's
    // getSessionStats() and built-in footer sum these too — no stopReason to filter.
    if (message.role === "toolResult") {
      return sumUsage(acc, message.usage as UsageShape);
    }
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

  // Per-child breakdown, keyed by the child's agent definition name. Informational
  // only: these costs are already part of usageStats (the subagent tool result's
  // message.usage), so the cost segment must not add them on top.
  const subagentCosts: SubagentCosts = {};
  for (const event of branch) {
    if (event.type !== "message") continue;
    const message = event.message;
    if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;
    const child = message.details;
    if (!child?.agent) continue;
    const total = child.usage?.cost?.total;
    if (typeof total === "number" && total > 0) {
      subagentCosts[child.agent] = (subagentCosts[child.agent] ?? 0) + total;
    }
  }

  return { usageStats, subagentCosts };
}

/** Short label for the cost breakdown: bundled agents get a fixed letter, others their initial. */
export function agentCostLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? (agent.charAt(0).toUpperCase() || "?");
}
