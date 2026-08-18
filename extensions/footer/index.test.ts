import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { mockPiCodingAgent } from "./pi-mock.ts";

mockPiCodingAgent();

const refreshedContexts: ExtensionContext[] = [];

mock.module("@earendil-works/pi-tui", () => ({
  visibleWidth: (text: string) => text.length,
  truncateToWidth: (text: string) => text,
}));

mock.module("./copilot-usage.js", () => ({
  refreshCopilotUsageStatistics: async (ctx: ExtensionContext) => {
    refreshedContexts.push(ctx);
    return undefined;
  },
}));

const { default: footer } = await import("./index.ts");

test("refresh timer uses the active context after a model switch", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
      handlers.set(event, handler);
    },
  } as ExtensionAPI;
  const originalSetInterval = globalThis.setInterval;
  let refreshTimer: (() => void) | undefined;

  globalThis.setInterval = ((callback: () => void) => {
    refreshTimer = callback;
    return 0 as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  try {
    footer(pi);
    const nonCopilot = { hasUI: false, model: { provider: "openai" } } as ExtensionContext;
    const copilot = { hasUI: false, model: { provider: "github-copilot" } } as ExtensionContext;

    await handlers.get("session_start")?.({}, nonCopilot);
    await handlers.get("model_select")?.({}, copilot);
    refreshedContexts.length = 0;

    refreshTimer?.();
    await Promise.resolve();

    assert.deepEqual(refreshedContexts, [copilot]);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("re-renders the footer after compaction", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
      handlers.set(event, handler);
    },
  } as ExtensionAPI;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;

  try {
    let footerSetup: unknown;
    let renderRequested = 0;
    const tui = { requestRender: () => { renderRequested += 1; } };
    const footerData = {
      onBranchChange: () => () => {},
      getGitBranch: () => null,
    };
    const ctx = {
      hasUI: true,
      model: undefined,
      ui: { setFooter: (setup: unknown) => { footerSetup = setup; } },
      sessionManager: {
        getBranch: () => [],
        buildContextEntries: () => [],
      },
    } as unknown as ExtensionContext;

    footer(pi);
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(typeof footerSetup, "function", "footer should be registered for a UI session");

    (footerSetup as (tui: unknown, theme: unknown, footerData: unknown) => unknown)?.(tui, {}, footerData);
    assert.equal(renderRequested, 0);

    // Both manual (/compact) and automatic compaction fire session_compact.
    await handlers.get("session_compact")?.({ type: "session_compact", reason: "manual" }, ctx);
    assert.equal(renderRequested, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});
