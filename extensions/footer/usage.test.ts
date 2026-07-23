import assert from "node:assert/strict";
import test from "node:test";

import { calculateUsage } from "./usage.ts";

const completedAssistant = (cost: number) => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
  },
});

const subagentResult = (results: Array<{ agent: string; cost: number }>) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolName: "subagent",
    details: { results: results.map(({ agent, cost }) => ({ agent, usage: { cost } })) },
  },
});

test("includes a final reviewer when a live subagent result changes without growing the branch", () => {
  const branch = [
    completedAssistant(0.10),
    subagentResult([{ agent: "implementer", cost: 0.10 }]),
  ];

  assert.equal(calculateUsage(branch).subagentCosts.implementer, 0.10);

  // A chain update replaces its existing tool result while its final reviewer finishes.
  branch[1] = subagentResult([
    { agent: "implementer", cost: 0.10 },
    { agent: "reviewer", cost: 0.35 },
  ]);

  const { usageStats, subagentCosts } = calculateUsage(branch);
  assert.ok(Math.abs(usageStats.cost + Object.values(subagentCosts).reduce((sum, cost) => sum + (cost ?? 0), 0) - 0.55) < Number.EPSILON);
  assert.equal(subagentCosts.reviewer, 0.35);
});
