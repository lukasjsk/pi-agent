import type { RenderedSegment, SegmentContext } from "../types.js";
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
    const subagentTotal = Object.values(ctx.subagentCosts).reduce((total, cost) => total + (cost ?? 0), 0);
    const totalCost = ctx.usageStats.cost + subagentTotal;
    let content = formatCost(ctx, totalCost);

    const labels: Array<[keyof typeof ctx.subagentCosts, string]> = [
      ["explorer", "E"],
      ["planner", "P"],
      ["implementer", "I"],
      ["reviewer", "R"],
    ];
    const subagentBreakdown = labels
      .filter(([agent]) => ctx.subagentCosts[agent] !== undefined)
      .map(([agent, label]) => `${label}:${formatCost(ctx, ctx.subagentCosts[agent] ?? 0)}`);
    const breakdown = [
      `O:${formatCost(ctx, ctx.usageStats.cost)}`,
      ...subagentBreakdown,
    ];

    if (subagentBreakdown.length > 0) {
      content += `${applyColor(ctx.theme, "dim", " (")}${breakdown.join(applyColor(ctx.theme, "dim", ", "))}${applyColor(ctx.theme, "dim", ")")}`;
    }

    if (ctx.isLocalModel) {
      content += applyColor(ctx.theme, "dim", " (local model)");
    }

    return { content, visible: true };
  },
};
