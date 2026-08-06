import { spawn } from "node:child_process";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { Text } from "@hansjm10/volt-tui";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellEnv,
	terminateProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { Theme } from "../theme/runtime.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const DEFAULT_INSPECTION_TIMEOUT_SECONDS = 120;
const MAX_INSPECTION_TIMEOUT_SECONDS = 300;

export const INSPECTION_OPERATIONS = [
	"git.status",
	"git.log",
	"git.show",
	"git.diff",
	"git.blame",
	"git.branches",
	"git.tags",
	"git.refs",
	"gh.issue.view",
	"gh.issue.list",
	"gh.issue.status",
	"gh.pr.view",
	"gh.pr.list",
	"gh.pr.status",
	"gh.pr.diff",
	"gh.pr.checks",
	"gh.search.issues",
	"gh.search.prs",
	"gh.search.code",
	"gh.search.commits",
	"gh.search.repos",
] as const;

export type InspectionOperation = (typeof INSPECTION_OPERATIONS)[number];

const inspectionOperationSchema = Type.Unsafe<InspectionOperation>({
	type: "string",
	enum: [...INSPECTION_OPERATIONS],
});
const inspectionSchema = Type.Object(
	{
		operation: inspectionOperationSchema,
		args: Type.Optional(
			Type.Array(Type.String({ maxLength: 4096 }), {
				description: "Arguments passed literally to the approved read operation; shell syntax is not supported",
				maxItems: 128,
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: `Overall wall-clock limit in seconds (default ${DEFAULT_INSPECTION_TIMEOUT_SECONDS}, max ${MAX_INSPECTION_TIMEOUT_SECONDS})`,
				minimum: 1,
				maximum: MAX_INSPECTION_TIMEOUT_SECONDS,
			}),
		),
	},
	{ additionalProperties: false },
);

export type InspectionToolInput = Static<typeof inspectionSchema>;

export interface ResolvedInspectionCommand {
	executable: "git" | "gh";
	args: string[];
	kind: "workspace-read" | "network-read";
	display: string;
}

export interface InspectionToolDetails {
	command: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface InspectionOperations {
	exec(
		executable: string,
		args: readonly string[],
		cwd: string,
		options: {
			onData(data: Buffer): void;
			signal?: AbortSignal;
			timeout: number;
			env: NodeJS.ProcessEnv;
		},
	): Promise<{ exitCode: number | null }>;
}

export interface InspectionToolOptions {
	operations?: InspectionOperations;
}

const SHELL_CONTROL_ARGUMENTS = new Set(["|", "||", "&&", ";", "<", ">", ">>", "2>", "2>>"]);
const BLOCKED_GH_LONG_OPTIONS = ["--help", "--web"];
const MAX_GIT_FILTER_CONFIG_BYTES = 1024 * 1024;
const GIT_FILTER_CONFIG_PATTERN = "^filter\\..*\\.(clean|smudge|process|required)$";

type GitInspectionOperation = Extract<InspectionOperation, `git.${string}`>;
type GitHubInspectionOperation = Extract<InspectionOperation, `gh.${string}`>;
type GitOptionValueMode = "none" | "required" | "optional-attached";

const GH_VALUE_SHORT_OPTIONS: Record<GitHubInspectionOperation, ReadonlySet<string>> = {
	"gh.issue.view": new Set(["q", "t", "R"]),
	"gh.issue.list": new Set(["a", "A", "q", "l", "L", "m", "S", "s", "t", "R"]),
	"gh.issue.status": new Set(["q", "t", "R"]),
	"gh.pr.view": new Set(["q", "t", "R"]),
	"gh.pr.list": new Set(["a", "A", "B", "H", "q", "l", "L", "S", "s", "t", "R"]),
	"gh.pr.status": new Set(["q", "t", "R"]),
	"gh.pr.diff": new Set(["e", "R"]),
	"gh.pr.checks": new Set(["i", "q", "t", "R"]),
	"gh.search.issues": new Set(["q", "L", "R", "t"]),
	"gh.search.prs": new Set(["B", "H", "q", "L", "R", "t"]),
	"gh.search.code": new Set(["q", "L", "R", "t"]),
	"gh.search.commits": new Set(["q", "L", "R", "t"]),
	"gh.search.repos": new Set(["q", "L", "t"]),
};

interface GitArgumentGrammar {
	long: ReadonlyMap<string, GitOptionValueMode>;
	short: ReadonlyMap<string, GitOptionValueMode>;
	allowNumericShort?: boolean;
}

function optionModes(
	none: readonly string[],
	required: readonly string[] = [],
	optionalAttached: readonly string[] = [],
): ReadonlyMap<string, GitOptionValueMode> {
	return new Map<string, GitOptionValueMode>([
		...none.map((option) => [option, "none"] as const),
		...required.map((option) => [option, "required"] as const),
		...optionalAttached.map((option) => [option, "optional-attached"] as const),
	]);
}

const COMMON_DIFF_LONG_NONE = [
	"binary",
	"cached",
	"check",
	"color-moved-ws",
	"compact-summary",
	"cumulative",
	"default-prefix",
	"exit-code",
	"find-copies-harder",
	"full-index",
	"histogram",
	"ignore-all-space",
	"ignore-blank-lines",
	"ignore-cr-at-eol",
	"ignore-space-at-eol",
	"ignore-space-change",
	"indent-heuristic",
	"irreversible-delete",
	"ita-invisible-in-index",
	"ita-visible-in-index",
	"minimal",
	"name-only",
	"name-status",
	"no-color",
	"no-color-moved",
	"no-color-moved-ws",
	"no-indent-heuristic",
	"no-prefix",
	"no-renames",
	"numstat",
	"patch",
	"patch-with-raw",
	"patch-with-stat",
	"patience",
	"pickaxe-all",
	"pickaxe-regex",
	"quiet",
	"raw",
	"relative",
	"shortstat",
	"staged",
	"stat",
	"summary",
	"text",
	"word-diff",
	"zero-commit",
] as const;
const COMMON_DIFF_LONG_REQUIRED = [
	"anchored",
	"diff-algorithm",
	"diff-filter",
	"dst-prefix",
	"find-object",
	"ignore-matching-lines",
	"inter-hunk-context",
	"line-prefix",
	"output-indicator-context",
	"output-indicator-new",
	"output-indicator-old",
	"rotate-to",
	"skip-to",
	"src-prefix",
	"stat-count",
	"stat-graph-width",
	"stat-name-width",
	"stat-width",
	"unified",
	"word-diff-regex",
] as const;
const COMMON_DIFF_LONG_OPTIONAL = [
	"color",
	"color-moved",
	"dirstat",
	"dirstat-by-file",
	"find-copies",
	"find-renames",
	"ignore-submodules",
	"relative",
	"stat",
	"submodule",
	"word-diff",
	"ws-error-highlight",
] as const;
const COMMON_DIFF_SHORT_NONE = ["b", "p", "q", "R", "u", "w", "z"] as const;
const COMMON_DIFF_SHORT_REQUIRED = ["G", "I", "S"] as const;
const COMMON_DIFF_SHORT_OPTIONAL = ["B", "C", "M", "U"] as const;

const LOG_LONG_NONE = [
	...COMMON_DIFF_LONG_NONE,
	"abbrev-commit",
	"all",
	"all-match",
	"alternate-refs",
	"author-date-order",
	"basic-regexp",
	"boundary",
	"cherry-mark",
	"cherry-pick",
	"children",
	"date-order",
	"decorate",
	"dense",
	"do-walk",
	"extended-regexp",
	"first-parent",
	"fixed-strings",
	"follow",
	"full-diff",
	"full-history",
	"ignore-missing",
	"invert-grep",
	"left-right",
	"log-size",
	"mailmap",
	"merges",
	"no-abbrev-commit",
	"no-expand-tabs",
	"no-mailmap",
	"no-max-parents",
	"no-merges",
	"no-min-parents",
	"no-notes",
	"not",
	"oneline",
	"parents",
	"perl-regexp",
	"reflog",
	"regexp-ignore-case",
	"remerge-diff",
	"remove-empty",
	"reverse",
	"show-notes-by-default",
	"show-pulls",
	"simplify-by-decoration",
	"simplify-merges",
	"single-worktree",
	"source",
	"sparse",
	"topo-order",
	"use-mailmap",
] as const;
const LOG_LONG_REQUIRED = [
	...COMMON_DIFF_LONG_REQUIRED,
	"after",
	"author",
	"before",
	"committer",
	"date",
	"decorate-refs",
	"decorate-refs-exclude",
	"diff-merges",
	"encoding",
	"exclude",
	"glob",
	"grep",
	"max-count",
	"max-parents",
	"min-parents",
	"skip",
	"since",
	"since-as-filter",
	"until",
] as const;
const LOG_LONG_OPTIONAL = [
	...COMMON_DIFF_LONG_OPTIONAL,
	"abbrev",
	"ancestry-path",
	"branches",
	"decorate",
	"expand-tabs",
	"no-walk",
	"notes",
	"pretty",
	"remotes",
	"tags",
] as const;

const GIT_ARGUMENT_GRAMMARS: Record<GitInspectionOperation, GitArgumentGrammar> = {
	"git.status": {
		long: optionModes(
			[
				"ahead-behind",
				"branch",
				"long",
				"no-ahead-behind",
				"no-column",
				"no-renames",
				"null",
				"renames",
				"short",
				"show-stash",
				"verbose",
			],
			[],
			["column", "find-renames", "ignore-submodules", "ignored", "porcelain", "untracked-files"],
		),
		short: optionModes(["b", "s", "v", "z"], [], ["M", "u"]),
	},
	"git.log": {
		long: optionModes(LOG_LONG_NONE, LOG_LONG_REQUIRED, LOG_LONG_OPTIONAL),
		short: optionModes(
			[...COMMON_DIFF_SHORT_NONE, "c", "E", "F", "g", "i", "m", "P", "s", "t"],
			[...COMMON_DIFF_SHORT_REQUIRED, "n"],
			COMMON_DIFF_SHORT_OPTIONAL,
		),
		allowNumericShort: true,
	},
	"git.show": {
		long: optionModes(LOG_LONG_NONE, LOG_LONG_REQUIRED, LOG_LONG_OPTIONAL),
		short: optionModes(
			[...COMMON_DIFF_SHORT_NONE, "c", "E", "F", "m", "P", "s", "t"],
			[...COMMON_DIFF_SHORT_REQUIRED, "n"],
			COMMON_DIFF_SHORT_OPTIONAL,
		),
		allowNumericShort: true,
	},
	"git.diff": {
		long: optionModes([...COMMON_DIFF_LONG_NONE, "merge-base"], COMMON_DIFF_LONG_REQUIRED, COMMON_DIFF_LONG_OPTIONAL),
		short: optionModes(COMMON_DIFF_SHORT_NONE, COMMON_DIFF_SHORT_REQUIRED, COMMON_DIFF_SHORT_OPTIONAL),
	},
	"git.blame": {
		long: optionModes(
			[
				"color-by-age",
				"color-lines",
				"first-parent",
				"incremental",
				"line-porcelain",
				"long",
				"porcelain",
				"progress",
				"reverse",
				"root",
				"score-debug",
				"show-email",
				"show-name",
				"show-number",
				"show-stats",
			],
			["abbrev", "date", "encoding", "ignore-rev"],
		),
		short: optionModes(["b", "e", "f", "l", "n", "p", "s", "t", "w"], ["L"], ["C", "M"]),
	},
	"git.branches": {
		long: optionModes(
			[
				"all",
				"ignore-case",
				"list",
				"no-abbrev",
				"no-column",
				"omit-empty",
				"quiet",
				"remotes",
				"show-current",
				"verbose",
			],
			["format", "points-at", "sort"],
			["abbrev", "color", "column", "contains", "merged", "no-contains", "no-merged"],
		),
		short: optionModes(["a", "q", "r", "v"]),
	},
	"git.tags": {
		long: optionModes(
			["ignore-case", "list", "no-column", "omit-empty"],
			["format", "points-at", "sort"],
			["color", "column", "contains", "merged", "no-contains", "no-merged"],
		),
		short: optionModes(["i", "l"], [], ["n"]),
	},
	"git.refs": {
		long: optionModes(
			["ignore-case", "omit-empty", "perl", "python", "shell", "tcl"],
			["count", "format", "points-at", "sort"],
			["color", "contains", "merged", "no-contains", "no-merged"],
		),
		short: optionModes([]),
	},
};

const GIT_INSPECTION_PREFIX_ARGS = [
	"--no-pager",
	"--no-optional-locks",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.pager=cat",
	"-c",
	"color.ui=false",
	"-c",
	"diff.external=",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"format.pretty=medium",
	"-c",
	"log.showSignature=false",
] as const;

const GIT_OPERATION_ARGS: Record<GitInspectionOperation, readonly string[]> = {
	"git.status": ["status"],
	"git.log": ["log", "--no-ext-diff", "--no-textconv"],
	"git.show": ["show", "--no-ext-diff", "--no-textconv"],
	"git.diff": ["diff", "--no-ext-diff", "--no-textconv"],
	"git.blame": ["blame", "--no-textconv"],
	"git.branches": ["branch", "--list"],
	"git.tags": ["tag", "--list"],
	"git.refs": ["for-each-ref"],
};

const GH_OPERATION_ARGS: Record<GitHubInspectionOperation, readonly string[]> = {
	"gh.issue.view": ["issue", "view"],
	"gh.issue.list": ["issue", "list"],
	"gh.issue.status": ["issue", "status"],
	"gh.pr.view": ["pr", "view"],
	"gh.pr.list": ["pr", "list"],
	"gh.pr.status": ["pr", "status"],
	"gh.pr.diff": ["pr", "diff"],
	"gh.pr.checks": ["pr", "checks"],
	"gh.search.issues": ["search", "issues"],
	"gh.search.prs": ["search", "prs"],
	"gh.search.code": ["search", "code"],
	"gh.search.commits": ["search", "commits"],
	"gh.search.repos": ["search", "repos"],
};

function optionMatches(argument: string, option: string): boolean {
	return argument === option || argument.startsWith(`${option}=`);
}

function assertLiteralArguments(args: readonly string[]): void {
	for (const argument of args) {
		if (argument.includes("\0") || argument.includes("\n") || argument.includes("\r")) {
			throw new Error("Inspection arguments must be single-line strings without NUL bytes");
		}
		if (SHELL_CONTROL_ARGUMENTS.has(argument)) {
			throw new Error(`Shell control syntax is not supported by inspect: ${JSON.stringify(argument)}`);
		}
	}
}

function assertSafeGitHubArguments(args: readonly string[], operation: GitHubInspectionOperation): void {
	let positionalsOnly = false;
	for (const argument of args) {
		if (positionalsOnly || argument === "-" || !argument.startsWith("-")) continue;
		if (argument === "--") {
			positionalsOnly = true;
			continue;
		}
		if (argument.startsWith("--")) {
			const option = BLOCKED_GH_LONG_OPTIONS.find((candidate) => optionMatches(argument, candidate));
			if (option) {
				throw new Error(`GitHub CLI option is not allowed for read-only inspection: ${argument}`);
			}
			continue;
		}
		for (const name of argument.slice(1)) {
			if (name === "w") {
				throw new Error(`GitHub CLI option is not allowed for read-only inspection: ${argument}`);
			}
			if (GH_VALUE_SHORT_OPTIONS[operation].has(name)) break;
		}
	}
}

function assertSafeGitFormatValue(value: string): void {
	if (value.includes("%G") || /%\(signature(?=[:)])/i.test(value)) {
		throw new Error("Git signature verification formats are not allowed for read-only inspection");
	}
}

const BUILTIN_GIT_PRETTY_FORMATS = new Set([
	"email",
	"full",
	"fuller",
	"medium",
	"oneline",
	"raw",
	"reference",
	"short",
]);

function assertSafeGitOptionValue(name: string, value: string): void {
	assertSafeGitFormatValue(value);
	if (
		name === "pretty" &&
		!BUILTIN_GIT_PRETTY_FORMATS.has(value) &&
		!value.startsWith("format:") &&
		!value.startsWith("tformat:")
	) {
		throw new Error(`Repository-configured Git pretty formats are not allowed: ${value}`);
	}
}

function validateGitArguments(args: readonly string[], grammar: GitArgumentGrammar): void {
	let positionalsOnly = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		assertSafeGitFormatValue(argument);
		if (positionalsOnly || argument === "-" || !argument.startsWith("-")) continue;
		if (argument === "--") {
			positionalsOnly = true;
			continue;
		}
		if (argument.startsWith("--")) {
			const equalsIndex = argument.indexOf("=");
			const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
			const mode = grammar.long.get(name);
			if (!mode) {
				throw new Error(`Git option is not allowed for this read-only inspection operation: ${argument}`);
			}
			if (mode === "none" && equalsIndex !== -1) {
				throw new Error(`Git option does not accept a value: ${argument}`);
			}
			if (equalsIndex !== -1) {
				assertSafeGitOptionValue(name, argument.slice(equalsIndex + 1));
			} else if (mode === "required") {
				const value = args[index + 1];
				if (value === undefined || value === "--") {
					throw new Error(`Git option requires a value: --${name}`);
				}
				assertSafeGitOptionValue(name, value);
				index += 1;
			}
			continue;
		}
		if (grammar.allowNumericShort && /^-\d+$/.test(argument)) continue;
		for (let shortIndex = 1; shortIndex < argument.length; shortIndex += 1) {
			const name = argument[shortIndex]!;
			const mode = grammar.short.get(name);
			if (!mode) {
				throw new Error(`Git short option is not allowed for this read-only inspection operation: -${name}`);
			}
			if (mode === "none") continue;
			const attachedValue = argument.slice(shortIndex + 1);
			if (attachedValue) {
				assertSafeGitFormatValue(attachedValue);
				break;
			}
			if (mode === "required") {
				const value = args[index + 1];
				if (value === undefined || value === "--") {
					throw new Error(`Git short option requires a value: -${name}`);
				}
				assertSafeGitFormatValue(value);
				index += 1;
			}
			break;
		}
	}
}

function configuredGitFilterDrivers(output: string): string[] {
	const drivers = new Set<string>();
	for (const key of output.split("\0")) {
		if (!key) continue;
		const match = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key);
		if (!match?.[1]) {
			throw new Error(`Unexpected Git filter configuration key: ${JSON.stringify(key)}`);
		}
		const driver = match[1];
		if (driver.includes("=")) {
			throw new Error(`Git filter driver cannot be disabled safely: ${JSON.stringify(driver)}`);
		}
		drivers.add(driver);
	}
	return [...drivers];
}

function gitFilterOverrides(drivers: readonly string[]): string[] {
	return drivers.flatMap((driver) => [
		"-c",
		`filter.${driver}.clean=`,
		"-c",
		`filter.${driver}.smudge=`,
		"-c",
		`filter.${driver}.process=`,
		"-c",
		`filter.${driver}.required=false`,
	]);
}

async function addGitFilterOverrides(
	args: readonly string[],
	operations: InspectionOperations,
	cwd: string,
	options: {
		signal?: AbortSignal;
		timeout: number;
		env: NodeJS.ProcessEnv;
	},
): Promise<string[]> {
	const chunks: Buffer[] = [];
	let outputBytes = 0;
	let outputTooLarge = false;
	const result = await operations.exec(
		"git",
		[
			"--no-pager",
			"--no-optional-locks",
			"config",
			"--null",
			"--name-only",
			"--get-regexp",
			GIT_FILTER_CONFIG_PATTERN,
		],
		cwd,
		{
			...options,
			onData(data) {
				outputBytes += data.length;
				if (outputBytes > MAX_GIT_FILTER_CONFIG_BYTES) {
					outputTooLarge = true;
					return;
				}
				chunks.push(data);
			},
		},
	);
	if (outputTooLarge) {
		throw new Error("Git filter configuration exceeds the inspection safety limit");
	}
	const output = Buffer.concat(chunks).toString("utf8");
	if (result.exitCode === 1 && !output) return [...args];
	if (result.exitCode !== 0 && result.exitCode !== null) {
		throw new Error(
			`${output.trimEnd()}${output ? "\n\n" : ""}Git filter discovery exited with code ${result.exitCode}`,
		);
	}
	return [
		...GIT_INSPECTION_PREFIX_ARGS,
		...gitFilterOverrides(configuredGitFilterDrivers(output)),
		...args.slice(GIT_INSPECTION_PREFIX_ARGS.length),
	];
}

export function resolveInspectionCommand(input: InspectionToolInput): ResolvedInspectionCommand {
	const args = input.args ?? [];
	assertLiteralArguments(args);
	if (input.operation.startsWith("git.")) {
		const gitOperation = input.operation as keyof typeof GIT_OPERATION_ARGS;
		const grammar = GIT_ARGUMENT_GRAMMARS[gitOperation];
		if (!grammar) {
			throw new Error(`Unsupported Git inspection operation: ${input.operation}`);
		}
		validateGitArguments(args, grammar);
		const operationArgs = GIT_OPERATION_ARGS[gitOperation];
		if (!operationArgs) {
			throw new Error(`Unsupported Git inspection operation: ${input.operation}`);
		}
		const commandArgs = [...GIT_INSPECTION_PREFIX_ARGS, ...operationArgs, ...args];
		return {
			executable: "git",
			args: commandArgs,
			kind: "workspace-read",
			display: ["git", ...operationArgs, ...args].join(" "),
		};
	}

	const githubOperation = input.operation as GitHubInspectionOperation;
	assertSafeGitHubArguments(args, githubOperation);
	const operationArgs = GH_OPERATION_ARGS[githubOperation];
	if (!operationArgs) {
		throw new Error(`Unsupported GitHub inspection operation: ${input.operation}`);
	}
	return {
		executable: "gh",
		args: [...operationArgs, ...args],
		kind: "network-read",
		display: ["gh", ...operationArgs, ...args].join(" "),
	};
}

export function createLocalInspectionOperations(): InspectionOperations {
	return {
		async exec(executable, args, cwd, options) {
			if (options.signal?.aborted) {
				throw new Error("aborted");
			}
			const child = spawn(executable, [...args], {
				cwd,
				detached: process.platform !== "win32",
				env: options.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let exited = false;
			let timedOut = false;
			let tornDown = false;
			child.once("exit", () => {
				exited = true;
			});
			const teardown = () => {
				if (tornDown || exited || !child.pid) return;
				tornDown = true;
				void terminateProcessTree(child.pid, () => exited);
			};
			const timeoutHandle = setTimeout(() => {
				timedOut = true;
				teardown();
			}, options.timeout * 1000);
			child.stdout?.on("data", options.onData);
			child.stderr?.on("data", options.onData);
			if (options.signal) {
				if (options.signal.aborted) teardown();
				else options.signal.addEventListener("abort", teardown, { once: true });
			}
			try {
				const exitCode = await waitForChildProcess(child);
				if (options.signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${options.timeout}`);
				return { exitCode };
			} finally {
				clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", teardown);
				if (child.pid) untrackDetachedChildPid(child.pid);
			}
		},
	};
}

function createInspectionEnvironment(): NodeJS.ProcessEnv {
	return {
		...getShellEnv(),
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		GH_PAGER: "cat",
		GH_PROMPT_DISABLED: "1",
		NO_COLOR: "1",
		PAGER: "cat",
		TERM: "dumb",
	};
}

function renderInspectionCall(args: InspectionToolInput | undefined, theme: Theme): string {
	if (!args) return theme.fg("error", "[invalid inspect arguments]");
	try {
		const command = resolveInspectionCommand(args);
		return `${theme.fg("toolTitle", theme.bold("inspect"))} ${theme.fg("accent", command.display)}`;
	} catch {
		const operation = str(args.operation);
		return `${theme.fg("toolTitle", theme.bold("inspect"))} ${operation === null ? invalidArgText(theme) : theme.fg("accent", operation || "...")}`;
	}
}

export function createInspectionToolDefinition(
	cwd: string,
	options?: InspectionToolOptions,
): ToolDefinition<typeof inspectionSchema, InspectionToolDetails | undefined> {
	const operations = options?.operations ?? createLocalInspectionOperations();
	return {
		name: "inspect",
		label: "inspect",
		description: `Inspect Git state and history or authenticated GitHub issue and pull-request context without a shell. Executes only approved read operations as direct argv. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Inspect Git history/diffs and GitHub issues or pull requests with vetted read-only commands",
		promptGuidelines: [
			"Use inspect for Git history and authenticated GitHub issue or pull-request context when arbitrary shell execution is unavailable.",
			"Pass each CLI argument as a separate args item; shell syntax, redirection, and pipelines are not supported.",
		],
		parameters: inspectionSchema,
		async execute(_toolCallId, input, signal, onUpdate) {
			const command = resolveInspectionCommand(input);
			const timeout = Math.min(
				MAX_INSPECTION_TIMEOUT_SECONDS,
				Math.max(1, input.timeout ?? DEFAULT_INSPECTION_TIMEOUT_SECONDS),
			);
			const output = new OutputAccumulator({ tempFilePrefix: "volt-inspect" });
			let acceptingOutput = true;
			const onData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				if (onUpdate) {
					const snapshot = output.snapshot({ persistIfTruncated: true });
					onUpdate({
						content: [{ type: "text", text: snapshot.content }],
						details: {
							command: command.display,
							...(snapshot.truncation.truncated ? { truncation: snapshot.truncation } : {}),
							...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
						},
					});
				}
			};
			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};
			try {
				let exitCode: number | null;
				try {
					const env = createInspectionEnvironment();
					let commandArgs = command.args;
					let commandTimeout = timeout;
					if (command.executable === "git") {
						const deadline = Date.now() + timeout * 1000;
						const remainingTimeout = () => {
							const remainingMs = deadline - Date.now();
							if (remainingMs <= 0) throw new Error(`timeout:${timeout}`);
							return remainingMs / 1000;
						};
						commandArgs = await addGitFilterOverrides(command.args, operations, cwd, {
							signal,
							timeout: remainingTimeout(),
							env,
						});
						commandTimeout = remainingTimeout();
					}
					({ exitCode } = await operations.exec(command.executable, commandArgs, cwd, {
						onData,
						signal,
						timeout: commandTimeout,
						env,
					}));
				} catch (error) {
					const snapshot = await finishOutput();
					const errorOutput = snapshot.content.trimEnd();
					const prefix = errorOutput ? `${errorOutput}\n\n` : "";
					if (error instanceof Error && error.message === "aborted") {
						throw new Error(`${prefix}Inspection aborted`);
					}
					if (error instanceof Error && error.message.startsWith("timeout:")) {
						throw new Error(`${prefix}Inspection timed out after ${timeout} seconds`);
					}
					throw error;
				}
				const snapshot = await finishOutput();
				if (exitCode !== 0 && exitCode !== null) {
					const errorOutput = snapshot.content.trimEnd();
					throw new Error(`${errorOutput ? `${errorOutput}\n\n` : ""}Inspection exited with code ${exitCode}`);
				}
				let text = snapshot.content || "(no output)";
				if (snapshot.truncation.truncated) {
					text += `\n\n[Showing ${snapshot.truncation.outputLines} of ${snapshot.truncation.totalLines} lines (${formatSize(snapshot.truncation.maxBytes)} limit). Full output: ${snapshot.fullOutputPath}]`;
				}
				return {
					content: [{ type: "text", text }],
					details: {
						command: command.display,
						...(snapshot.truncation.truncated ? { truncation: snapshot.truncation } : {}),
						...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
					},
				};
			} finally {
				if (acceptingOutput) {
					output.finish();
					await output.closeTempFile();
				}
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(renderInspectionCall(args, theme));
			return text;
		},
	};
}

export function createInspectionTool(
	cwd: string,
	options?: InspectionToolOptions,
): AgentTool<typeof inspectionSchema, InspectionToolDetails | undefined> {
	return wrapToolDefinition(createInspectionToolDefinition(cwd, options));
}
