import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";
import type { ColorValue } from "../types.js";
import { color } from "./helpers.js";
import { formatTokens } from "./helpers.js";

// Set to a number (0–100) to override context % for visual testing, null to disable
const DEBUG_PCT: number | null = null;

const DEFAULT_BAR_WIDTH     = 18;
const DEFAULT_FILLED_CHAR   = "▋";
const DEFAULT_UNFILLED_CHAR = "▋";
const DEFAULT_UNFILLED_COLOR = "#4e4c49";
const CONTEXT_COLORS = {
  healthy: "success",
  warning: "warning",
  caution: "#f97316",
  critical: "error",
} as const satisfies Record<string, ColorValue>;

/** Color the active bar by the number of tokens currently in context. */
export function getContextProgressColor(contextTokens: number): ColorValue {
  if (contextTokens < 100_000) return CONTEXT_COLORS.healthy;
  if (contextTokens < 120_000) return CONTEXT_COLORS.warning;
  if (contextTokens < 150_000) return CONTEXT_COLORS.caution;
  return CONTEXT_COLORS.critical;
}

export const contextPctSegment = {
  id: "context_pct" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const pct = DEBUG_PCT ?? ctx.contextPercent;
    const barOpts = ctx.options.contextBar ?? {};

    const barWidth     = barOpts.barWidth     ?? DEFAULT_BAR_WIDTH;
    const filledChar   = barOpts.filledChar   ?? DEFAULT_FILLED_CHAR;
    const unfilledChar = barOpts.unfilledChar ?? DEFAULT_UNFILLED_CHAR;
    const unfilledColor = barOpts.unfilledColor ?? DEFAULT_UNFILLED_COLOR;
    const activeColor = getContextProgressColor(ctx.contextTokens);
    const filled = Math.round((pct / 100) * barWidth);

    let bar = "";
    for (let i = 0; i < barWidth; i++) {
      if (i < filled) {
        bar += applyColor(ctx.theme, activeColor, filledChar);
      } else {
        bar += applyColor(ctx.theme, unfilledColor, unfilledChar);
      }
    }
    bar += "\x1b[0m";

    const pctLabel = `${pct.toFixed(1)}%`;
    const pctStr = color(ctx, "contextLabel", pctLabel);
    const tokensLabel = `/ ${formatTokens(ctx.contextWindow)}`;
    const tokensStr = color(ctx, "contextLabel", tokensLabel);

    return { content: `${bar} ${pctStr} ${tokensStr}`, visible: true };
  },
};

export const contextTotalSegment = {
  id: "context_total" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const window = ctx.contextWindow;
    if (!window) return { content: "", visible: false };
    return {
      content: color(ctx, "context", `${window}`),
      visible: true,
    };
  },
};
