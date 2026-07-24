import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import {
	buildReviewPrompt,
	createWorkingTreeGuard,
	executeReviewWorkflow,
	formatReviewForNewSession,
	listBaseBranches,
	listRecentCommits,
	MAX_GITHUB_PR_NUMBER,
	MAX_REVIEW_COMMIT_REF_BYTES,
	MAX_REVIEW_DIFF_CHARS,
	normalizeReviewPullRequestNumber,
	parseReviewCommandArgs,
	parseReviewOutput,
	type ResolvedReview,
	resolveReviewTarget,
	runReview,
	runReviewWorkflow,
	stripReviewEnvelopeForDisplay,
	truncateDiff,
} from "../../src/core/review.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("parseReviewCommandArgs", () => {
	it("returns no target for empty args (selector flow)", () => {
		expect(parseReviewCommandArgs("")).toEqual({});
		expect(parseReviewCommandArgs("   ")).toEqual({});
	});

	it("parses uncommitted aliases", () => {
		expect(parseReviewCommandArgs("uncommitted").target).toEqual({ kind: "uncommitted" });
		expect(parseReviewCommandArgs("unstaged").target).toEqual({ kind: "uncommitted" });
		expect(parseReviewCommandArgs("working").target).toEqual({ kind: "uncommitted" });
	});

	it("parses branch with and without base", () => {
		expect(parseReviewCommandArgs("branch").target).toEqual({ kind: "branch", base: undefined });
		expect(parseReviewCommandArgs("branch develop").target).toEqual({ kind: "branch", base: "develop" });
	});

	it("parses pr with and without number", () => {
		expect(parseReviewCommandArgs("pr").target).toEqual({ kind: "pr", number: undefined });
		expect(parseReviewCommandArgs("pr 42").target).toEqual({ kind: "pr", number: "42" });
	});

	it("parses commit with and without a sha", () => {
		expect(parseReviewCommandArgs("commit abc123").target).toEqual({ kind: "commit", sha: "abc123" });
		// Without a SHA the caller shows the commit picker.
		expect(parseReviewCommandArgs("commit").target).toEqual({ kind: "commit", sha: undefined });
	});

	it("parses review tool configuration", () => {
		expect(parseReviewCommandArgs("tools")).toEqual({ configureTools: true });
		expect(parseReviewCommandArgs("tools now").error).toMatch(/Unexpected arguments/);
	});

	it("errors on unknown targets", () => {
		expect(parseReviewCommandArgs("everything").error).toMatch(/Unknown review target/);
	});

	it("rejects unexpected trailing arguments for every target", () => {
		expect(parseReviewCommandArgs("uncommitted now").error).toMatch(/Unexpected arguments/);
		expect(parseReviewCommandArgs("working extra").error).toMatch(/Unexpected arguments/);
		expect(parseReviewCommandArgs("branch main extra").error).toMatch(/Unexpected arguments/);
		expect(parseReviewCommandArgs("pr 42 foo").error).toMatch(/Unexpected arguments/);
		expect(parseReviewCommandArgs("commit abc def").error).toMatch(/Unexpected arguments/);
		// The single expected argument is still accepted.
		expect(parseReviewCommandArgs("branch main").target).toEqual({ kind: "branch", base: "main" });
		expect(parseReviewCommandArgs("pr 42").target).toEqual({ kind: "pr", number: "42" });
	});
});

describe("parseReviewOutput", () => {
	it("parses findings from a fenced json block after prose", () => {
		const text = [
			"I reviewed the change and ran the tests.",
			"",
			"```json",
			JSON.stringify({
				findings: [
					{
						title: "Off-by-one in pagination",
						body: "The loop skips the last page.",
						priority: 1,
						confidence: 0.9,
						file: "src/pager.ts",
						line: "10-20",
					},
				],
				overall_correctness: "incorrect",
				overall_explanation: "One real bug.",
			}),
			"```",
		].join("\n");

		const parsed = parseReviewOutput(text);
		expect(parsed).toBeDefined();
		expect(parsed?.findings).toHaveLength(1);
		expect(parsed?.findings[0]).toEqual({
			title: "Off-by-one in pagination",
			body: "The loop skips the last page.",
			priority: 1,
			confidence: 0.9,
			file: "src/pager.ts",
			line: "10-20",
		});
		expect(parsed?.overallCorrectness).toBe("incorrect");
		expect(parsed?.overallExplanation).toBe("One real bug.");
	});

	it("parses findings and coverage from an XML payload", () => {
		const text = [
			"<response>",
			"  <summary>Reviewed changed files and targeted tests.</summary>",
			"  <payload><![CDATA[",
			JSON.stringify({
				findings: [{ title: "Missing guard", body: "The new branch accepts empty input.", priority: 1 }],
				coverage: {
					files_reviewed: ["src/review.ts"],
					commands_run: ["npm run check"],
					unchecked_areas: ["E2E tests not run"],
				},
				overall_correctness: "incorrect",
				overall_explanation: "One bug remains.",
			}),
			"]]></payload>",
			"</response>",
		].join("\n");

		const parsed = parseReviewOutput(text);
		expect(parsed?.findings[0]?.title).toBe("Missing guard");
		expect(parsed?.coverage).toEqual({
			filesReviewed: ["src/review.ts"],
			commandsRun: ["npm run check"],
			uncheckedAreas: ["E2E tests not run"],
		});
		expect(parsed?.overallCorrectness).toBe("incorrect");
	});

	it("preserves entity-like text in a raw JSON payload", () => {
		const body = "Escape &amp; and &quot; in the rendered output";
		const text = [
			"<response>",
			"  <summary>Reviewed output escaping.</summary>",
			"  <payload>",
			JSON.stringify({ findings: [{ title: "escaping", body }] }),
			"  </payload>",
			"</response>",
		].join("\n");
		// Raw JSON parses directly, so the literal entity text must survive verbatim
		// (previously eager entity-decoding turned &quot; into a quote and dropped
		// the whole payload as invalid JSON).
		const parsed = parseReviewOutput(text);
		expect(parsed?.findings[0]?.title).toBe("escaping");
		expect(parsed?.findings[0]?.body).toBe(body);
	});

	it("recovers a payload whose JSON was XML-escaped", () => {
		const raw = JSON.stringify({ findings: [{ title: "compare", body: "a < b && c > d" }] });
		const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const text = ["<response>", "  <payload>", escaped, "  </payload>", "</response>"].join("\n");
		// The raw text is not valid JSON, so parsing falls back to decoding entities.
		const parsed = parseReviewOutput(text);
		expect(parsed?.findings[0]?.title).toBe("compare");
		expect(parsed?.findings[0]?.body).toBe("a < b && c > d");
	});

	it("keeps an earlier valid payload when a later payload is invalid JSON", () => {
		const text = [
			"<response>",
			'  <payload>{"findings":[{"title":"first","body":"good"}]}</payload>',
			'  <payload>{"findings": [oops not json}</payload>',
			"</response>",
		].join("\n");
		// The last payload is tried first; when it fails to parse the loop must fall
		// back to the earlier valid one rather than giving up.
		expect(parseReviewOutput(text)?.findings[0]?.title).toBe("first");
	});

	it("preserves literal angle brackets and ampersands in a raw JSON payload", () => {
		const body = "compare a < b and c > d and x & y";
		const text = [
			"<response>",
			"  <payload>",
			JSON.stringify({ findings: [{ title: "chars", body }] }),
			"  </payload>",
			"</response>",
		].join("\n");
		expect(parseReviewOutput(text)?.findings[0]?.body).toBe(body);
	});

	it("parses a payload split across adjacent CDATA sections", () => {
		const payload = `<![CDATA[{"findings":[{"title":"cd",]]><![CDATA["body":"ok"}]}]]>`;
		const text = ["<response>", `  <payload>${payload}</payload>`, "</response>"].join("\n");
		expect(parseReviewOutput(text)?.findings[0]?.title).toBe("cd");
	});

	it("decodes an XML-escaped payload only one level", () => {
		// The author's finding body literally contains the text "&lt;".
		const intendedBody = "x &lt; y";
		const raw = JSON.stringify({ findings: [{ title: "once", body: intendedBody }] });
		const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const text = ["<response>", "  <payload>", escaped, "  </payload>", "</response>"].join("\n");
		// Fallback decoding runs once (&amp; is decoded last), so the literal entity
		// text survives instead of collapsing to "<".
		expect(parseReviewOutput(text)?.findings[0]?.body).toBe(intendedBody);
	});

	it("recovers a payload escaped with numeric and hex character references", () => {
		const raw = JSON.stringify({ findings: [{ title: "num", body: "a<b" }] });
		// Decimal for the structural quotes, hex for the angle bracket.
		const numericEscaped = raw.replace(/"/g, "&#34;").replace(/</g, "&#x3C;");
		const text = ["<response>", "  <payload>", numericEscaped, "  </payload>", "</response>"].join("\n");
		const parsed = parseReviewOutput(text);
		expect(parsed?.findings[0]?.title).toBe("num");
		expect(parsed?.findings[0]?.body).toBe("a<b");
	});

	it("uses the last parseable json block", () => {
		const text = [
			"```json",
			JSON.stringify({ findings: [{ title: "old", body: "old" }] }),
			"```",
			"Revised report:",
			"```json",
			JSON.stringify({ findings: [{ title: "new", body: "new" }] }),
			"```",
		].join("\n");
		expect(parseReviewOutput(text)?.findings[0]?.title).toBe("new");
	});

	it("ignores non-json fenced blocks in prose before the findings block", () => {
		const text = [
			"Here's the problem code:",
			"```ts",
			"foo();",
			"```",
			"And my findings:",
			"```json",
			JSON.stringify({ findings: [{ title: "real", body: "found it" }] }),
			"```",
		].join("\n");
		expect(parseReviewOutput(text)?.findings[0]?.title).toBe("real");
	});

	it("handles triple-backtick fences embedded in finding bodies", () => {
		const body = "Broken snippet:\n```ts\nfoo();\n```\nshould be bar().";
		const text = ["Summary.", "```json", JSON.stringify({ findings: [{ title: "bug", body }] }), "```"].join("\n");
		expect(parseReviewOutput(text)?.findings[0]?.body).toBe(body);
	});

	it("parses an unterminated trailing json fence", () => {
		const text = ["```json", JSON.stringify({ findings: [{ title: "open", body: "no closer" }] })].join("\n");
		expect(parseReviewOutput(text)?.findings[0]?.title).toBe("open");
	});

	it("parses bare json without a fence", () => {
		const parsed = parseReviewOutput(JSON.stringify({ findings: [] }));
		expect(parsed?.findings).toEqual([]);
	});

	it("returns undefined for unstructured text", () => {
		expect(parseReviewOutput("Looks good to me!")).toBeUndefined();
	});

	it("drops malformed findings and coerces numeric lines", () => {
		const parsed = parseReviewOutput(
			JSON.stringify({
				findings: [{ title: "ok", body: "fine", line: 12 }, { nonsense: true }, "garbage"],
			}),
		);
		expect(parsed?.findings).toHaveLength(1);
		expect(parsed?.findings[0]?.line).toBe("12");
	});
});

describe("formatReviewForNewSession", () => {
	const resolved = { description: "uncommitted changes", diffCommand: "git diff HEAD" };

	it("numbers findings for fix-by-number follow-ups", () => {
		const content = formatReviewForNewSession(
			resolved,
			{
				findings: [
					{ title: "First bug", body: "Body one", priority: 0, file: "a.ts", line: "1" },
					{ title: "Second bug", body: "Body two" },
				],
				coverage: {
					filesReviewed: ["a.ts"],
					commandsRun: ["npm run check"],
					uncheckedAreas: ["E2E tests not run"],
				},
				overallCorrectness: "incorrect",
				overallExplanation: "Two bugs.",
			},
			"raw text",
		);
		expect(content).toContain("### 1. First bug [P0] (a.ts:1)");
		expect(content).toContain("### 2. Second bug");
		expect(content).toContain("Files reviewed: a.ts");
		expect(content).toContain("Commands run: npm run check");
		expect(content).toContain("git diff HEAD");
		expect(content).toContain("refer to findings by number");
	});

	it("reports a clean review", () => {
		const content = formatReviewForNewSession(resolved, { findings: [] }, "raw");
		expect(content).toContain("no issues worth flagging");
	});

	it("separates the footer with exactly one blank line after findings", () => {
		const content = formatReviewForNewSession(resolved, { findings: [{ title: "Bug", body: "Body" }] }, "raw");
		expect(content).not.toContain("\n\n\n");
		expect(content).toContain("Body\n\nReproduce the reviewed diff");
	});

	it("falls back to the raw report when parsing failed", () => {
		const content = formatReviewForNewSession(resolved, undefined, "Everything looks great.");
		expect(content).toContain("Everything looks great.");
	});
});

describe("buildReviewPrompt", () => {
	it("includes the diff, command, and extra context", () => {
		const resolved: ResolvedReview = {
			description: "branch changes vs main",
			diffCommand: "git diff main...HEAD",
			diff: "diff --git a/x b/x",
			truncated: false,
			extraContext: "Commits:\nabc fix things",
		};
		const prompt = buildReviewPrompt(resolved);
		expect(prompt).toContain("<review_request>");
		expect(prompt).toContain("<description>branch changes vs main</description>");
		expect(prompt).toContain("<diff_command>git diff main...HEAD</diff_command>");
		expect(prompt).toContain("<diff><![CDATA[diff --git a/x b/x]]></diff>");
		expect(prompt).toContain("<extra_context><![CDATA[Commits:\nabc fix things]]></extra_context>");
	});

	it("tells the reviewer to re-run the diff command when truncated", () => {
		const resolved: ResolvedReview = {
			description: "uncommitted changes",
			diffCommand: "git diff HEAD",
			diff: "x".repeat(100),
			truncated: true,
		};
		expect(buildReviewPrompt(resolved)).toContain("too large to include inline");
	});
});

describe("resolveReviewTarget", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	function git(cwd: string, ...args: string[]): void {
		const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		}
	}

	function createRepo(): string {
		const dir = join(tmpdir(), `volt-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		git(dir, "init", "--initial-branch=main");
		git(dir, "config", "core.autocrlf", "false");
		git(dir, "config", "core.eol", "lf");
		git(dir, "config", "user.email", "test@example.com");
		git(dir, "config", "user.name", "Test");
		git(dir, "config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "file.txt"), "one\n");
		git(dir, "add", "file.txt");
		git(dir, "commit", "-m", "initial");
		return dir;
	}

	it("errors outside a git repository", async () => {
		const dir = join(tmpdir(), `volt-review-norepo-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		const result = await resolveReviewTarget({ kind: "uncommitted" }, dir);
		expect(result).toEqual({ error: "Not inside a git repository." });
	});

	it("errors when there are no uncommitted changes", async () => {
		const repo = createRepo();
		const result = await resolveReviewTarget({ kind: "uncommitted" }, repo);
		expect(result).toEqual({ error: "No uncommitted changes to review." });
	});

	it("resolves uncommitted changes including untracked files", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "new.txt"), "fresh\n");
		const result = await resolveReviewTarget({ kind: "uncommitted" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.description).toBe("uncommitted changes");
		expect(result.diff).toContain("+two");
		expect(result.truncated).toBe(false);
		expect(result.extraContext).toContain("new.txt");
	});

	it("includes staged changes in a repo with no commits", async () => {
		const dir = join(tmpdir(), `volt-review-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		git(dir, "init", "--initial-branch=main");
		git(dir, "config", "core.autocrlf", "false");
		git(dir, "config", "core.eol", "lf");
		git(dir, "config", "user.email", "test@example.com");
		git(dir, "config", "user.name", "Test");
		writeFileSync(join(dir, "staged.txt"), "staged content\n");
		git(dir, "add", "staged.txt");
		const result = await resolveReviewTarget({ kind: "uncommitted" }, dir);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.diffCommand).toBe(
			"git diff --no-textconv --no-ext-diff --cached; git diff --no-textconv --no-ext-diff",
		);
		expect(result.diff).toContain("+staged content");
	});

	it("resolves branch changes against an explicit base", async () => {
		const repo = createRepo();
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "file.txt"), "one\nfeature\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "feature change");
		const result = await resolveReviewTarget({ kind: "branch", base: "main" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.description).toBe("branch changes vs main");
		expect(result.diff).toContain("+feature");
		expect(result.extraContext).toContain("feature change");
	});

	it("auto-detects main as the base branch", async () => {
		const repo = createRepo();
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "file.txt"), "one\nfeature\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "feature change");
		const result = await resolveReviewTarget({ kind: "branch" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.description).toBe("branch changes vs main");
	});

	it("errors when the base branch does not exist", async () => {
		const repo = createRepo();
		const result = await resolveReviewTarget({ kind: "branch", base: "nope" }, repo);
		expect(result).toEqual({ error: 'Base branch "nope" not found.' });
	});

	/** Publish main to a fresh bare remote and point origin/HEAD at it. */
	function publishMainToRemote(repo: string): void {
		const remote = join(tmpdir(), `volt-review-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(remote, { recursive: true });
		tempDirs.push(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(repo, "remote", "add", "origin", remote);
		git(repo, "push", "origin", "main");
		git(repo, "remote", "set-head", "origin", "main");
	}

	it("falls back to the remote-tracking base when the local base branch is absent", async () => {
		const repo = createRepo();
		publishMainToRemote(repo);
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "file.txt"), "one\nfeature\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "feature change");
		// Mimic a single-branch/shallow checkout that never created a local `main`.
		git(repo, "branch", "-D", "main");
		const result = await resolveReviewTarget({ kind: "branch", base: "main" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.description).toBe("branch changes vs origin/main");
		expect(result.diffCommand).toBe("git diff --no-textconv --no-ext-diff origin/main...HEAD");
		expect(result.diff).toContain("+feature");
	});

	it("auto-detects the remote-tracking base from origin/HEAD", async () => {
		const repo = createRepo();
		publishMainToRemote(repo);
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "file.txt"), "one\nfeature\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "feature change");
		git(repo, "branch", "-D", "main");
		const result = await resolveReviewTarget({ kind: "branch" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.description).toBe("branch changes vs origin/main");
		expect(result.diffCommand).toBe("git diff --no-textconv --no-ext-diff origin/main...HEAD");
		expect(result.diff).toContain("+feature");
	});

	it("normalizes canonical pull request numbers and rejects malformed selectors", () => {
		expect(normalizeReviewPullRequestNumber(undefined)).toEqual({});
		expect(normalizeReviewPullRequestNumber("   ")).toEqual({});
		expect(normalizeReviewPullRequestNumber(" 42 ")).toEqual({ number: "42" });
		expect(normalizeReviewPullRequestNumber(String(MAX_GITHUB_PR_NUMBER))).toEqual({
			number: String(MAX_GITHUB_PR_NUMBER),
		});
		for (const number of ["0", "-1", "+1", "01", "1.0", "1e2", " 1 2 ", String(MAX_GITHUB_PR_NUMBER + 1)]) {
			expect(normalizeReviewPullRequestNumber(number)).toEqual({
				error: `PR number must be a canonical positive decimal no greater than ${MAX_GITHUB_PR_NUMBER}.`,
			});
		}
	});

	it("provides stable remote pull request errors without exposing GitHub CLI diagnostics", async () => {
		const repo = createRepo();
		const binDir = join(repo, "bin");
		mkdirSync(binDir);
		const ghPath = join(binDir, process.platform === "win32" ? "gh.exe" : "gh");
		if (process.platform === "win32") {
			// Windows process lookup ignores extensionless scripts. A copied Node
			// executable resolves its first argument (`pr`) as this fixture script.
			copyFileSync(process.execPath, ghPath);
			writeFileSync(join(repo, "pr"), "console.error('private-repository.example'); process.exit(1);\n");
		} else {
			writeFileSync(ghPath, "#!/bin/sh\necho 'private-repository.example' >&2\nexit 1\n");
			chmodSync(ghPath, 0o755);
		}
		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		try {
			const result = await resolveReviewTarget({ kind: "pr", number: "42" }, repo);
			expect(result).toEqual({
				error: "gh pr view failed: private-repository.example",
				remoteError: "Could not load pull request metadata with GitHub CLI.",
			});
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});

	it("returns stable remote errors for uncommitted and branch diff failures", async () => {
		const uncommittedRepo = createRepo();
		writeFileSync(join(uncommittedRepo, ".git", "index"), "invalid index\n");
		const uncommittedResult = await resolveReviewTarget({ kind: "uncommitted" }, uncommittedRepo);
		expect(uncommittedResult).toMatchObject({
			remoteError: "Could not load the uncommitted changes diff.",
		});
		if (!("error" in uncommittedResult)) {
			throw new Error("expected uncommitted diff failure");
		}
		expect(uncommittedResult.error).toContain("git diff failed:");

		const branchRepo = createRepo();
		git(branchRepo, "checkout", "-b", "feature");
		writeFileSync(join(branchRepo, "file.txt"), "one\nfeature\n");
		git(branchRepo, "add", "file.txt");
		git(branchRepo, "commit", "-m", "feature change");
		const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: branchRepo, encoding: "utf-8" });
		if (headResult.status !== 0) {
			throw new Error(`git rev-parse HEAD failed: ${headResult.stderr}`);
		}
		const head = headResult.stdout.trim();
		rmSync(join(branchRepo, ".git", "objects", head.slice(0, 2), head.slice(2)));
		const branchResult = await resolveReviewTarget({ kind: "branch", base: "main" }, branchRepo);
		expect(branchResult).toMatchObject({ remoteError: "Could not load the branch diff." });
		if (!("error" in branchResult)) {
			throw new Error("expected branch diff failure");
		}
		expect(branchResult.error).toContain("git diff failed:");
	});

	it("resolves a commit ref to a canonical object id before showing it", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "second");
		const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" });
		if (commitResult.status !== 0) {
			throw new Error(`git rev-parse HEAD failed: ${commitResult.stderr}`);
		}
		const commit = commitResult.stdout.trim();
		const result = await resolveReviewTarget({ kind: "commit", sha: " HEAD~0 " }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result).toMatchObject({
			description: `commit ${commit}`,
			workflowDescription: `commit ${commit}`,
			diffCommand: `git show --stat --patch --diff-merges=first-parent --no-textconv --no-ext-diff ${commit}`,
		});
		expect(result.diff).toContain("+two");
	});

	it("rejects option-like commit refs without writing files", async () => {
		const repo = createRepo();
		const outputPath = join(repo, "injected.patch");
		const result = await resolveReviewTarget({ kind: "commit", sha: `--output=${outputPath}` }, repo);
		expect(result).toEqual({ error: "Commit ref was not found or does not resolve to a commit." });
		expect(existsSync(outputPath)).toBe(false);
	});

	it("rejects non-commit objects and oversized refs", async () => {
		const repo = createRepo();
		const blobPath = join(repo, "blob.txt");
		writeFileSync(blobPath, "blob\n");
		const blobResult = spawnSync("git", ["hash-object", "-w", blobPath], { cwd: repo, encoding: "utf-8" });
		if (blobResult.status !== 0) {
			throw new Error(`git hash-object failed: ${blobResult.stderr}`);
		}
		await expect(resolveReviewTarget({ kind: "commit", sha: blobResult.stdout.trim() }, repo)).resolves.toEqual({
			error: "Commit ref was not found or does not resolve to a commit.",
		});
		await expect(
			resolveReviewTarget({ kind: "commit", sha: "x".repeat(MAX_REVIEW_COMMIT_REF_BYTES + 1) }, repo),
		).resolves.toEqual({ error: `Commit ref exceeds ${MAX_REVIEW_COMMIT_REF_BYTES} UTF-8 bytes.` });
	});

	it("does not execute configured textconv commands for Git-backed review diffs", async () => {
		const repo = createRepo();
		const sentinelPath = join(repo, "textconv-ran");
		const textconvPath = join(repo, "textconv.sh");
		writeFileSync(textconvPath, `#!/bin/sh\ntouch '${sentinelPath}'\ncat "$1"\n`);
		chmodSync(textconvPath, 0o755);
		git(repo, "config", "diff.review-test.textconv", textconvPath);
		writeFileSync(join(repo, ".gitattributes"), "file.txt diff=review-test\n");
		git(repo, "add", ".gitattributes");
		git(repo, "commit", "-m", "configure attributes");
		writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "target commit");

		const commitResult = await resolveReviewTarget({ kind: "commit", sha: "HEAD" }, repo);
		if ("error" in commitResult) {
			throw new Error(commitResult.error);
		}
		expect(commitResult.diff).toContain("+two");
		expect(existsSync(sentinelPath)).toBe(false);

		writeFileSync(join(repo, "file.txt"), "one\ntwo\nthree\n");
		const uncommittedResult = await resolveReviewTarget({ kind: "uncommitted" }, repo);
		if ("error" in uncommittedResult) {
			throw new Error(uncommittedResult.error);
		}
		expect(uncommittedResult.diff).toContain("+three");
		expect(existsSync(sentinelPath)).toBe(false);

		git(repo, "checkout", "-b", "feature");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "feature change");
		const branchResult = await resolveReviewTarget({ kind: "branch", base: "main" }, repo);
		if ("error" in branchResult) {
			throw new Error(branchResult.error);
		}
		expect(branchResult.diff).toContain("+three");
		expect(existsSync(sentinelPath)).toBe(false);
	});

	it("resolves a merge commit with first-parent patch hunks", async () => {
		const repo = createRepo();
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "file.txt"), "one\nfeature\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "feature change");
		git(repo, "checkout", "main");
		git(repo, "merge", "--no-ff", "feature", "-m", "merge feature");
		const result = await resolveReviewTarget({ kind: "commit", sha: "HEAD" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.diff).toContain("+feature");
	});

	it("errors on a commit target without a ref", async () => {
		const repo = createRepo();
		const result = await resolveReviewTarget({ kind: "commit" }, repo);
		expect(result).toEqual({ error: "Missing commit ref." });
	});

	it("lists local branches with main and master first for the base picker", async () => {
		const repo = createRepo();
		git(repo, "checkout", "-b", "zeta");
		git(repo, "checkout", "main");
		git(repo, "checkout", "-b", "master");
		git(repo, "checkout", "main");
		git(repo, "checkout", "-b", "alpha");
		const branches = await listBaseBranches(repo);
		if ("error" in branches) {
			throw new Error(branches.error);
		}
		expect(branches).toEqual(["main", "master", "alpha", "zeta"]);
	});

	it("includes remote-tracking branches after local ones and skips origin/HEAD", async () => {
		const repo = createRepo();
		git(repo, "checkout", "-b", "dev");
		git(repo, "checkout", "-b", "feature/login");
		git(repo, "checkout", "main");
		publishMainToRemote(repo);
		git(repo, "push", "origin", "dev", "feature/login");
		const branches = await listBaseBranches(repo);
		if ("error" in branches) {
			throw new Error(branches.error);
		}
		// Canonical bases first (local main, then origin/main), then other locals,
		// then other remote-tracking branches; the origin/HEAD alias is omitted.
		expect(branches).toEqual(["main", "origin/main", "dev", "feature/login", "origin/dev", "origin/feature/login"]);
		expect(branches).not.toContain("origin");
		expect(branches).not.toContain("origin/HEAD");
	});

	it("lists recent commits for the picker", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "second change");
		const commits = await listRecentCommits(repo);
		if ("error" in commits) {
			throw new Error(commits.error);
		}
		expect(commits).toHaveLength(2);
		expect(commits[0]?.subject).toBe("second change");
		expect(commits[1]?.subject).toBe("initial");
		expect(commits[0]?.sha).toMatch(/^[0-9a-f]{7,}$/);
		expect(commits[0]?.date).toBeTruthy();
	});

	it("errors when listing commits outside a git repository", async () => {
		const dir = join(tmpdir(), `volt-review-nolog-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		const commits = await listRecentCommits(dir);
		expect("error" in commits).toBe(true);
	});

	it("truncates oversized diffs", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, "big.txt"), `${"line of content\n".repeat(20000)}`);
		git(repo, "add", "big.txt");
		const result = await resolveReviewTarget({ kind: "uncommitted" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.truncated).toBe(true);
		expect(result.diff.length).toBeLessThanOrEqual(MAX_REVIEW_DIFF_CHARS);
		// The preview ends on a whole-line boundary, not a partial hunk line.
		expect(result.diff.endsWith("\n")).toBe(true);
	});
});

describe("truncateDiff", () => {
	it("returns the diff unchanged when under the limit", () => {
		expect(truncateDiff("small diff\n")).toEqual({ diff: "small diff\n", truncated: false });
	});

	it("truncates on a line boundary", () => {
		const line = `${"x".repeat(100)}\n`;
		const { diff, truncated } = truncateDiff(line.repeat(2000));
		expect(truncated).toBe(true);
		expect(diff.length).toBeLessThanOrEqual(MAX_REVIEW_DIFF_CHARS);
		expect(diff.length).toBeGreaterThan(MAX_REVIEW_DIFF_CHARS - line.length);
		expect(diff.endsWith("\n")).toBe(true);
	});

	it("cuts a single oversized line at the limit", () => {
		const { diff, truncated } = truncateDiff("a".repeat(MAX_REVIEW_DIFF_CHARS + 100));
		expect(truncated).toBe(true);
		expect(diff.length).toBe(MAX_REVIEW_DIFF_CHARS);
	});

	it("does not split a surrogate pair when there is no line boundary", () => {
		const filler = "a".repeat(MAX_REVIEW_DIFF_CHARS - 1);
		// The emoji's high surrogate lands exactly on the cut index (MAX - 1).
		const { diff, truncated } = truncateDiff(`${filler}\u{1F600}${"a".repeat(10)}`);
		expect(truncated).toBe(true);
		expect(diff).toBe(filler);
		expect(isHighSurrogateCode(diff.charCodeAt(diff.length - 1))).toBe(false);
	});
});

function isHighSurrogateCode(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

describe("stripReviewEnvelopeForDisplay", () => {
	it("removes a complete response envelope but keeps surrounding prose", () => {
		const text = [
			"I traced the call sites and ran the tests.",
			"<response>",
			"  <summary>All good.</summary>",
			'  <payload>{"findings":[]}</payload>',
			"</response>",
		].join("\n");
		expect(stripReviewEnvelopeForDisplay(text)).toBe("I traced the call sites and ran the tests.");
	});

	it("strips a mid-stream unterminated envelope so no raw markup flashes", () => {
		const text = "Done reviewing.\n<response>\n  <summary>Wr";
		expect(stripReviewEnvelopeForDisplay(text)).toBe("Done reviewing.");
	});

	it("returns empty string when the message is only the envelope", () => {
		const text = '<response><payload>{"findings":[]}</payload></response>';
		expect(stripReviewEnvelopeForDisplay(text)).toBe("");
	});

	it("leaves envelope-free prose untouched", () => {
		expect(stripReviewEnvelopeForDisplay("Reading src/foo.ts to check the bounds.")).toBe(
			"Reading src/foo.ts to check the bounds.",
		);
	});
});

describe("runReview", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	const resolved: ResolvedReview = {
		description: "uncommitted changes",
		diffCommand: "git diff HEAD",
		diff: "diff --git a/file.txt b/file.txt\n+two",
		truncated: false,
	};

	it("carries Fast mode through the isolated review and fresh findings session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runGit = (...args: string[]): void => {
			const command = spawnSync("git", args, { cwd: harness.tempDir, encoding: "utf-8" });
			if (command.status !== 0) {
				throw new Error(`git ${args.join(" ")} failed: ${command.stderr}`);
			}
		};
		runGit("init", "--initial-branch=main");
		runGit("config", "user.email", "test@example.com");
		runGit("config", "user.name", "Test");
		writeFileSync(join(harness.tempDir, "review.txt"), "before\n");
		runGit("add", "review.txt");
		runGit("commit", "-m", "initial");
		writeFileSync(join(harness.tempDir, "review.txt"), "after\n");

		const observedInferenceSpeeds: Array<SimpleStreamOptions["inferenceSpeed"]> = [];
		harness.setResponses([
			(_context, options) => {
				const streamOptions = options as (typeof options & Pick<SimpleStreamOptions, "inferenceSpeed">) | undefined;
				observedInferenceSpeeds.push(streamOptions?.inferenceSpeed);
				harness.session.setFastModeEnabled(false);
				return fauxAssistantMessage(JSON.stringify({ findings: [] }));
			},
		]);
		harness.session.setFastModeEnabled(true);
		let replacementFastModeEnabled = false;

		const result = await runReviewWorkflow({
			target: { kind: "uncommitted" },
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			session: harness.session,
			newSession: async (options) => {
				const sessionManager = SessionManager.inMemory(harness.tempDir);
				await options?.setup?.(sessionManager);
				replacementFastModeEnabled = sessionManager.buildSessionContext().fastMode.enabled;
				return { cancelled: false, seeded: true };
			},
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
		});

		expect(result.status).toBe("completed");
		expect(observedInferenceSpeeds).toEqual(["fast"]);
		expect(harness.session.fastModeEnabled).toBe(false);
		expect(replacementFastModeEnabled).toBe(true);
	});

	it("runs an isolated review session and parses findings", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const report = [
			"Reviewed the diff and traced the call sites.",
			"```json",
			JSON.stringify({
				findings: [{ title: "Bug in file.txt", body: "Line two is wrong.", priority: 1, confidence: 0.8 }],
				overall_correctness: "incorrect",
				overall_explanation: "One bug.",
			}),
			"```",
		].join("\n");
		harness.setResponses([fauxAssistantMessage(report)]);

		const result = await runReview({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved,
		});

		expect(result.aborted).toBe(false);
		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.findings).toHaveLength(1);
		expect(result.parsed?.findings[0]?.title).toBe("Bug in file.txt");
		// The review runs in its own session: the harness session is untouched.
		expect(harness.session.messages).toHaveLength(0);
	});

	it("keeps richer pull request metadata out of detached workflow events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("grep", { pattern: "private body", path: "." }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(JSON.stringify({ findings: [] })),
		]);
		const events: object[] = [];

		const result = await executeReviewWorkflow({
			prepared: {
				workflowId: "review:pr",
				action: "review.pr",
				target: { kind: "pr", number: "42" },
				resolution: {
					...resolved,
					description: "PR #42 (private title)",
					workflowDescription: "PR #42",
					diffCommand: "gh pr diff 42",
					extraContext: "PR #42: private title\nDescription:\nprivate body",
				},
				model: harness.getModel(),
			},
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			skipWorkingTreeGuard: true,
			onEvent: (event) => events.push(event),
		});

		expect(result.status).toBe("completed");
		expect(events[0]).toMatchObject({ type: "workflow_start", message: "Reviewing PR #42." });
		expect(JSON.stringify(events)).not.toContain("private title");
		expect(JSON.stringify(events)).not.toContain("private body");
	});

	it("forwards the review session's full event stream via onSessionEvent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(JSON.stringify({ findings: [] }))]);

		const eventTypes: string[] = [];
		const result = await runReview({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved,
			onSessionEvent: (event) => eventTypes.push(event.type),
		});

		expect(result.aborted).toBe(false);
		// The full AgentSessionEvent stream flows through (not just tool events),
		// which is what the TUI needs to render the review as a live conversation.
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
	});

	it("can inherit extension tools from the parent session", async () => {
		const toolRuns: Array<{ activeTools: string[]; query: string }> = [];
		const workflowEvents: object[] = [];
		const extensionFactory: ExtensionFactory = (volt) => {
			volt.registerTool({
				name: "review_helper",
				label: "Review Helper",
				description: "Returns review context",
				parameters: Type.Object({ query: Type.String() }),
				async execute(_toolCallId, params) {
					const activeTools = volt.getActiveTools();
					toolRuns.push({ activeTools, query: params.query });
					return { content: [{ type: "text", text: `context:${params.query}` }], details: {} };
				},
			});
		};
		const harness = await createHarness({ extensionFactories: [extensionFactory] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("review_helper", { query: "changed file" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(JSON.stringify({ findings: [] })),
		]);

		const result = await runReview({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved,
			parentResourceLoader: harness.session.resourceLoader,
			tools: ["review_helper"],
			workflowId: "review:test",
			workflowAction: "review.uncommitted",
			onEvent: (event) => workflowEvents.push(event),
		});

		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.findings).toEqual([]);
		expect(toolRuns.map((run) => run.query)).toEqual(["changed file"]);
		expect(workflowEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool_execution_start",
					workflowId: "review:test",
					workflowKind: "review",
					workflowAction: "review.uncommitted",
					toolName: "review_helper",
					args: { query: "changed file" },
				}),
				expect.objectContaining({
					type: "tool_execution_end",
					workflowId: "review:test",
					workflowKind: "review",
					workflowAction: "review.uncommitted",
					toolName: "review_helper",
					isError: false,
				}),
			]),
		);
		expect(harness.session.messages).toHaveLength(0);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("review_helper", { query: "parent session" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("parent");

		expect(toolRuns.map((run) => run.query)).toEqual(["changed file", "parent session"]);
		expect(toolRuns[1]?.activeTools).toContain("review_helper");
	});

	it("returns the raw report when the output is unstructured", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Looks good, no issues.")]);

		const result = await runReview({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved,
		});

		expect(result.parsed).toBeUndefined();
		expect(result.raw).toContain("Looks good");
	});

	it("reports an aborted review when the signal fires", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const abortController = new AbortController();
		harness.setResponses([
			() => {
				abortController.abort();
				return fauxAssistantMessage("too late");
			},
		]);

		const result = await runReview({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved,
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
	});

	it("reports aborted without prompting when the signal fired before the session was ready", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let prompted = false;
		harness.setResponses([
			() => {
				prompted = true;
				return fauxAssistantMessage("should not run");
			},
		]);
		const abortController = new AbortController();
		abortController.abort();

		const result = await runReview({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved,
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(prompted).toBe(false);
	});
});

describe("createWorkingTreeGuard", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	function git(cwd: string, ...args: string[]): void {
		const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		}
	}

	function createRepo(): string {
		const dir = join(tmpdir(), `volt-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		git(dir, "init", "--initial-branch=main");
		git(dir, "config", "core.autocrlf", "false");
		git(dir, "config", "core.eol", "lf");
		git(dir, "config", "user.email", "test@example.com");
		git(dir, "config", "user.name", "Test");
		git(dir, "config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "tracked.txt"), "committed\n");
		git(dir, "add", "tracked.txt");
		git(dir, "commit", "-m", "initial");
		return dir;
	}

	it("removes files the reviewer created", async () => {
		const repo = createRepo();
		const guard = await createWorkingTreeGuard(repo);
		writeFileSync(join(repo, "scratch.test.js"), "console.log('temp')\n");
		await guard.restore();
		expect(existsSync(join(repo, "scratch.test.js"))).toBe(false);
	});

	it("reverts reviewer edits while preserving the uncommitted changes under review", async () => {
		const repo = createRepo();
		// The uncommitted change that is the subject of the review.
		writeFileSync(join(repo, "tracked.txt"), "under review\n");
		const guard = await createWorkingTreeGuard(repo);
		// Reviewer overwrites the file to test a hypothesis and forgets to revert.
		writeFileSync(join(repo, "tracked.txt"), "reviewer edit\n");
		await guard.restore();
		expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("under review\n");
	});

	it("restores files the reviewer deleted", async () => {
		const repo = createRepo();
		const guard = await createWorkingTreeGuard(repo);
		rmSync(join(repo, "tracked.txt"));
		await guard.restore();
		expect(existsSync(join(repo, "tracked.txt"))).toBe(true);
		expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("committed\n");
	});

	it("is a no-op when the reviewer leaves the tree unchanged", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, "tracked.txt"), "under review\n");
		writeFileSync(join(repo, "untracked.txt"), "user scratch\n");
		const guard = await createWorkingTreeGuard(repo);
		await guard.restore();
		expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("under review\n");
		expect(readFileSync(join(repo, "untracked.txt"), "utf-8")).toBe("user scratch\n");
	});

	it("leaves git-ignored files untouched", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, ".gitignore"), "ignored/\n");
		git(repo, "add", ".gitignore");
		git(repo, "commit", "-m", "ignore");
		const guard = await createWorkingTreeGuard(repo);
		mkdirSync(join(repo, "ignored"), { recursive: true });
		writeFileSync(join(repo, "ignored", "build.out"), "artifact\n");
		await guard.restore();
		expect(existsSync(join(repo, "ignored", "build.out"))).toBe(true);
	});

	it("only restores once", async () => {
		const repo = createRepo();
		const guard = await createWorkingTreeGuard(repo);
		writeFileSync(join(repo, "scratch.txt"), "temp\n");
		await guard.restore();
		expect(existsSync(join(repo, "scratch.txt"))).toBe(false);
		// A file created after the first restore is not touched by a second call.
		writeFileSync(join(repo, "scratch.txt"), "temp2\n");
		await guard.restore();
		expect(existsSync(join(repo, "scratch.txt"))).toBe(true);
	});

	it("does nothing outside a git repository", async () => {
		const dir = join(tmpdir(), `volt-guard-norepo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		const guard = await createWorkingTreeGuard(dir);
		writeFileSync(join(dir, "scratch.txt"), "temp\n");
		await guard.restore();
		expect(existsSync(join(dir, "scratch.txt"))).toBe(true);
	});
});
