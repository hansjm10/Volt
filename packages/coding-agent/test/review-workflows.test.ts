import { describe, expect, test, vi } from "vitest";
import type { ExecuteReviewWorkflowResult, ParsedReview } from "../src/core/review.ts";
import {
	MAX_ACTIVE_REVIEW_WORKFLOWS,
	MAX_RETAINED_REVIEW_RESULTS,
	type ReviewWorkflowExecuteHooks,
	ReviewWorkflowManager,
} from "../src/core/review-workflows.ts";

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

function prepared(workflowId: string, options: { workflowDescription?: string; dispose?: () => Promise<void> } = {}) {
	return {
		workflowId,
		action: "review.uncommitted",
		startedAt: 1_782_470_400_000,
		resolution: {
			description: "uncommitted changes with private metadata",
			...(options.workflowDescription ? { workflowDescription: options.workflowDescription } : {}),
			diffCommand: "git diff exact-base..exact-head",
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

	test("retains only the sanitized workflow description", () => {
		const manager = new ReviewWorkflowManager();
		const { descriptor } = manager.start({
			prepared: prepared("review:safe", { workflowDescription: "PR #7" }),
			execute: async () => completed(),
		});
		expect(descriptor.target.description).toBe("PR #7");
		expect(JSON.stringify(descriptor)).not.toContain("private metadata");
	});

	test("updates a launched provisional workflow and retains it until cancellation settles", async () => {
		const dispose = vi.fn(async () => {});
		let releasePreparation!: () => void;
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const manager = new ReviewWorkflowManager();
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

		started.updatePrepared(prepared("review:preparing", { workflowDescription: "PR #7", dispose }));
		expect(manager.get("review:preparing")?.target.description).toBe("PR #7");
		manager.cancel("review:preparing");
		const remainedActiveUntilPreparationSettled = manager.hasActiveWorkflows;
		releasePreparation();
		await started.finished;

		expect(remainedActiveUntilPreparationSettled).toBe(true);
		expect(started.signal.aborted).toBe(true);
		expect(dispose).toHaveBeenCalledOnce();
		expect(manager.get("review:preparing")?.status).toBe("cancelled");
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
		expect(received).toEqual(["workflow_end"]);
	});
});
