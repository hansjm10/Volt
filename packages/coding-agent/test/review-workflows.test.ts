import { describe, expect, test, vi } from "vitest";
import type { ExecuteReviewWorkflowResult, ParsedReview } from "../src/core/review.ts";
import {
	createReviewFileMetadata,
	MAX_ACTIVE_REVIEW_WORKFLOWS,
	MAX_RETAINED_REVIEW_RESULTS,
	type ReviewWorkflowExecuteHooks,
	ReviewWorkflowManager,
} from "../src/core/review-workflows.ts";
import { ConversationProjectionFeed } from "../src/core/rpc/conversation-projection-feed.ts";

function parsed(findingsCount = 1, completionStatus: ParsedReview["completionStatus"] = "complete"): ParsedReview {
	return {
		completionStatus,
		summary: findingsCount === 0 ? "No findings." : "One finding.",
		findings:
			findingsCount === 0
				? []
				: [
						{
							id: "finding-1",
							fingerprint: "a".repeat(64),
							status: "open",
							title: "Finding",
							body: "Body",
							trigger: "Trigger",
							impact: "Impact",
							category: "correctness",
							rootCauseKey: "root-cause",
							priority: 2,
							confidence: 0.9,
							changeLocation: { path: "src/file.ts", side: "head", startLine: 1, endLine: 1 },
							evidenceLocations: [],
							verification: {
								outcome: "accepted",
								method: "Exact snapshot",
								rationale: "Present",
								confidence: 0.9,
							},
						},
					],
		coverage: {
			changedFileInventoryComplete: true,
			filesInspected: ["src/file.ts"],
			hunksInspected: ["h1"],
			commandsRun: [],
			failedVerificationAttempts: [],
			exclusions: [],
			uncheckedAreas: [],
			residualRisk: [],
			modelReportedLimitations: [],
		},
		...(completionStatus === "complete"
			? findingsCount === 0
				? { overallCorrectness: "correct" as const }
				: { overallCorrectness: "incorrect" as const }
			: {}),
		overallExplanation:
			completionStatus === "incomplete"
				? "Verification did not cover the complete change."
				: findingsCount === 0
					? "No verified findings."
					: "One verified finding.",
	};
}

function completed(
	findingsCount = 1,
	completionStatus: ParsedReview["completionStatus"] = "complete",
	durableRecordCommitted = false,
): ExecuteReviewWorkflowResult {
	return {
		status: "completed",
		raw: "summary",
		parsed: parsed(findingsCount, completionStatus),
		findingsCount,
		completionStatus,
		...(durableRecordCommitted ? { durableRecordCommitted: true as const } : {}),
	};
}

function prepared(
	workflowId: string,
	options: {
		workflowDescription?: string;
		dispose?: () => Promise<void>;
		pullRequest?: { providerId: string; number: number };
	} = {},
) {
	return {
		workflowId,
		action: options.pullRequest ? "review.pr" : "review.uncommitted",
		startedAt: 1_782_470_400_000,
		resolution: {
			description: "uncommitted changes with private metadata",
			...(options.workflowDescription ? { workflowDescription: options.workflowDescription } : {}),
			diffCommand: "git diff exact-base..exact-head",
			...(options.pullRequest
				? {
						identity: {
							kind: "pr" as const,
							baseTree: "base-tree",
							headTree: "head-tree",
							pullRequest: {
								...options.pullRequest,
								title: "Review target title",
								body: "PRIVATE_PULL_REQUEST_BODY",
								url: "https://example.test/pull/7",
								baseRefName: "main",
								headRefName: "feature/review",
								baseRefOid: "a".repeat(40),
								headRefOid: "b".repeat(40),
								author: {
									login: "review-author",
									avatarUrl: "https://example.test/review-author.png",
								},
								reviewState: "draft" as const,
								mergeability: "conflicting" as const,
								checks: {
									state: "failing" as const,
									totalCount: 2,
									passedCount: 1,
									pendingCount: 0,
									failedCount: 1,
									neutralCount: 0,
									unknownCount: 0,
								},
								observedAt: 1_782_470_399_000,
							},
						},
						changedFiles: [
							{
								path: "src/review.ts",
								status: "modified" as const,
								hunks: [],
								additions: 4,
								deletions: 2,
								binary: false,
								reviewable: true,
							},
						],
					}
				: {}),
			...(options.dispose ? { dispose: options.dispose } : {}),
		},
	};
}

describe("ReviewWorkflowManager", () => {
	test("waits for launch, then retains a bounded structured result and emits terminal events", async () => {
		const events: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => events.push(event) });
		let executed = false;
		const started = manager.start({
			prepared: prepared("review:one"),
			fastModeEnabled: true,
			execute: async (hooks: ReviewWorkflowExecuteHooks) => {
				executed = true;
				hooks.onEvent({
					type: "workflow_start",
					workflowId: "review:one",
					kind: "review",
					action: "review.uncommitted",
					title: "Review",
					message: "Reviewing.",
					status: "running",
					startedAt: 1_782_470_400_000,
				});
				return completed();
			},
		});
		expect(executed).toBe(false);
		started.launch();
		started.launch();
		const terminalRecord = await started.finished;
		await manager.waitForIdle();
		expect(executed).toBe(true);
		expect(terminalRecord).toMatchObject({ status: "completed", findingsCount: 1 });
		expect(manager.get("review:one")).toMatchObject({
			status: "completed",
			findingsCount: 1,
			parsed: { completionStatus: "complete" },
		});
		expect(events.map((event) => event.type)).toEqual(["workflow_start", "workflow_end"]);
		expect(events[0]).toMatchObject({
			type: "workflow_start",
			workflowId: "review:one",
			message: "Reviewing uncommitted changes with private metadata.",
		});
		expect(events.at(-1)).toMatchObject({ type: "workflow_end", status: "completed" });
	});

	test("preserves incomplete status in detached records and terminal summaries", async () => {
		const events: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => events.push(event) });
		const started = manager.start({
			prepared: prepared("review:incomplete"),
			execute: async () => completed(0, "incomplete"),
		});
		started.launch();
		await manager.waitForIdle();
		expect(manager.get("review:incomplete")).toMatchObject({
			status: "completed",
			completionStatus: "incomplete",
			findingsCount: 0,
		});
		expect(events.at(-1)).toMatchObject({
			type: "workflow_end",
			status: "completed",
			message: "Review incomplete. Fetch the findings or open them in a review session.",
		});
	});

	test("retains bounded pull request display and changed-file metadata without the private body", () => {
		const manager = new ReviewWorkflowManager();
		const { descriptor } = manager.start({
			prepared: prepared("review:safe", {
				workflowDescription: "PR #7",
				pullRequest: { providerId: "github", number: 7 },
			}),
			execute: async () => completed(),
		});
		expect(descriptor.target).toMatchObject({
			description: "PR #7",
			diffCommand: "git diff exact-base..exact-head",
			pullRequest: {
				provider: "github",
				number: 7,
				title: "Review target title",
				author: { login: "review-author", avatarUrl: "https://example.test/review-author.png" },
				reviewState: "draft",
				mergeability: "conflicting",
				checks: { state: "failing", totalCount: 2 },
			},
			files: {
				totalCount: 1,
				projectedCount: 1,
				omittedCount: 0,
				additions: 4,
				deletions: 2,
				isComplete: true,
				items: [{ path: "src/review.ts", status: "modified", additions: 4, deletions: 2 }],
			},
		});
		expect(JSON.stringify(descriptor)).not.toContain("private metadata");
		expect(JSON.stringify(descriptor)).not.toContain("PRIVATE_PULL_REQUEST_BODY");
	});

	test("reports bounded file projection completeness instead of treating omitted files as an empty change", () => {
		const files = Array.from({ length: 201 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			status: "modified" as const,
			additions: 2,
			deletions: 1,
		}));
		expect(createReviewFileMetadata(files)).toMatchObject({
			totalCount: 201,
			projectedCount: 200,
			omittedCount: 1,
			additions: 402,
			deletions: 201,
			isComplete: false,
		});
		expect(
			createReviewFileMetadata([], {
				totalCount: 3,
				additions: 8,
				deletions: 5,
				inventoryComplete: false,
			}),
		).toEqual({
			totalCount: 3,
			projectedCount: 0,
			omittedCount: 3,
			additions: 8,
			deletions: 5,
			isComplete: false,
			items: [],
		});
	});

	test("publishes and updates a launched provisional workflow before execution admission", async () => {
		const dispose = vi.fn(async () => {});
		let releasePreparation!: () => void;
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const projection = new ConversationProjectionFeed({ subscribe: () => () => {} });
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => projection.publishExternal(event) });
		const started = manager.start({
			provisional: true,
			prepared: prepared("review:preparing", { workflowDescription: "Preparing pull request review" }),
			execute: async (hooks) => {
				await preparationGate;
				if (hooks.signal.aborted) {
					await dispose();
					return { status: "cancelled" };
				}
				return completed();
			},
		});
		started.launch();
		expect(started.signal.aborted).toBe(false);
		expect(manager.get("review:preparing")?.target.description).toBe("Preparing pull request review");
		expect(projection.activeWorkflows).toMatchObject([
			{
				workflowId: "review:preparing",
				workflowEvent: {
					type: "workflow_start",
					workflowId: "review:preparing",
					message: "Preparing pull request review.",
				},
				activeTools: [],
			},
		]);

		started.updatePrepared(
			prepared("review:preparing", {
				workflowDescription: "PR #7",
				dispose,
				pullRequest: { providerId: "github", number: 7 },
			}),
		);
		expect(manager.get("review:preparing")?.target).toMatchObject({
			description: "PR #7",
			pullRequest: { provider: "github", number: 7 },
		});
		expect(projection.activeWorkflows).toMatchObject([
			{
				workflowId: "review:preparing",
				workflowEvent: {
					type: "workflow_update",
					workflowId: "review:preparing",
					message: "Reviewing PR #7.",
					pullRequest: { provider: "github", number: 7 },
				},
				activeTools: [],
			},
		]);
		manager.cancel("review:preparing");
		const remainedActiveUntilPreparationSettled = manager.hasActiveWorkflows;
		releasePreparation();
		await started.finished;

		expect(remainedActiveUntilPreparationSettled).toBe(true);
		expect(started.signal.aborted).toBe(true);
		expect(dispose).toHaveBeenCalledOnce();
		expect(manager.get("review:preparing")?.status).toBe("cancelled");
		expect(projection.activeWorkflows).toEqual([]);
		projection.dispose();
	});

	test("records thrown failures", async () => {
		const manager = new ReviewWorkflowManager();
		const started = manager.start({
			prepared: prepared("review:fail"),
			execute: async () => {
				throw new Error("provider unavailable");
			},
		});
		started.launch();
		await manager.waitForIdle();
		expect(manager.get("review:fail")).toMatchObject({ status: "failed", errorMessage: "provider unavailable" });
	});

	test("cancellation wins a race with a launched execution", async () => {
		const manager = new ReviewWorkflowManager();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = manager.start({
			prepared: prepared("review:cancel"),
			execute: async () => {
				await gate;
				return completed();
			},
		});
		started.launch();
		manager.cancel("review:cancel");
		release();
		await manager.waitForIdle();
		expect(manager.get("review:cancel")?.status).toBe("cancelled");
		expect(() => manager.cancel("review:missing")).toThrow(/No running/);
	});

	test("preserves a committed terminal result when cancellation races settlement", async () => {
		const events: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => events.push(event) });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = manager.start({
			prepared: prepared("review:committed"),
			execute: async () => {
				await gate;
				return completed(0, "incomplete", true);
			},
		});
		started.launch();
		manager.cancel("review:committed");
		release();
		await manager.waitForIdle();
		expect(manager.get("review:committed")).toMatchObject({
			status: "completed",
			completionStatus: "incomplete",
		});
		expect(events.at(-1)).toMatchObject({ type: "workflow_end", status: "completed" });
	});

	test("cancelling an unlaunched workflow disposes its snapshot", async () => {
		const dispose = vi.fn(async () => {});
		const manager = new ReviewWorkflowManager();
		manager.start({ prepared: prepared("review:pending", { dispose }), execute: async () => completed() });
		manager.cancel("review:pending");
		await manager.waitForIdle();
		expect(dispose).toHaveBeenCalledOnce();
		expect(manager.get("review:pending")?.status).toBe("cancelled");
	});

	test("caps concurrent workflows and evicts oldest transient results", async () => {
		const manager = new ReviewWorkflowManager();
		const pending = Array.from({ length: MAX_ACTIVE_REVIEW_WORKFLOWS }, (_, index) =>
			manager.start({ prepared: prepared(`review:active-${index}`), execute: async () => completed() }),
		);
		expect(() => manager.start({ prepared: prepared("review:overflow"), execute: async () => completed() })).toThrow(
			/Too many/,
		);
		for (const workflow of pending) workflow.launch();
		await manager.waitForIdle();
		for (let index = 0; index <= MAX_RETAINED_REVIEW_RESULTS; index++) {
			const workflow = manager.start({
				prepared: prepared(`review:result-${index}`),
				execute: async () => completed(0),
			});
			workflow.launch();
			await manager.waitForIdle();
		}
		expect(manager.get("review:result-0")).toBeUndefined();
		expect(manager.get(`review:result-${MAX_RETAINED_REVIEW_RESULTS}`)?.status).toBe("completed");
	});

	test("observer failures do not break other sinks", async () => {
		const received: string[] = [];
		const manager = new ReviewWorkflowManager({
			publishEvent: () => {
				throw new Error("closed");
			},
		});
		manager.attachSink(() => {
			throw new Error("disposed");
		});
		manager.attachSink((event) => received.push(event.type));
		const started = manager.start({ prepared: prepared("review:sinks"), execute: async () => completed() });
		started.launch();
		await manager.waitForIdle();
		expect(received).toEqual(["workflow_start", "workflow_end"]);
	});
});
