// placement.ts — the multiplexer-agnostic subagent pane placement policy
// (GLOSSARY.md "Subagent pane"): the first spawn goes right of the orchestrator
// pane; concurrent siblings stack vertically underneath the last opened subagent
// pane. The manager advances the state only after a successful split.

import type { PaneDirection } from "./multiplexer.ts";

export function splitTarget(
	state: { lastSubagentPaneId: string | undefined },
	mainPaneId: string,
): { paneId: string; direction: PaneDirection } {
	if (state.lastSubagentPaneId === undefined) return { paneId: mainPaneId, direction: "right" };
	return { paneId: state.lastSubagentPaneId, direction: "down" };
}
