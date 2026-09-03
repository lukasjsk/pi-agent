import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { mockPiCodingAgent } from "../footer/pi-mock.ts";

mockPiCodingAgent();

mock.module("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(readonly text: string, readonly padding: number, readonly indent: number) {}
  },
}));

const { default: compactAndNewSession } = await import("./index.ts");

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type CompactCallbacks = {
  onComplete?: (result: { summary: string }) => void;
  onError?: (error: Error) => void;
};

function registerExtension(): CommandHandler {
  let handler: CommandHandler | undefined;
  let rendererType: string | undefined;
  const pi = {
    registerCommand: (_name: string, command: { handler: CommandHandler }) => {
      handler = command.handler;
    },
    registerMessageRenderer: (type: string) => {
      rendererType = type;
    },
  } as unknown as ExtensionAPI;

  compactAndNewSession(pi);
  assert.ok(handler, "the command should be registered");
  assert.equal(rendererType, "compact-and-new-session-handoff");
  return handler;
}

test("creates a child session and sends its visible summary handoff after compaction", async () => {
  const handler = registerExtension();
  let callbacks: CompactCallbacks | undefined;
  let waitedForIdle = false;
  let parentSession: string | undefined;
  let sentMessage: unknown;
  let sendOptions: unknown;
  const notifications: Array<{ message: string; type: string | undefined }> = [];

  const ctx = {
    hasUI: true,
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    waitForIdle: async () => { waitedForIdle = true; },
    compact: (options: CompactCallbacks) => { callbacks = options; },
    sessionManager: { getSessionFile: () => "/sessions/original.jsonl" },
    newSession: async (options: {
      parentSession?: string;
      withSession?: (replacement: unknown) => Promise<void>;
    }) => {
      parentSession = options.parentSession;
      await options.withSession?.({
        hasUI: true,
        ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
        sendMessage: async (message: unknown, sendMessageOptions: unknown) => {
          sentMessage = message;
          sendOptions = sendMessageOptions;
        },
      });
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  await handler("", ctx);
  assert.ok(waitedForIdle);
  assert.ok(callbacks?.onComplete, "compaction callbacks should be registered");

  callbacks?.onComplete?.({ summary: "Completed work and remaining tasks." });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(parentSession, "/sessions/original.jsonl");
  assert.deepEqual(sentMessage, {
    customType: "compact-and-new-session-handoff",
    content: "Completed work and remaining tasks.",
    display: true,
  });
  assert.deepEqual(sendOptions, { triggerTurn: false });
  assert.deepEqual(notifications.at(-1), { message: "Compaction handoff ready", type: "info" });
});

test("does not replace the session when compaction fails or is cancelled", async () => {
  const handler = registerExtension();
  let callbacks: CompactCallbacks | undefined;
  let newSessionCalls = 0;
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    waitForIdle: async () => {},
    compact: (options: CompactCallbacks) => { callbacks = options; },
    sessionManager: { getSessionFile: () => "/sessions/original.jsonl" },
    newSession: async () => {
      newSessionCalls += 1;
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  await handler("", ctx);
  callbacks?.onError?.(new Error("Compaction cancelled"));
  callbacks?.onError?.(new Error("Model unavailable"));

  assert.equal(newSessionCalls, 0);
  assert.deepEqual(notifications.slice(-2), [
    { message: "Compaction did not complete: Compaction cancelled", type: "error" },
    { message: "Compaction did not complete: Model unavailable", type: "error" },
  ]);
});
