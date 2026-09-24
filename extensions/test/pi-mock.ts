// Shared bun mock for @earendil-works/pi-coding-agent, usable by every extension test
// suite in this repo. Bun's mock.module registry is process-global across test files,
// so two suites registering different shapes of the same module mock break whichever
// file registers later (the last factory wins for subsequent imports). This module is
// the single source of truth: one mock shape covering everything the suites need —
// footer's token/context helpers AND the subagents' session/SDK surface with per-test
// platformHooks.
import { mock } from "bun:test";

/** Per-test hooks consulted by the mock (subagents suite drives these). */
export const platformHooks: {
	createAgentSession: (options: Record<string, unknown>) => Promise<{ session: unknown }>;
} = {
	createAgentSession: async () => {
		throw new Error("platformHooks.createAgentSession not configured for this test");
	},
};

/** Same chars/4 heuristic pi uses for estimateTokens (footer suite). */
function estimateTokens(message: {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	summary?: string;
}): number {
	let chars = 0;
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		chars = message.summary?.length ?? 0;
	} else {
		for (const block of message.content ?? []) {
			if (block.type === "text") chars += block.text?.length ?? 0;
		}
	}
	return Math.ceil(chars / 4);
}

/** One complete, stable mock shape. Registering it again (any order) is a no-op. */
export const piCodingAgentMock = {
	// footer needs:
	estimateTokens,
	sessionEntryToContextMessages(): unknown[] {
		return [];
	},
	// subagents needs:
	createAgentSession: (options: Record<string, unknown>) => platformHooks.createAgentSession(options),
	DefaultResourceLoader: class {
		options: Record<string, unknown>;
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
		async reload() {}
	},
	SessionManager: {
		inMemory: (cwd?: string) => ({ kind: "inMemory", cwd }),
	},
	getAgentDir: () => "/fake/agent-dir",
	defineTool: (tool: unknown) => tool,
	// subagents self-shell framing (§R11.1): a full-width rule line.
	DynamicBorder: class {
		constructor(private color?: (s: string) => string) {}
		render(width: number): string[] {
			return [this.color ? this.color("─".repeat(Math.max(1, width))) : "─".repeat(Math.max(1, width))];
		}
		invalidate(): void {}
	},
};

/** Register the shared mock. Idempotent: every file may call it, in any order. */
export function installPiCodingAgentMock(): void {
	mock.module("@earendil-works/pi-coding-agent", () => piCodingAgentMock);
}

// typebox is only resolvable under Pi's module aliases, not from this repo. One shared
// superset stub (Object/String/Optional plus the Array/Union/Literal/Number/Boolean the
// subagents schemas use) so no suite's typebox mock can poison another's process-global
// bun mock, regardless of load order. The shapes are inert — suites assert on behavior,
// not on the schema objects these return.
export function installTypeboxMock(): void {
	mock.module("typebox", () => ({
		Type: {
			Object: (properties: unknown) => ({ type: "object", properties }),
			String: (options: unknown = {}) => ({ type: "string", ...(options as object) }),
			Number: (options: unknown = {}) => ({ type: "number", ...(options as object) }),
			Boolean: (options: unknown = {}) => ({ type: "boolean", ...(options as object) }),
			Optional: (schema: unknown) => schema,
			Array: (schema: unknown = {}) => ({ type: "array", items: schema }),
			Union: (schemas: unknown, options: unknown = {}) => ({ type: "union", anyOf: schemas, ...(options as object) }),
			Literal: (value: unknown) => ({ type: "literal", const: value }),
		},
	}));
}

// Same story for @earendil-works/pi-tui: footer needs width helpers, subagents needs
// the Text component. One shape for the whole repo.
export const piTuiMock = {
	visibleWidth: (text: string) => text.length,
	truncateToWidth: (text: string, _maxWidth?: number) => text,
	wrapTextWithAnsi: (text: string, _maxWidth: number) => text.split("\n"),
	matchesKey: (data: string, key: string) => data === key,
	Key: {
		up: "up",
		down: "down",
		enter: "enter",
		space: "space",
		escape: "escape",
	},
	Editor: class {
		private text = "";
		onSubmit?: (value: string) => void;

		constructor(_tui: unknown, _theme: unknown) {}

		setText(text: string) {
			this.text = text;
		}

		handleInput(data: string) {
			if (data === "\r" || data === "\n") {
				this.onSubmit?.(this.text);
			} else if (data === "\x7f") {
				this.text = this.text.slice(0, -1);
			} else {
				this.text += data;
			}
		}

		render(): string[] {
			return this.text ? [this.text] : [];
		}
	},
	Text: class {
		text: string;
		constructor(text = "") {
			this.text = text;
		}
		setText(text: string) {
			this.text = text;
		}
		render() {
			return [this.text];
		}
	},
};

export function installPiTuiMock(): void {
	mock.module("@earendil-works/pi-tui", () => piTuiMock);
}
