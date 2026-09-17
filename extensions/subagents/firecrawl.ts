// firecrawl — purpose-built web-research tools injected into `researcher` child sessions,
// replacing raw `bash`. Each tool wraps one firecrawl CLI subcommand via execFile (no
// shell), so a researcher child gets a constrained, typed web surface instead of an
// arbitrary command surface.
//
// Children never load extensions (spec §R1.4), so these ToolDefinitions reach the child
// through the `childTools` injection path — the same wiring that gives a worker its
// restricted scout tool (see index.ts). They are NOT registered as top-level pi tools.
//
// Platform-light: the argv mapping (buildFirecrawlArgs) is a pure function and the process
// runner is injectable, so both are unit-testable without spawning a real CLI. The only
// non-injectable seam is defaultFirecrawlRunner (node:child_process.execFile).
//
// Design note: each tool fixes the subcommand and its primary positional argument(s) as
// typed parameters; advanced flags are carried in an `options` string array. `options`
// entries are passed as individual argv tokens (never through a shell), so this is not an
// arbitrary-command escape hatch — the researcher can only ever run `firecrawl <fixed-sub> …`.
// The firecrawl skills (loaded in the child via `skills: on`) document the exact flags.

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const FIREFCRAWL_BIN = "firecrawl";
/** Output cap for a single firecrawl call; larger stdout is truncated with a marker. */
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

export const FIREFCRAWL_TOOL_NAMES = [
	"firecrawl_search",
	"firecrawl_scrape",
	"firecrawl_map",
	"firecrawl_crawl",
	"firecrawl_research",
	"firecrawl_developer",
] as const;
export type FirecrawlToolName = (typeof FIREFCRAWL_TOOL_NAMES)[number];

/** Injectable process runner so tests can stub the CLI. */
export interface FirecrawlRunner {
	run(
		bin: string,
		args: readonly string[],
		signal: AbortSignal | undefined,
	): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Default runner: execFile with no shell; large maxBuffer for page content. */
export const defaultFirecrawlRunner: FirecrawlRunner = {
	async run(bin, args, signal) {
		return await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
			execFile(bin, [...args], { signal, maxBuffer: OUTPUT_CAP_BYTES }, (error, stdout, stderr) => {
				if (error) {
					const message = error.message || String(error);
					// On abort execFile reports a non-ExitError; report it as a failed run —
					// the caller also checks signal.aborted to phrase the result.
					const code = (error as NodeJS.ErrnoException & { code?: number }).code;
					resolve({
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? "") + (message ? `\n${message}` : ""),
						code: typeof code === "number" ? code : 1,
					});
					return;
				}
				resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
			});
		});
	},
};

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
	const single = asString(value);
	return single ? [single] : [];
}
function requiredString(params: Record<string, unknown>, key: string): string {
	const value = asString(params[key]);
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}
function passthroughOptions(params: Record<string, unknown>): string[] {
	const raw = params.options;
	if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
	return [];
}

/** Pure argv mapping from a firecrawl tool name + typed params to the firecrawl argv. */
export function buildFirecrawlArgs(tool: FirecrawlToolName, params: Record<string, unknown>): string[] {
	const options = passthroughOptions(params);
	switch (tool) {
		case "firecrawl_search":
			return ["search", requiredString(params, "query"), ...options];
		case "firecrawl_developer":
			return ["developer", requiredString(params, "query"), ...options];
		case "firecrawl_map":
			return ["map", requiredString(params, "url"), ...options];
		case "firecrawl_crawl":
			return ["crawl", requiredString(params, "url"), ...options];
		case "firecrawl_scrape":
			return ["scrape", ...asStringArray(params.urls), ...options];
		case "firecrawl_research":
			return ["research", requiredString(params, "subcommand"), ...asStringArray(params.arg), ...options];
		default:
			throw new Error(`unknown firecrawl tool "${tool}"`);
	}
}

const RESEARCH_SUBCOMMANDS = ["search-papers", "inspect-paper", "related-papers", "read-paper", "search-github"] as const;
const stringArrayParam = Type.Array(Type.String(), { description: "Additional firecrawl CLI flags/values, in order (e.g. [\"--limit\", \"20\"]). Passed as individual argv tokens — no shell." });

interface FirecrawlSpec {
	name: FirecrawlToolName;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
}

const SPECS: FirecrawlSpec[] = [
	{
		name: "firecrawl_search",
		label: "firecrawl search",
		description:
			"Search the live web for pages on a topic (no specific URL yet). Returns ranked results with titles and URLs. " +
			"Use this first in the research escalation when you only have a question.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language search query." }),
			options: Type.Optional(stringArrayParam),
		}),
	},
	{
		name: "firecrawl_scrape",
		label: "firecrawl scrape",
		description:
			"Extract one or more URLs' content as clean markdown (handles JS-rendered pages). URLs are scraped concurrently and saved to .firecrawl/. " +
			"Use this when you already have a URL and want its content.",
		parameters: Type.Object({
			urls: Type.Union([Type.String(), Type.Array(Type.String())], { description: "One URL, or several to scrape concurrently." }),
			options: Type.Optional(stringArrayParam),
		}),
	},
	{
		name: "firecrawl_map",
		label: "firecrawl map",
		description:
			"Discover and list a site's URLs, with optional search filtering. Use it to find a specific subpage on a known site before scraping.",
		parameters: Type.Object({
			url: Type.String({ description: "Base site URL to map." }),
			options: Type.Optional(stringArrayParam),
		}),
	},
	{
		name: "firecrawl_crawl",
		label: "firecrawl crawl",
		description:
			"Bulk-extract content from a site section (e.g. all of /docs). Use only when you need many linked pages, not a single page (use scrape for that).",
		parameters: Type.Object({
			url: Type.String({ description: "Starting URL or crawl job id." }),
			options: Type.Optional(stringArrayParam),
		}),
	},
	{
		name: "firecrawl_research",
		label: "firecrawl research",
		description:
			"Search the research paper index (~43M abstracts, mostly biomedical) and related scholarly sources. " +
			`Subcommands: ${RESEARCH_SUBCOMMANDS.join(", ")}. Use this for biomedical/clinical/scientific literature instead of scraping PubMed/bioRxiv/Google Scholar by hand.`,
		parameters: Type.Object({
			subcommand: Type.Union(
				RESEARCH_SUBCOMMANDS.map((s) => Type.Literal(s)),
				{ description: "Which research subcommand to run." },
			),
			arg: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Query / paper id / seed ids for the subcommand." })),
			options: Type.Optional(stringArrayParam),
		}),
	},
	{
		name: "firecrawl_developer",
		label: "firecrawl developer",
		description:
			"Answer a coding question against an index of GitHub issues, merged PRs, READMEs, and curated docs. Use for library/API/error/bug questions instead of a general web page.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language coding question; express scoping (repo, language, topic) in the text." }),
			options: Type.Optional(stringArrayParam),
		}),
	},
];

interface FirecrawlDetails {
	command: string;
	exitCode: number;
	truncated: boolean;
}

function resultText(content: string, details: FirecrawlDetails) {
	return { content: [{ type: "text" as const, text: content }], details };
}

/** Build a researcher-side firecrawl tool set. The runner is injectable for tests. */
export function createFirecrawlTools(runner: FirecrawlRunner = defaultFirecrawlRunner): ToolDefinition[] {
	return SPECS.map((spec) =>
		defineTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters,
			execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
				const args = buildFirecrawlArgs(spec.name, params as Record<string, unknown>);
				if (signal?.aborted) return resultText("Cancelled before the firecrawl command ran.", { command: args[0], exitCode: -1, truncated: false });

				const out = await runner.run(FIREFCRAWL_BIN, args, signal);

				if (signal?.aborted) return resultText("Cancelled while the firecrawl command was running.", { command: args[0], exitCode: -1, truncated: false });

				if (out.code !== 0) {
					const detail = out.stderr.trim() || out.stdout.trim() || `firecrawl ${args[0]} exited with code ${out.code}`;
					return resultText(`firecrawl ${args[0]} failed (exit ${out.code}):\n${detail}`, { command: args[0], exitCode: out.code, truncated: false });
				}

				const stdout = out.stdout ?? "";
				const byteLength = Buffer.byteLength(stdout, "utf8");
				const truncated = byteLength > OUTPUT_CAP_BYTES;
				const body = truncated ? `${stdout.slice(0, OUTPUT_CAP_BYTES)}\n… [output truncated at ${OUTPUT_CAP_BYTES} bytes]` : stdout;
				return resultText(body, { command: args[0], exitCode: 0, truncated });
			},
		}) as ToolDefinition,
	);
}
