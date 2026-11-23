import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clipboardHooks,
	installPiCodingAgentMock,
	installPiTuiMock,
	installTypeboxMock,
} from "../test/pi-mock.ts";

installPiCodingAgentMock();
installPiTuiMock();
installTypeboxMock();

const { default: askUserQuestion } = await import("./index.ts");

interface AskParams {
	question: string;
	details?: string;
	options?: Array<{ label: string; value?: string; description?: string }>;
	multiSelect?: boolean;
}

interface AskResultDetails {
	status: "answered" | "cancelled" | "unavailable";
	question: string;
	context?: string;
	mode: "text" | "single-select" | "multi-select";
	answers: Array<{
		type: "text" | "option" | "other";
		label: string;
		value: string;
		index?: number;
	}>;
	message?: string;
}

interface RegisteredTool {
	name: string;
	label: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: AskParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: AskResultDetails }>;
}

interface EmittedEvent {
	channel: string;
	data: unknown;
}

const emittedEvents: EmittedEvent[] = [];
let failEventEmit = false;
// Text the fake `pi.exec` and the native clipboard fallback return. `null` means
// "clipboard is empty": the exec stub exits non-zero and getText() returns null.
let clipboardText: string | null = null;

function registerTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: RegisteredTool) {
			registered = tool;
		},
		exec: async (_command: string, _args: string[]) => ({
			stdout: clipboardText ?? "",
			stderr: "",
			code: clipboardText === null ? 1 : 0,
			killed: false,
			truncated: false,
		}),
		events: {
			emit(channel: string, data: unknown) {
				if (failEventEmit) throw new Error("event bus unavailable");
				emittedEvents.push({ channel, data });
			},
		},
	} as unknown as ExtensionAPI;

	askUserQuestion(pi);
	assert.ok(registered, "the extension should register a tool");
	return registered;
}

const tool = registerTool();

function context(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			custom: async () => undefined,
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function customComponentContext(
	drive: (component: any) => void | Promise<void>,
	keybindings: unknown = () => {},
): ExtensionContext {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = { requestRender() {} };

	return context({
		ui: {
			custom: async (factory: any) => {
				let result: unknown;
				const component = factory(tui, theme, keybindings, (value: unknown) => {
					result = value;
				});
				await drive(component);
				return result;
			},
		},
	});
}

/** Let an async clipboard read finish before the next key arrives. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Set the clipboard for one test. Wayland is forced on so the implementation's
 * wl-paste path answers from the fake `pi.exec`; the native helper sees the same
 * text through `clipboardHooks`.
 */
async function withClipboard<T>(text: string | null, run: () => Promise<T>): Promise<T> {
	const previousText = clipboardText;
	const previousHooks = clipboardHooks.text;
	const previousWayland = process.env.WAYLAND_DISPLAY;

	clipboardText = text;
	clipboardHooks.text = text;
	process.env.WAYLAND_DISPLAY = "wayland-test";
	try {
		return await run();
	} finally {
		clipboardText = previousText;
		clipboardHooks.text = previousHooks;
		if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = previousWayland;
	}
}

test("registers the ask_user_question tool with a TypeBox parameter schema", () => {
	assert.equal(tool.name, "ask_user_question");
	assert.equal(tool.label, "ask_user_question");
	assert.match(JSON.stringify(tool.parameters), /question/);
	assert.match(JSON.stringify(tool.parameters), /multiSelect/);
});

test("returns a structured cancelled result when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	let uiAccessed = false;
	const ctx = context({
		hasUI: true,
		ui: {
			custom: async () => {
				uiAccessed = true;
				return undefined;
			},
		},
	});

	const result = await tool.execute("call-1", { question: "Proceed?" }, controller.signal, undefined, ctx);

	assert.equal(result.details.status, "cancelled");
	assert.equal(result.details.answers.length, 0);
	assert.equal(uiAccessed, false);
});

test("returns a structured unavailable result without interactive UI", async () => {
	const result = await tool.execute(
		"call-2",
		{ question: "Which environment?" },
		undefined,
		undefined,
		context({ hasUI: false, ui: undefined }),
	);

	assert.equal(result.details.status, "unavailable");
	assert.equal(result.details.mode, "text");
	assert.match(result.content[0].text, /requires interactive mode UI/);
});

test("free-form mode delegates to the editor and returns the trimmed answer", async () => {
	let rendered = "";
	const ctx = customComponentContext((component) => {
		component.handleInput("  staging  ");
		// Render while the dialog is still open: the question and details must be visible.
		rendered = component.render(80).join("\n");
		component.handleInput("\r");
	});

	const result = await tool.execute(
		"call-3",
		{ question: "Which environment?", details: "Choose the deployment target" },
		undefined,
		undefined,
		ctx,
	);

	assert.match(rendered, /Which environment\?/);
	assert.match(rendered, /Choose the deployment target/);
	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "text");
	assert.deepEqual(result.details.answers, [{ type: "text", label: "staging", value: "staging" }]);
	assert.equal(result.content[0].text, "User answered: staging");
});

test("free-form cancellation returns a structured cancelled result", async () => {
	const result = await tool.execute(
		"call-4",
		{ question: "Explain the blocker" },
		undefined,
		undefined,
		customComponentContext((component) => {
			component.handleInput("escape");
		}),
	);

	assert.equal(result.details.status, "cancelled");
	assert.equal(result.details.answers.length, 0);
});

test("free-form mode inserts the clipboard text on Ctrl+V", async () => {
	const result = await withClipboard("dictated words", async () =>
		tool.execute(
			"call-12",
			{ question: "Which environment?" },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("\r");
			}),
		),
	);

	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "text");
	assert.equal(result.details.answers.length, 1);
	assert.equal(result.details.answers[0].label, "dictated words");
	assert.equal(result.content[0].text, "User answered: dictated words");
});

test("free-form mode trims the newline that xclip keeps on the clipboard", async () => {
	const result = await withClipboard("dictated words\n", async () =>
		tool.execute(
			"call-18",
			{ question: "Which environment?" },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("\r");
			}),
		),
	);

	assert.equal(result.details.status, "answered");
	assert.deepEqual(result.details.answers, [{ type: "text", label: "dictated words", value: "dictated words" }]);
});

test("free-form mode ignores an empty clipboard", async () => {
	const result = await withClipboard(null, async () =>
		tool.execute(
			"call-13",
			{ question: "Which environment?" },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("escape");
			}),
		),
	);

	assert.equal(result.details.status, "cancelled");
	assert.equal(result.details.answers.length, 0);
	assert.equal(result.content[0].text, "User cancelled the question");
});

test("free-form mode ignores a clipboard that decodes to binary noise", async () => {
	const result = await withClipboard("\u0001\u0002binary", async () =>
		tool.execute(
			"call-19",
			{ question: "Which environment?" },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("escape");
			}),
		),
	);

	assert.equal(result.details.status, "cancelled");
});

test("single-select honors the configured paste keybinding", async () => {
	const keybindings = {
		matches: (data: string, action: string) => action === "app.clipboard.pasteImage" && data === "alt+v",
	};
	const result = await withClipboard("dictated words", async () =>
		tool.execute(
			"call-20",
			{ question: "Choose a rollout strategy", options: [{ label: "Blue-green" }] },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("alt+v");
				await settle();
				component.handleInput("\r");
			}, keybindings),
		),
	);

	assert.equal(result.details.status, "answered");
	assert.deepEqual(result.details.answers, [
		{ type: "other", label: "dictated words", value: "dictated words" },
	]);
});

test("single-select mode returns the normalized selected option", async () => {
	const result = await tool.execute(
		"call-5",
		{
			question: "Choose a rollout strategy",
			options: [
				{ label: "  Blue-green  ", value: " blue-green " },
				{ label: "Canary", value: "canary" },
			],
		},
		undefined,
		undefined,
		customComponentContext((component) => component.handleInput("enter")),
	);

	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "single-select");
	assert.deepEqual(result.details.answers, [
		{ type: "option", label: "Blue-green", value: "blue-green", index: 1 },
	]);
	assert.equal(result.content[0].text, "User selected: 1. Blue-green");
});

test("single-select mode accepts a custom Other answer", async () => {
	const result = await tool.execute(
		"call-6",
		{
			question: "Choose a rollout strategy",
			options: [{ label: "Blue-green" }],
		},
		undefined,
		undefined,
		customComponentContext((component) => {
			component.handleInput("down"); // Other
			component.handleInput("enter");
			for (const character of "custom") component.handleInput(character);
			component.handleInput("\r");
		}),
	);

	assert.equal(result.details.status, "answered");
	assert.deepEqual(result.details.answers, [{ type: "other", label: "custom", value: "custom" }]);
	assert.equal(result.content[0].text, "User selected: Other: custom");
});

test("single-select asks Other and inserts the clipboard text", async () => {
	const result = await withClipboard("dictated words", async () =>
		tool.execute(
			"call-14",
			{ question: "Choose a rollout strategy", options: [{ label: "Blue-green" }] },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("down"); // Other
				component.handleInput("enter");
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("\r");
			}),
		),
	);

	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "single-select");
	assert.deepEqual(result.details.answers, [
		{ type: "other", label: "dictated words", value: "dictated words" },
	]);
});

test("single-select pastes into Other while the list has focus", async () => {
	const result = await withClipboard("dictated words", async () =>
		tool.execute(
			"call-15",
			{ question: "Choose a rollout strategy", options: [{ label: "Blue-green" }] },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("\r");
			}),
		),
	);

	assert.equal(result.details.status, "answered");
	assert.deepEqual(result.details.answers, [
		{ type: "other", label: "dictated words", value: "dictated words" },
	]);
});

test("single-select accepts a bracketed paste in the list", async () => {
	const result = await tool.execute(
		"call-16",
		{ question: "Choose a rollout strategy", options: [{ label: "Blue-green" }] },
		undefined,
		undefined,
		customComponentContext((component) => {
			component.handleInput("\x1b[200~dictated words\x1b[201~");
			component.handleInput("\r");
		}),
	);

	assert.equal(result.details.status, "answered");
	assert.deepEqual(result.details.answers, [
		{ type: "other", label: "dictated words", value: "dictated words" },
	]);
});

test("multi-select mode can submit more than one option", async () => {
	const result = await tool.execute(
		"call-7",
		{
			question: "Select checks",
			options: [{ label: "Tests" }, { label: "Lint" }],
			multiSelect: true,
		},
		undefined,
		undefined,
		customComponentContext((component) => {
			component.handleInput("space"); // Tests
			component.handleInput("down"); // Lint
			component.handleInput("down"); // Other
			component.handleInput("down"); // Submit
			component.handleInput("enter");
		}),
	);

	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "multi-select");
	assert.deepEqual(
		result.details.answers.map((answer) => answer.label),
		["Tests"],
	);
	assert.equal(result.content[0].text, "User selected:\n- 1. Tests");
});

test("multi-select inserts the clipboard text into Other", async () => {
	const result = await withClipboard("dictated words", async () =>
		tool.execute(
			"call-17",
			{ question: "Select checks", options: [{ label: "Tests" }], multiSelect: true },
			undefined,
			undefined,
			customComponentContext(async (component) => {
				component.handleInput("ctrl+v");
				await settle();
				component.handleInput("\r"); // save Other
				component.handleInput("down"); // Other
				component.handleInput("down"); // Submit
				component.handleInput("enter");
			}),
		),
	);

	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "multi-select");
	assert.deepEqual(
		result.details.answers.map((answer) => answer.label),
		["dictated words"],
	);
	assert.deepEqual(result.details.answers[0], {
		type: "other",
		label: "dictated words",
		value: "dictated words",
	});
});

async function withHerdrEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
	const previous = process.env.HERDR_ENV;
	if (value === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previous;
	}
}

test("reports blocked to herdr while the dialog waits and clears it afterwards", async () => {
	emittedEvents.length = 0;

	await withHerdrEnv("1", async () => {
		await tool.execute(
			"call-8",
			{ question: "Choose a rollout\nstrategy", options: [{ label: "Blue-green" }] },
			undefined,
			undefined,
			customComponentContext((component) => component.handleInput("enter")),
		);
	});

	assert.deepEqual(emittedEvents, [
		{ channel: "herdr:blocked", data: { active: true, label: "Choose a rollout strategy" } },
		{ channel: "herdr:blocked", data: { active: false } },
	]);
});

test("reports blocked around the free-form editor too", async () => {
	emittedEvents.length = 0;

	await withHerdrEnv("1", async () => {
		await tool.execute(
			"call-9",
			{ question: "Which environment?" },
			undefined,
			undefined,
			customComponentContext((component) => {
				component.handleInput("staging");
				component.handleInput("\r");
			}),
		);
	});

	assert.deepEqual(emittedEvents, [
		{ channel: "herdr:blocked", data: { active: true, label: "Which environment?" } },
		{ channel: "herdr:blocked", data: { active: false } },
	]);
});

test("does not emit herdr events outside a herdr session", async () => {
	emittedEvents.length = 0;

	await withHerdrEnv(undefined, async () => {
		await tool.execute(
			"call-10",
			{ question: "Choose a rollout strategy", options: [{ label: "Blue-green" }] },
			undefined,
			undefined,
			customComponentContext((component) => component.handleInput("enter")),
		);
	});

	assert.deepEqual(emittedEvents, []);
});

test("a failing herdr emit never breaks the question flow", async () => {
	emittedEvents.length = 0;
	failEventEmit = true;
	try {
		const result = await withHerdrEnv("1", async () =>
			tool.execute(
				"call-11",
				{ question: "Which environment?" },
				undefined,
				undefined,
				customComponentContext((component) => {
					component.handleInput("staging");
					component.handleInput("\r");
				}),
			),
		);
		assert.equal(result.details.status, "answered");
		assert.equal(result.content[0].text, "User answered: staging");
	} finally {
		failEventEmit = false;
	}
});
