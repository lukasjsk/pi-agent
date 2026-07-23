import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { SubagentCosts, UsageStats } from "./types.js";

type SessionMessageEvent = {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: { total: number };
    };
    toolName?: string;
    details?: {
      results?: Array<{
        agent?: string;
        usage?: { cost?: number };
      }>;
    };
  };
};

const WORKFLOW_AGENTS = new Set<keyof SubagentCosts>([
  "explorer",
  "planner",
  "implementer",
  "reviewer",
]);

export function calculateUsage(branch: readonly SessionMessageEvent[]): {
  usageStats: UsageStats;
  subagentCosts: SubagentCosts;
} {
  const usageStats = branch.reduce<UsageStats>((acc, event) => {
    const message = event.type === "message" && event.message?.role === "assistant"
      ? event.message as AssistantMessage
      : undefined;
    if (!message || message.stopReason === "error" || message.stopReason === "aborted") return acc;

    return {
      input: acc.input + message.usage.input,
      output: acc.output + message.usage.output,
      cacheRead: acc.cacheRead + message.usage.cacheRead,
      cacheWrite: acc.cacheWrite + message.usage.cacheWrite,
      cost: acc.cost + message.usage.cost.total,
    };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

  const subagentCosts: SubagentCosts = {};
  for (const event of branch) {
    const message = event.type === "message" && event.message;
    if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;

    for (const result of message.details?.results ?? []) {
      if (!result.agent || !WORKFLOW_AGENTS.has(result.agent as keyof SubagentCosts)) continue;
      const agent = result.agent as keyof SubagentCosts;
      subagentCosts[agent] = (subagentCosts[agent] ?? 0) + (result.usage?.cost ?? 0);
    }
  }

  return { usageStats, subagentCosts };
}
