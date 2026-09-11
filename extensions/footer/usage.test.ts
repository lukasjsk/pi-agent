import assert from "node:assert/strict";
import test from "node:test";

import { agentCostLabel, calculateUsage } from "./usage.ts";

const completedAssistant = (cost: number) => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
  },
});

const subagentResult = (agent: string, cost: number) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolName: "subagent",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    details: { agent, status: "completed", usage: { cost: { total: cost } } },
  },
});

test("tool-result usage is folded into the totals, matching /session and the built-in footer", () => {
  const branch = [completedAssistant(0.10), subagentResult("scout", 0.05)];
  const { usageStats } = calculateUsage(branch);
  assert.ok(Math.abs(usageStats.cost - 0.15) < Number.EPSILON);
});

test("aborted assistant messages are skipped; tool-result usage never is", () => {
  const branch = [
    completedAssistant(0.10),
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "aborted",
        usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } },
      },
    },
    subagentResult("scout", 0.05),
  ];
  const { usageStats } = calculateUsage(branch);
  assert.ok(Math.abs(usageStats.cost - 0.15) < Number.EPSILON);
  assert.equal(usageStats.input, 0);
});

test("per-child breakdown is keyed by the child's agent name and is not added to the total", () => {
  const branch = [completedAssistant(0.10), subagentResult("scout", 0.05), subagentResult("worker", 0.20)];
  const { usageStats, subagentCosts } = calculateUsage(branch);
  assert.equal(subagentCosts.scout, 0.05);
  assert.equal(subagentCosts.worker, 0.20);
  // Child costs already ride usageStats — adding them again would double count.
  assert.ok(Math.abs(usageStats.cost - 0.35) < Number.EPSILON);
});

test("usage-bearing subagent results without an agent name are not attributed", () => {
  const branch = [
    completedAssistant(0.10),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
        details: { status: "completed" },
      },
    },
  ];
  const { subagentCosts } = calculateUsage(branch);
  assert.deepEqual(subagentCosts, {});
});

test("non-subagent tool results count toward totals but never the breakdown", () => {
  const branch = [
    completedAssistant(0.10),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        details: {},
      },
    },
  ];
  const { usageStats, subagentCosts } = calculateUsage(branch);
  assert.ok(Math.abs(usageStats.cost - 0.11) < Number.EPSILON);
  assert.deepEqual(subagentCosts, {});
});

test("agentCostLabel: fixed letters for bundled agents, initial for user-defined", () => {
  assert.equal(agentCostLabel("worker"), "W");
  assert.equal(agentCostLabel("scout"), "S");
  assert.equal(agentCostLabel("researcher"), "R");
});
