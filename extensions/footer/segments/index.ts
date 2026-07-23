import type { RenderedSegment, SegmentContext, StatusLineSegmentId } from "../types.js";
import { piSegment } from "./pi.js";
import { modelSegment } from "./model.js";
import { pathSegment } from "./path.js";
import { gitSegment } from "./git.js";
import { tokenInSegment, tokenOutSegment, tokenTotalSegment, cacheReadSegment, cacheWriteSegment } from "./tokens.js";
import { costSegment } from "./cost.js";
import { contextPctSegment, contextTotalSegment } from "./context.js";
import { separatorSegment } from "./separator.js";
import { copilotUsageSegment } from "./copilot.js";

const SEGMENTS = {
  pi: piSegment,
  model: modelSegment,
  path: pathSegment,
  git: gitSegment,
  token_in: tokenInSegment,
  token_out: tokenOutSegment,
  token_total: tokenTotalSegment,
  cost: costSegment,
  context_pct: contextPctSegment,
  context_total: contextTotalSegment,
  cache_read: cacheReadSegment,
  cache_write: cacheWriteSegment,
  separator: separatorSegment,
  copilot_usage: copilotUsageSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
  if (id.startsWith("text:")) {
    const text = id.slice(5);
    return { content: text, visible: text.length > 0 };
  }

  const segment = SEGMENTS[id as keyof typeof SEGMENTS];
  if (!segment) {
    return { content: "", visible: false };
  }
  return segment.render(ctx);
}
