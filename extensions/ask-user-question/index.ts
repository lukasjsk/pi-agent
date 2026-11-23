import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    Editor,
    type EditorTheme,
    Key,
    Text,
    getNativeClipboard,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskOption {
    label: string;
    value: string;
    description?: string;
}

interface DisplayOption extends AskOption {
    id: string;
    index?: number;
    isOther?: boolean;
    isSubmit?: boolean;
}

interface TextAnswer {
    type: "text";
    label: string;
    value: string;
}

interface OptionAnswer {
    type: "option";
    label: string;
    value: string;
    index: number;
}

interface OtherAnswer {
    type: "other";
    label: string;
    value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
    status: AskUserQuestionStatus;
    question: string;
    context?: string;
    mode: AskUserQuestionMode;
    answers: AskAnswer[];
    message?: string;
}

const OptionSchema = Type.Object({
    label: Type.String({
        description:
            'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
    }),
    value: Type.Optional(
        Type.String({
            description: "Optional machine-readable value returned for the option. Defaults to the label.",
        }),
    ),
    description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
    question: Type.String({
        description: "The single question to ask the user. Ask exactly one question per tool call.",
    }),
    details: Type.Optional(
        Type.String({
            description: "Optional extra context or instructions shown under the question.",
        }),
    ),
    options: Type.Optional(
        Type.Array(OptionSchema, {
            description:
                "Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
        }),
    ),
    multiSelect: Type.Optional(
        Type.Boolean({
            description: "Set to true to allow multiple answers to be selected for a question.",
        }),
    ),
});

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
    return (options || [])
        .map((option) => ({
            label: option.label.trim(),
            value: option.value?.trim() || option.label.trim(),
            description: option.description?.trim() || undefined,
        }))
        .filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
    return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function createEditorTheme(theme: any): EditorTheme {
    return {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
        },
    };
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
    const contentWidth = Math.max(1, width - indent.length);
    for (const line of wrapTextWithAnsi(text, contentWidth)) {
        lines.push(truncateToWidth(`${indent}${line}`, width));
    }
}

const PASTE_KEYBINDING = "app.clipboard.pasteImage";
const BRACKETED_PASTE_START = "\x1b[200~";

async function runClipboardCommand(pi: ExtensionAPI, command: string, args: string[]): Promise<string | null> {
    try {
        const result = await pi.exec(command, args, { timeout: 5000 });
        if (result.code !== 0) return null;
        if (!result.stdout) return null;
        return result.stdout;
    } catch {
        return null;
    }
}

// Prefer the command-line tools over the native helper: Hex owns the clipboard
// through wl-copy, and the native helper may not see that content under Wayland.
async function readClipboardText(pi: ExtensionAPI): Promise<string | null> {
    let text: string | null = null;
    if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
        text = await runClipboardCommand(pi, "wl-paste", ["--no-newline", "--type", "text"]);
    }
    if (text === null && process.platform === "linux" && process.env.DISPLAY) {
        text = await runClipboardCommand(pi, "xclip", ["-selection", "clipboard", "-out"]);
        if (text === null) text = await runClipboardCommand(pi, "xsel", ["--clipboard", "--output"]);
    }
    if (text === null) {
        try {
            text = (await getNativeClipboard()?.getText()) ?? null;
        } catch {
            text = null;
        }
    }
    // xclip returns the newline the clipboard holds; a dictation must not insert it.
    const trimmed = text?.trim();
    if (!trimmed) return null;
    // An image or other binary payload can decode into control characters: never
    // insert those into an answer.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) return null;
    return trimmed;
}

function isPasteKey(keybindings: any, data: string): boolean {
    if (keybindings && typeof keybindings.matches === "function") {
        try {
            return Boolean(keybindings.matches(data, PASTE_KEYBINDING));
        } catch {
            return false;
        }
    }
    return matchesKey(data, "ctrl+v");
}

async function askText(
    ctx: any,
    pi: ExtensionAPI,
    question: string,
    context: string | undefined,
): Promise<string | undefined> {
    return ctx.ui.custom<string | undefined>((tui: any, theme: any, kb: any, done: (result: string | undefined) => void) => {
        let closed = false;
        let focused = false;
        let cachedLines: string[] | undefined;
        let cachedWidth = -1;
        const editor = new Editor(tui, createEditorTheme(theme));

        editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            finish(trimmed);
        };

        function refresh() {
            cachedLines = undefined;
            tui.requestRender();
        }

        function finish(value: string | undefined) {
            if (closed) return;
            closed = true;
            done(value);
        }

        async function pasteFromClipboard() {
            const text = await readClipboardText(pi);
            if (closed || !text) return;
            editor.insertTextAtCursor(text);
            refresh();
        }

        function handleInput(data: string) {
            if (matchesKey(data, Key.escape)) {
                finish(undefined);
                return;
            }
            if (isPasteKey(kb, data)) {
                void pasteFromClipboard();
                return;
            }
            editor.handleInput(data);
            refresh();
        }

        function render(width: number): string[] {
            // The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
            // invalidate() on terminal resize, so render() can be re-entered with a
            // new width. Returning stale wider lines trips the TUI width guard and
            // crashes the process.
            if (cachedLines && cachedWidth === width) return cachedLines;

            const lines: string[] = [];
            const add = (text: string) => lines.push(truncateToWidth(text, width));

            add(theme.fg("accent", "─".repeat(width)));
            lines.push("");
            addWrapped(lines, theme.fg("accent", ` ${question}`), width);
            if (context) {
                lines.push("");
                addWrapped(lines, theme.fg("muted", ` ${context}`), width);
            }
            lines.push("");
            for (const line of editor.render(Math.max(1, width - 2))) {
                add(` ${line}`);
            }
            lines.push("");
            add(theme.fg("dim", " Enter to submit • Esc to cancel"));
            add(theme.fg("accent", "─".repeat(width)));

            cachedLines = lines;
            cachedWidth = width;
            return lines;
        }

        return {
            // A component holding an Editor is focusable: pi sets `focused` on it, so the
            // editor draws the hardware cursor instead of a fake one (see docs/tui.md).
            get focused() {
                return focused;
            },
            set focused(value: boolean) {
                focused = value;
                editor.focused = value;
            },
            render,
            invalidate: () => {
                cachedLines = undefined;
            },
            handleInput,
        };
    }, { blocked: { kind: "question", message: question } });
}

function formatAnswerForModel(answer: AskAnswer): string {
    switch (answer.type) {
        case "text":
            return answer.label;
        case "other":
            return `Other: ${answer.label}`;
        case "option":
            return `${answer.index}. ${answer.label}`;
    }
}

function answerSortRank(answer: AskAnswer): number {
    switch (answer.type) {
        case "option":
            return answer.index;
        case "other":
            return Number.MAX_SAFE_INTEGER - 1;
        case "text":
            return Number.MAX_SAFE_INTEGER;
    }
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
    return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
    status: AskUserQuestionStatus,
    question: string,
    mode: AskUserQuestionMode,
    answers: AskAnswer[],
    context?: string,
    message?: string,
) {
    return {
        status,
        question,
        context,
        mode,
        answers,
        message,
    } as AskUserQuestionResultDetails;
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
    const message = "User cancelled the question";
    return {
        content: [{ type: "text" as const, text: message }],
        details: buildStructuredResult("cancelled", question, mode, [], context, message),
    };
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
    return {
        content: [{ type: "text" as const, text: message }],
        details: buildStructuredResult("unavailable", question, mode, [], context, message),
    };
}

function buildResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[]) {
    let text: string;
    if (mode === "text") {
        const answer = answers[0];
        text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
    } else if (mode === "single-select") {
        text = `User selected: ${formatAnswerForModel(answers[0])}`;
    } else {
        text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
    }

    return {
        content: [{ type: "text" as const, text }],
        details: buildStructuredResult("answered", question, mode, answers, context),
    };
}

async function askSingleChoice(
    ctx: any,
    pi: ExtensionAPI,
    question: string,
    context: string | undefined,
    options: AskOption[],
): Promise<AskAnswer | null> {
    const otherLabel = getOtherLabel(options);
    const allOptions: DisplayOption[] = [
        ...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
        { id: "other", label: otherLabel, value: "__other__", isOther: true },
    ];

    return ctx.ui.custom<AskAnswer | null>((tui: any, theme: any, kb: any, done: (result: AskAnswer | null) => void) => {
        let optionIndex = 0;
        let editMode = false;
        let closed = false;
        let cachedLines: string[] | undefined;
        let cachedWidth = -1;
        const editor = new Editor(tui, createEditorTheme(theme));

        editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            finish({ type: "other", label: trimmed, value: trimmed });
        };

        function refresh() {
            cachedLines = undefined;
            tui.requestRender();
        }

        function finish(result: AskAnswer | null) {
            if (closed) return;
            closed = true;
            done(result);
        }

        function openOther(prefill: string) {
            editMode = true;
            editor.setText(prefill);
            refresh();
        }

        async function pasteFromClipboard() {
            const text = await readClipboardText(pi);
            if (closed || !text) return;
            if (!editMode) openOther("");
            editor.insertTextAtCursor(text);
            refresh();
        }

        function handleInput(data: string) {
            if (editMode) {
                if (isPasteKey(kb, data)) {
                    void pasteFromClipboard();
                    return;
                }
                if (matchesKey(data, Key.escape)) {
                    editMode = false;
                    editor.setText("");
                    refresh();
                    return;
                }
                editor.handleInput(data);
                refresh();
                return;
            }

            // A dictation transcript arrives either as Ctrl+V or as a bracketed paste.
            // It must land in the Other field instead of being dropped while the list
            // has focus.
            if (isPasteKey(kb, data)) {
                void pasteFromClipboard();
                return;
            }
            if (data.includes(BRACKETED_PASTE_START)) {
                openOther("");
                editor.handleInput(data);
                refresh();
                return;
            }

            if (matchesKey(data, Key.up)) {
                optionIndex = Math.max(0, optionIndex - 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.down)) {
                optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.enter)) {
                const selected = allOptions[optionIndex];
                if (selected.isOther) {
                    openOther("");
                    return;
                }
                finish({
                    type: "option",
                    label: selected.label,
                    value: selected.value,
                    index: selected.index!,
                });
                return;
            }
            if (matchesKey(data, Key.escape)) {
                finish(null);
            }
        }

        function render(width: number): string[] {
            // The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
            // invalidate() on terminal resize, so render() can be re-entered with a
            // new width. Returning stale wider lines trips the TUI width guard and
            // crashes the process.
            if (cachedLines && cachedWidth === width) return cachedLines;

            const lines: string[] = [];
            const add = (text: string) => lines.push(truncateToWidth(text, width));

            add(theme.fg("accent", "─".repeat(width)));
            addWrapped(lines, theme.fg("text", ` ${question}`), width);
            if (context) {
                lines.push("");
                addWrapped(lines, theme.fg("muted", ` ${context}`), width);
            }
            lines.push("");

            for (let i = 0; i < allOptions.length; i++) {
                const option = allOptions[i];
                const selected = i === optionIndex;
                const prefix = selected ? theme.fg("accent", "> ") : "  ";
                const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
                const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
                add(`${prefix}${styled}`);
                if (option.description) {
                    addWrapped(lines, theme.fg("muted", option.description), width, "     ");
                }
            }

            if (editMode) {
                lines.push("");
                add(theme.fg("muted", " Write your custom answer:"));
                for (const line of editor.render(Math.max(1, width - 2))) {
                    add(` ${line}`);
                }
                lines.push("");
                add(theme.fg("dim", " Enter to submit • Esc to go back"));
            } else {
                lines.push("");
                add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
            }

            add(theme.fg("accent", "─".repeat(width)));
            cachedLines = lines;
            cachedWidth = width;
            return lines;
        }

        return {
            render,
            invalidate: () => {
                cachedLines = undefined;
            },
            handleInput,
        };
    });
}

async function askMultiChoice(
    ctx: any,
    pi: ExtensionAPI,
    question: string,
    context: string | undefined,
    options: AskOption[],
): Promise<AskAnswer[] | null> {
    const otherLabel = getOtherLabel(options);
    const choiceItems: DisplayOption[] = options.map((option, index) => ({
        ...option,
        id: `option:${index}`,
        index: index + 1,
    }));
    const submitItem: DisplayOption = { id: "submit", label: "Submit", value: "__submit__", isSubmit: true };
    const allItems: DisplayOption[] = [
        ...choiceItems,
        { id: "other", label: otherLabel, value: "__other__", isOther: true },
        submitItem,
    ];

    return ctx.ui.custom<AskAnswer[] | null>((tui: any, theme: any, kb: any, done: (result: AskAnswer[] | null) => void) => {
        let optionIndex = 0;
        let editMode = false;
        let closed = false;
        let cachedLines: string[] | undefined;
        let cachedWidth = -1;
        const selected = new Map<string, AskAnswer>();
        const editor = new Editor(tui, createEditorTheme(theme));

        editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            selected.set("other", { type: "other", label: trimmed, value: trimmed });
            editMode = false;
            refresh();
        };

        function refresh() {
            cachedLines = undefined;
            tui.requestRender();
        }

        function finish(result: AskAnswer[] | null) {
            if (closed) return;
            closed = true;
            done(result);
        }

        function otherPrefill(): string {
            return selected.get("other")?.label ?? "";
        }

        function openOther(prefill: string) {
            editMode = true;
            editor.setText(prefill);
            refresh();
        }

        async function pasteFromClipboard() {
            const text = await readClipboardText(pi);
            if (closed || !text) return;
            if (!editMode) openOther(otherPrefill());
            editor.insertTextAtCursor(text);
            refresh();
        }

        function toggleOption(item: DisplayOption) {
            if (selected.has(item.id)) {
                selected.delete(item.id);
            } else {
                selected.set(item.id, {
                    type: "option",
                    label: item.label,
                    value: item.value,
                    index: item.index!,
                });
            }
            refresh();
        }

        function handleInput(data: string) {
            if (editMode) {
                if (isPasteKey(kb, data)) {
                    void pasteFromClipboard();
                    return;
                }
                if (matchesKey(data, Key.escape)) {
                    editMode = false;
                    editor.setText(otherPrefill());
                    refresh();
                    return;
                }
                editor.handleInput(data);
                refresh();
                return;
            }

            // A dictation transcript arrives either as Ctrl+V or as a bracketed paste.
            // It must land in the Other field instead of being dropped while the list
            // has focus.
            if (isPasteKey(kb, data)) {
                void pasteFromClipboard();
                return;
            }
            if (data.includes(BRACKETED_PASTE_START)) {
                openOther(otherPrefill());
                editor.handleInput(data);
                refresh();
                return;
            }

            if (matchesKey(data, Key.up)) {
                optionIndex = Math.max(0, optionIndex - 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.down)) {
                optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
                refresh();
                return;
            }

            const current = allItems[optionIndex];
            if (matchesKey(data, Key.space)) {
                if (current.isSubmit) return;
                if (current.isOther) {
                    if (selected.has("other")) {
                        selected.delete("other");
                        refresh();
                    } else {
                        openOther("");
                    }
                    return;
                }
                toggleOption(current);
                return;
            }

            if (matchesKey(data, Key.enter)) {
                if (current.isSubmit) {
                    if (selected.size > 0) {
                        finish(sortAnswers(Array.from(selected.values())));
                    }
                    return;
                }
                if (current.isOther) {
                    openOther(otherPrefill());
                    return;
                }
                toggleOption(current);
                return;
            }

            if (matchesKey(data, Key.escape)) {
                finish(null);
            }
        }

        function render(width: number): string[] {
            // The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
            // invalidate() on terminal resize, so render() can be re-entered with a
            // new width. Returning stale wider lines trips the TUI width guard and
            // crashes the process.
            if (cachedLines && cachedWidth === width) return cachedLines;

            const lines: string[] = [];
            const add = (text: string) => lines.push(truncateToWidth(text, width));

            add(theme.fg("accent", "─".repeat(width)));
            addWrapped(lines, theme.fg("text", ` ${question}`), width);
            if (context) {
                lines.push("");
                addWrapped(lines, theme.fg("muted", ` ${context}`), width);
            }
            lines.push("");

            for (let i = 0; i < allItems.length; i++) {
                const item = allItems[i];
                const isFocused = i === optionIndex;
                const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

                if (item.isSubmit) {
                    const label = selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
                    const styled = isFocused
                        ? theme.fg("accent", label)
                        : theme.fg(selected.size > 0 ? "success" : "dim", label);
                    add(`${prefix}${styled}`);
                    continue;
                }

                if (item.isOther) {
                    const other = selected.get("other");
                    const marker = other ? "[x]" : "[ ]";
                    const suffix = other ? ` — ${other.label}` : "";
                    const styled = isFocused
                        ? theme.fg("accent", `${marker} ${item.label}${suffix}`)
                        : theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`);
                    add(`${prefix}${styled}`);
                    continue;
                }

                const checked = selected.has(item.id);
                const marker = checked ? "[x]" : "[ ]";
                const label = `${marker} ${item.index}. ${item.label}`;
                const styled = isFocused
                    ? theme.fg("accent", label)
                    : theme.fg(checked ? "success" : "text", label);
                add(`${prefix}${styled}`);
                if (item.description) {
                    addWrapped(lines, theme.fg("muted", item.description), width, "     ");
                }
            }

            if (editMode) {
                lines.push("");
                add(theme.fg("muted", " Write your custom answer:"));
                for (const line of editor.render(Math.max(1, width - 2))) {
                    add(` ${line}`);
                }
                lines.push("");
                add(theme.fg("dim", " Enter to save • Esc to go back"));
            } else {
                lines.push("");
                if (selected.size === 0) {
                    add(theme.fg("warning", " Select at least one answer before submitting."));
                }
                add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel"));
            }

            add(theme.fg("accent", "─".repeat(width)));
            cachedLines = lines;
            cachedWidth = width;
            return lines;
        }

        return {
            render,
            invalidate: () => {
                cachedLines = undefined;
            },
            handleInput,
        };
    });
}

// Shared UI mutex. ctx.ui.custom()/editor can only handle one active call at
// a time, so ALL pop-up-style tools (ask_user_question, quiz, ...) must
// serialize against each other, not just against themselves. We stash one
// mutex on globalThis so separate extension files can share it without
// importing each other.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
    const g = globalThis as any;
    if (!g[SHARED_UI_LOCK_KEY]) {
        let chain: Promise<void> = Promise.resolve();
        g[SHARED_UI_LOCK_KEY] = {
            withLock<T>(fn: () => T | Promise<T>): Promise<T> {
                const prev = chain;
                let release: () => void;
                chain = new Promise<void>((r) => { release = r; });
                return prev.then(fn).finally(() => release!());
            },
        };
    }
    return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
    return sharedUiLock.withLock(fn);
}

// Herdr shows a pane as "working" while a blocking dialog waits unless an
// extension emits its `herdr:blocked` event; herdr's pi integration listens for
// that event and reports the pane as blocked until the matching `active: false`.
// Emit around every dialog this tool shows. Outside herdr no listener exists,
// so the emit is a no-op, and it must never change or break the answer flow.
const HERDR_BLOCKED_EVENT = "herdr:blocked";

function herdrEnabled(): boolean {
    // Same gate as herdr's pi integration: it reports nothing unless HERDR_ENV=1.
    return process.env.HERDR_ENV === "1";
}

function herdrLabel(question: string): string {
    return question.replace(/\s+/gu, " ").trim();
}

function emitHerdrBlocked(pi: ExtensionAPI, active: boolean, label?: string): void {
    if (!herdrEnabled()) return;
    try {
        pi?.events?.emit?.(HERDR_BLOCKED_EVENT, active ? { active: true, label } : { active: false });
    } catch {
        // A status report must never break the question flow.
    }
}

async function withHerdrBlocked<T>(pi: ExtensionAPI, label: string, run: () => Promise<T>): Promise<T> {
    emitHerdrBlocked(pi, true, label);
    try {
        return await run();
    } finally {
        emitHerdrBlocked(pi, false);
    }
}

export default function askUserQuestion(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user_question",
        label: "ask_user_question",
        description:
            "Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
        promptSnippet:
            "Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing. Always use it when presenting the user with 2+ options or next-step choices.",
        promptGuidelines: [
            "Ask exactly one question per tool call.",
            "If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
            'Users will always be able to select "Other" to provide custom text input when options are provided.',
            "Use multiSelect: true only when you need multiple answers to the same question.",
            'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
            "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
            "Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
            "Always render decision points and next-step choices (2+ valid paths) as options in this tool — never present them as prose in your reply, even when matching a conversational tone.",
        ],
        parameters: AskUserQuestionParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const options = normalizeOptions(params.options);
            const context = params.details?.trim() || undefined;
            const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

            if (signal?.aborted) {
                return cancelledResult(params.question, mode, context);
            }

            if (!ctx.hasUI) {
                return unavailableResult(params.question, mode, "ask_user_question requires interactive mode UI", context);
            }

            return withUILock(async () => {
                const label = herdrLabel(params.question);

                if (mode === "text") {
                    const answer = await withHerdrBlocked(pi, label, () => askText(ctx, pi, params.question, context));
                    if (answer === undefined) {
                        return cancelledResult(params.question, mode, context);
                    }
                    return buildResult(params.question, context, mode, [
                        { type: "text", label: answer.trim(), value: answer.trim() },
                    ]);
                }

                if (mode === "single-select") {
                    const answer = await withHerdrBlocked(pi, label, () =>
                        askSingleChoice(ctx, pi, params.question, context, options),
                    );
                    if (!answer) {
                        return cancelledResult(params.question, mode, context);
                    }
                    return buildResult(params.question, context, mode, [answer]);
                }

                const answers = await withHerdrBlocked(pi, label, () =>
                    askMultiChoice(ctx, pi, params.question, context, options),
                );
                if (!answers) {
                    return cancelledResult(params.question, mode, context);
                }
                return buildResult(params.question, context, mode, answers);
            });
        },

        renderCall(args, theme) {
            const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
            let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
            if (args.multiSelect) {
                text += theme.fg("dim", " [multi-select]");
            }
            if (options.length > 0) {
                const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
                text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details as AskUserQuestionResultDetails | undefined;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }

            if (details.status === "cancelled") {
                return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
            }

            if (details.status === "unavailable") {
                return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
            }

            const lines = details.answers.map((answer) => {
                switch (answer.type) {
                    case "text":
                        return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
                    case "other":
                        return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
                    case "option":
                        return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
                }
            });
            return new Text(lines.join("\n"), 0, 0);
        },
    });
}
