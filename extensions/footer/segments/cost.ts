import type { RenderedSegment, SegmentContext } from "../types.js";
import { agentCostLabel } from "../usage.js";
import { applyColor } from "../theme.js";

function costColor(cost: number): "success" | "warning" | "error" | "#ff9800" {
  if (cost > 2) return "error";
  if (cost > 1) return "#ff9800";
  if (cost > 0.5) return "warning";
  return "success";
}

function formatCost(ctx: SegmentContext, cost: number): string {
  return applyColor(ctx.theme, costColor(cost), `$${cost.toFixed(2)}`);
}

export const costSegment = {
  id: "cost" as const,
  render(ctx: SegmentContext): RenderedSegment {
    // Child usage rides the subagent tool result's message.usage and is already part of
    // usageStats (calculateUsage sums toolResult messages), matching /session and the
    // built-in footer. The per-agent breakdown is informational — never added on top.
    const totalCost = ctx.usageStats.cost;
    let content = formatCost(ctx, totalCost);

    const breakdown = [
      `O:${formatCost(ctx, ctx.usageStats.cost)}`,
      ...Object.entries(ctx.subagentCosts)
        .filter(([, cost]) => cost !== undefined)
        .map(([agent, cost]) => `${agentCostLabel(agent)}:${formatCost(ctx, cost ?? 0)}`),
    ];

    if (Object.keys(ctx.subagentCosts).length > 0) {
      content += `${applyColor(ctx.theme, "dim", " (")}${breakdown.join(applyColor(ctx.theme, "dim", ", "))}${applyColor(ctx.theme, "dim", ")")}`;
    }

    if (ctx.isLocalModel) {
      content += applyColor(ctx.theme, "dim", " (local model)");
    }

    return { content, visible: true };
  },
};
