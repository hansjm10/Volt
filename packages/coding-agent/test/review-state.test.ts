import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedReview, ReviewFinding } from "../src/core/review-report.ts";
import type { ReviewSnapshot } from "../src/core/review-snapshot.ts";
import {
	appendReviewFindingTransition,
	appendReviewPublication,
	appendReviewRun,
	appendReviewRunDurably,
	createReviewRunRecord,
	exportReviewFeedback,
	listReviewRuns,
	MAX_REVIEW_STATE_RECORD_BYTES,
	planIncrementalReview,
	type ReviewRunRecord,
	reconcileFindingIdentities,
} from "../src/core/review-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
	return {
		id: "finding-1",
		fingerprint: "a".repeat(64),
		status: "open",
		title: "Broken guard",
		body: "The guard returns the wrong value.",
		trigger: "Call the function with zero.",
		impact: "A wrong value is returned.",
		category: "correctness",
		rootCauseKey: "wrong-zero-guard",
		priority: 2,
		confidence: 0.9,
		changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
		evidenceLocations: [],
		verification: {
			outcome: "accepted",
			method: "Compared exact blobs.",
			rationale: "The branch is present.",
			confidence: 0.95,
		},
		...overrides,
	};
}

function result(findings: ReviewFinding[] = [finding()]): ParsedReview {
	return {
		completionStatus: "complete",
		summary: "One verified finding.",
		findings,
		coverage: {
			changedFileInventoryComplete: true,
			filesInspected: ["src/value.ts"],
			hunksInspected: ["hunk-1"],
			commandsRun: [],
			failedVerificationAttempts: [],
			exclusions: [],
			uncheckedAreas: [],
			residualRisk: [],
			modelReportedLimitations: [],
		},
		overallCorrectness: "incorrect",
		overallExplanation: "A verified P2 finding remains open.",
	};
}

function record(runId: string, endedAt: number, findings: ReviewFinding[] = [finding()]): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.branch",
		status: "completed",
		startedAt: endedAt - 10,
		endedAt,
		target: {
			description: "current branch against main",
			diffCommand: "git diff base..head",
			identity: {
				kind: "branch",
				baseTree: "base-tree",
				headTree: `head-${runId}`,
				baseCommit: "base",
				headCommit: `head-${runId}`,
			},
			files: [
				{
					path: "src/value.ts",
					status: "modified",
					baseOid: "base-blob",
					baseMode: "100644",
					baseType: "blob",
					headOid: `blob-${runId}`,
					headMode: "100644",
					headType: "blob",
					hunkIds: ["hunk-1"],
					reviewable: true,
				},
			],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: result(findings),
	};
}

function snapshot(headOid: string, hunkId = "hunk-1"): ReviewSnapshot {
	return {
		description: "current branch against main",
		diffCommand: "git diff base..head",
		identity: {
			kind: "branch",
			baseTree: "base-tree",
			headTree: `tree-${headOid}`,
			baseCommit: "base",
			headCommit: `commit-${headOid}`,
		},
		changedFiles: [
			{
				path: "src/value.ts",
				status: "modified",
				base: { path: "src/value.ts", mode: "100644", type: "blob", oid: "base-blob" },
				head: { path: "src/value.ts", mode: "100644", type: "blob", oid: headOid },
				hunks: [
					{
						id: hunkId,
						path: "src/value.ts",
						header: "@@",
						oldStart: 1,
						oldCount: 1,
						newStart: 1,
						newCount: 1,
						baseChangedLines: [{ startLine: 1, endLine: 1 }],
						headChangedLines: [{ startLine: 1, endLine: 1 }],
						patch: "+value",
					},
				],
				binary: false,
				reviewable: true,
			},
		],
		root: "/tmp/review",
		readFile: async () => undefined,
		listFiles: async () => [],
		materializeHead: async () => "/tmp/review-materialized",
		dispose: async () => {},
	};
}

describe("durable review state", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("hydrates paginated runs and applies branch-local finding transitions", () => {
		const manager = SessionManager.inMemory("/tmp/review-state");
		const branchPoint = manager.appendCustomEntry("test.branch-point", { value: true });
		appendReviewRun(manager, record("run-1", 1));
		appendReviewFindingTransition(manager, {
			runId: "run-1",
			findingId: "finding-1",
			status: "dismissed",
			reason: "false_positive",
		});
		expect(listReviewRuns(manager).runs[0]?.result?.findings[0]?.status).toBe("dismissed");
		expect(exportReviewFeedback(manager).outcomes).toHaveLength(1);
		appendReviewPublication(manager, {
			runId: "run-1",
			reviewId: 42,
			url: "https://example.test/review/42",
			inlineFindingIds: ["finding-1"],
			summaryOnlyFindingIds: [],
		});
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: "volt.review.publication",
			data: { runId: "run-1", reviewId: 42 },
		});
		expect(exportReviewFeedback(manager).outcomes).toHaveLength(1);

		manager.branch(branchPoint);
		appendReviewRun(manager, record("run-2", 2));
		expect(listReviewRuns(manager).runs.map((run) => run.runId)).toEqual(["run-2"]);
	});

	it("durably records a review before any prompt and recovers it after restart", async () => {
		const root = join(tmpdir(), `volt-review-state-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		directories.push(root);
		const manager = SessionManager.create(root, join(root, "sessions"));
		await appendReviewRunDurably(manager, record("run-before-prompt", 1));

		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		const reopened = SessionManager.open(file);
		expect(listReviewRuns(reopened).runs).toMatchObject([{ runId: "run-before-prompt", status: "completed" }]);
	});

	it("survives session-manager restart and paginates with opaque cursors", async () => {
		const root = join(tmpdir(), `volt-review-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		directories.push(root);
		mkdirSync(join(root, "sessions"), { recursive: true });
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "Review the branch", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Starting review" }],
			api: "openai-responses",
			provider: "openai",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		appendReviewRun(manager, record("run-1", 1));
		appendReviewRun(manager, record("run-2", 2));
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		const reopened = SessionManager.open(file);
		const first = listReviewRuns(reopened, { limit: 1 });
		expect(first.runs[0]?.runId).toBe("run-2");
		expect(first.nextCursor).toBeTruthy();
		expect(listReviewRuns(reopened, { cursor: first.nextCursor, limit: 1 }).runs[0]?.runId).toBe("run-1");
	});

	it("plans compatible incremental scope and reconciles durable finding ids", () => {
		const manager = SessionManager.inMemory("/tmp/review-state");
		appendReviewRun(manager, record("run-1", 1));
		const unchanged = planIncrementalReview(manager, snapshot("blob-run-1"), {
			scope: [],
			effort: "standard",
			includeOptional: false,
			scopeMode: "incremental",
		});
		expect(unchanged).toMatchObject({
			mode: "incremental",
			changedPaths: [],
			priorOpenFindings: [{ id: "finding-1" }],
		});
		const rediscovered = finding({ id: "new-random-id" });
		expect(reconcileFindingIdentities([rediscovered], unchanged)[0]?.id).toBe("finding-1");

		const changed = planIncrementalReview(manager, snapshot("new-blob", "new-hunk"), {
			scope: [],
			effort: "standard",
			includeOptional: false,
			scopeMode: "incremental",
		});
		expect(changed.changedPaths).toEqual(["src/value.ts"]);

		const boundedInventory = record("run-2", 2);
		boundedInventory.target.files = [];
		appendReviewRun(manager, boundedInventory);
		expect(
			planIncrementalReview(manager, snapshot("newer-blob", "newer-hunk"), {
				scope: [],
				effort: "standard",
				includeOptional: false,
				scopeMode: "incremental",
			}),
		).toMatchObject({ mode: "full", fallbackReason: expect.stringContaining("inventory exceeded") });
	});

	it("honors an explicitly requested incremental parent instead of the newest run", () => {
		const manager = SessionManager.inMemory("/tmp/review-state");
		appendReviewRun(manager, record("run-1", 1));
		appendReviewRun(manager, record("run-2", 2));
		const plan = planIncrementalReview(
			manager,
			snapshot("blob-run-1"),
			{
				scope: [],
				effort: "standard",
				includeOptional: false,
				scopeMode: "incremental",
			},
			{ parentRunId: "run-1" },
		);
		expect(plan).toMatchObject({
			mode: "incremental",
			previousRun: { runId: "run-1" },
			changedPaths: [],
		});
	});

	it("re-reviews files when Git metadata changes", () => {
		const manager = SessionManager.inMemory("/tmp/review-state");
		appendReviewRun(manager, record("run-1", 1));
		const controls = {
			scope: [],
			effort: "standard" as const,
			includeOptional: false,
			scopeMode: "incremental" as const,
		};

		const modeChanged = snapshot("blob-run-1");
		modeChanged.changedFiles[0]!.head!.mode = "100755";
		expect(planIncrementalReview(manager, modeChanged, controls, { parentRunId: "run-1" }).changedPaths).toEqual([
			"src/value.ts",
		]);

		const renamed = snapshot("blob-run-1");
		renamed.changedFiles[0]!.status = "renamed";
		renamed.changedFiles[0]!.previousPath = "src/old-value.ts";
		expect(planIncrementalReview(manager, renamed, controls, { parentRunId: "run-1" }).changedPaths).toEqual([
			"src/value.ts",
		]);
	});

	it("falls back to full coverage for incomplete, narrower, or uncovered parents", () => {
		const manager = SessionManager.inMemory("/tmp/review-state");
		const controls = {
			scope: [],
			effort: "standard" as const,
			includeOptional: false,
			scopeMode: "incremental" as const,
		};

		const incomplete = record("incomplete", 1);
		incomplete.status = "incomplete";
		appendReviewRun(manager, incomplete);
		expect(
			planIncrementalReview(manager, snapshot("blob-incomplete"), controls, {
				parentRunId: incomplete.runId,
			}),
		).toMatchObject({ mode: "full", fallbackReason: expect.stringContaining("did not complete") });

		const narrower = record("narrower", 2);
		narrower.options.scope = ["src/value.ts"];
		appendReviewRun(manager, narrower);
		expect(
			planIncrementalReview(manager, snapshot("blob-narrower"), controls, {
				parentRunId: narrower.runId,
			}),
		).toMatchObject({ mode: "full", fallbackReason: expect.stringContaining("controls") });

		const uncovered = record("uncovered", 3);
		uncovered.result!.coverage.exclusions = [{ path: "src/value.ts", reason: "Excluded by prior scope." }];
		appendReviewRun(manager, uncovered);
		expect(
			planIncrementalReview(manager, snapshot("blob-uncovered"), controls, {
				parentRunId: uncovered.runId,
			}),
		).toMatchObject({ mode: "full", fallbackReason: expect.stringContaining("lacks verified coverage") });
	});

	it("records bounded run snapshots through the host record builder", () => {
		const built = createReviewRunRecord({
			workflowId: "review:test",
			workflowAction: "review.branch",
			startedAt: 1,
			snapshot: snapshot("new-blob"),
			controls: { scope: [], effort: "high", includeOptional: false, scopeMode: "full" },
			status: "completed",
			result: result(),
		});
		expect(built).toMatchObject({
			runId: "review:test",
			status: "completed",
			target: {
				files: [
					{
						status: "modified",
						baseMode: "100644",
						baseType: "blob",
						headOid: "new-blob",
						headMode: "100644",
						headType: "blob",
					},
				],
			},
		});
		expect(() =>
			createReviewRunRecord({
				workflowId: "review:oversized-controls",
				workflowAction: "review.branch",
				startedAt: 1,
				snapshot: snapshot("new-blob"),
				controls: {
					focus: "x".repeat(4_001),
					scope: [],
					effort: "high",
					includeOptional: false,
					scopeMode: "full",
				},
				status: "cancelled",
			}),
		).toThrow(/at most 4000 UTF-8 bytes/);

		const oversizedResult = result([
			finding({
				body: "🙂".repeat(2_000),
				evidenceLocations: Array.from({ length: 12 }, () => ({
					path: "src/value.ts",
					side: "head" as const,
					startLine: 1,
					endLine: 1,
				})),
			}),
		]);
		oversizedResult.coverage.filesInspected = Array.from(
			{ length: 600 },
			(_, index) => `src/${index}-${"x".repeat(1_000)}`,
		);
		const compacted = createReviewRunRecord({
			workflowId: "review:large",
			workflowAction: "review.branch",
			startedAt: 1,
			snapshot: snapshot("large-blob"),
			controls: { scope: [], effort: "high", includeOptional: false, scopeMode: "full" },
			status: "completed",
			result: oversizedResult,
		});
		expect(Buffer.byteLength(JSON.stringify(compacted), "utf8")).toBeLessThanOrEqual(MAX_REVIEW_STATE_RECORD_BYTES);
		expect(compacted.result?.coverage.residualRisk).toContain(
			"Durable coverage details were compacted to the host persistence bound.",
		);
	});
});
