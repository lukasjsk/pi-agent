import type { SegmentContext } from "../types.js";
import { fg } from "../theme.js";

export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

/**
 * Format a context size for the context-usage display. Uses the `k` suffix
 * below 1M and switches to `M` from 1M up ("0.12k", "23.1k", "120k",
 * "1.12M"); `M` is the largest suffix used.
 */
export function formatContextTokens(n: number): string {
  if (n === 0) return "0";
  const [value, suffix] = n < 1_000_000 ? [n / 1_000, "k"] : [n / 1_000_000, "M"];
  return trimTrailingZeros(value.toFixed(2)) + suffix;
}

function trimTrailingZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

export function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

export function color(ctx: SegmentContext, semantic: string, text: string): string {
  return fg(ctx.theme, semantic as any, text, ctx.colors);
}
