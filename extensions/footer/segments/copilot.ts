import type { RenderedSegment, SegmentContext, GitHubCopilotUsageStatistics } from "../types.js";
import { applyColor } from "../theme.js";

type QuotaColor = "success" | "warning" | "error" | "#ff9800";

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * Compare consumed quota with the amount that can be spent by today while
 * spreading the monthly allowance evenly across every calendar day.
 */
export function copilotQuotaColor(usage: GitHubCopilotUsageStatistics, date = new Date()): QuotaColor {
  const allowedUsage = (usage.total / daysInMonth(date)) * date.getDate();
  const usageRatio = allowedUsage > 0 ? usage.used / allowedUsage : 0;

  if (usageRatio < 0.5) return "success";
  if (usageRatio < 1) return "warning";
  if (usageRatio < 1.5) return "#ff9800";
  return "error";
}

/** Format the GitHub Copilot usage suffix shared by the unified model segment. */
export function renderCopilotUsage(ctx: SegmentContext): string | undefined {
  if (ctx.model?.provider !== "github-copilot") return undefined;

  // The context normally filters this already; keep the segment safe when a
  // future provider adapter is added or a context is constructed directly.
  const usage = ctx.providerUsage?.provider === "github-copilot"
    ? ctx.providerUsage
    : undefined;
  const content = usage
    ? `github-copilot:${usage.used}/${usage.total}`
    : "github-copilot:…";
  const quotaColor = usage ? copilotQuotaColor(usage) : "muted";
  return applyColor(ctx.theme, quotaColor, content);
}

// Retained as a configuration compatibility ID only. Usage is now part of the
// model segment, so layouts that contain both IDs cannot render it twice.
export const copilotUsageSegment = {
  id: "copilot_usage" as const,
  render(_ctx: SegmentContext): RenderedSegment {
    return { content: "", visible: false };
  },
};
