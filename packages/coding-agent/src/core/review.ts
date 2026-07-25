/**
 * Built-in /review support.
 *
 * Resolves a review target (uncommitted changes, branch diff, GitHub PR, or a
 * single commit) into a diff, runs an isolated in-process review session over
 * it, and parses the structured findings from the reviewer's final message.
 *
 * The review session is intentionally separate from the user's session: it has
 * its own context window and its own reviewer system prompt. It loads the
 * project's context files (AGENTS.md) and inherits the user's configured
 * extension tools, but excludes user extensions, skills, prompt templates,
 * themes, and subagents, and does not start MCP servers. After the review
 * completes the caller starts a fresh session seeded only with the findings.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, Model } from "@hansjm10/volt-ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { AuthStorage } from "./auth-storage.ts";
import { createExtensionRuntime } from "./extensions/loader.ts";
import type { ReplacedSessionContext, ToolDefinition } from "./extensions/types.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
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
	"Usage: /review [tools | uncommitted | branch [base] | pr [number] | commit [sha]] (no arguments opens a selector)";

export const REMOTE_REVIEW_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/**
 * Parse the argument text after "/review".
 * Returns an empty object when no arguments were given (caller shows a selector).
 */
export function parseReviewCommandArgs(argsText: string): {
	target?: ReviewTarget;
	configureTools?: boolean;
	error?: string;
} {
	const tokens = argsText.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return {};
	}

	const keyword = tokens[0].toLowerCase();
	// Reject trailing tokens beyond the keyword's expected arity so mistakes like
	// `/review pr 42 foo` fail loudly instead of silently dropping the extra args.
	const tooManyArgs = (max: number): { error: string } | undefined =>
		tokens.length > max ? { error: `Unexpected arguments after "${tokens[0]}". ${REVIEW_USAGE}` } : undefined;
	switch (keyword) {
		case "tools":
			return tooManyArgs(1) ?? { configureTools: true };
		case "uncommitted":
		case "unstaged":
		case "working":
			return tooManyArgs(1) ?? { target: { kind: "uncommitted" } };
		case "branch":
			return tooManyArgs(2) ?? { target: { kind: "branch", base: tokens[1] } };
		case "pr":
			return tooManyArgs(2) ?? { target: { kind: "pr", number: tokens[1] } };
		case "commit":
			// Without a SHA the caller shows a commit picker.
			return tooManyArgs(2) ?? { target: { kind: "commit", sha: tokens[1] } };
		default:
			return { error: `Unknown review target "${tokens[0]}". ${REVIEW_USAGE}` };
	}
}

// ============================================================================
// Target resolution (git / gh)
// ============================================================================

/** A review target resolved to a concrete diff plus reviewer-facing metadata. */
interface ReviewResolutionError {
	error: string;
	/** Stable replacement for subprocess diagnostics returned to remote clients. */
	remoteError?: string;
}

export interface ResolvedReview {
	/** Human-readable description, e.g. `branch changes vs main`. */
	description: string;
	/** Bounded description safe for detached workflow events and retained RPC results. */
	workflowDescription?: string;
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
/** Maximum UTF-8 bytes accepted for a commit revision expression. */
export const MAX_REVIEW_COMMIT_REF_BYTES = 1024;
/** GitHub's GraphQL `Int` ceiling for pull request numbers. */
export const MAX_GITHUB_PR_NUMBER = 2_147_483_647;

const MAX_GITHUB_PR_NUMBER_TEXT = String(MAX_GITHUB_PR_NUMBER);
const CANONICAL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function normalizeReviewPullRequestNumber(value: string | undefined): { number?: string } | { error: string } {
	const number = value?.trim();
	if (!number) {
		return {};
	}
	const exceedsMaximum =
		number.length > MAX_GITHUB_PR_NUMBER_TEXT.length ||
		(number.length === MAX_GITHUB_PR_NUMBER_TEXT.length && number > MAX_GITHUB_PR_NUMBER_TEXT);
	if (exceedsMaximum || !/^[1-9]\d*$/.test(number)) {
		return {
			error: `PR number must be a canonical positive decimal no greater than ${MAX_GITHUB_PR_NUMBER}.`,
		};
	}
	return { number };
}

interface PullRequestInfo {
	number: number;
	title: string;
	body: string;
	baseRefName: string;
	headRefName: string;
	url: string;
}

function parsePullRequestInfo(stdout: string): PullRequestInfo | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.number !== "number" ||
		!Number.isInteger(record.number) ||
		record.number < 1 ||
		record.number > MAX_GITHUB_PR_NUMBER ||
		typeof record.title !== "string" ||
		typeof record.body !== "string" ||
		typeof record.baseRefName !== "string" ||
		typeof record.headRefName !== "string" ||
		typeof record.url !== "string"
	) {
		return undefined;
	}
	return {
		number: record.number,
		title: record.title,
		body: record.body,
		baseRefName: record.baseRefName,
		headRefName: record.headRefName,
		url: record.url,
	};
}

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: env ? { ...process.env, ...env } : process.env,
		});
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

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

export function truncateDiff(diff: string): { diff: string; truncated: boolean } {
	if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
		return { diff, truncated: false };
	}
	let end = MAX_REVIEW_DIFF_CHARS;
	// Prefer cutting on a line boundary so the preview ends with whole diff lines
	// rather than a partial hunk. For a single line longer than the limit there is
	// no boundary, so fall back to a raw cut that does not split a surrogate pair.
	const lastNewline = diff.lastIndexOf("\n", end - 1);
	if (lastNewline >= 0) {
		end = lastNewline + 1;
	} else if (isHighSurrogate(diff.charCodeAt(end - 1))) {
		end -= 1;
	}
	return { diff: diff.slice(0, end), truncated: true };
}

async function detectBaseBranch(cwd: string): Promise<string | undefined> {
	const originHead = await runCommand("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (originHead.ok) {
		const ref = originHead.stdout.trim();
		if (ref) {
			// Keep the remote-tracking ref (e.g. "origin/main") rather than stripping
			// to "main": it always resolves and reflects the fetched upstream instead
			// of a possibly stale or missing local branch (single-branch/shallow checkouts).
			return ref;
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
 * Resolve a base ref to something that exists. Returns the ref itself when it
 * resolves, otherwise the matching remote-tracking ref (`origin/<base>`) when
 * only that exists (e.g. a checkout that has no local copy of the base branch).
 */
async function resolveBaseRef(base: string, cwd: string): Promise<string | undefined> {
	const direct = await runCommand("git", ["rev-parse", "--verify", "--quiet", base], cwd);
	if (direct.ok) {
		return base;
	}
	if (!base.startsWith("origin/")) {
		const remote = `origin/${base}`;
		const remoteExists = await runCommand("git", ["rev-parse", "--verify", "--quiet", remote], cwd);
		if (remoteExists.ok) {
			return remote;
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
): Promise<ResolvedReview | ReviewResolutionError> {
	const inRepo = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (!inRepo.ok) {
		return { error: "Not inside a git repository." };
	}

	switch (target.kind) {
		case "uncommitted": {
			let diffResult = await runCommand("git", ["diff", "--no-textconv", "--no-ext-diff", "HEAD"], cwd);
			let diffCommand = "git diff --no-textconv --no-ext-diff HEAD";
			if (!diffResult.ok) {
				// No commits yet: combine the staged diff (index vs the empty tree)
				// with the worktree diff so staged changes are not missed.
				const stagedResult = await runCommand("git", ["diff", "--no-textconv", "--no-ext-diff", "--cached"], cwd);
				const worktreeResult = await runCommand("git", ["diff", "--no-textconv", "--no-ext-diff"], cwd);
				if (!stagedResult.ok || !worktreeResult.ok) {
					const failed = stagedResult.ok ? worktreeResult : stagedResult;
					return {
						error: `git diff failed: ${failed.stderr.trim()}`,
						remoteError: "Could not load the uncommitted changes diff.",
					};
				}
				diffResult = { ok: true, stdout: stagedResult.stdout + worktreeResult.stdout, stderr: "" };
				diffCommand = "git diff --no-textconv --no-ext-diff --cached; git diff --no-textconv --no-ext-diff";
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
			const requestedBase = target.base ?? (await detectBaseBranch(cwd));
			if (!requestedBase) {
				return { error: "Could not detect a base branch. Use /review branch <base>." };
			}
			const base = await resolveBaseRef(requestedBase, cwd);
			if (!base) {
				return { error: `Base branch "${requestedBase}" not found.` };
			}
			const diffResult = await runCommand("git", ["diff", "--no-textconv", "--no-ext-diff", `${base}...HEAD`], cwd);
			if (!diffResult.ok) {
				return {
					error: `git diff failed: ${diffResult.stderr.trim()}`,
					remoteError: "Could not load the branch diff.",
				};
			}
			if (!diffResult.stdout.trim()) {
				return { error: `No changes between ${base} and HEAD.` };
			}
			const logResult = await runCommand("git", ["log", "--oneline", `${base}..HEAD`], cwd);
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: `branch changes vs ${base}`,
				diffCommand: `git diff --no-textconv --no-ext-diff ${base}...HEAD`,
				diff,
				truncated,
				extraContext: logResult.ok && logResult.stdout.trim() ? `Commits:\n${logResult.stdout.trim()}` : undefined,
			};
		}
		case "pr": {
			const normalizedNumber = normalizeReviewPullRequestNumber(target.number);
			if ("error" in normalizedNumber) {
				return normalizedNumber;
			}
			const numberArgs = normalizedNumber.number ? [normalizedNumber.number] : [];
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
				return {
					error: `gh pr view failed: ${stderr}`,
					remoteError: "Could not load pull request metadata with GitHub CLI.",
				};
			}
			const prInfo = parsePullRequestInfo(viewResult.stdout);
			if (!prInfo) {
				return { error: "Could not parse gh pr view output." };
			}
			const diffResult = await runCommand("gh", ["pr", "diff", String(prInfo.number)], cwd);
			if (!diffResult.ok) {
				return {
					error: `gh pr diff failed: ${diffResult.stderr.trim()}`,
					remoteError: "Could not load the pull request diff with GitHub CLI.",
				};
			}
			if (!diffResult.stdout.trim()) {
				return { error: `PR #${prInfo.number} has an empty diff.` };
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			const bodyText = prInfo.body.trim();
			return {
				description: `PR #${prInfo.number} (${prInfo.title})`,
				workflowDescription: `PR #${prInfo.number}`,
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
			const ref = target.sha?.trim();
			if (!ref) {
				return { error: "Missing commit ref." };
			}
			if (Buffer.byteLength(ref, "utf8") > MAX_REVIEW_COMMIT_REF_BYTES) {
				return { error: `Commit ref exceeds ${MAX_REVIEW_COMMIT_REF_BYTES} UTF-8 bytes.` };
			}
			const resolveResult = await runCommand(
				"git",
				["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
				cwd,
			);
			if (!resolveResult.ok) {
				return { error: "Commit ref was not found or does not resolve to a commit." };
			}
			const commit = resolveResult.stdout.trim();
			if (!CANONICAL_GIT_OBJECT_ID_PATTERN.test(commit)) {
				return { error: "Git returned an invalid canonical commit id." };
			}
			// --diff-merges=first-parent: plain `git show` prints no patch hunks
			// for merge commits; diff against the first parent shows what the
			// merge brought into the branch. Non-merge commits are unaffected.
			const diffResult = await runCommand(
				"git",
				[
					"show",
					"--stat",
					"--patch",
					"--diff-merges=first-parent",
					"--no-textconv",
					"--no-ext-diff",
					"--end-of-options",
					commit,
				],
				cwd,
			);
			if (!diffResult.ok) {
				return {
					error: `git show failed: ${diffResult.stderr.trim()}`,
					remoteError: "Could not load the commit diff.",
				};
			}
			const { diff, truncated } = truncateDiff(diffResult.stdout);
			return {
				description: `commit ${commit}`,
				workflowDescription: `commit ${commit}`,
				diffCommand: `git show --stat --patch --diff-merges=first-parent --no-textconv --no-ext-diff ${commit}`,
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

/**
 * Order base-branch candidates for the picker. Canonical bases come first
 * (local main/master, then their origin/ equivalents), then other local
 * branches, then other remote-tracking branches; each tier is sorted
 * alphabetically. Local vs remote is known from the source lists, so branch
 * names containing slashes (e.g. `feature/login`) are classified correctly.
 */
function orderBaseBranches(local: string[], remote: string[]): string[] {
	const scored: Array<{ ref: string; tier: number }> = [];
	const seen = new Set<string>();
	const add = (ref: string, tier: number): void => {
		if (!ref || seen.has(ref)) {
			return;
		}
		seen.add(ref);
		scored.push({ ref, tier });
	};
	for (const ref of local) {
		add(ref, ref === "main" ? 0 : ref === "master" ? 1 : 4);
	}
	for (const ref of remote) {
		add(ref, ref === "origin/main" ? 2 : ref === "origin/master" ? 3 : 5);
	}
	return scored
		.sort((a, b) => (a.tier === b.tier ? a.ref.localeCompare(b.ref) : a.tier - b.tier))
		.map((entry) => entry.ref);
}

function splitBranchLines(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * List candidate base branches for the /review base-branch picker: local
 * branches plus remote-tracking branches (e.g. `origin/main`). The `origin/HEAD`
 * alias (which `%(refname:short)` renders as the bare remote name) is skipped.
 */
export async function listBaseBranches(cwd: string): Promise<string[] | { error: string }> {
	const localResult = await runCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
	if (!localResult.ok) {
		return { error: `git branch failed: ${localResult.stderr.trim()}` };
	}
	const local = splitBranchLines(localResult.stdout);
	const remoteResult = await runCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], cwd);
	const remote = remoteResult.ok
		? splitBranchLines(remoteResult.stdout).filter((ref) => ref.includes("/") && !ref.endsWith("/HEAD"))
		: [];
	return orderBaseBranches(local, remote);
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

const NAMED_XML_ENTITIES: Record<string, string> = {
	quot: '"',
	apos: "'",
	lt: "<",
	gt: ">",
	amp: "&",
};

// Matches the five named entities plus decimal (&#38;) and hex (&#x26;/&#X26;)
// character references. A single global pass decodes each reference exactly once
// left-to-right, so `&amp;lt;` yields `&lt;` (no double-decode).
const XML_ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(quot|apos|lt|gt|amp));/g;

function decodeXmlEntities(value: string): string {
	return value.replace(
		XML_ENTITY_PATTERN,
		(match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
			if (named !== undefined) {
				return NAMED_XML_ENTITIES[named] ?? match;
			}
			const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
			// Leave invalid, out-of-range, or surrogate code points as-is rather than
			// producing replacement or lone-surrogate characters that could break JSON.
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
				return match;
			}
			return String.fromCodePoint(code);
		},
	);
}

/** Unwrap CDATA sections; the enclosed text is literal and needs no entity decoding. */
function unwrapCdata(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
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
		candidates.push({ index: match.index, text: unwrapCdata(match[1] ?? "").trim() });
		match = payloadRegex.exec(text);
	}
	return candidates;
}

/** Parse one JSON candidate into a ParsedReview, or undefined if it lacks a findings array. */
function tryParseFindingsObject(candidate: string): ParsedReview | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (!Array.isArray(record.findings)) {
		return undefined;
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

/**
 * Parse a JSON candidate, retrying with XML entities decoded only when the raw
 * text does not parse. Trying raw first avoids corrupting payloads whose string
 * values legitimately contain entity-like text (e.g. a finding that mentions
 * `&amp;` or `&quot;`), while still recovering payloads that a model XML-escaped
 * to keep them valid inside the <payload> tag.
 */
function parseFindingsCandidate(candidate: string): ParsedReview | undefined {
	const parsed = tryParseFindingsObject(candidate);
	if (parsed) {
		return parsed;
	}
	const decoded = decodeXmlEntities(candidate);
	return decoded === candidate ? undefined : tryParseFindingsObject(decoded);
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
		const parsed = parseFindingsCandidate(candidate);
		if (parsed) {
			return parsed;
		}
	}
	return undefined;
}

// ============================================================================
// Seeding the fresh session
// ============================================================================

/**
 * Strip the machine-readable `<response>…</response>` envelope (summary + JSON
 * payload) from reviewer assistant text so a live in-process render shows the
 * reviewer's prose and tool activity instead of raw markup. Also drops a
 * trailing unterminated `<response>` so a mid-stream partial envelope never
 * flashes. The formatted findings are surfaced separately after the handoff.
 */
export function stripReviewEnvelopeForDisplay(text: string): string {
	return text
		.replace(/<response\b[\s\S]*?<\/response>/gi, "")
		.replace(/<response\b[\s\S]*$/i, "")
		.trim();
}

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

	// Collapse any trailing blank lines (the findings loop appends one after each
	// entry) so the footer is always separated by exactly one blank line.
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
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

/**
 * Minimal resource loader for the isolated review session: it loads the
 * project's context files (AGENTS.md) but provides no user extensions, skills,
 * prompt templates, themes, or subagents. Configured extension *tools* are
 * inherited separately (see collectParentExtensionTools) and passed as
 * customTools in runReviewSession.
 */
export function createReviewResourceLoader(cwd: string, agentDir: string): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const agentsFiles = loadProjectContextFiles({ cwd, agentDir });
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getSubagents: () => ({ definitions: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
		getSystemPrompt: () => REVIEW_SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function collectParentExtensionTools(parentResourceLoader: ResourceLoader | undefined): ToolDefinition[] {
	const parentExtensions = parentResourceLoader?.getExtensions();
	if (!parentExtensions) {
		return [];
	}

	const toolsByName = new Map<string, ToolDefinition>();
	for (const extension of parentExtensions.extensions) {
		for (const tool of extension.tools.values()) {
			if (!toolsByName.has(tool.definition.name)) {
				toolsByName.set(tool.definition.name, tool.definition);
			}
		}
	}
	return Array.from(toolsByName.values());
}

export interface RunReviewOptions {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled?: boolean;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	resolved: ResolvedReview;
	/** Parent session resource loader used to inherit configured extension tools. */
	parentResourceLoader?: ResourceLoader;
	/** Optional review tool allowlist. Omit to use normal review defaults. */
	tools?: string[];
	/**
	 * Skip the working-tree snapshot/restore guard. Only safe when the review
	 * session cannot modify the tree; see ExecuteReviewWorkflowOptions.
	 */
	skipWorkingTreeGuard?: boolean;
	/** Aborts the review session when triggered. */
	signal?: AbortSignal;
	/** Called with short progress updates (tool activity) while the review runs. */
	onProgress?: (message: string) => void;
	/** Emits sanitized review tool lifecycle events while the review runs. */
	onEvent?: (event: ReviewWorkflowToolEvent) => void;
	/**
	 * Full in-process review-session event stream, for rich local rendering.
	 * In-process (TUI) only; never forwarded over RPC, where only the sanitized
	 * `onEvent` stream is exposed.
	 */
	onSessionEvent?: (event: AgentSessionEvent) => void;
	workflowId?: string;
	workflowAction?: string;
}

export interface ReviewRunResult {
	aborted: boolean;
	/** Full text of the reviewer's final message. */
	raw: string;
	parsed?: ParsedReview;
	errorMessage?: string;
}

export interface ReviewWorkflowSession {
	/** Falls back to isStreaming for legacy workflow integrations. */
	isBusy?: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled?: boolean;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	sendCustomMessage<T = unknown>(
		message: Pick<ReviewCustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
}

interface ReviewCustomMessage<T> {
	customType: string;
	content: string;
	display: boolean;
	details: T;
}

export type ReviewWorkflowEvent =
	| {
			type: "workflow_start";
			workflowId: string;
			kind: "review";
			action: string;
			title: string;
			message: string;
			status: "running";
	  }
	| {
			type: "workflow_update";
			workflowId: string;
			kind: "review";
			action: string;
			title: string;
			message: string;
			status: "running" | "finalizing";
	  }
	| {
			type: "workflow_end";
			workflowId: string;
			kind: "review";
			action: string;
			title: string;
			message: string;
			status: "completed" | "cancelled" | "failed";
	  };

export type ReviewWorkflowToolEvent =
	| {
			type: "tool_execution_start";
			workflowId: string;
			workflowKind: "review";
			workflowAction: string;
			toolCallId: string;
			toolName: string;
			args?: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_end";
			workflowId: string;
			workflowKind: "review";
			workflowAction: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
	  };

export interface ReviewWorkflowHooks {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onEvent?: (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent) => void;
	/** Full in-process review-session event stream, for rich local rendering. */
	onSessionEvent?: (event: AgentSessionEvent) => void;
	cleanup?: () => void;
}

export interface ReviewWorkflowOptions {
	target: ReviewTarget;
	cwd: string;
	agentDir: string;
	session: ReviewWorkflowSession;
	newSession: AgentSessionRuntime["newSession"];
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	tools?: readonly string[];
	requireProjectTrust?: boolean;
	requireConfirmation?: boolean;
	confirm?: (request: { title: string; message: string; resolution: ResolvedReview }) => Promise<boolean>;
	onBeforeReview?: (
		resolution: ResolvedReview,
		model: Model<any>,
	) => Promise<ReviewWorkflowHooks> | ReviewWorkflowHooks;
	onReviewModelWarning?: (message: string) => void;
	/** Emits sanitized review workflow and tool-usage events for UI surfaces. */
	onEvent?: (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent) => void;
}

export type ReviewWorkflowResult =
	| { status: "accepted"; workflowId: string; message?: string }
	| { status: "cancelled"; resolution?: ResolvedReview }
	| {
			status: "completed";
			resolution: ResolvedReview;
			findingsCount?: number;
			sessionSwitchCancelled: boolean;
	  };

export function createReviewConfirmationMessage(resolution: ResolvedReview): string {
	return [
		`Review ${resolution.description}?`,
		"",
		"Volt will inspect the selected git diff, may read related project files with host-approved read-only tools, consume model tokens, and create a fresh session seeded with the findings.",
		`Diff command: ${resolution.diffCommand}`,
	].join("\n");
}

export function resolveReviewModel(options: {
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	currentModel?: Model<any>;
}): { model?: Model<any>; warning?: string } {
	const reference = options.settingsManager.getReviewModel();
	if (reference) {
		options.modelRegistry.refresh();
		const available = options.modelRegistry.getAvailable();
		const match = findExactModelReferenceMatch(reference, available);
		if (match) {
			return { model: match };
		}
		return {
			model: options.currentModel,
			warning: `reviewModel "${reference}" not found or not authenticated; using the current model.`,
		};
	}
	return { model: options.currentModel };
}

export function reviewActionIdForTarget(target: ReviewTarget): string {
	switch (target.kind) {
		case "uncommitted":
			return "review.uncommitted";
		case "branch":
			return "review.branch";
		case "pr":
			return "review.pr";
		case "commit":
			return "review.commit";
	}
}

function createReviewWorkflowId(): string {
	return `review:${randomUUID()}`;
}

export interface PrepareReviewWorkflowOptions {
	target: ReviewTarget;
	cwd: string;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	currentModel?: Model<any>;
	requireProjectTrust?: boolean;
	/** Replace subprocess diagnostics with stable messages before returning them remotely. */
	sanitizeRemoteErrors?: boolean;
}

/** A review workflow that passed preflight and is ready to execute. */
export interface PreparedReviewWorkflow {
	workflowId: string;
	/** Review host-action id, e.g. `review.branch`. */
	action: string;
	target: ReviewTarget;
	resolution: ResolvedReview;
	model: Model<any>;
	modelWarning?: string;
}

/**
 * Fast review preflight: verifies project trust, resolves the target into a
 * concrete diff, and picks the review model. Throws user-facing errors and
 * performs no model calls, so callers can run it inline before detaching the
 * actual review execution.
 */
export async function prepareReviewWorkflow(options: PrepareReviewWorkflowOptions): Promise<PreparedReviewWorkflow> {
	if (options.requireProjectTrust && !options.settingsManager.isProjectTrusted()) {
		throw new Error("Project trust is required before running a remote review.");
	}
	const resolution = await resolveReviewTarget(options.target, options.cwd);
	if ("error" in resolution) {
		throw new Error(
			options.sanitizeRemoteErrors && resolution.remoteError ? resolution.remoteError : resolution.error,
		);
	}
	const reviewModel = resolveReviewModel({
		settingsManager: options.settingsManager,
		modelRegistry: options.modelRegistry,
		currentModel: options.currentModel,
	});
	if (!reviewModel.model) {
		throw new Error("No model available for review. Use /model to select one.");
	}
	return {
		workflowId: createReviewWorkflowId(),
		action: reviewActionIdForTarget(options.target),
		target: options.target,
		resolution,
		model: reviewModel.model,
		modelWarning: reviewModel.warning,
	};
}

export interface ExecuteReviewWorkflowOptions {
	prepared: PreparedReviewWorkflow;
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled?: boolean;
	/** Parent session resource loader used to inherit configured extension tools. */
	parentResourceLoader?: ResourceLoader;
	/** Optional review tool allowlist. Omit to use normal review defaults. */
	tools?: readonly string[];
	/**
	 * Skip the working-tree snapshot/restore guard. Only safe when the review
	 * session cannot modify the tree (read-only tool allowlist and no inherited
	 * extension tools); a guard restore would otherwise revert edits made by
	 * concurrent agent or user work while the detached review ran.
	 */
	skipWorkingTreeGuard?: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	/** Receives workflow_start, workflow_update, and sanitized tool events. */
	onEvent?: (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent) => void;
	/** Full in-process review-session event stream, for rich local rendering. */
	onSessionEvent?: (event: AgentSessionEvent) => void;
}

export type ExecuteReviewWorkflowResult =
	| { status: "cancelled" }
	| { status: "failed"; errorMessage: string }
	| { status: "completed"; raw: string; parsed?: ParsedReview; findingsCount?: number };

/**
 * Run a prepared review to a terminal result. Emits workflow_start, sanitized
 * tool events, and the finalizing workflow_update; the caller owns the
 * terminal workflow_end event so it can describe how findings are delivered.
 * Review failures surface as a "failed" result rather than a throw.
 */
export async function executeReviewWorkflow(
	options: ExecuteReviewWorkflowOptions,
): Promise<ExecuteReviewWorkflowResult> {
	const { prepared } = options;
	options.onEvent?.({
		type: "workflow_start",
		workflowId: prepared.workflowId,
		kind: "review",
		action: prepared.action,
		title: "Review",
		message: `Reviewing ${prepared.resolution.workflowDescription ?? prepared.resolution.description}.`,
		status: "running",
	});
	let result: ReviewRunResult;
	try {
		result = await runReview({
			cwd: options.cwd,
			agentDir: options.agentDir,
			model: prepared.model,
			thinkingLevel: options.thinkingLevel,
			fastModeEnabled: options.fastModeEnabled,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			settingsManager: options.settingsManager,
			resolved: prepared.resolution,
			parentResourceLoader: options.parentResourceLoader,
			tools: options.tools ? [...options.tools] : undefined,
			skipWorkingTreeGuard: options.skipWorkingTreeGuard,
			signal: options.signal,
			onProgress: options.onProgress,
			onSessionEvent: options.onSessionEvent,
			onEvent: options.onEvent,
			workflowId: prepared.workflowId,
			workflowAction: prepared.action,
		});
	} catch (error) {
		return { status: "failed", errorMessage: error instanceof Error ? error.message : String(error) };
	}
	if (result.aborted || options.signal?.aborted) {
		return { status: "cancelled" };
	}
	if (result.errorMessage) {
		return { status: "failed", errorMessage: result.errorMessage };
	}
	options.onEvent?.({
		type: "workflow_update",
		workflowId: prepared.workflowId,
		kind: "review",
		action: prepared.action,
		title: "Review",
		message: "Finalizing findings.",
		status: "finalizing",
	});
	return {
		status: "completed",
		raw: result.raw,
		parsed: result.parsed,
		findingsCount: result.parsed?.findings.length,
	};
}

export async function runReviewWorkflow(options: ReviewWorkflowOptions): Promise<ReviewWorkflowResult> {
	assertReviewCanStart(options.session);
	const prepared = await prepareReviewWorkflow({
		target: options.target,
		cwd: options.cwd,
		settingsManager: options.settingsManager,
		modelRegistry: options.session.modelRegistry,
		currentModel: options.session.model,
		requireProjectTrust: options.requireProjectTrust,
	});
	const { resolution, model, workflowId, action: workflowAction } = prepared;

	if (options.requireConfirmation) {
		const confirmed = await options.confirm?.({
			title: "Review changes",
			message: createReviewConfirmationMessage(resolution),
			resolution,
		});
		if (!confirmed) {
			return { status: "cancelled", resolution };
		}
	}
	if (prepared.modelWarning) {
		options.onReviewModelWarning?.(prepared.modelWarning);
	}

	assertReviewCanStart(options.session);
	const hooks = await options.onBeforeReview?.(resolution, model);
	const emitEvent = (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent): void => {
		options.onEvent?.(event);
		hooks?.onEvent?.(event);
	};

	let terminalWorkflowEmitted = false;
	const emitTerminalWorkflowEvent = (event: Extract<ReviewWorkflowEvent, { type: "workflow_end" }>): void => {
		terminalWorkflowEmitted = true;
		emitEvent(event);
	};

	try {
		const fastModeEnabled = options.session.fastModeEnabled === true;
		let result: ExecuteReviewWorkflowResult;
		try {
			result = await executeReviewWorkflow({
				prepared,
				cwd: options.cwd,
				agentDir: options.agentDir,
				authStorage: options.authStorage,
				modelRegistry: options.session.modelRegistry,
				settingsManager: options.settingsManager,
				thinkingLevel: options.session.thinkingLevel,
				fastModeEnabled,
				parentResourceLoader: options.session.resourceLoader,
				tools: options.tools,
				signal: hooks?.signal,
				onProgress: hooks?.onProgress,
				onSessionEvent: hooks?.onSessionEvent,
				onEvent: emitEvent,
			});
		} finally {
			hooks?.cleanup?.();
		}

		if (result.status === "cancelled") {
			emitTerminalWorkflowEvent({
				type: "workflow_end",
				workflowId,
				kind: "review",
				action: workflowAction,
				title: "Review",
				message: "Review cancelled.",
				status: "cancelled",
			});
			return { status: "cancelled", resolution };
		}
		if (result.status === "failed") {
			emitTerminalWorkflowEvent({
				type: "workflow_end",
				workflowId,
				kind: "review",
				action: workflowAction,
				title: "Review",
				message: `Review failed: ${result.errorMessage}`,
				status: "failed",
			});
			throw new Error(`Review failed: ${result.errorMessage}`);
		}

		const reviewMessage = createReviewSeedMessage(resolution, result);
		const newSessionResult = await options.newSession({
			setup: async (sessionManager) => {
				if (fastModeEnabled) {
					sessionManager.appendFastModeChange(true);
				}
			},
			withSession: async (ctx: ReplacedSessionContext) => {
				await ctx.sendMessage(reviewMessage);
			},
		});
		if (newSessionResult.cancelled) {
			await options.session.sendCustomMessage(reviewMessage);
		} else if (!newSessionResult.seeded) {
			// The replacement session was applied, but the recovered-client-input
			// gate skipped the seed callback: the findings were never delivered
			// anywhere. Fail loudly instead of reporting a seeded review session.
			throw new Error(
				"Review completed, but seeding the findings was skipped: recovered client input failed to replay in the replacement session.",
			);
		}
		const completedResult = {
			status: "completed" as const,
			resolution,
			findingsCount: result.parsed?.findings.length,
			sessionSwitchCancelled: newSessionResult.cancelled,
		};
		emitTerminalWorkflowEvent({
			type: "workflow_end",
			workflowId,
			kind: "review",
			action: workflowAction,
			title: "Review",
			message: newSessionResult.cancelled
				? `${formatReviewWorkflowSummary(completedResult)} Findings were added to the current session.`
				: `${formatReviewWorkflowSummary(completedResult)} Opening review session.`,
			status: "completed",
		});
		return completedResult;
	} catch (error) {
		if (!terminalWorkflowEmitted) {
			emitTerminalWorkflowEvent({
				type: "workflow_end",
				workflowId,
				kind: "review",
				action: workflowAction,
				title: "Review",
				message: "Review failed.",
				status: "failed",
			});
		}
		throw error;
	}
}

export function formatReviewWorkflowSummary(result: { findingsCount?: number }): string {
	const findingCount = result.findingsCount;
	if (findingCount === undefined) {
		return "Review complete.";
	}
	if (findingCount === 0) {
		return "Review complete: no issues found.";
	}
	return `Review complete: ${findingCount} finding${findingCount === 1 ? "" : "s"}.`;
}

function assertReviewCanStart(session: Pick<ReviewWorkflowSession, "isBusy" | "isStreaming" | "isCompacting">): void {
	if ((session.isBusy ?? session.isStreaming) || session.isCompacting) {
		throw new Error("Wait for the current response to finish before starting a review.");
	}
}

export function createReviewSeedMessage(
	resolution: Pick<ResolvedReview, "description" | "diffCommand">,
	result: Pick<ReviewRunResult, "raw" | "parsed">,
) {
	return {
		customType: "review",
		content: formatReviewForNewSession(resolution, result.parsed, result.raw),
		display: true,
		details: { target: resolution.description, findings: result.parsed?.findings ?? [] },
	};
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

const REVIEW_WORKFLOW_ARG_STRING_LIMIT = 240;

function createReviewWorkflowToolCallId(workflowId: string | undefined, toolCallId: unknown): string {
	const id = typeof toolCallId === "string" && toolCallId.trim() ? toolCallId.trim() : "unknown";
	return workflowId ? `${workflowId}:${id}` : id;
}

function sanitizeReviewWorkflowToolArgs(
	toolName: string | undefined,
	args: unknown,
	includeStrings: boolean,
): Record<string, unknown> | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	const normalizedToolName = toolName?.trim().toLowerCase();
	const keysByTool: Record<string, string[]> = {
		read: ["path", "file_path", "offset", "limit"],
		grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
		find: ["pattern", "query", "path", "limit"],
		ls: ["path", "limit"],
		bash: ["command"],
		lsp: ["action", "symbol", "line", "path"],
	};
	const allowedKeys = keysByTool[normalizedToolName ?? ""] ?? [
		"action",
		"command",
		"file_path",
		"glob",
		"line",
		"path",
		"pattern",
		"query",
		"symbol",
	];
	const sanitized: Record<string, unknown> = {};
	for (const key of allowedKeys) {
		if (!Object.hasOwn(record, key)) {
			continue;
		}
		const value = sanitizeReviewWorkflowArgValue(record[key], includeStrings);
		if (value !== undefined) {
			sanitized[key] = value;
		}
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeReviewWorkflowArgValue(
	value: unknown,
	includeStrings: boolean,
): string | number | boolean | undefined {
	if (typeof value === "string") {
		if (!includeStrings) {
			return undefined;
		}
		const trimmed = value.replace(/\s+/g, " ").trim();
		if (!trimmed) {
			return undefined;
		}
		return trimmed.length <= REVIEW_WORKFLOW_ARG_STRING_LIMIT
			? trimmed
			: `${trimmed.slice(0, REVIEW_WORKFLOW_ARG_STRING_LIMIT - 1)}…`;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "boolean") {
		return value;
	}
	return undefined;
}

function emitReviewWorkflowToolEvent(
	emit: ((event: ReviewWorkflowToolEvent) => void) | undefined,
	options: Pick<RunReviewOptions, "workflowId" | "workflowAction">,
	event: { type: string; toolCallId?: string; toolName?: string; args?: unknown; isError?: boolean },
): void {
	if (!emit || !options.workflowId || !options.workflowAction || !event.toolName) {
		return;
	}
	if (event.type === "tool_execution_start") {
		emit({
			type: "tool_execution_start",
			workflowId: options.workflowId,
			workflowKind: "review",
			workflowAction: options.workflowAction,
			toolCallId: createReviewWorkflowToolCallId(options.workflowId, event.toolCallId),
			toolName: event.toolName,
			args: sanitizeReviewWorkflowToolArgs(event.toolName, event.args, options.workflowAction !== "review.pr"),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		emit({
			type: "tool_execution_end",
			workflowId: options.workflowId,
			workflowKind: "review",
			workflowAction: options.workflowAction,
			toolCallId: createReviewWorkflowToolCallId(options.workflowId, event.toolCallId),
			toolName: event.toolName,
			isError: event.isError === true,
		});
	}
}

// ============================================================================
// Working-tree guard
// ============================================================================

/**
 * Snapshot/restore guard for the reviewer's working tree.
 *
 * The reviewer runs in the user's real cwd so it can execute the project's
 * tests and reproduce bugs with the real dependencies (node_modules, build
 * caches, ...). To keep that safe, we snapshot the full working state before
 * the review and afterward — including on error or abort — revert anything the
 * reviewer added, modified, or deleted, while preserving the uncommitted
 * changes that were under review.
 *
 * Caveats: files edited by another process during the review may also be
 * reverted, since the guard cannot distinguish those from reviewer edits;
 * git-ignored files (e.g. node_modules, build output) are never touched.
 */
interface WorkingTreeGuard {
	restore(): Promise<void>;
}

export async function createWorkingTreeGuard(cwd: string): Promise<WorkingTreeGuard> {
	const root = await gitRepoRoot(cwd);
	const snapshot = root ? await captureWorkingTree(root) : undefined;
	let restored = false;
	return {
		async restore() {
			if (restored || !root || !snapshot) {
				return;
			}
			restored = true;
			await restoreWorkingTree(root, snapshot);
		},
	};
}

async function gitRepoRoot(cwd: string): Promise<string | undefined> {
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
	return result.ok ? result.stdout.trim() || undefined : undefined;
}

/** Write a tree object capturing every non-ignored file in the working tree. */
async function captureWorkingTree(root: string): Promise<string | undefined> {
	return withTempIndex(async (indexFile) => {
		const env = { GIT_INDEX_FILE: indexFile };
		const add = await runCommand("git", ["add", "-A"], root, env);
		if (!add.ok) {
			return undefined;
		}
		const tree = await runCommand("git", ["write-tree"], root, env);
		return tree.ok ? tree.stdout.trim() || undefined : undefined;
	});
}

/** Revert the working tree back to the snapshot, touching only changed paths. */
async function restoreWorkingTree(root: string, snapshotTree: string): Promise<void> {
	await withTempIndex(async (indexFile) => {
		const env = { GIT_INDEX_FILE: indexFile };
		const add = await runCommand("git", ["add", "-A"], root, env);
		if (!add.ok) {
			return;
		}
		const endTreeResult = await runCommand("git", ["write-tree"], root, env);
		const endTree = endTreeResult.ok ? endTreeResult.stdout.trim() : "";
		if (!endTree || endTree === snapshotTree) {
			return; // The reviewer left the working tree as it found it.
		}
		const diff = await runCommand(
			"git",
			["diff-tree", "-r", "-z", "--no-renames", "--name-status", snapshotTree, endTree],
			root,
		);
		if (!diff.ok) {
			return;
		}
		const { added, changed } = parseNameStatusZ(diff.stdout);
		// Restore modified/deleted paths from the snapshot, then remove additions.
		if (changed.length > 0) {
			await runCommand("git", ["read-tree", snapshotTree], root, env);
			await runCommand("git", ["checkout-index", "-f", "--", ...changed], root, env);
		}
		for (const path of added) {
			await rm(join(root, path), { force: true });
		}
	});
}

/** Split a `-z --name-status` diff-tree stream into added vs modified/deleted paths. */
function parseNameStatusZ(stdout: string): { added: string[]; changed: string[] } {
	const tokens = stdout.split("\0").filter((token) => token.length > 0);
	const added: string[] = [];
	const changed: string[] = [];
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		const status = tokens[i];
		const path = tokens[i + 1];
		if (status.startsWith("A")) {
			added.push(path);
		} else {
			changed.push(path);
		}
	}
	return { added, changed };
}

async function withTempIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "volt-review-index-"));
	const indexFile = join(dir, "index");
	try {
		return await fn(indexFile);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Run a review in an isolated in-process agent session.
 * The session is in-memory (not persisted) and disposed when done.
 *
 * The reviewer executes in the user's real cwd so it can run the project's
 * tests and reproduce bugs with real dependencies. A working-tree guard
 * snapshots the tree first and reverts anything the reviewer adds, modifies,
 * or deletes once the review finishes — including on error or abort.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewRunResult> {
	if (options.skipWorkingTreeGuard) {
		return runReviewSession(options);
	}
	const guard = await createWorkingTreeGuard(options.cwd);
	try {
		return await runReviewSession(options);
	} finally {
		await guard.restore();
	}
}

async function runReviewSession(options: RunReviewOptions): Promise<ReviewRunResult> {
	const inheritedTools = collectParentExtensionTools(options.parentResourceLoader);
	const resourceLoader = createReviewResourceLoader(options.cwd, options.agentDir);
	const sessionManager = SessionManager.inMemory(options.cwd);
	if (options.fastModeEnabled) {
		sessionManager.appendFastModeChange(true);
	}
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settingsManager: options.settingsManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		sessionManager,
		resourceLoader,
		customTools: inheritedTools.length > 0 ? inheritedTools : undefined,
		tools: options.tools,
		// Isolated reviewer: never spin up (or tear down) the user's MCP servers.
		disableMcp: true,
	});

	// An abort during session creation fires before the listener below is
	// attached, and AbortSignal does not invoke listeners added after the fact.
	if (options.signal?.aborted) {
		await session.dispose();
		return { aborted: true, raw: "" };
	}

	const onAbort = () => {
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const unsubscribe = session.subscribe((event) => {
		options.onSessionEvent?.(event);
		if (event.type === "tool_execution_start") {
			const summary = summarizeToolArgs(event.args);
			options.onProgress?.(summary ? `${event.toolName}: ${summary}` : event.toolName);
			emitReviewWorkflowToolEvent(options.onEvent, options, event);
		} else if (event.type === "tool_execution_end") {
			emitReviewWorkflowToolEvent(options.onEvent, options, event);
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
		await session.dispose();
	}
}
