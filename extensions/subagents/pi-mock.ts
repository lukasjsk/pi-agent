// Shared mock of @earendil-works/pi-coding-agent for subagents tests.
// The real package resolves when Pi loads the extension, but not from this
// repository — mirror footer/pi-mock.ts. Bun's module mock registry is shared
// across test files in the same process, so every mock registers the same
// shape; per-test behavior is injected through platformHooks.

import { mock } from "bun:test";

export interface FakeSession {
	model: { provider: string; id: string } | undefined;
	messages: unknown[];
	agent: { state: { errorMessage?: string } };
	aborted: boolean;
	abortCount: number;
	disposed: boolean;
	subscribe(cb: (event: any) => void): () => void;
	emit(event: unknown): void;
	abort(): Promise<void>;
	prompt(task: string): Promise<void>;
	dispose(): void;
}

export interface FakeSessionConfig {
	messages?: unknown[];
	model?: { provider: string; id: string } | undefined;
	errorMessage?: string;
	prompt?: (session: FakeSession) => Promise<void>;
}

export function fakeSession(config: FakeSessionConfig = {}): FakeSession {
	const listeners = new Set<(event: any) => void>();
	const session: any = {
		model: config.model ?? { provider: "test-provider", id: "test-model" },
		messages: config.messages ?? [],
		agent: { state: { errorMessage: config.errorMessage } },
		aborted: false,
		abortCount: 0,
		disposed: false,
		subscribe(cb: (event: any) => void) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		emit(event: unknown) {
			for (const listener of [...listeners]) listener(event);
		},
		async abort() {
			session.abortCount++;
			session.aborted = true;
		},
		async prompt(task: string) {
			await config.prompt?.(session);
		},
		dispose() {
			session.disposed = true;
		},
	};
	return session as FakeSession;
}

/** Per-test hooks consulted by the registered mock. */
export const platformHooks: {
	createAgentSession: (options: Record<string, unknown>) => Promise<{ session: FakeSession }>;
} = {
	createAgentSession: async () => {
		throw new Error("platformHooks.createAgentSession not configured for this test");
	},
};

/** Call once per test file, before dynamically importing modules that import the pi package. */
export function installPlatformMock(): void {
	mock.module("@earendil-works/pi-coding-agent", () => ({
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
	}));
}

/** Convenience event emitters matching the platform's event shapes (sdk.md "Events"). */
export function textDelta(session: FakeSession, delta: string): void {
	session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
}

export function toolStart(session: FakeSession, toolName: string): void {
	session.emit({ type: "tool_execution_start", toolName });
}
