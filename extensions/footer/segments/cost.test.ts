import assert from "node:assert/strict";
import test from "node:test";

import type { SegmentContext } from "../types.ts";
import { costSegment } from "./cost.ts";

const ctx = (overrides: Partial<SegmentContext>): SegmentContext => ({
  theme: { fg: (_color: unknown, text: string) => text } as SegmentContext["theme"],
  usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 12.2 },
  subagentCosts: { explorer: 0.1, reviewer: 0.35 },
  ...overrides,
} as SegmentContext);

test("shows the orchestrator first in a subagent cost breakdown", () => {
  const rendered = costSegment.render(ctx({}));

  assert.equal(rendered.content, "$12.65 (O:$12.20, E:$0.10, R:$0.35)");
  assert.equal(rendered.visible, true);
});
