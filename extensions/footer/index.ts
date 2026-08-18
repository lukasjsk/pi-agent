import { sessionEntryToContextMessages, type ExtensionAPI, type ReadonlyFooterDataProvider, type Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import type { SegmentContext, StatusLineSegmentId, ProviderUsageStatistics, SessionEvent, ThinkingLevelEvent, ToolResultEvent, UserBashEvent } from "./types.js";
import { estimateCurrentContextTokens, postCompactionEntries } from "./compaction.js";
import { renderSegment } from "./segments/index.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { getEffectiveConfig } from "./config.js";
import { getIcons } from "./icons.js";
import { getDefaultColors, fg } from "./theme.js";
import { refreshCopilotUsageStatistics } from "./copilot-usage.js";
import { calculateUsage } from "./usage.js";

const GIT_BRANCH_PATTERNS: RegExp[] = [
  /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
  /\bgit\s+stash\s+(pop|apply)/,
];

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/**
 * Build footer content from left and right segments.
 * Left segments are left-aligned, right segments are right-aligned.
 */
function buildFooterContent(
  ctx: SegmentContext,
  leftSegments: StatusLineSegmentId[],
  rightSegments: StatusLineSegmentId[],
  availableWidth: number,
): string {
  const maxContentWidth = Math.max(0, availableWidth - 2);

  // Render left segments
  const leftParts: string[] = [];
  for (const segId of leftSegments) {
    const { content, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      leftParts.push(content);
    }
  }

  // Render right segments
  const rightParts: string[] = [];
  let rightWidth = 0;
  for (const segId of rightSegments) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      rightParts.push(content);
      rightWidth += width + 1; // +1 for space between
    }
  }
  if (rightParts.length > 0) {
    rightWidth -= 1; // Remove trailing space
  }

  let leftStr = leftParts.join(" ");
  let rightStr = rightParts.join(" ");

  // Handle case with no right segments
  if (rightParts.length === 0) {
    const finalLeft = truncateToWidth(leftStr, maxContentWidth);
    return " " + finalLeft + " ".repeat(Math.max(0, maxContentWidth - visibleWidth(finalLeft))) + " ";
  }

  // If right side alone is too big, just show right side
  if (rightWidth >= maxContentWidth) {
    return " " + truncateToWidth(rightStr, maxContentWidth) + " ";
  }

  // Ensure at least 1 space between left and right
  const maxLeftWidth = maxContentWidth - rightWidth - 1;
  const finalLeft = truncateToWidth(leftStr, Math.max(0, maxLeftWidth));
  const finalLeftWidth = visibleWidth(finalLeft);

  const padding = maxContentWidth - finalLeftWidth - rightWidth;

  const result = " " + finalLeft + " ".repeat(padding) + rightStr + " ";
  return truncateToWidth(result, availableWidth);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function footer(pi: ExtensionAPI) {
  let sessionStartTime = Date.now();
  let currentCtx: ExtensionContext | null = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let providerUsage: ProviderUsageStatistics | undefined;
  let usageRefreshVersion = 0;
  let copilotRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let tuiRef: TUI | null = null;

  // Track session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    providerUsage = undefined;

    if (ctx.hasUI) {
      setupFooter(ctx);
    }
    await refreshCopilotUsage(ctx);
    copilotRefreshTimer = setInterval(() => {
      if (currentCtx) void refreshCopilotUsage(currentCtx);
    }, 60_000);
  });

  pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
    currentCtx = ctx;
    await refreshCopilotUsage(ctx);
  });

  pi.on("session_shutdown", () => {
    if (copilotRefreshTimer) clearInterval(copilotRefreshTimer);
    copilotRefreshTimer = undefined;
  });

  // Compaction (manual /compact or automatic threshold/overflow) appends a compaction
  // entry and rebuilds the active context. Re-render immediately so context size,
  // token usage and cost reflect the compacted branch, regardless of the trigger.
  pi.on("session_compact", () => {
    tuiRef?.requestRender();
  });

  // Invalidate git status on file changes
  pi.on("tool_result", async (event: ToolResultEvent, _ctx: ExtensionContext) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (GIT_BRANCH_PATTERNS.some(p => p.test(cmd))) {
        invalidateGitStatus();
        invalidateGitBranch();
        setTimeout(() => tuiRef?.requestRender(), 100);
      }
    }
  });

  // A subagent tool result is committed to the branch only after its tool_result event.
  // Render at message_end, when the completed chain details (including its final step) exist.
  pi.on("message_end", (event, _ctx) => {
    if (event.message.role === "toolResult" && event.message.toolName === "subagent") {
      tuiRef?.requestRender();
    }
  });

  // Also catch user escape commands (! prefix)
  pi.on("user_bash", async (event: UserBashEvent, _ctx: ExtensionContext) => {
    if (GIT_BRANCH_PATTERNS.some(p => p.test(event.command))) {
      invalidateGitStatus();
      invalidateGitBranch();
      tuiRef?.requestRender();
    }
  });

  function buildSegmentContext(ctx: ExtensionContext, width: number, theme: Theme): SegmentContext {
    const effectiveConfig = getEffectiveConfig();
    const colors = effectiveConfig.colors ?? getDefaultColors();

    const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];

    // A compaction resets session stats: only entries after the latest compaction
    // entry count toward token usage and cost.
    const statEntries = postCompactionEntries(branchEntries);

    // Tool updates can replace an existing branch entry as a subagent chain progresses.
    // Recalculate on every render so a final step is never hidden by a stale length-based cache.
    const { usageStats, subagentCosts } = calculateUsage(statEntries as SessionEvent[]);

    const isThinkingEvent = (e: SessionEvent): e is ThinkingLevelEvent =>
      e.type === "thinking_level_change";
    const thinkingLevelFromSession = (branchEntries as SessionEvent[])
      .filter(isThinkingEvent)
      .reduce((_, e) => e.thinkingLevel ?? "off", "off");

    // Calculate context percentage. Compaction-aware: right after a compaction there is no
    // post-compaction assistant usage yet, so the rebuilt context (summary + kept messages)
    // is estimated instead of reusing the stale pre-compaction size.
    const contextMessages = (ctx.sessionManager?.buildContextEntries?.() ?? []).flatMap(sessionEntryToContextMessages);
    const contextTokens = estimateCurrentContextTokens(branchEntries, contextMessages);
    const contextWindow = ctx.model?.contextWindow || 0;
    const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

    // Get git status (cached)
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch);

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    const isLocalModel = /localhost|127\.0\.0\.1|::1/.test((ctx.model as any)?.baseUrl ?? "");

    return {
      model: ctx.model,
      isLocalModel,
      thinkingLevel: thinkingLevelFromSession || pi.getThinkingLevel(),
      sessionId: ctx.sessionManager?.getSessionId?.(),
      usageStats,
      subagentCosts,
      // Only expose usage for the active provider. This also prevents a completed
      // request for the previous model from rendering stale data after a switch.
      providerUsage: providerUsage?.provider === ctx.model?.provider ? providerUsage : undefined,
      contextPercent,
      contextTokens,
      contextWindow,
      usingSubscription,
      sessionStartTime,
      git: gitStatus,
      options: effectiveConfig.segmentOptions ?? {},
      width,
      theme,
      colors,
      icons: getIcons(effectiveConfig.icons),
    };
  }

  async function refreshCopilotUsage(ctx: ExtensionContext) {
    const refreshVersion = ++usageRefreshVersion;
    providerUsage = undefined;
    tuiRef?.requestRender();

    const usage = await refreshCopilotUsageStatistics(ctx);
    if (refreshVersion !== usageRefreshVersion) return;

    providerUsage = usage;
    tuiRef?.requestRender();
  }

  function setupFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;

      // Subscribe to branch changes for re-render
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          if (!currentCtx) return [];

          const effectiveConfig = getEffectiveConfig();
          let segmentCtx;
          try {
            segmentCtx = buildSegmentContext(currentCtx, width, theme);
          } catch {
            return [];
          }

          const row1 = buildFooterContent(
            segmentCtx,
            effectiveConfig.row1LeftSegments,
            effectiveConfig.row1RightSegments,
            width,
          );
          const row2 = buildFooterContent(
            segmentCtx,
            effectiveConfig.row2LeftSegments,
            effectiveConfig.row2RightSegments,
            width,
          );

          const divider = fg(theme, "separator", "\u2500".repeat(width), segmentCtx.colors);

          return ["", row1, divider, row2];
        },
      };
    });
  }
}
