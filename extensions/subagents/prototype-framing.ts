// PROTOTYPE — throwaway, for map #30 ticket #33. Do not merge to main.
// Three variants of bordered framing for subagent tool rows, printed to the terminal
// so the real theme/background of the user's terminal is part of the judgement.
//
//   bun extensions/subagents/prototype-framing.ts
//
// Variants:
//   A  default box + role/status-tinted background
//   B  renderShell:"self" — DynamicBorder in a role/status color, no background
//   C  left-rail / indent treatment (vertical rail, no full border)
//
// Each variant renders: collapsed running, collapsed settled, expanded running,
// expanded settled, using the layout contracts decided in tickets #31 / #32.
// A narrow (60 col) re-render of the settled collapsed view covers width behavior.
// Ordinary tool rows are printed around each sample so density/distinction is judged in situ.

// ---- fake theme (ANSI approximations of pi's default dark theme) ----
const ansi = (open: string, s: string) => `\x1b[${open}m${s}\x1b[0m`;
const T = {
	fg: {
		text: (s: string) => ansi("39", s),
		accent: (s: string) => ansi("38;5;75", s), // running
		success: (s: string) => ansi("38;5;114", s),
		error: (s: string) => ansi("38;5;203", s),
		warning: (s: string) => ansi("38;5;215", s),
		muted: (s: string) => ansi("38;5;244", s),
		dim: (s: string) => ansi("38;5;240", s),
		toolTitle: (s: string) => ansi("1;39", s),
		border: (s: string) => ansi("38;5;238", s),
	},
	bg: {
		toolPendingBg: (s: string) => ansi("48;5;236", s),
		toolSuccessBg: (s: string) => ansi("48;5;235", s),
		toolErrorBg: (s: string) => ansi("48;5;52", s),
		roleWorker: (s: string) => ansi("48;5;237", s),
		roleScout: (s: string) => ansi("48;5;236", s),
	},
};

type Status = "running" | "completed" | "failed";
const STATUS_FG: Record<Status, (s: string) => string> = {
	running: T.fg.accent,
	completed: T.fg.success,
	failed: T.fg.error,
};
const STATUS_ICON: Record<Status, string> = { running: "◦", completed: "✓", failed: "✗" };

/** strip ANSI for width math */
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const width = (s: string) => [...visible(s)].length;
function padLine(s: string, w: number) {
	const pad = " ".repeat(Math.max(0, w - width(s)));
	return s + pad;
}
function truncate(s: string, max: number) {
	return width(s) <= max ? s : [...s].slice(0, max - 1).join("") + "…";
}

// ---- shared fixture: a worker's row content (per decisions #31/#32) ----
type Fixture = {
	role: string;
	task: string;
	status: Status;
	model: string;
	thinking: string;
	elapsed: string;
	cost?: string;
	tools: { name: string; target: string; mark: string }[];
	contentLines: string[];
	report: string;
};

const WORKER: Fixture = {
	role: "worker",
	task: 'implement footer cost reflection in extensions/footer',
	status: "completed",
	model: "github-copilot/gpt-5.3-codex",
	thinking: "high",
	elapsed: "3m 42s",
	cost: "$0.4127 · 88.4k tok",
	tools: [
		{ name: "read", target: "extensions/footer/footer.ts", mark: "✓" },
		{ name: "edit", target: "extensions/footer/footer.ts", mark: "✓" },
		{ name: "bash", target: "bun test extensions/footer", mark: "✓" },
	],
	contentLines: [
		"The footer currently reads details.results[], which the",
		"platform stopped populating for tool-result usage — the",
		"fix is to walk session entries and sum usage.totalCost.",
	],
	report:
		"Replaced the deprecated details.results[] walk with a session-entry usage aggregation. Per-child cost is folded into the session total; no label table was needed.",
};

const SCOUT: Fixture = {
	role: "scout",
	task: 'find where tool rows are composed',
	status: "running",
	model: "github-copilot/gpt-5.3-codex",
	thinking: "low",
	elapsed: "48s",
	tools: [
		{ name: "rg", target: "tool-execution.ts", mark: "✓" },
		{ name: "read", target: "tool-execution.ts", mark: "✓" },
		{ name: "bash", target: "rg renderShell docs/", mark: "◦" },
	],
	contentLines: [
		"tool-execution.ts composes the row: renderCall above,",
		"result below, wrapped in a Box with toolPendingBg while",
	],
};

const reportOf = (f: Fixture): string => f.report ?? "(transcript streaming…)";

const headerLines = (f: Fixture, w: number): string[] => {
	const icon = STATUS_FG[f.status](`${STATUS_ICON[f.status]} ${f.role}`);
	const l1 = truncate(`${icon} ${T.fg.toolTitle(`"${f.task}"`)}${f.status === "running" ? " " + T.fg.dim("· streaming…") : ""}`, w);
	const prov = [T.fg.dim(f.model), T.fg.dim(`think ${f.thinking}`), T.fg.dim(f.elapsed)];
	if (f.cost) prov.push(STATUS_FG[f.status] === T.fg.success ? T.fg.success(f.cost) : T.fg.dim(f.cost));
	const l2 = truncate(prov.join(T.fg.dim(" · ")), w);
	return [l1, l2];
};

// ---------------- Variant A: default box + tinted background ----------------
function boxA(f: Fixture, w: number, expanded: boolean): string[] {
	const inner = w - 4;
	const bg = f.status === "completed" ? T.bg.toolSuccessBg : f.status === "running" ? T.bg.toolPendingBg : T.bg.toolErrorBg;
	const tint = f.role === "worker" ? T.bg.roleWorker : T.bg.roleScout;
	const body: string[] = [...headerLines(f, inner)];
	if (!expanded) {
		body.push("");
		for (const t of f.tools) body.push(`${T.fg.dim(t.mark)} ${T.fg.text(t.name)} ${T.fg.dim(truncate(t.target, inner - 10))}`);
		body.push("");
		for (const c of f.contentLines) body.push(T.fg.text(truncate(c, inner)));
	} else {
		body.push("");
		for (const t of f.tools) body.push(`${T.fg.dim(t.mark)} ${T.fg.text(t.name)} ${T.fg.dim(truncate(t.target, inner - 10))}`);
		body.push("");
		body.push(T.fg.text(truncate(f.report ?? "(transcript streaming…)", inner)));
		body.push("");
		body.push(T.fg.dim(`model: ${f.model} · thinking: requested high, effective ${f.thinking}`));
	}
	const top = T.fg.border(`  ┌${"─".repeat(inner + 2)}┐`);
	const bot = T.fg.border(`  └${"─".repeat(inner + 2)}┘`);
	const lines = [top];
	for (const l of body) lines.push("  " + bg(tint(` ${padLine(l, inner)} `)));
	lines.push(bot);
	return lines;
}

// ---------------- Variant B: DynamicBorder in role/status color (renderShell:"self") ----------------
function boxB(f: Fixture, w: number, expanded: boolean): string[] {
	const inner = w - 6;
	const roleColor = f.role === "worker" ? T.fg.accent : T.fg.muted;
	const borderColor = f.status === "completed" ? T.fg.success : f.status === "failed" ? T.fg.error : roleColor;
	const edge = `╭${"─".repeat(inner + 2)}╮`;
	const bottom = `╰${"─".repeat(inner + 2)}╯`;
	const side = (s: string) => "  " + borderColor("│") + " " + padLine(s, inner) + " " + borderColor("│");
	const body: string[] = [...headerLines(f, inner)];
	if (!expanded) {
		body.push("");
		for (const t of f.tools) body.push(`${T.fg.dim(t.mark)} ${T.fg.text(t.name)} ${T.fg.dim(truncate(t.target, inner - 10))}`);
		body.push("");
		for (const c of f.contentLines) body.push(T.fg.text(truncate(c, inner)));
	} else {
		body.push("");
		for (const t of f.tools) body.push(`${T.fg.dim(t.mark)} ${T.fg.text(t.name)} ${T.fg.dim(truncate(t.target, inner - 10))}`);
		body.push("");
		body.push(T.fg.text(truncate(reportOf(f), inner)));
		body.push("");
		body.push(T.fg.dim(`model: ${f.model} · thinking: requested high, effective ${f.thinking}`));
	}
	return [borderColor(`  ${edge}`), ...body.map(side), borderColor(`  ${bottom}`)];
}

// ---------------- Variant C: left-rail / indent ----------------
function boxC(f: Fixture, w: number, expanded: boolean): string[] {
	const inner = w - 5;
	const statusColor = f.status === "completed" ? T.fg.success : f.status === "failed" ? T.fg.error : T.fg.accent;
	const rail = f.role === "worker" ? statusColor("▌") : T.fg.muted("▏");
	const body: string[] = [...headerLines(f, inner)];
	if (!expanded) {
		body.push("");
		for (const t of f.tools) body.push(`${T.fg.dim(t.mark)} ${T.fg.text(t.name)} ${T.fg.dim(truncate(t.target, inner - 10))}`);
		body.push("");
		for (const c of f.contentLines) body.push(T.fg.text(truncate(c, inner)));
	} else {
		body.push("");
		for (const t of f.tools) body.push(`${T.fg.dim(t.mark)} ${T.fg.text(t.name)} ${T.fg.dim(truncate(t.target, inner - 10))}`);
		body.push("");
		body.push(T.fg.text(truncate(reportOf(f), inner)));
		body.push("");
		body.push(T.fg.dim(`model: ${f.model} · thinking: requested high, effective ${f.thinking}`));
	}
	return body.map((l) => `  ${rail} ${l === "" ? "" : l}`);
}

// ---------------- ordinary tool rows for in-situ context ----------------
const ORDINARY = [
	`  ${T.fg.dim("✓")} ${T.fg.toolTitle("bash")} ${T.fg.dim("bun test extensions/subagents")}  ${T.fg.dim("12s")}`,
	`  ${T.fg.dim("✓")} ${T.fg.toolTitle("read")}  ${T.fg.dim("extensions/footer/footer.ts")}`,
];

// ---------------- driver ----------------
const W = 100;
const variants: { key: string; name: string; render: (f: Fixture, w: number, expanded: boolean) => string[] }[] = [
	{ key: "A", name: "default box + tinted background", render: boxA },
	{ key: "B", name: 'renderShell:"self" DynamicBorder in role/status color', render: boxB },
	{ key: "C", name: "left-rail / indent", render: boxC },
];

const section = (title: string) => console.log(`\n${T.fg.toolTitle(`━━ ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`)}`);
const context = () => console.log(T.fg.dim("  … preceding orchestrator rows:") + "\n" + ORDINARY.join("\n"));

for (const v of variants) {
	section(`Variant ${v.key} — ${v.name}`);
	context();
	console.log(`\n  [collapsed · running]`);
	console.log(v.render(SCOUT, W, false).join("\n"));
	console.log(`\n  [collapsed · settled]`);
	console.log(v.render(WORKER, W, false).join("\n"));
	console.log(`\n  [expanded · running]`);
	console.log(v.render(SCOUT, W, true).join("\n"));
	console.log(`\n  [expanded · settled]`);
	console.log(v.render(WORKER, W, true).join("\n"));
}

// narrow-width pass: 60 columns, collapsed settled, each variant
section("Narrow terminal (60 cols) · collapsed · settled");
for (const v of variants) {
	console.log(T.fg.dim(`  — variant ${v.key} —`));
	console.log(v.render(WORKER, 60, false).join("\n"));
	console.log("");
}

console.log(T.fg.dim("PROTOTYPE — throwaway; react, then discard. Which framing wins, and does the border/background survive running→settled?"));
