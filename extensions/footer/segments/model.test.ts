import assert from "node:assert/strict";
import test from "node:test";

import type { SegmentContext } from "../types.ts";
import { DEFAULT_ROW1_LEFT, DEFAULT_ROW2_LEFT } from "../config.ts";
import { copilotQuotaColor, copilotUsageSegment } from "./copilot.ts";
import { modelSegment } from "./model.ts";

const ctx = (overrides: Partial<SegmentContext>): SegmentContext => ({
  model: { id: "gpt-5.6", name: "GPT-5.6 Terra", provider: "github-copilot" },
  thinkingLevel: "medium",
  providerUsage: undefined,
  theme: { fg: (_color: unknown, text: string) => text } as SegmentContext["theme"],
  colors: { model: "accent", thinkingMedium: "success" },
  ...overrides,
} as SegmentContext);

test("combines GitHub Copilot usage into the model segment", () => {
  // Low enough that the date-adjusted quota ratio stays in the "success" tier on
  // every calendar day, so the passthrough theme renders the suffix uncolored.
  const rendered = modelSegment.render(ctx({
    providerUsage: { provider: "github-copilot", used: 100, total: 10_000 },
  }));

  assert.equal(rendered.content, "GPT-5.6 Terra (MEDIUM) (github-copilot:100/10000)");
  assert.equal(rendered.visible, true);
});

test("colors the usage suffix by the date-adjusted quota tier", () => {
  // 5051/10000 mid-month lands in the hex tier; applyColor emits raw ANSI for hex
  // colors, so the visible text is the assertion, not the full styled string.
  const rendered = modelSegment.render(ctx({
    providerUsage: { provider: "github-copilot", used: 5051, total: 10_000 },
  }));
  assert.match(rendered.content, /github-copilot:5051\/10000/);
  assert.match(rendered.content, /\x1b\[/, "hex tier applies ANSI regardless of theme");
});

test("retains a pending GitHub Copilot usage suffix while usage loads", () => {
  assert.equal(
    modelSegment.render(ctx({ providerUsage: undefined })).content,
    "GPT-5.6 Terra (MEDIUM) (github-copilot:…)",
  );
});

test("suppresses usage for non-Copilot models and stale provider data", () => {
  const rendered = modelSegment.render(ctx({
    model: { id: "other", name: "Other", provider: "openai" },
    providerUsage: { provider: "github-copilot", used: 1, total: 10 },
  }));

  assert.equal(rendered.content, "Other (MEDIUM)");
});

test("preserves GitHub Copilot's date-adjusted quota color thresholds", () => {
  const date = new Date(2025, 3, 15); // halfway through a 30-day month
  assert.equal(copilotQuotaColor({ provider: "github-copilot", used: 20, total: 100 }, date), "success");
  assert.equal(copilotQuotaColor({ provider: "github-copilot", used: 30, total: 100 }, date), "warning");
  assert.equal(copilotQuotaColor({ provider: "github-copilot", used: 60, total: 100 }, date), "#ff9800");
  assert.equal(copilotQuotaColor({ provider: "github-copilot", used: 90, total: 100 }, date), "error");
});

test("keeps copilot_usage as an invisible compatibility segment", () => {
  assert.deepEqual(copilotUsageSegment.render(ctx({})), { content: "", visible: false });
});

test("places the unified model segment in the default second-row left layout", () => {
  assert.ok(!DEFAULT_ROW1_LEFT.includes("model"));
  assert.deepEqual(DEFAULT_ROW2_LEFT, ["model"]);
  assert.ok(!DEFAULT_ROW2_LEFT.includes("copilot_usage"));
});
