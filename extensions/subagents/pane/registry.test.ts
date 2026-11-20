// registry.test.ts — multiplexer selection. The TUI environment wins when both
// markers are present; the app marker alone selects the app adapter; no marker
// leaves the pane feature off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaneMultiplexer } from "./registry.ts";

test("no multiplexer env leaves the pane feature off", () => {
	assert.equal(createPaneMultiplexer({}), undefined);
	assert.equal(createPaneMultiplexer({ HERDR_PANE_ID: "w1:p1" }), undefined);
	assert.equal(createPaneMultiplexer({ HC_TERMINAL_ID: "" }), undefined);
});

test("the Herdr TUI env selects the TUI adapter", () => {
	const multiplexer = createPaneMultiplexer({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
	assert.equal(multiplexer?.name, "herdr-tui");
});

test("the Herdr app env selects the app adapter", () => {
	const multiplexer = createPaneMultiplexer({ HC_TERMINAL_ID: "t8", HC_TERMINAL_SOCKET: "/run/hc.sock" });
	assert.equal(multiplexer?.name, "herdr-app");
});

test("the TUI marker wins when both environments are present", () => {
	const multiplexer = createPaneMultiplexer({
		HERDR_ENV: "1",
		HERDR_PANE_ID: "w1:p1",
		HC_TERMINAL_ID: "t8",
	});
	assert.equal(multiplexer?.name, "herdr-tui");
});
