import { mock } from "bun:test";

// pi-coding-agent is resolvable when Pi loads the extension, but not from this
// repository, so footer tests mock it. Bun's module mock registry is shared
// across test files running in the same process, so every footer test file must
// register this same complete mock: providing only a subset of the exports used
// by index.ts and compaction.ts breaks whichever test file registered it later.
export const piCodingAgentMock = {
  /** Same chars/4 heuristic pi uses for estimateTokens. */
  estimateTokens(message: {
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
  },
  sessionEntryToContextMessages(): unknown[] {
    return [];
  },
};

export function mockPiCodingAgent(): void {
  mock.module("@earendil-works/pi-coding-agent", () => piCodingAgentMock);
}
