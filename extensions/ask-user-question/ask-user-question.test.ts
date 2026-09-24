import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPiCodingAgentMock, installPiTuiMock, installTypeboxMock } from "../test/pi-mock.ts";

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

function registerTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: RegisteredTool) {
			registered = tool;
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
			editor: async () => undefined,
			custom: async () => undefined,
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function customComponentContext(drive: (component: any) => void): ExtensionContext {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = { requestRender() {} };

	return context({
		ui: {
			editor: async () => undefined,
			custom: async (factory: any) => {
				let result: unknown;
				const component = factory(tui, theme, () => {}, (value: unknown) => {
					result = value;
				});
				drive(component);
				return result;
			},
		},
	});
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
			editor: async () => {
				uiAccessed = true;
				return undefined;
			},
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
	const editorCalls: string[] = [];
	const ctx = context({
		ui: {
			editor: async (title: string) => {
				editorCalls.push(title);
				return "  staging  ";
			},
			custom: async () => undefined,
		},
	});

	const result = await tool.execute(
		"call-3",
		{ question: "Which environment?", details: "Choose the deployment target" },
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(editorCalls, ["Which environment?\n\nChoose the deployment target"]);
	assert.equal(result.details.status, "answered");
	assert.equal(result.details.mode, "text");
	assert.deepEqual(result.details.answers, [{ type: "text", label: "staging", value: "staging" }]);
	assert.equal(result.content[0].text, "User answered: staging");
});

test("free-form cancellation returns a structured cancelled result", async () => {
	const ctx = context({
		ui: {
			editor: async () => undefined,
			custom: async () => undefined,
		},
	});

	const result = await tool.execute("call-4", { question: "Explain the blocker" }, undefined, undefined, ctx);

	assert.equal(result.details.status, "cancelled");
	assert.equal(result.details.answers.length, 0);
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
