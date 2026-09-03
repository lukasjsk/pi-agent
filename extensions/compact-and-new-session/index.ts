import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ReplacedSessionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const HANDOFF_MESSAGE_TYPE = "compact-and-new-session-handoff";

type HandoffMessage = string;

function notify(
  ctx: ExtensionCommandContext | ReplacedSessionContext,
  message: string,
  type: "info" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default function compactAndNewSession(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HandoffMessage>(HANDOFF_MESSAGE_TYPE, (message, { outputPad }, theme) => {
    const heading = theme.fg("accent", "[Compaction handoff]");
    return new Text(`${heading}\n${message.content}`, outputPad, 0);
  });

  pi.registerCommand("compact-and-new-session", {
    description: "Compact this session and continue in a new child session",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      notify(ctx, "Compacting session before starting a new one", "info");

      ctx.compact({
        onComplete: (result) => {
          // A replacement must only follow a successfully generated summary.
          void createReplacementSession(ctx, result.summary);
        },
        onError: (error) => {
          // This includes cancellation. The current session remains active because
          // only onComplete can initiate a replacement.
          notify(ctx, `Compaction did not complete: ${error.message}`, "error");
        },
      });
    },
  });
}

async function createReplacementSession(ctx: ExtensionCommandContext, summary: string): Promise<void> {
  try {
    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      withSession: async (replacementCtx) => {
        try {
          await replacementCtx.sendMessage(
            {
              customType: HANDOFF_MESSAGE_TYPE,
              content: summary,
              display: true,
            },
            { triggerTurn: false },
          );
          notify(replacementCtx, "Compaction handoff ready", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(replacementCtx, `Could not add compaction handoff: ${message}`, "error");
        }
      },
    });

    if (result.cancelled) {
      notify(ctx, "New session cancelled", "error");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Could not start a new session: ${message}`, "error");
  }
}
