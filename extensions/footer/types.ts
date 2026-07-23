import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { IconSet } from "./icons.js";

// Theme color - either a pi theme color name or a custom hex color
export type ColorValue = ThemeColor | `#${string}`;

// Semantic color names for segments
export type SemanticColor =
  | "pi"
  | "model"
  | "path"
  | "git"
  | "gitDirty"
  | "gitClean"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax"
  | "context"
  | "contextWarn"
  | "contextError"
  | "contextLabel"
  | "cost"
  | "tokens"
  | "separator";

// Color scheme mapping semantic names to actual colors
export type ColorScheme = Partial<Record<SemanticColor, ColorValue>>;

// Segment identifiers
export type StatusLineSegmentId =
  | "pi"
  | "model"
  | "path"
  | "git"
  | "token_in"
  | "token_out"
  | "token_total"
  | "cost"
  | "context_pct"
  | "context_total"
  | "cache_read"
  | "cache_write"
  | "separator"
  | "copilot_usage"
  | `text:${string}`;

// Per-segment options
export interface StatusLineSegmentOptions {
  path?: {
    mode?: "basename" | "abbreviated" | "full";
    maxLength?: number;
  };
  git?: {
    showBranch?: boolean;
    showStaged?: boolean;
    showUnstaged?: boolean;
    showUntracked?: boolean;
  };
  contextBar?: {
    barWidth?: number;
    filledChar?: string;
    unfilledChar?: string;
    unfilledColor?: ColorValue;
    gradientStart?: ColorValue;
    gradientMid?: ColorValue;
    gradientEnd?: ColorValue;
    gradientMidPoint?: number;
  };
}

// Git status data
export interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
}

// Usage statistics
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SubagentCosts {
  explorer?: number;
  planner?: number;
  implementer?: number;
  reviewer?: number;
}

// Provider-qualified usage data. Add provider-specific variants here as new
// usage adapters are introduced.
export interface GitHubCopilotUsageStatistics {
  provider: "github-copilot";
  used: number;
  total: number;
}

export type ProviderUsageStatistics = GitHubCopilotUsageStatistics;

// Context passed to segment render functions
export interface SegmentContext {
  model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; provider?: string; baseUrl?: string } | undefined;
  isLocalModel: boolean;
  thinkingLevel: string;
  sessionId: string | undefined;
  usageStats: UsageStats;
  subagentCosts: SubagentCosts;
  providerUsage: ProviderUsageStatistics | undefined;
  contextPercent: number;
  contextTokens: number;
  contextWindow: number;
  usingSubscription: boolean;
  sessionStartTime: number;
  git: GitStatus;
  options: StatusLineSegmentOptions;
  width: number;
  theme: Theme;
  colors: ColorScheme;
  icons: IconSet;
}

// Minimal event shapes used by the footer handlers
export interface ToolResultEvent {
  toolName: string;
  input?: { command?: string };
}

export interface UserBashEvent {
  command: string;
}

// Minimal session event shapes used for footer stats
export interface ThinkingLevelEvent {
  type: "thinking_level_change";
  thinkingLevel?: string;
}

export interface AssistantMessageEvent {
  type: "message";
  message: { role: string };
}

export interface SubagentToolResultEvent {
  type: "message";
  message: {
    role: "toolResult";
    toolName: "subagent";
    details?: {
      results?: Array<{
        agent?: string;
        usage?: { cost?: number };
      }>;
    };
  };
}

export type SessionEvent = ThinkingLevelEvent | AssistantMessageEvent | SubagentToolResultEvent | { type: string };

// Rendered segment output
export interface RenderedSegment {
  content: string;
  visible: boolean;
}

// User configuration from footer.json
export interface FooterUserConfig {
  row1LeftSegments?: StatusLineSegmentId[];
  row1RightSegments?: StatusLineSegmentId[];
  row2LeftSegments?: StatusLineSegmentId[];
  row2RightSegments?: StatusLineSegmentId[];
  colors?: ColorScheme;
  segmentOptions?: StatusLineSegmentOptions;
  icons?: Partial<IconSet>;
}
