import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import {
	buildReviewPrompt,
	formatReviewForNewSession,
	listLocalBranches,
	listRecentCommits,
	MAX_REVIEW_DIFF_CHARS,
	parseReviewCommandArgs,
	parseReviewOutput,
	type ResolvedReview,
	resolveReviewTarget,
	runReview,
} from "../../src/core/review.ts";
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
		git(dir, "config", "user.email", "test@example.com");
		git(dir, "config", "user.name", "Test");
		writeFileSync(join(dir, "staged.txt"), "staged content\n");
		git(dir, "add", "staged.txt");
		const result = await resolveReviewTarget({ kind: "uncommitted" }, dir);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.diffCommand).toBe("git diff --cached; git diff");
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

	it("resolves a single commit", async () => {
		const repo = createRepo();
		writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "second");
		const result = await resolveReviewTarget({ kind: "commit", sha: "HEAD" }, repo);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.description).toBe("commit HEAD");
		expect(result.diff).toContain("+two");
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

	it("errors on a commit target without a sha", async () => {
		const repo = createRepo();
		const result = await resolveReviewTarget({ kind: "commit" }, repo);
		expect(result).toEqual({ error: "Missing commit SHA." });
	});

	it("lists local branches with main and master first for the base picker", async () => {
		const repo = createRepo();
		git(repo, "checkout", "-b", "zeta");
		git(repo, "checkout", "main");
		git(repo, "checkout", "-b", "master");
		git(repo, "checkout", "main");
		git(repo, "checkout", "-b", "alpha");
		const branches = await listLocalBranches(repo);
		if ("error" in branches) {
			throw new Error(branches.error);
		}
		expect(branches).toEqual(["main", "master", "alpha", "zeta"]);
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
		expect(result.diff.length).toBe(MAX_REVIEW_DIFF_CHARS);
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

	it("can inherit extension tools from the parent session", async () => {
		const toolRuns: Array<{ activeTools: string[]; query: string }> = [];
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
		});

		expect(result.errorMessage).toBeUndefined();
		expect(result.parsed?.findings).toEqual([]);
		expect(toolRuns.map((run) => run.query)).toEqual(["changed file"]);
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
