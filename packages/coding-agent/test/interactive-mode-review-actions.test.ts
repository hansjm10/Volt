import { describe, expect, test, vi } from "vitest";
import { REVIEW_FIX_ACTION_ID } from "../src/core/host-actions.ts";
import type { ParsedReview } from "../src/core/review-report.ts";
import { acknowledgeReviewRun, appendReviewRun, getReviewRun, type ReviewRunRecord } from "../src/core/review-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function durableRecord(): ReviewRunRecord {
	const firstFinding: ParsedReview["findings"][number] = {
		id: "finding-1",
		fingerprint: "a".repeat(64),
		status: "open",
		title: "Wrong guard",
		body: "The guard returns the wrong value.",
		trigger: "Call with zero.",
		impact: "The caller receives incorrect data.",
		category: "correctness",
		rootCauseKey: "wrong-zero-guard",
		priority: 2,
		confidence: 0.9,
		changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
		evidenceLocations: [{ path: "src/value.ts", side: "base", startLine: 1, endLine: 3 }],
		verification: {
			outcome: "accepted",
			method: "Exact blob comparison",
			rationale: "The added branch is present.",
			confidence: 0.95,
		},
	};
	return {
		schemaVersion: 1,
		runId: "review:test",
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "uncommitted changes",
			diffCommand: "git diff exact-base..exact-head",
			identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
			files: [
				{
					path: "src/value.ts",
					baseOid: "base-blob",
					headOid: "head-blob",
					hunkIds: ["hunk-1"],
					reviewable: true,
				},
			],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: {
			completionStatus: "complete",
			summary: "Two issues were independently verified.",
			findings: [
				firstFinding,
				{
					...firstFinding,
					id: "finding-2",
					fingerprint: "b".repeat(64),
					title: "Second issue",
				},
			],
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
			overallExplanation: "Two verified findings remain.",
		},
	};
}

describe("InteractiveMode durable review actions", () => {
	test.each([
		{ findingIds: "", acknowledgedAt: undefined },
		{ findingIds: " \t ", acknowledgedAt: 123 },
	])("seeds all durable findings and preserves acknowledgment for blank findingIds $findingIds", async (testCase) => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord());
		if (testCase.acknowledgedAt !== undefined) {
			acknowledgeReviewRun(manager, "review:test", testCase.acknowledgedAt);
		}
		const replacementManager = SessionManager.inMemory("/workspace");
		const seedMessages: object[] = [];
		const fakeThis = {
			session: { sessionManager: manager },
			runtimeHost: {
				newSession: vi.fn(
					async (options: {
						setup(sessionManager: SessionManager): Promise<void>;
						withSession(context: { sendMessage(message: object): Promise<void> }): Promise<void>;
					}) => {
						await options.setup(replacementManager);
						await options.withSession({
							sendMessage: async (message) => {
								seedMessages.push(message);
							},
						});
						return { cancelled: false, seeded: true };
					},
				),
			},
			renderCurrentSessionState: vi.fn(),
		};
		const runInteractiveReviewLifecycleAction = Reflect.get(
			InteractiveMode.prototype,
			"runInteractiveReviewLifecycleAction",
		) as (this: typeof fakeThis, action: string, args: Record<string, unknown>) => Promise<{ status: string }>;

		await expect(
			runInteractiveReviewLifecycleAction.call(fakeThis, REVIEW_FIX_ACTION_ID, {
				runId: "review:test",
				findingIds: testCase.findingIds,
			}),
		).resolves.toMatchObject({ status: "completed" });
		expect(seedMessages).toHaveLength(1);
		const seedMessage = seedMessages[0] as { details?: { findings?: Array<{ id: string }> } };
		expect(seedMessage.details?.findings?.map((finding) => finding.id)).toEqual(["finding-1", "finding-2"]);
		const sourceAcknowledgedAt = getReviewRun(manager, "review:test")?.acknowledgedAt;
		expect(sourceAcknowledgedAt).toEqual(expect.any(Number));
		if (testCase.acknowledgedAt !== undefined) expect(sourceAcknowledgedAt).toBe(testCase.acknowledgedAt);
		expect(getReviewRun(replacementManager, "review:test")?.acknowledgedAt).toBe(sourceAcknowledgedAt);
		expect(fakeThis.renderCurrentSessionState).toHaveBeenCalledOnce();
	});
});
