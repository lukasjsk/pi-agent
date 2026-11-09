import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Path of the user's pi settings file. Uses pi's own agent-dir resolution
 * (PI_CODING_AGENT_DIR env var, defaulting to ~/.pi/agent) instead of a
 * hand-rolled fallback, so the path always matches where pi itself reads
 * and writes settings.
 */
export function getUserSettingsPath(): string {
	return `${getAgentDir()}/settings.json`;
}
