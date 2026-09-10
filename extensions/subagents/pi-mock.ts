// Mock of @earendil-works/pi-coding-agent for subagents tests. The real package
// resolves when Pi loads the extension, but not from this repository — the mock now
// lives in the shared extensions/test/pi-mock.ts (one repo-wide shape; suites cannot
// poison each other's process-global bun mocks). Per-test behavior via platformHooks.

import { installPiCodingAgentMock, platformHooks } from "../test/pi-mock.ts";

// Re-exported so tests configure the SAME hooks object the shared mock consults.
export { platformHooks };

export interface FakeSession {
	model: { provider: string; id: string } | undefined;
	thinkingLevel?: string;
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
	thinkingLevel?: string;
	errorMessage?: string;
	prompt?: (session: FakeSession) => Promise<void>;
}

export function fakeSession(config: FakeSessionConfig = {}): FakeSession {
	const listeners = new Set<(event: any) => void>();
	const promptWaiters = new Set<() => void>();
	const session: any = {
		model: config.model ?? { provider: "test-provider", id: "test-model" },
		thinkingLevel: config.thinkingLevel,
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
			// Platform contract: abort() settles the in-flight prompt run.
			for (const waiter of [...promptWaiters]) waiter();
			promptWaiters.clear();
		},
		async prompt(task: string) {
			const aborted = new Promise<void>((resolve) => promptWaiters.add(resolve));
			await Promise.race([config.prompt?.(session), aborted]);
		},
		dispose() {
			session.disposed = true;
		},
	};
	return session as FakeSession;
}

/** Per-test hooks are owned by the shared mock module (extensions/test/pi-mock.ts). */

/** Call once per test file, before dynamically importing modules that import the pi package. */
export function installPlatformMock(): void {
	installPiCodingAgentMock();
}

/** Convenience event emitters matching the platform's event shapes (sdk.md "Events"). */
export function textDelta(session: FakeSession, delta: string): void {
	session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
}

export function toolStart(session: FakeSession, toolName: string): void {
	session.emit({ type: "tool_execution_start", toolName });
}
