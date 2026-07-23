import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitHubCopilotUsageStatistics } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;

type CopilotUserResponse = {
  quota_snapshots?: {
    premium_interactions?: {
      entitlement?: unknown;
      remaining?: unknown;
    };
  };
};

export function isCopilotModel(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "github-copilot";
}

function parseUsageStatistics(payload: CopilotUserResponse): GitHubCopilotUsageStatistics | undefined {
  const premium = payload.quota_snapshots?.premium_interactions;
  const total = typeof premium?.entitlement === "number" ? premium.entitlement : undefined;
  const remaining = typeof premium?.remaining === "number" ? premium.remaining : undefined;
  if (total === undefined || remaining === undefined || total < 0 || remaining < 0) return undefined;
  return { provider: "github-copilot", used: Math.max(0, total - remaining), total };
}

/** Fetch the GitHub Copilot implementation of provider usage statistics. */
export async function refreshCopilotUsageStatistics(ctx: ExtensionContext): Promise<GitHubCopilotUsageStatistics | undefined> {
  if (!isCopilotModel(ctx)) return undefined;

  try {
    // Pi calls this a refresh token, but it is the GitHub OAuth token accepted by
    // Copilot's quota endpoint. Keep it in Pi's credential store; never log it.
    const credential = readStoredCredential("github-copilot");
    const token = credential?.type === "oauth" && typeof credential.refresh === "string"
      ? credential.refresh
      : undefined;
    if (!token) return undefined;

    const response = await fetch("https://api.github.com/copilot_internal/user", {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2025-04-01",
      },
    });
    return response.ok ? parseUsageStatistics((await response.json()) as CopilotUserResponse) : undefined;
  } catch {
    return undefined;
  }
}
