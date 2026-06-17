/**
 * Review Loop extension.
 *
 * Runs isolated review/fix cycles over the cumulative branch diff. The loop
 * refuses to start unless the working tree is clean, fixes all review findings,
 * and commits each fix interval before reviewing the updated branch again.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/volt-coding-agent";

const DEFAULT_MAX_LOOPS = 5;
const MAX_REVIEW_DIFF_CHARS = 150_000;
const STATE_TYPE = "review-loop-memory";
const REVIEW_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const FIX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

type JsonRecord = Record<string, unknown>;

interface ParsedLoopArgs {
	maxLoops: number;
	base?: string;
	error?: string;
}

interface ResolvedReview {
	base: string;
	description: string;
	diffCommand: string;
	diff: string;
	truncated: boolean;
	extraContext?: string;
}

interface ReviewFinding {
	title: string;
	body: string;
	priority?: number;
	confidence?: number;
	file?: string;
	line?: string;
}

interface ReviewCoverage {
	filesReviewed: string[];
	commandsRun: string[];
	uncheckedAreas: string[];
}

interface ParsedReview {
	findings: ReviewFinding[];
	coverage?: ReviewCoverage;
	overallCorrectness?: string;
	overallExplanation?: string;
}

interface FixedFinding {
	number?: number;
	title?: string;
	files: string[];
}

interface ParsedFix {
	summary: string;
	fixedFindings: FixedFinding[];
	commandsRun: string[];
	unresolvedFindings: string[];
}

interface LoopMemoryEntry {
	iteration: number;
	commit: string;
	findings: ReviewFinding[];
	fixedFindings: string[];
	filesChanged: string[];
	commandsRun: string[];
	unresolvedFindings: string[];
	summary: string;
}

interface VoltRunOptions {
	cwd: string;
	phase: string;
	prompt: string;
	tools: readonly string[];
	modelRef: string;
	thinkingLevel: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
}

interface VoltRunResult {
	raw: string;
	stderr: string;
	exitCode: number;
	error?: string;
}

interface JsonCandidate {
	index: number;
	text: string;
}

const REVIEW_SYSTEM_PROMPT = `<reviewer_prompt>
  <role>
    You are an expert code reviewer operating inside volt, a coding agent harness.
    You review a code change comprehensively and report every substantiated finding that matters.
  </role>

  <goal>
    Complete the whole review, not a first-hit bug hunt. Do not stop after finding one or two issues.
    Continue until you have reviewed the full cumulative branch diff and the relevant surrounding code.
  </goal>

  <tool_use>
    <instruction>Build a map of the changed files, changed symbols, and intended behavior before judging individual hunks.</instruction>
    <instruction>Read the full files around changed hunks, or enough of each file to understand its invariants; never judge a hunk in isolation.</instruction>
    <instruction>Trace callers, callees, tests, configuration, and related code when a change could break an invariant elsewhere.</instruction>
    <instruction>If the inline diff is truncated, run the provided diff command and review the full diff before finalizing.</instruction>
    <instruction>If you suspect a behavioral bug, verify it when feasible: run the relevant tests, or write a small scratch test/script to confirm.</instruction>
    <instruction>Delete any scratch files you create and revert any temporary edits before finishing, leaving the working tree as you found it.</instruction>
  </tool_use>

  <review_workflow>
    <step id="1" name="scope">Identify all changed files, changed entry points, and the intended behavior.</step>
    <step id="2" name="context">Read surrounding code and project instructions relevant to each change.</step>
    <step id="3" name="trace">Follow call sites, data flow, configuration, and tests for changes that affect contracts or invariants.</step>
    <step id="4" name="verify">Run targeted commands or scratch checks for suspected behavioral bugs when feasible.</step>
    <step id="5" name="coverage">Apply the checklist below across the whole cumulative branch diff before finalizing.</step>
    <step id="6" name="report">Report all independent substantiated findings in the required payload.</step>
  </review_workflow>

  <coverage_checklist>
    <item>Runtime correctness, logic errors, regressions, and broken invariants.</item>
    <item>Missed call sites, API/contract compatibility, migrations, and configuration changes.</item>
    <item>Edge cases: empty input, partial failure, cancellation/abort, retries, large inputs, platform differences, and boundary values.</item>
    <item>Error handling, cleanup, data loss, concurrency, async ordering, and race conditions.</item>
    <item>Security and privacy issues: trust boundaries, injection, path traversal, credential exposure, unsafe file/network operations.</item>
    <item>Tests: missing or weakened coverage for changed behavior, and whether existing tests still exercise the intended behavior.</item>
    <item>Project-specific conventions and instructions from project context.</item>
  </coverage_checklist>

  <finding_rules>
    <flag>Bugs and logic errors that affect behavior.</flag>
    <flag>Security issues, data loss, race conditions, broken error handling.</flag>
    <flag>Changes that contradict explicit project conventions from project context.</flag>
    <flag>Regressions: removed checks, broken invariants, missed call sites.</flag>
    <flag>All independent, substantiated priority 0, 1, 2, or 3 findings.</flag>
    <do_not_flag>Style nits, formatting, or naming preferences.</do_not_flag>
    <do_not_flag>Speculative concerns you could not substantiate from the code.</do_not_flag>
    <do_not_flag>Pre-existing issues in code the branch does not touch, unless the branch makes them worse.</do_not_flag>
    <grouping>If multiple hunks share one root cause, group them into one finding; otherwise do not omit independent issues.</grouping>
    <empty_findings>Use an empty findings array only after completing the workflow and checklist.</empty_findings>
  </finding_rules>

  <priority_scale>
    <priority value="0">Must fix before landing.</priority>
    <priority value="1">Should fix.</priority>
    <priority value="2">Worth fixing.</priority>
    <priority value="3">Optional but valid.</priority>
  </priority_scale>

  <output_contract>
    <format>End your final message with one XML response envelope. Do not put anything after the closing response tag.</format>
    <summary>Before the payload, include a short summary of what you reviewed, what you verified, and any important areas you could not verify.</summary>
    <payload_rules>
      <rule>The payload content must be valid JSON. Do not wrap it in markdown fences.</rule>
      <rule>overall_correctness must be "correct" or "incorrect".</rule>
      <rule>Confidence is a number from 0.0 to 1.0 and must be grounded in code you read or executed.</rule>
      <rule>Use empty arrays in coverage when nothing applies.</rule>
    </payload_rules>
    <response_shape>
<response>
  <summary>Short prose summary.</summary>
  <payload>
{
  "findings": [
    {
      "title": "Short imperative summary",
      "body": "Explanation with evidence: what is wrong, why, and the concrete impact. Reference files and lines.",
      "priority": 1,
      "confidence": 0.9,
      "file": "relative/path/to/file.ts",
      "line": "120-134"
    }
  ],
  "coverage": {
    "files_reviewed": ["relative/path/to/file.ts"],
    "commands_run": ["npm run check"],
    "unchecked_areas": ["Integration tests not run: reason"]
  },
  "overall_correctness": "correct",
  "overall_explanation": "One or two sentences on whether the branch is safe to land."
}
  </payload>
</response>
    </response_shape>
  </output_contract>
</reviewer_prompt>`;

const FIX_APPEND_SYSTEM_PROMPT = `<review_loop_fix_prompt>
  <role>You are a senior coding agent fixing findings from an isolated automated review.</role>
  <goal>Fix every supplied finding with minimal, correct changes. Do not skip priority 3 findings if they are valid.</goal>
  <instructions>
    <instruction>Read the relevant files before editing.</instruction>
    <instruction>Apply focused fixes for all findings in the request.</instruction>
    <instruction>Run targeted verification commands when feasible.</instruction>
    <instruction>Do not create commits, branches, tags, or stashes. The review-loop extension owns committing.</instruction>
    <instruction>Do not leave scratch files behind.</instruction>
    <instruction>If a finding is invalid or cannot be fixed safely, explain it in unresolved_findings.</instruction>
  </instructions>
  <output_contract>
    <format>End your final message with one XML response envelope. Do not put anything after the closing response tag.</format>
    <payload_rules>The payload content must be valid JSON. Do not wrap it in markdown fences.</payload_rules>
    <response_shape>
<response>
  <summary>Short prose summary.</summary>
  <payload>
{
  "summary": "What changed and why.",
  "fixed_findings": [
    { "number": 1, "title": "Finding title", "files": ["relative/path.ts"] }
  ],
  "commands_run": ["npm run check"],
  "unresolved_findings": []
}
  </payload>
</response>
    </response_shape>
  </output_contract>
</review_loop_fix_prompt>`;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLoopArgs(argsText: string): ParsedLoopArgs {
	const tokens = argsText.trim().split(/\s+/).filter(Boolean);
	let maxLoops = DEFAULT_MAX_LOOPS;

	if (tokens[0] && /^\d+$/.test(tokens[0])) {
		maxLoops = Number.parseInt(tokens.shift() ?? "", 10);
	}

	if (!Number.isSafeInteger(maxLoops) || maxLoops < 1) {
		return { maxLoops: DEFAULT_MAX_LOOPS, error: "Loop count must be a positive integer." };
	}

	if (tokens[0]?.toLowerCase() === "uncommitted") {
		return {
			maxLoops,
			error: "review-loop reviews clean branch diffs only. Commit or discard local changes, then pass an optional base branch.",
		};
	}

	if (tokens[0]?.toLowerCase() === "branch") {
		tokens.shift();
	}

	if (tokens.length > 1) {
		return {
			maxLoops,
			error: "Usage: /review-loop [max-loops] [base-branch]",
		};
	}

	return {
		maxLoops,
		...(tokens[0] ? { base: tokens[0] } : {}),
	};
}

function commandFailure(result: ExecResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

async function git(volt: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<ExecResult> {
	return volt.exec("git", args, { cwd: ctx.cwd });
}

async function isGitRepo(volt: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const result = await git(volt, ctx, ["rev-parse", "--is-inside-work-tree"]);
	return result.code === 0 && result.stdout.trim() === "true";
}

async function getDirtyStatus(volt: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const result = await git(volt, ctx, ["status", "--porcelain"]);
	if (result.code !== 0) {
		throw new Error(`git status failed: ${commandFailure(result)}`);
	}
	return result.stdout.trim();
}

function formatDirtyStatus(status: string): string {
	const lines = status.split("\n").filter(Boolean);
	const preview = lines.slice(0, 12).join("\n");
	const suffix =
		lines.length > 12 ? `\n... ${lines.length - 12} more entr${lines.length - 12 === 1 ? "y" : "ies"}` : "";
	return `${preview}${suffix}`;
}

async function refExists(volt: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<boolean> {
	const result = await git(volt, ctx, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return result.code === 0;
}

async function detectBaseBranch(volt: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const originHead = await git(volt, ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead.code === 0) {
		const ref = originHead.stdout.trim();
		if (ref && (await refExists(volt, ctx, ref))) {
			return ref;
		}
	}

	for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
		if (await refExists(volt, ctx, candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
	if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
		return { diff, truncated: false };
	}
	return { diff: diff.slice(0, MAX_REVIEW_DIFF_CHARS), truncated: true };
}

async function resolveBranchReview(
	volt: ExtensionAPI,
	ctx: ExtensionCommandContext,
	base: string,
): Promise<ResolvedReview | { error: string } | { empty: true }> {
	if (!(await refExists(volt, ctx, base))) {
		return { error: `Base branch/ref "${base}" not found.` };
	}

	const diffResult = await git(volt, ctx, ["diff", `${base}...HEAD`]);
	if (diffResult.code !== 0) {
		return { error: `git diff failed: ${commandFailure(diffResult)}` };
	}
	if (!diffResult.stdout.trim()) {
		return { empty: true };
	}

	const logResult = await git(volt, ctx, ["log", "--oneline", `${base}..HEAD`]);
	const { diff, truncated } = truncateDiff(diffResult.stdout);
	return {
		base,
		description: `branch changes vs ${base}`,
		diffCommand: `git diff ${base}...HEAD`,
		diff,
		truncated,
		extraContext:
			logResult.code === 0 && logResult.stdout.trim() ? `Commits:\n${logResult.stdout.trim()}` : undefined,
	};
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapXmlCdata(value: string): string {
	return `<![CDATA[${value.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function formatFindingForPrompt(finding: ReviewFinding, index: number): string {
	const meta: string[] = [];
	if (finding.priority !== undefined) meta.push(`P${finding.priority}`);
	if (finding.file) meta.push(finding.line ? `${finding.file}:${finding.line}` : finding.file);
	const metaText = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
	return [`${index + 1}. ${finding.title}${metaText}`, finding.body].filter(Boolean).join("\n");
}

function formatLoopMemory(history: readonly LoopMemoryEntry[]): string {
	if (history.length === 0) {
		return "No prior review-loop fixes have been committed in this run.";
	}

	return history
		.map((entry) => {
			const lines = [`Iteration ${entry.iteration} commit ${entry.commit}: ${entry.summary}`];
			if (entry.filesChanged.length > 0) lines.push(`Files changed: ${entry.filesChanged.join(", ")}`);
			if (entry.fixedFindings.length > 0) lines.push(`Fixed findings: ${entry.fixedFindings.join("; ")}`);
			if (entry.commandsRun.length > 0) lines.push(`Commands run: ${entry.commandsRun.join("; ")}`);
			if (entry.unresolvedFindings.length > 0) {
				lines.push(`Unresolved notes: ${entry.unresolvedFindings.join("; ")}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function buildReviewPrompt(resolved: ResolvedReview, iteration: number, history: readonly LoopMemoryEntry[]): string {
	const diffNote = resolved.truncated
		? `The diff is too large to include inline. Run \`${resolved.diffCommand}\` yourself to read the full diff. A truncated preview is included in the diff node.`
		: `Reproduce this diff with \`${resolved.diffCommand}\`.`;
	const parts: string[] = [
		"<review_request>",
		"  <target>",
		`    <description>${escapeXml(resolved.description)}</description>`,
		`    <diff_command>${escapeXml(resolved.diffCommand)}</diff_command>`,
		`    <diff_truncated>${resolved.truncated ? "true" : "false"}</diff_truncated>`,
		"  </target>",
		"  <loop>",
		`    <iteration>${iteration}</iteration>`,
		"    <instruction>Review the cumulative branch diff from base to HEAD, including all prior review-loop fix commits.</instruction>",
		"  </loop>",
		`  <loop_memory>${wrapXmlCdata(formatLoopMemory(history))}</loop_memory>`,
	];
	if (resolved.extraContext) {
		parts.push(`  <extra_context>${wrapXmlCdata(resolved.extraContext)}</extra_context>`);
	}
	parts.push(
		`  <diff_note>${escapeXml(diffNote)}</diff_note>`,
		`  <diff>${wrapXmlCdata(resolved.diff)}</diff>`,
		"  <task>Investigate the surrounding code before judging any hunk. Complete the review workflow across the whole cumulative branch diff before finalizing; do not stop after the first finding. Verify suspected bugs when feasible. Then produce your findings in the required XML response envelope with a JSON payload.</task>",
		"</review_request>",
	);
	return parts.join("\n");
}

function buildFixPrompt(
	resolved: ResolvedReview,
	review: ParsedReview,
	iteration: number,
	history: readonly LoopMemoryEntry[],
): string {
	const findingsText = review.findings.map(formatFindingForPrompt).join("\n\n");
	return [
		"<review_loop_fix_request>",
		"  <target>",
		`    <description>${escapeXml(resolved.description)}</description>`,
		`    <diff_command>${escapeXml(resolved.diffCommand)}</diff_command>`,
		"  </target>",
		"  <loop>",
		`    <iteration>${iteration}</iteration>`,
		"    <instruction>Fix all findings in this request. The extension will commit your work after you finish.</instruction>",
		"  </loop>",
		`  <loop_memory>${wrapXmlCdata(formatLoopMemory(history))}</loop_memory>`,
		`  <findings>${wrapXmlCdata(findingsText)}</findings>`,
		`  <findings_json>${wrapXmlCdata(JSON.stringify(review.findings, null, 2))}</findings_json>`,
		"  <task>Read the relevant code, fix every finding, run targeted verification when feasible, and leave the working tree with only the intended fixes. Do not commit. Finish with the required XML response envelope and JSON payload.</task>",
		"</review_loop_fix_request>",
	].join("\n");
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function decodeXmlPayloadText(value: string): string {
	const decodedCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
	return (decodedCdata === value ? decodeXmlEntities(value) : decodedCdata).trim();
}

function stripJsonMarkdownFence(value: string): string {
	const trimmed = value.trim();
	const match = /^```(?:json)?[ \t]*(?:\r?\n)?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
	return match?.[1]?.trim() ?? trimmed;
}

function collectJsonCandidates(text: string): JsonCandidate[] {
	const candidates: JsonCandidate[] = [];
	const payloadRegex = /<payload\b[^>]*>([\s\S]*?)<\/payload>/gi;
	let payloadMatch = payloadRegex.exec(text);
	while (payloadMatch !== null) {
		candidates.push({ index: payloadMatch.index, text: decodeXmlPayloadText(payloadMatch[1] ?? "") });
		payloadMatch = payloadRegex.exec(text);
	}

	let blockLines: string[] | undefined;
	let blockIsCandidate = false;
	let blockStartIndex = 0;
	let lineStartIndex = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (blockLines === undefined) {
			if (trimmed.startsWith("```")) {
				const infoString = trimmed.slice(3).trim();
				blockLines = [];
				blockIsCandidate = infoString === "" || infoString === "json";
				blockStartIndex = lineStartIndex;
			}
		} else if (trimmed === "```") {
			if (blockIsCandidate) {
				candidates.push({ index: blockStartIndex, text: blockLines.join("\n") });
			}
			blockLines = undefined;
		} else {
			blockLines.push(line);
		}
		lineStartIndex += line.length + 1;
	}
	if (blockLines !== undefined && blockIsCandidate) {
		candidates.push({ index: blockStartIndex, text: blockLines.join("\n") });
	}
	candidates.push({ index: 0, text });
	return candidates;
}

function parseLastJsonObject(text: string, accepts: (record: JsonRecord) => boolean): JsonRecord | undefined {
	for (const candidateEntry of collectJsonCandidates(text).sort((left, right) => right.index - left.index)) {
		const candidate = stripJsonMarkdownFence(candidateEntry.text);
		if (!candidate.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (!accepts(parsed)) continue;
		return parsed;
	}
	return undefined;
}

function coerceStringArray(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
}

function coerceFinding(raw: unknown): ReviewFinding | undefined {
	if (!isRecord(raw)) return undefined;
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	const body = typeof raw.body === "string" ? raw.body.trim() : "";
	if (!title && !body) return undefined;
	return {
		title: title || body.slice(0, 80),
		body,
		priority: typeof raw.priority === "number" ? raw.priority : undefined,
		confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
		file: typeof raw.file === "string" && raw.file.trim() ? raw.file.trim() : undefined,
		line:
			typeof raw.line === "string" && raw.line.trim()
				? raw.line.trim()
				: typeof raw.line === "number"
					? String(raw.line)
					: undefined,
	};
}

function coerceCoverage(raw: unknown): ReviewCoverage | undefined {
	if (!isRecord(raw)) return undefined;
	const coverage = {
		filesReviewed: coerceStringArray(raw.files_reviewed),
		commandsRun: coerceStringArray(raw.commands_run),
		uncheckedAreas: coerceStringArray(raw.unchecked_areas),
	};
	if (
		coverage.filesReviewed.length === 0 &&
		coverage.commandsRun.length === 0 &&
		coverage.uncheckedAreas.length === 0
	) {
		return undefined;
	}
	return coverage;
}

function parseReviewOutput(text: string): ParsedReview | undefined {
	const record = parseLastJsonObject(text, (candidate) => Array.isArray(candidate.findings));
	if (!record) return undefined;
	const findings = (record.findings as unknown[])
		.map(coerceFinding)
		.filter((finding): finding is ReviewFinding => finding !== undefined);
	return {
		findings,
		coverage: coerceCoverage(record.coverage),
		overallCorrectness: typeof record.overall_correctness === "string" ? record.overall_correctness : undefined,
		overallExplanation: typeof record.overall_explanation === "string" ? record.overall_explanation : undefined,
	};
}

function coerceFixedFinding(raw: unknown): FixedFinding | undefined {
	if (!isRecord(raw)) return undefined;
	const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined;
	const number = typeof raw.number === "number" && Number.isFinite(raw.number) ? raw.number : undefined;
	const files = coerceStringArray(raw.files);
	if (title === undefined && number === undefined && files.length === 0) return undefined;
	return { ...(number !== undefined ? { number } : {}), ...(title !== undefined ? { title } : {}), files };
}

function parseFixOutput(text: string): ParsedFix {
	const record = parseLastJsonObject(
		text,
		(candidate) =>
			typeof candidate.summary === "string" ||
			Array.isArray(candidate.fixed_findings) ||
			Array.isArray(candidate.commands_run),
	);
	if (!record) {
		return {
			summary: text.trim() || "Fix phase completed.",
			fixedFindings: [],
			commandsRun: [],
			unresolvedFindings: [],
		};
	}

	return {
		summary:
			typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : "Fix phase completed.",
		fixedFindings: Array.isArray(record.fixed_findings)
			? record.fixed_findings.map(coerceFixedFinding).filter((entry): entry is FixedFinding => entry !== undefined)
			: [],
		commandsRun: coerceStringArray(record.commands_run),
		unresolvedFindings: coerceStringArray(record.unresolved_findings),
	};
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return "";
			return part.text;
		})
		.filter(Boolean)
		.join("\n");
}

function getVoltInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "volt", args };
}

async function runIsolatedVolt(options: VoltRunOptions): Promise<VoltRunResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "volt-review-loop-"));
	try {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--tools",
			options.tools.join(","),
			"--model",
			options.modelRef,
			"--thinking",
			options.thinkingLevel,
		];

		if (options.systemPrompt !== undefined) {
			const systemPath = join(tempDir, "system.md");
			await writeFile(systemPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--system-prompt", systemPath);
		}
		if (options.appendSystemPrompt !== undefined) {
			const appendPath = join(tempDir, "append-system.md");
			await writeFile(appendPath, options.appendSystemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", appendPath);
		}

		const promptPath = join(tempDir, "prompt.md");
		await writeFile(promptPath, options.prompt, { encoding: "utf8", mode: 0o600 });
		args.push(`@${promptPath}`);

		const invocation = getVoltInvocation(args);
		let stdoutBuffer = "";
		let stderr = "";
		let lastAssistantText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let spawnError: string | undefined;

		const processLine = (line: string): void => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(parsed) || parsed.type !== "message_end" || !isRecord(parsed.message)) return;
			const message = parsed.message;
			if (message.role !== "assistant") return;
			lastAssistantText = extractTextContent(message.content);
			stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		};

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			proc.stdout.on("data", (data) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("error", (error) => {
				spawnError = error.message;
				resolve(1);
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});
		});

		if (spawnError) {
			return { raw: "", stderr, exitCode, error: `${options.phase} failed to start: ${spawnError}` };
		}
		if (exitCode !== 0) {
			const detail = stderr.trim() || `exit code ${exitCode}`;
			return { raw: lastAssistantText, stderr, exitCode, error: `${options.phase} exited with ${detail}` };
		}
		if (stopReason === "error") {
			return { raw: lastAssistantText, stderr, exitCode, error: errorMessage ?? `${options.phase} failed` };
		}
		if (stopReason === "aborted") {
			return { raw: lastAssistantText, stderr, exitCode, error: `${options.phase} was aborted` };
		}
		if (!lastAssistantText.trim()) {
			const detail = stderr.trim() ? ` Stderr: ${stderr.trim()}` : "";
			return { raw: "", stderr, exitCode, error: `${options.phase} produced no assistant output.${detail}` };
		}
		return { raw: lastAssistantText, stderr, exitCode };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function getChangedFiles(volt: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string[]> {
	const files = new Set<string>();
	for (const args of [
		["diff", "--name-only"],
		["diff", "--cached", "--name-only"],
		["ls-files", "--others", "--exclude-standard"],
	]) {
		const result = await git(volt, ctx, args);
		if (result.code !== 0) continue;
		for (const file of result.stdout.split("\n")) {
			const trimmed = file.trim();
			if (trimmed) files.add(trimmed);
		}
	}
	return [...files].sort((left, right) => left.localeCompare(right));
}

function formatFixedFinding(entry: FixedFinding): string {
	const number = entry.number !== undefined ? `#${entry.number}` : undefined;
	const title = entry.title;
	const files = entry.files.length > 0 ? ` (${entry.files.join(", ")})` : "";
	return [number, title].filter(Boolean).join(" ") + files;
}

function formatReviewFindingForCommit(finding: ReviewFinding, index: number): string {
	const priority = finding.priority !== undefined ? `P${finding.priority} ` : "";
	const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
	return `#${index + 1} ${priority}${finding.title}${location}`;
}

function buildCommitMessage(
	iteration: number,
	resolved: ResolvedReview,
	review: ParsedReview,
	fix: ParsedFix,
	filesChanged: readonly string[],
): string {
	const lines = [
		`review/work: iteration ${iteration}`,
		"",
		`Review target: ${resolved.diffCommand}`,
		"",
		"Findings addressed:",
		...review.findings.map((finding, index) => `- ${formatReviewFindingForCommit(finding, index)}`),
		"",
		"Fix summary:",
		fix.summary,
		"",
		"Files changed:",
		...(filesChanged.length > 0 ? filesChanged.map((file) => `- ${file}`) : ["- none reported"]),
		"",
		"Verification:",
		...(fix.commandsRun.length > 0 ? fix.commandsRun.map((command) => `- ${command}`) : ["- not reported"]),
	];
	if (fix.unresolvedFindings.length > 0) {
		lines.push("", "Unresolved findings:", ...fix.unresolvedFindings.map((finding) => `- ${finding}`));
	}
	return `${lines.join("\n")}\n`;
}

async function commitFixes(
	volt: ExtensionAPI,
	ctx: ExtensionCommandContext,
	iteration: number,
	resolved: ResolvedReview,
	review: ParsedReview,
	fix: ParsedFix,
	filesChanged: readonly string[],
): Promise<string | { error: string }> {
	const addResult = await git(volt, ctx, ["add", "-A"]);
	if (addResult.code !== 0) {
		return { error: `git add failed: ${commandFailure(addResult)}` };
	}

	const tempDir = await mkdtemp(join(tmpdir(), "volt-review-loop-commit-"));
	try {
		const messagePath = join(tempDir, "message.txt");
		await writeFile(messagePath, buildCommitMessage(iteration, resolved, review, fix, filesChanged), {
			encoding: "utf8",
			mode: 0o600,
		});
		const commitResult = await git(volt, ctx, ["commit", "-F", messagePath]);
		if (commitResult.code !== 0) {
			return { error: `git commit failed: ${commandFailure(commitResult)}` };
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}

	const revResult = await git(volt, ctx, ["rev-parse", "--short", "HEAD"]);
	if (revResult.code !== 0) {
		return { error: `git rev-parse failed after commit: ${commandFailure(revResult)}` };
	}
	return revResult.stdout.trim();
}

function updateProgress(ctx: ExtensionCommandContext, lines: string[]): void {
	ctx.ui.setWidget("review-loop", lines);
	ctx.ui.setStatus("review-loop", lines[0] ?? "review-loop");
}

async function runReviewLoop(volt: ExtensionAPI, argsText: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsedArgs = parseLoopArgs(argsText);
	if (parsedArgs.error) {
		ctx.ui.notify(parsedArgs.error, "error");
		return;
	}

	await ctx.waitForIdle();

	if (!ctx.model) {
		ctx.ui.notify("No active model available for review-loop.", "error");
		return;
	}

	if (!(await isGitRepo(volt, ctx))) {
		ctx.ui.notify("review-loop requires a git repository.", "error");
		return;
	}

	const initialStatus = await getDirtyStatus(volt, ctx);
	if (initialStatus) {
		ctx.ui.notify(
			`review-loop refused to start because the working tree is dirty:\n${formatDirtyStatus(initialStatus)}`,
			"error",
		);
		return;
	}

	const base = parsedArgs.base ?? (await detectBaseBranch(volt, ctx));
	if (!base) {
		ctx.ui.notify("Could not detect a base branch. Use /review-loop 5 <base-branch>.", "error");
		return;
	}

	const modelRef = `${ctx.model.provider}/${ctx.model.id}`;
	const thinkingLevel = volt.getThinkingLevel();
	const history: LoopMemoryEntry[] = [];

	try {
		for (let iteration = 1; iteration <= parsedArgs.maxLoops; iteration++) {
			const status = await getDirtyStatus(volt, ctx);
			if (status) {
				ctx.ui.notify(
					`review-loop stopped because the working tree became dirty:\n${formatDirtyStatus(status)}`,
					"error",
				);
				return;
			}

			updateProgress(ctx, [
				`review-loop ${iteration}/${parsedArgs.maxLoops}: reviewing ${base}...HEAD`,
				`Model: ${modelRef}`,
				`Prior fix commits: ${history.length}`,
			]);

			const resolved = await resolveBranchReview(volt, ctx, base);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			if ("empty" in resolved) {
				ctx.ui.notify(`review-loop complete: no branch diff vs ${base}.`, "info");
				return;
			}

			const reviewRun = await runIsolatedVolt({
				cwd: ctx.cwd,
				phase: `review iteration ${iteration}`,
				prompt: buildReviewPrompt(resolved, iteration, history),
				tools: REVIEW_TOOLS,
				modelRef,
				thinkingLevel,
				systemPrompt: REVIEW_SYSTEM_PROMPT,
			});
			if (reviewRun.error) {
				ctx.ui.notify(`Review failed: ${reviewRun.error}`, "error");
				return;
			}

			const parsedReview = parseReviewOutput(reviewRun.raw);
			if (!parsedReview) {
				ctx.ui.notify("Review failed: could not parse structured review payload.", "error");
				return;
			}

			if (parsedReview.findings.length === 0) {
				ctx.ui.notify(
					`review-loop complete after ${iteration} review${iteration === 1 ? "" : "s"}: no findings remain.`,
					"info",
				);
				return;
			}

			updateProgress(ctx, [
				`review-loop ${iteration}/${parsedArgs.maxLoops}: fixing ${parsedReview.findings.length} finding${parsedReview.findings.length === 1 ? "" : "s"}`,
				`Target: ${resolved.diffCommand}`,
				`Prior fix commits: ${history.length}`,
			]);

			const fixRun = await runIsolatedVolt({
				cwd: ctx.cwd,
				phase: `fix iteration ${iteration}`,
				prompt: buildFixPrompt(resolved, parsedReview, iteration, history),
				tools: FIX_TOOLS,
				modelRef,
				thinkingLevel,
				appendSystemPrompt: FIX_APPEND_SYSTEM_PROMPT,
			});
			if (fixRun.error) {
				ctx.ui.notify(`Fix failed: ${fixRun.error}`, "error");
				return;
			}

			const afterFixStatus = await getDirtyStatus(volt, ctx);
			if (!afterFixStatus) {
				ctx.ui.notify(
					`review-loop stopped: fix iteration ${iteration} produced no working tree changes for ${parsedReview.findings.length} finding${parsedReview.findings.length === 1 ? "" : "s"}.`,
					"warning",
				);
				return;
			}

			const parsedFix = parseFixOutput(fixRun.raw);
			const filesChanged = await getChangedFiles(volt, ctx);
			const commit = await commitFixes(volt, ctx, iteration, resolved, parsedReview, parsedFix, filesChanged);
			if (typeof commit !== "string") {
				ctx.ui.notify(commit.error, "error");
				return;
			}

			const memoryEntry: LoopMemoryEntry = {
				iteration,
				commit,
				findings: parsedReview.findings,
				fixedFindings: parsedFix.fixedFindings.map(formatFixedFinding).filter(Boolean),
				filesChanged,
				commandsRun: parsedFix.commandsRun,
				unresolvedFindings: parsedFix.unresolvedFindings,
				summary: parsedFix.summary,
			};
			history.push(memoryEntry);
			volt.appendEntry(STATE_TYPE, memoryEntry);
			ctx.ui.notify(`review-loop iteration ${iteration} committed ${commit}.`, "info");
		}

		ctx.ui.notify(
			`review-loop stopped after reaching the ${parsedArgs.maxLoops} loop limit. Run /review-loop again to continue.`,
			"warning",
		);
	} finally {
		ctx.ui.setStatus("review-loop", undefined);
		ctx.ui.setWidget("review-loop", undefined);
	}
}

export default function reviewLoop(volt: ExtensionAPI): void {
	volt.registerCommand("review-loop", {
		description: "Run isolated branch review/fix loops and commit each fix interval",
		getArgumentCompletions: (prefix) => {
			const options = ["5", "3", "branch", "main", "origin/main", "master", "origin/master"];
			const normalized = prefix.trim().toLowerCase();
			const matches = options.filter((option) => option.toLowerCase().startsWith(normalized));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			try {
				await runReviewLoop(volt, args, ctx);
			} catch (error) {
				ctx.ui.setStatus("review-loop", undefined);
				ctx.ui.setWidget("review-loop", undefined);
				ctx.ui.notify(`review-loop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
