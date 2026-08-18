import assert from "node:assert/strict";
import test from "node:test";

import type { SegmentContext } from "../types.ts";
import { contextPctSegment, getContextProgressColor } from "./context.ts";

const ctx = (overrides: Partial<SegmentContext>): SegmentContext => ({
  contextPercent: 23.1,
  contextTokens: 23_100,
  contextWindow: 1_000_000,
  options: {},
  theme: { fg: (_color: unknown, text: string) => text } as SegmentContext["theme"],
  ...overrides,
} as SegmentContext);

test("shows used context tokens next to the percentage", () => {
  const rendered = contextPctSegment.render(ctx({}));
  assert.equal(rendered.visible, true);
  assert.ok(rendered.content.endsWith("23.1% 23.1k/1M"), rendered.content);
});

test("switches context sizes to the M suffix from 1M", () => {
  const rendered = contextPctSegment.render(ctx({ contextPercent: 12, contextTokens: 120_000 }));
  assert.ok(rendered.content.endsWith("12.0% 120k/1M"), rendered.content);
});

test("uses green progress below 100k context tokens", () => {
  assert.equal(getContextProgressColor(99_999), "success");
});

test("uses yellow progress from 100k through 119,999 context tokens", () => {
  assert.equal(getContextProgressColor(100_000), "warning");
  assert.equal(getContextProgressColor(119_999), "warning");
});

test("uses orange progress from 120k through 149,999 context tokens", () => {
  assert.equal(getContextProgressColor(120_000), "#f97316");
  assert.equal(getContextProgressColor(149_999), "#f97316");
});

test("uses red progress at 150k context tokens and above", () => {
  assert.equal(getContextProgressColor(150_000), "error");
  assert.equal(getContextProgressColor(200_000), "error");
});
