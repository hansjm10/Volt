/**
 * Built-in /review support.
 *
 * Resolves a review target (uncommitted changes, branch diff, GitHub PR, or a
 * single commit) into a diff, runs an isolated in-process review session over
 * it, and parses the structured findings from the reviewer's final message.
 *
 * The review session is intentionally separate from the user's session: it has
 * its own context window, its own system prompt, and no extensions, skills, or
 * prompt templates. After the review completes the caller starts a fresh
 * session seeded only with the findings.
 */

import { spawn } from "node:child_process";
import type { ThinkingLevel } from "@earendil-works/volt-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/volt-ai";
import type { AuthStorage } from "./auth-storage.ts";
import { createExtensionRuntime } from "./extensions/loader.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { loadProjectContextFiles, type ResourceLoader } from "./resource-loader.ts";
import { createAgentSession } from "./sdk.ts";
import { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

// ============================================================================
// Review targets
// ============================================================================

export type ReviewTarget =
	| { kind: "uncommitted" }
	| { kind: "branch"; base?: string }
	| { kind: "pr"; number?: string }
	| { kind: "commit"; sha?: string };

export const REVIEW_USAGE =
	"Usage: /review [uncommitted | branch [base] | pr [number] | commit [sha]] (no arguments opens a selector)";

/**
 * Parse the argument text after "/review".
 * Returns an empty object when no arguments were given (caller shows a selector).
 */
export function parseReviewCommandArgs(argsText: string): { target?: ReviewTarget; error?: string } {
	const tokens = argsText.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return {};
	}

	const keyword = tokens[0].toLowerCase();
	switch (keyword) {
		case "uncommitted":
		case "unstaged":
		case "working":
			return { target: { kind: "uncommitted" } };
		case "branch":
			return { target: { kind: "branch", base: tokens[1] } };
		case "pr":
			return { target: { kind: "pr", number: tokens[1] } };
		case "commit":
			// Without a SHA the caller shows a commit picker.
			return { target: { kind: "commit", sha: tokens[1] } };
		default:
			return { error: `Unknown review target "${tokens[0]}". ${REVIEW_USAGE}` };
	}
}

// ============================================================================
// Target resolution (git / gh)
// ============================================================================

/** A review target resolved to a concrete diff plus reviewer-facing metadata. */
export interface ResolvedReview {
	/** Human-readable description, e.g. `branch changes vs main`. */
	description: string;
	/** Command the reviewer can re-run to reproduce the diff. */
	diffCommand: string;
	/** The diff text (possibly truncated, see `truncated`). */
	diff: string;
	/** True when the diff exceeded the inline size limit and was truncated. */
	truncated: boolean;
	/** Extra context: commit log, PR metadata, untracked file list. */
	extraContext?: string;
}

/** Maximum diff characters embedded inline in the review prompt. */
export const MAX_REVIEW_DIFF_CHARS = 150_000;

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (error) => {
			resolve({ ok: false, stdout, stderr: error.message });
		});
		proc.on("close", (code) => {
			resolve({ ok: code === 0, stdout, stderr });
		});
	});
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
	if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
		return { diff, truncated: false };
	}
	return { diff: diff.slice(0, MAX_REVIEW_DIFF_CHARS), truncated: true };
}

async function detectBaseBranch(cwd: string): Promise<string | undefined> {
	const originHead = await runCommand("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (originHead.ok) {
		const ref = originHead.stdout.trim();
		if (ref) {
			return ref.replace(/^origin\//, "");
		}
	}
	for (const candidate of ["main", "master"]) {
		const exists = await runCommand("git", ["rev-parse", "--verify", "--quiet", candidate], cwd);
		if (exists.ok) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve a review target into a concrete diff.
 * Returns `{ error }` for user-facing failures (not a git repo, empty diff, gh missing, ...).
 */
export async function resolveReviewTarget(
	target: ReviewTarget,
	cwd: string,
): Promise<ResolvedReview | { error: string }> {
	const inRepo = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (!inRepo.ok) {
		return { error: "Not inside a git repository." };
	}

	switch (target.kind) {
		case "uncommitted": {
			let diffResult = await runCommand("git", ["diff", "HEAD"], cwd);
			let diffCommand = "git diff HEAD";
			if (!diffResult.ok) {
				// No commits yet: combine the staged diff (index vs the empty tree)
				// with the worktree diff so staged changes are not missed.
				const stagedResult = await runCommand("git", ["diff", "--cached"], cwd);
				const worktreeResult = await runCommand("git", ["diff"], cwd);
				if (!stagedResult.ok || !worktreeResult.ok) {
					const failed = stagedResult.ok ? worktreeResult : stagedResult;
					return { error: `git diff failed: ${failed.stderr.trim()}` };
				}
				diffResult = { ok: true, stdout: stagedResult.stdout + worktreeResult.stdout, stderr: "" };
				diffCommand = "git diff --cached; git diff";
			}
			const untrackedResult = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], cwd);
			const untracked = untrackedResult.ok
				? untrackedResult.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
				: [];
			if (!diffResult.stdout.trim() && untracked.length === 0) {
				return { error: "No uncommitted changes to review." };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: "uncommitted changes",
				diffCommand,
				diff,
				truncated,
				extraContext:
					untracked.length > 0
						? `Untracked files (not in the diff; read them directly):\n${untracked.map((file) => `- ${file}`).join("\n")}`
						: undefined,
			};
		}
		case "branch": {
			const base = target.base ?? (await detectBaseBranch(cwd));
			if (!base) {
				return { error: "Could not detect a base branch. Use /review branch <base>." };
			}
			const baseExists = await runCommand("git", ["rev-parse", "--verify", "--quiet", base], cwd);
			if (!baseExists.ok) {
				return { error: `Base branch "${base}" not found.` };
			}
			const diffResult = await runCommand("git", ["diff", `${base}...HEAD`], cwd);
			if (!diffResult.ok) {
				return { error: `git diff failed: ${diffResult.stderr.trim()}` };
			}
			if (!diffResult.stdout.trim()) {
				return { error: `No changes between ${base} and HEAD.` };
			}
			const logResult = await runCommand("git", ["log", "--oneline", `${base}..HEAD`], cwd);
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: `branch changes vs ${base}`,
				diffCommand: `git diff ${base}...HEAD`,
				diff,
				truncated,
				extraContext: logResult.ok && logResult.stdout.trim() ? `Commits:\n${logResult.stdout.trim()}` : undefined,
			};
		}
		case "pr": {
			const numberArgs = target.number ? [target.number] : [];
			const viewResult = await runCommand(
				"gh",
				["pr", "view", ...numberArgs, "--json", "number,title,body,baseRefName,headRefName,url"],
				cwd,
			);
			if (!viewResult.ok) {
				const stderr = viewResult.stderr.trim();
				if (/ENOENT|not found|not recognized/i.test(stderr)) {
					return { error: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/" };
				}
				return { error: `gh pr view failed: ${stderr}` };
			}
			let prInfo: {
				number: number;
				title: string;
				body: string;
				baseRefName: string;
				headRefName: string;
				url: string;
			};
			try {
				prInfo = JSON.parse(viewResult.stdout);
			} catch {
				return { error: "Could not parse gh pr view output." };
			}
			const diffResult = await runCommand("gh", ["pr", "diff", String(prInfo.number)], cwd);
			if (!diffResult.ok) {
				return { error: `gh pr diff failed: ${diffResult.stderr.trim()}` };
			}
			if (!diffResult.stdout.trim()) {
				return { error: `PR #${prInfo.number} has an empty diff.` };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			const bodyText = prInfo.body?.trim();
			return {
				description: `PR #${prInfo.number} (${prInfo.title})`,
				diffCommand: `gh pr diff ${prInfo.number}`,
				diff,
				truncated,
				extraContext: [
					`PR #${prInfo.number}: ${prInfo.title}`,
					`Base branch: ${prInfo.baseRefName}`,
					`Head branch: ${prInfo.headRefName}`,
					`URL: ${prInfo.url}`,
					`Note: the local worktree may not have the PR head checked out. Do not assume local files match the diff; inspect PR file contents against fetched refs instead (e.g. \`git fetch origin ${prInfo.headRefName}\` then \`git show FETCH_HEAD:<path>\`).`,
					bodyText ? `Description:\n${bodyText}` : undefined,
				]
					.filter(Boolean)
					.join("\n"),
			};
		}
		case "commit": {
			if (!target.sha) {
				return { error: "Missing commit SHA." };
			}
			// --diff-merges=first-parent: plain `git show` prints no patch hunks
			// for merge commits; diff against the first parent shows what the
			// merge brought into the branch. Non-merge commits are unaffected.
			const diffResult = await runCommand(
				"git",
				["show", "--stat", "--patch", "--diff-merges=first-parent", target.sha],
				cwd,
			);
			if (!diffResult.ok) {
				return { error: `git show failed: ${diffResult.stderr.trim()}` };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: `commit ${target.sha}`,
				diffCommand: `git show --stat --patch --diff-merges=first-parent ${target.sha}`,
				diff,
				truncated,
			};
		}
	}
}

/** A commit entry for the /review commit picker. */
export interface RecentCommit {
	sha: string;
	subject: string;
	/** Relative author date, e.g. "2 days ago". */
	date: string;
}

function prioritizeBaseBranches(branches: string[]): string[] {
	const priority = new Map([
		["main", 0],
		["master", 1],
	]);
	return [...branches].sort((a, b) => {
		const aPriority = priority.get(a) ?? 2;
		const bPriority = priority.get(b) ?? 2;
		return aPriority === bPriority ? a.localeCompare(b) : aPriority - bPriority;
	});
}

/** List local branches for the /review base-branch picker. */
export async function listLocalBranches(cwd: string): Promise<string[] | { error: string }> {
	const result = await runCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
	if (!result.ok) {
		return { error: `git branch failed: ${result.stderr.trim()}` };
	}
	const branches = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return prioritizeBaseBranches(branches);
}

/** List recent commits on HEAD for the /review commit picker. */
export async function listRecentCommits(cwd: string, limit = 30): Promise<RecentCommit[] | { error: string }> {
	const result = await runCommand("git", ["log", "-n", String(limit), "--pretty=format:%h%x09%cr%x09%s"], cwd);
	if (!result.ok) {
		return { error: `git log failed: ${result.stderr.trim()}` };
	}
	const commits: RecentCommit[] = [];
	for (const line of result.stdout.split("\n")) {
		const [sha, date, ...subjectParts] = line.split("\t");
		if (!sha?.trim()) {
			continue;
		}
		commits.push({ sha: sha.trim(), date: date?.trim() ?? "", subject: subjectParts.join("\t").trim() });
	}
	return commits;
}

// ============================================================================
// Review prompt
// ============================================================================

export const REVIEW_SYSTEM_PROMPT = `<reviewer_prompt>
  <role>
    You are an expert code reviewer operating inside volt, a coding agent harness.
    You review a code change comprehensively and report every substantiated finding that matters.
  </role>

  <goal>
    Complete the whole review, not a first-hit bug hunt. Do not stop after finding one or two issues.
    Continue until you have reviewed the full diff and the relevant surrounding code.
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
    <step id="5" name="coverage">Apply the checklist below across the whole diff before finalizing.</step>
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
    <flag>All independent, substantiated priority 0, 1, or 2 findings. Include priority 3 only when it meaningfully helps the author.</flag>
    <do_not_flag>Style nits, formatting, or naming preferences.</do_not_flag>
    <do_not_flag>Speculative concerns you could not substantiate from the code.</do_not_flag>
    <do_not_flag>Pre-existing issues in code the change does not touch, unless the change makes them worse.</do_not_flag>
    <grouping>If multiple hunks share one root cause, group them into one finding; otherwise do not omit independent issues.</grouping>
    <empty_findings>Use an empty findings array only after completing the workflow and checklist.</empty_findings>
  </finding_rules>

  <priority_scale>
    <priority value="0">Must fix before landing.</priority>
    <priority value="1">Should fix.</priority>
    <priority value="2">Worth fixing.</priority>
    <priority value="3">Optional.</priority>
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
  "overall_explanation": "One or two sentences on whether the change is safe to land."
}
  </payload>
</response>
    </response_shape>
  </output_contract>
</reviewer_prompt>`;

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapXmlCdata(value: string): string {
	return `<![CDATA[${value.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** Build the user prompt for the review session. */
export function buildReviewPrompt(resolved: ResolvedReview): string {
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
	];
	if (resolved.extraContext) {
		parts.push(`  <extra_context>${wrapXmlCdata(resolved.extraContext)}</extra_context>`);
	}
	parts.push(
		`  <diff_note>${escapeXml(diffNote)}</diff_note>`,
		`  <diff>${wrapXmlCdata(resolved.diff)}</diff>`,
		"  <task>Investigate the surrounding code before judging any hunk. Complete the review workflow across the whole diff before finalizing; do not stop after the first finding. Verify suspected bugs when feasible. Then produce your findings in the required XML response envelope with a JSON payload.</task>",
		"</review_request>",
	);
	return parts.join("\n");
}

// ============================================================================
// Findings parsing
// ============================================================================

export interface ReviewFinding {
	title: string;
	body: string;
	/** 0 = must fix, 1 = should fix, 2 = worth fixing, 3 = optional. */
	priority?: number;
	/** 0.0 - 1.0 */
	confidence?: number;
	file?: string;
	line?: string;
}

export interface ReviewCoverage {
	filesReviewed: string[];
	commandsRun: string[];
	uncheckedAreas: string[];
}

export interface ParsedReview {
	findings: ReviewFinding[];
	coverage?: ReviewCoverage;
	overallCorrectness?: string;
	overallExplanation?: string;
}

function coerceFinding(raw: unknown): ReviewFinding | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const body = typeof record.body === "string" ? record.body.trim() : "";
	if (!title && !body) {
		return undefined;
	}
	return {
		title: title || body.slice(0, 80),
		body,
		priority: typeof record.priority === "number" ? record.priority : undefined,
		confidence: typeof record.confidence === "number" ? record.confidence : undefined,
		file: typeof record.file === "string" && record.file.trim() ? record.file.trim() : undefined,
		line:
			typeof record.line === "string" && record.line.trim()
				? record.line.trim()
				: typeof record.line === "number"
					? String(record.line)
					: undefined,
	};
}

function coerceStringArray(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
}

function coerceCoverage(raw: unknown): ReviewCoverage | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const coverage = {
		filesReviewed: coerceStringArray(record.files_reviewed),
		commandsRun: coerceStringArray(record.commands_run),
		uncheckedAreas: coerceStringArray(record.unchecked_areas),
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

interface JsonCandidate {
	index: number;
	text: string;
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

function collectXmlPayloadCandidates(text: string): JsonCandidate[] {
	const candidates: JsonCandidate[] = [];
	const payloadRegex = /<payload\b[^>]*>([\s\S]*?)<\/payload>/gi;
	let match = payloadRegex.exec(text);
	while (match !== null) {
		candidates.push({ index: match.index, text: decodeXmlPayloadText(match[1] ?? "") });
		match = payloadRegex.exec(text);
	}
	return candidates;
}

/**
 * Parse the reviewer's final message. Looks for the last XML payload, fenced json block,
 * or bare JSON object containing a findings array. Returns undefined when no parseable block exists.
 */
export function parseReviewOutput(text: string): ParsedReview | undefined {
	// Extract XML payloads first so the preferred response envelope can contain prose safely.
	const candidates = collectXmlPayloadCandidates(text);

	// Extract fenced blocks line by line. Any info string opens a block (so a
	// ```ts block in prose doesn't pair fences off-by-one), but only json or
	// untagged blocks become candidates. A closer must be a bare ``` line, so
	// fences embedded inside JSON strings don't terminate the block early.
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
	// An unterminated trailing block is still worth trying.
	if (blockLines !== undefined && blockIsCandidate) {
		candidates.push({ index: blockStartIndex, text: blockLines.join("\n") });
	}
	// Also try the whole text in case the model emitted bare JSON.
	candidates.push({ index: 0, text });

	for (const candidateEntry of candidates.sort((a, b) => b.index - a.index)) {
		const candidate = stripJsonMarkdownFence(candidateEntry.text);
		if (!candidate.startsWith("{")) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) {
			continue;
		}
		const record = parsed as Record<string, unknown>;
		if (!Array.isArray(record.findings)) {
			continue;
		}
		const findings = record.findings
			.map(coerceFinding)
			.filter((finding): finding is ReviewFinding => finding !== undefined);
		return {
			findings,
			coverage: coerceCoverage(record.coverage),
			overallCorrectness: typeof record.overall_correctness === "string" ? record.overall_correctness : undefined,
			overallExplanation: typeof record.overall_explanation === "string" ? record.overall_explanation : undefined,
		};
	}
	return undefined;
}

// ============================================================================
// Seeding the fresh session
// ============================================================================

/**
 * Format the review result as the seed message for the fresh post-review session.
 * This text is both displayed and sent to the LLM as context.
 */
export function formatReviewForNewSession(
	resolved: Pick<ResolvedReview, "description" | "diffCommand">,
	parsed: ParsedReview | undefined,
	raw: string,
): string {
	const lines: string[] = [
		`An automated code review of ${resolved.description} was completed in a separate session.`,
		"",
	];

	if (!parsed) {
		lines.push("The reviewer's report (unstructured):", "", raw.trim());
	} else {
		if (parsed.overallCorrectness || parsed.overallExplanation) {
			const verdict = [parsed.overallCorrectness, parsed.overallExplanation].filter(Boolean).join(" — ");
			lines.push(`Overall: ${verdict}`, "");
		}
		if (parsed.coverage) {
			const coverageLines: string[] = [];
			if (parsed.coverage.filesReviewed.length > 0) {
				coverageLines.push(`Files reviewed: ${parsed.coverage.filesReviewed.join(", ")}`);
			}
			if (parsed.coverage.commandsRun.length > 0) {
				coverageLines.push(`Commands run: ${parsed.coverage.commandsRun.join("; ")}`);
			}
			if (parsed.coverage.uncheckedAreas.length > 0) {
				coverageLines.push(`Unchecked areas: ${parsed.coverage.uncheckedAreas.join("; ")}`);
			}
			if (coverageLines.length > 0) {
				lines.push("Coverage:", ...coverageLines.map((line) => `- ${line}`), "");
			}
		}
		if (parsed.findings.length === 0) {
			lines.push("The review found no issues worth flagging.");
		} else {
			lines.push("Findings:", "");
			parsed.findings.forEach((finding, index) => {
				const meta: string[] = [];
				if (finding.priority !== undefined) {
					meta.push(`P${finding.priority}`);
				}
				if (finding.confidence !== undefined) {
					meta.push(`confidence ${Math.round(finding.confidence * 100)}%`);
				}
				const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
				const metaText = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
				lines.push(`### ${index + 1}. ${finding.title}${metaText}${location}`, "");
				if (finding.body) {
					lines.push(finding.body, "");
				}
			});
		}
	}

	lines.push(
		"",
		`Reproduce the reviewed diff with \`${resolved.diffCommand}\`.`,
		'The user may refer to findings by number (e.g. "fix 1 and 3"). When asked to fix findings, read the relevant code first and apply minimal, correct fixes.',
	);
	return lines.join("\n");
}

// ============================================================================
// Running the review
// ============================================================================

/** Minimal resource loader for the isolated review session: no extensions, skills, prompts, or themes. */
export function createReviewResourceLoader(cwd: string, agentDir: string): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const agentsFiles = loadProjectContextFiles({ cwd, agentDir });
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
		getSystemPrompt: () => REVIEW_SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export interface RunReviewOptions {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	resolved: ResolvedReview;
	/** Aborts the review session when triggered. */
	signal?: AbortSignal;
	/** Called with short progress updates (tool activity) while the review runs. */
	onProgress?: (message: string) => void;
}

export interface ReviewRunResult {
	aborted: boolean;
	/** Full text of the reviewer's final message. */
	raw: string;
	parsed?: ParsedReview;
	errorMessage?: string;
}

function summarizeToolArgs(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	for (const value of Object.values(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) {
			const oneLine = value.replace(/\s+/g, " ").trim();
			return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
		}
	}
	return undefined;
}

/**
 * Run a review in an isolated in-process agent session.
 * The session is in-memory (not persisted) and disposed when done.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewRunResult> {
	const resourceLoader = createReviewResourceLoader(options.cwd, options.agentDir);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settingsManager: options.settingsManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		sessionManager: SessionManager.inMemory(options.cwd),
		resourceLoader,
	});

	// An abort during session creation fires before the listener below is
	// attached, and AbortSignal does not invoke listeners added after the fact.
	if (options.signal?.aborted) {
		session.dispose();
		return { aborted: true, raw: "" };
	}

	const onAbort = () => {
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			const summary = summarizeToolArgs(event.args);
			options.onProgress?.(summary ? `${event.toolName}: ${summary}` : event.toolName);
		}
	});

	try {
		await session.prompt(buildReviewPrompt(options.resolved), { expandPromptTemplates: false });

		if (options.signal?.aborted) {
			return { aborted: true, raw: "" };
		}

		const lastAssistant = [...session.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (lastAssistant?.stopReason === "aborted") {
			return { aborted: true, raw: "" };
		}
		if (lastAssistant?.stopReason === "error") {
			return { aborted: false, raw: "", errorMessage: lastAssistant.errorMessage ?? "Review failed" };
		}

		const raw = session.getLastAssistantText() ?? "";
		if (!raw.trim()) {
			return { aborted: false, raw: "", errorMessage: "Review produced no output" };
		}
		return { aborted: false, raw, parsed: parseReviewOutput(raw) };
	} catch (error) {
		if (options.signal?.aborted) {
			return { aborted: true, raw: "" };
		}
		return {
			aborted: false,
			raw: "",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	} finally {
		unsubscribe();
		options.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
