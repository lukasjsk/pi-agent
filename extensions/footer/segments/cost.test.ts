import assert from "node:assert/strict";
import test from "node:test";

import type { SegmentContext } from "../types.ts";
import { costSegment } from "./cost.ts";

const ctx = (overrides: Partial<SegmentContext>): SegmentContext => ({
  theme: { fg: (_color: unknown, text: string) => text } as SegmentContext["theme"],
  usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 12.2 },
  subagentCosts: {},
  ...overrides,
} as SegmentContext);

test("breakdown lists the orchestrator first; child costs are informational shares of the total", () => {
  const rendered = costSegment.render(ctx({ subagentCosts: { worker: 0.1, scout: 0.35 } }));

  // usageStats already includes the children (they ride the tool result's message.usage),
  // so the total stays 12.20 — adding the breakdown again would double count.
  assert.equal(rendered.content, "$12.20 (O:$12.20, W:$0.10, S:$0.35)");
  assert.equal(rendered.visible, true);
});

test("user-defined agents fall back to their initial as the breakdown label", () => {
  const rendered = costSegment.render(ctx({ subagentCosts: { researcher: 0.25 } }));
  assert.equal(rendered.content, "$12.20 (O:$12.20, R:$0.25)");
});

test("no breakdown is shown when no child cost was attributed", () => {
  const rendered = costSegment.render(ctx({}));
  assert.equal(rendered.content, "$12.20");
});
