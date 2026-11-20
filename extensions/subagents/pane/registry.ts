// registry.ts — choose the pane multiplexer for this process. Detection order is
// intentional: the Herdr TUI flag wins, then the Herdr app's terminal identity.
// A new multiplexer adds one detect function, one adapter, and one branch here;
// the manager and the spawn path stay unchanged.

import { detectHerdrApp, HerdrAppMultiplexer } from "./herdr-app.ts";
import { detectHerdrTui, HerdrTuiMultiplexer } from "./herdr.ts";
import type { PaneMultiplexer } from "./multiplexer.ts";

/** The process environment keys detection reads; plain object for tests. */
export type PaneEnv = Record<string, string | undefined>;

/** The detected pane multiplexer, or undefined when this process is not in one. */
export function createPaneMultiplexer(env: PaneEnv): PaneMultiplexer | undefined {
	const tui = detectHerdrTui(env);
	if (tui) return new HerdrTuiMultiplexer({ bin: tui.bin, mainPaneId: tui.mainPaneId });

	const app = detectHerdrApp(env);
	if (app) return new HerdrAppMultiplexer({ bin: app.bin, terminalId: app.terminalId });

	return undefined;
}
