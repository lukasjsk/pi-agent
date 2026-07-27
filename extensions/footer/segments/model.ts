import type { RenderedSegment, SegmentContext, SemanticColor } from "../types.js";
import { applyColor } from "../theme.js";
import { color } from "./helpers.js";
import { renderCopilotUsage } from "./copilot.js";

const LEVEL_CAPS: Record<string, string> = {
  off: "OFF",
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "EXTRA HIGH",
  max: "MAX",
};

const LEVEL_COLOR_KEY: Record<string, SemanticColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const LEVEL_COLOR_FALLBACK: Record<string, string> = {
  off: "dim",
  minimal: "muted",
  low: "warning",
  medium: "success",
  high: "#afb9fe",
};

export const modelSegment = {
  id: "model" as const,
  render(ctx: SegmentContext): RenderedSegment {
    let modelName = ctx.model?.name || ctx.model?.id || "no-model";

    if (modelName.startsWith("Claude ")) {
      modelName = modelName.slice(7);
    }

    let content = color(ctx, "model", modelName);

    // Append thinking level inline after model name
    const level = ctx.thinkingLevel || "off";
    const levelLabel = LEVEL_CAPS[level] || level.toUpperCase();
    const colorKey = LEVEL_COLOR_KEY[level];
    const configured = colorKey !== undefined ? ctx.colors[colorKey] : undefined;
    const textColor = configured ?? LEVEL_COLOR_FALLBACK[level] ?? "muted";
    const coloredLevel = applyColor(ctx.theme, textColor as any, levelLabel);

    content += ` ${applyColor(ctx.theme, "dim", "(")}${coloredLevel}${applyColor(ctx.theme, "dim", ")")}`;

    const usage = renderCopilotUsage(ctx);
    if (usage) {
      content += ` ${applyColor(ctx.theme, "dim", "(")}${usage}${applyColor(ctx.theme, "dim", ")")}`;
    }

    return { content, visible: true };
  },
};
