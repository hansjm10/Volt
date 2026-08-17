import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildReviewPrompt,
	executeReviewWorkflow,
	formatReviewForNewSession,
	listBaseBranches,
	listRecentCommits,
	MAX_GITHUB_PR_NUMBER,
	normalizeReviewPullRequestNumber,
	parseReviewCommandArgs,
	prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	type ReviewUsageSnapshot,
	resolveReviewModel,
	runReview,
} from "../../src/core/review.ts";
import type { ReviewCandidateReport, ReviewVerificationReport } from "../../src/core/review-report.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../../src/core/review-snapshot.ts";
import { getReviewRun } from "../../src/core/review-state.ts";
import { ReviewWorkflowManager } from "../../src/core/review-workflows.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function candidateReport(path = "src/value.ts"): ReviewCandidateReport {
	return {
		summary: "One introduced defect was found.",
		limitations: [],
		candidates: [
			{
				candidateId: "candidate-1",
				title: "Zero returns the numerator",
				body: "The added zero guard returns a plausible but incorrect value.",
				trigger: "Call divide with a zero divisor.",
				impact: "Callers receive the numerator as the result.",
				category: "correctness",
				rootCauseKey: "zero-divisor-returns-input",
				priority: 2,
				confidence: 0.95,
				changeLocation: { path, side: "head", startLine: 2, endLine: 2 },
				evidenceLocations: [],
			},
		],
	};
}

function verificationReport(assessment: "complete" | "incomplete" = "complete"): ReviewVerificationReport {
	return {
		summary: "The candidate was independently verified.",
		assessment,
		...(assessment === "incomplete" ? { challenge: "A changed hunk remains uninspected." } : {}),
		decisions: [
			{
				candidateId: "candidate-1",
				outcome: "accept",
				method: "Compared the exact base and head blobs.",
				rationale: "The added branch returns amount when divisor is zero.",
				confidence: 0.98,
			},
		],
		priorFindingDecisions: [],
		limitations: [],
	};
}

async function createSnapshotRepository(
	harness: Harness,
	options: { agentsPolicy?: string; maxBlobBytes?: number } = {},
): Promise<ReviewSnapshot> {
	mkdirSync(join(harness.tempDir, "src"), { recursive: true });
	git(harness.tempDir, "init", "--initial-branch=main");
	git(harness.tempDir, "config", "user.email", "review@example.com");
	git(harness.tempDir, "config", "user.name", "Review Test");
	writeFileSync(join(harness.tempDir, "AGENTS.md"), options.agentsPolicy ?? "BASE AGENT POLICY\n");
	writeFileSync(join(harness.tempDir, "REVIEW.md"), "BASE REVIEW POLICY\n");
	writeFileSync(
		join(harness.tempDir, "src", "value.ts"),
		"export function divide(amount: number, divisor: number) {\n\treturn amount / divisor;\n}\n",
	);
	git(harness.tempDir, "add", ".");
	git(harness.tempDir, "commit", "-m", "initial");
	writeFileSync(join(harness.tempDir, "REVIEW.md"), "CANDIDATE REVIEW POLICY MUST NOT LOAD\n");
	writeFileSync(
		join(harness.tempDir, "src", "value.ts"),
		"export function divide(amount: number, divisor: number) {\n\tif (divisor === 0) return amount;\n\treturn amount / divisor;\n}\n",
	);
	const snapshot = await resolveReviewSnapshot({ kind: "uncommitted" }, harness.tempDir, {
		maxCommitRefBytes: 1_024,
		maxPullRequestNumber: MAX_GITHUB_PR_NUMBER,
		...(options.maxBlobBytes === undefined ? {} : { limits: { maxBlobBytes: options.maxBlobBytes } }),
	});
	if ("error" in snapshot) throw new Error(snapshot.error);
	return snapshot;
}

describe("review command controls", () => {
	it("parses quoted focus, scopes, effort, optional findings, and scope mode", () => {
		expect(
			parseReviewCommandArgs(
				'branch main --focus "security boundary" --scope "src/**/*.ts,test/**/*.ts" --effort high --include-optional --full',
			),
		).toEqual({
			target: { kind: "branch", base: "main" },
			controls: {
				focus: "security boundary",
				scope: ["src/**/*.ts", "test/**/*.ts"],
				effort: "high",
				includeOptional: true,
				scopeMode: "full",
			},
		});
		expect(parseReviewCommandArgs("uncommitted --incremental").controls?.scopeMode).toBe("incremental");
		expect(parseReviewCommandArgs('commit HEAD --focus "unterminated').error).toMatch(/Unterminated/);
		expect(parseReviewCommandArgs("pr 1 --effort extreme").error).toMatch(/low, standard, or high/);
		expect(parseReviewCommandArgs("tools now").error).toMatch(/Unexpected arguments/);
	});

	it("normalizes bounded canonical pull request numbers", () => {
		expect(normalizeReviewPullRequestNumber(undefined)).toEqual({});
		expect(normalizeReviewPullRequestNumber("42")).toEqual({ number: "42" });
		expect(normalizeReviewPullRequestNumber("01")).toEqual({ error: expect.stringContaining("canonical") });
		expect(normalizeReviewPullRequestNumber(String(MAX_GITHUB_PR_NUMBER + 1))).toEqual({ error: expect.any(String) });
	});

	it("rejects controls that cannot be persisted losslessly before resolving the target", async () => {
		const harness = await createHarness();
		const options = {
			target: { kind: "uncommitted" as const },
			cwd: harness.tempDir,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			currentModel: harness.session.model,
		};
		try {
			await expect(prepareReviewWorkflow({ ...options, controls: { focus: "x".repeat(4_001) } })).rejects.toThrow(
				/at most 4000 UTF-8 bytes/,
			);
			await expect(
				prepareReviewWorkflow({ ...options, controls: { scope: Array.from({ length: 51 }, () => "src/**") } }),
			).rejects.toThrow(/at most 50 patterns/);
			await expect(prepareReviewWorkflow({ ...options, controls: { scope: ["x".repeat(501)] } })).rejects.toThrow(
				/at most 500 UTF-8 bytes/,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("emits capability-aware immutable-tool instructions", async () => {
		const harness = await createHarness();
		const snapshot = await createSnapshotRepository(harness);
		try {
			const readOnly = buildReviewPrompt(snapshot, { scope: ["src/**/*.ts"] }, false);
			expect(readOnly).toContain("No command-capable tool is available");
			expect(readOnly).not.toContain("run tests with bash");
			const commandCapable = buildReviewPrompt(snapshot, {}, true);
			expect(commandCapable).toContain("disposable checkout");
			expect(commandCapable).toContain("review_changed_files");
		} finally {
			await snapshot.dispose();
			harness.cleanup();
		}
	});
});

describe("two-pass review pipeline", () => {
	const harnesses: Harness[] = [];
	const snapshots: ReviewSnapshot[] = [];

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("loads base-side policy, uses immutable tools, and verifies in a fresh context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "REVIEW.md"), "USER REVIEW POLICY\n");
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		const requestSnapshots: Array<{ systemPrompt: string; tools: string[]; messages: string }> = [];
		const capture = (context: Parameters<FauxResponseFactory>[0]) => {
			requestSnapshots.push({
				systemPrompt: context.systemPrompt ?? "",
				tools: context.tools?.map((tool) => tool.name).sort() ?? [],
				messages: JSON.stringify(context.messages),
			});
		};
		harness.setResponses([
			(context) => {
				capture(context);
				return fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
				stopReason: "toolUse",
			}),
			(context) => {
				capture(context);
				return fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport() as never), {
				stopReason: "toolUse",
			}),
		]);

		const run = await runReview({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			verifierModel: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full", scope: ["src/**"] },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toBeUndefined();
		expect(run.parsed).toMatchObject({ completionStatus: "complete", overallCorrectness: "incorrect" });
		expect(run.parsed?.findings).toHaveLength(1);
		expect(requestSnapshots).toHaveLength(2);
		expect(requestSnapshots[0]?.systemPrompt).toContain("BASE REVIEW POLICY");
		expect(requestSnapshots[0]?.systemPrompt).toContain("BASE AGENT POLICY");
		expect(requestSnapshots[0]?.systemPrompt).toContain("USER REVIEW POLICY");
		expect(requestSnapshots[0]?.systemPrompt).not.toContain("CANDIDATE REVIEW POLICY MUST NOT LOAD");
		expect(requestSnapshots[0]?.tools).toContain("report_review_candidates");
		expect(requestSnapshots[0]?.tools).not.toContain("read");
		expect(requestSnapshots[1]?.tools).toContain("report_review_verification");
		expect(requestSnapshots[1]?.tools).not.toContain("report_review_candidates");
		expect(requestSnapshots[1]?.messages).not.toContain("Candidate report accepted");
		expect(harness.session.messages).toHaveLength(0);
	});

	it("projects active-pass context and cumulative usage across both isolated sessions", async () => {
		const harness = await createHarness({
			models: [
				{ id: "review-discovery", contextWindow: 100_000 },
				{ id: "review-verification", contextWindow: 200_000 },
			],
		});
		harnesses.push(harness);
		const discoveryModel = harness.getModel("review-discovery");
		const verificationModel = harness.getModel("review-verification");
		if (!discoveryModel || !verificationModel) throw new Error("Expected both review models");
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("report_review_candidates", {
					summary: "No candidates.",
					candidates: [],
					limitations: [],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("report_review_verification", {
					summary: "No omission found.",
					assessment: "complete",
					decisions: [],
					priorFindingDecisions: [],
					limitations: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const usageSnapshots: ReviewUsageSnapshot[] = [];

		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: discoveryModel,
			verifierModel: verificationModel,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full" },
			onUsage: (usage) => usageSnapshots.push(usage),
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toBeUndefined();

		const discoveryFinal = usageSnapshots.filter((usage) => usage.pass === "discovery").at(-1);
		const verificationSnapshots = usageSnapshots.filter((usage) => usage.pass === "verification");
		expect(discoveryFinal).toMatchObject({
			model: { id: "review-discovery" },
			contextUsage: { contextWindow: 100_000 },
		});
		expect(discoveryFinal?.totals.input).toBeGreaterThan(0);
		expect(verificationSnapshots[0]?.totals).toEqual(discoveryFinal?.totals);
		const verificationFinal = verificationSnapshots.at(-1);
		expect(verificationFinal?.totals.input).toBeGreaterThan(discoveryFinal?.totals.input ?? Number.MAX_VALUE);
		expect(verificationFinal).toMatchObject({
			pass: "verification",
			model: { id: "review-verification" },
			contextUsage: { contextWindow: 200_000 },
		});
	});

	it("repairs candidates anchored outside the explicit path scope", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		const excluded = candidateReport("REVIEW.md");
		excluded.candidates[0]!.changeLocation = { path: "REVIEW.md", side: "head", startLine: 1, endLine: 1 };
		let repairMessages = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("report_review_candidates", excluded as never), {
				stopReason: "toolUse",
			}),
			(context) => {
				repairMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport() as never), {
				stopReason: "toolUse",
			}),
		]);

		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			verifierModel: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full", scope: ["src/**"] },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toBeUndefined();
		expect(run.parsed).toMatchObject({ completionStatus: "complete", overallCorrectness: "incorrect" });
		expect(run.parsed?.findings).toMatchObject([{ changeLocation: { path: "src/value.ts" } }]);
		expect(repairMessages).toContain("outside the effective review scope");
	});

	it("fails closed before model execution when a snapshot policy file is oversized", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness, {
			agentsPolicy: "policy".repeat(64),
			maxBlobBytes: 64,
		});
		snapshots.push(snapshot);

		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			verifierModel: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full" },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toMatch(/Could not load snapshot policy AGENTS\.md.*64 bytes/i);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("sanitizes remote provider failures before returning or persisting them", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const remoteSnapshot = await createSnapshotRepository(harness);
		snapshots.push(remoteSnapshot);
		const localSnapshot = await resolveReviewSnapshot({ kind: "uncommitted" }, harness.tempDir, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: MAX_GITHUB_PR_NUMBER,
		});
		if ("error" in localSnapshot) throw new Error(localSnapshot.error);
		snapshots.push(localSnapshot);
		const privateDiagnostic =
			"Provider request to https://private-llm.internal/v1 failed while reading C:\\Users\\reviewer\\private-provider.json";
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: privateDiagnostic }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: privateDiagnostic }),
		]);
		const sessionManager = SessionManager.create(harness.tempDir, join(harness.tempDir, "remote-sessions"));
		const remoteOutcome = await executeReviewWorkflow({
			prepared: {
				workflowId: "review:remote-provider-failure",
				action: "review.uncommitted",
				target: { kind: "uncommitted" },
				controls: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
				resolution: remoteSnapshot,
				model: harness.getModel(),
				verifierModel: harness.getModel(),
				startedAt: 1,
				incrementalPlan: {
					mode: "full",
					changedPaths: remoteSnapshot.changedFiles.map((file) => file.path),
					priorOpenFindings: [],
					suppressedDismissedFingerprints: [],
				},
			},
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			sessionManager,
			sanitizeRemoteErrors: true,
		});
		snapshots.splice(snapshots.indexOf(remoteSnapshot), 1);
		expect(remoteOutcome).toMatchObject({
			status: "failed",
			errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE,
			record: { errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE },
		});
		expect(JSON.stringify(remoteOutcome)).not.toContain(privateDiagnostic);
		const reopened = SessionManager.open(sessionManager.getSessionFile()!);
		expect(getReviewRun(reopened, "review:remote-provider-failure")).toMatchObject({
			status: "failed",
			errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE,
		});
		expect(JSON.stringify(getReviewRun(reopened, "review:remote-provider-failure"))).not.toContain(privateDiagnostic);

		const localOutcome = await executeReviewWorkflow({
			prepared: {
				workflowId: "review:local-provider-failure",
				action: "review.uncommitted",
				target: { kind: "uncommitted" },
				controls: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
				resolution: localSnapshot,
				model: harness.getModel(),
				verifierModel: harness.getModel(),
				startedAt: 1,
				incrementalPlan: {
					mode: "full",
					changedPaths: localSnapshot.changedFiles.map((file) => file.path),
					priorOpenFindings: [],
					suppressedDismissedFingerprints: [],
				},
			},
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
		});
		snapshots.splice(snapshots.indexOf(localSnapshot), 1);
		expect(localOutcome).toMatchObject({ status: "failed", errorMessage: privateDiagnostic });
	});

	it("does not credit complete discovery coverage to a verifier that inspects nothing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport() as never), {
				stopReason: "toolUse",
			}),
		]);

		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			verifierModel: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full", scope: ["src/**"] },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toBeUndefined();
		expect(run.parsed).toMatchObject({ completionStatus: "incomplete" });
		expect(run.parsed?.overallCorrectness).toBeUndefined();
		expect(run.parsed?.coverage).toMatchObject({
			changedFileInventoryComplete: false,
			filesInspected: [],
			hunksInspected: [],
		});
	});

	it("requires the verifier to inspect relevant hunks after inventorying changed files", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport() as never), {
				stopReason: "toolUse",
			}),
		]);

		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			verifierModel: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full", scope: ["src/**"] },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toBeUndefined();
		expect(run.parsed).toMatchObject({ completionStatus: "incomplete" });
		expect(run.parsed?.overallCorrectness).toBeUndefined();
		expect(run.parsed?.coverage).toMatchObject({
			changedFileInventoryComplete: true,
			filesInspected: [],
			hunksInspected: [],
		});
		expect(run.parsed?.coverage.uncheckedAreas).toEqual([
			expect.stringContaining("Changed hunk was not fully inspected"),
		]);
	});

	it("applies the prepared incremental plan during workflow execution", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		let discoveryMessages = "";
		let repairMessages = "";
		harness.setResponses([
			(context) => {
				discoveryMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				repairMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(
					fauxToolCall("report_review_candidates", {
						summary: "No candidates.",
						candidates: [],
						limitations: [],
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("report_review_verification", {
					summary: "No omission found.",
					assessment: "complete",
					decisions: [],
					priorFindingDecisions: [],
					limitations: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);

		const outcome = await executeReviewWorkflow({
			prepared: {
				workflowId: "review:incremental",
				action: "review.uncommitted",
				target: { kind: "uncommitted" },
				controls: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
				resolution: snapshot,
				model: harness.getModel(),
				verifierModel: harness.getModel(),
				startedAt: 1,
				incrementalPlan: {
					mode: "incremental",
					changedPaths: [],
					priorOpenFindings: [],
					suppressedDismissedFingerprints: [],
				},
			},
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(outcome).toMatchObject({
			status: "completed",
			completionStatus: "complete",
			findingsCount: 0,
		});
		expect(discoveryMessages).toContain('\\"inScope\\":false');
		expect(repairMessages).toContain("outside the effective review scope");
	});

	it("does not retain stale prior anchors for files re-reviewed incrementally", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionManager = harness.session.sessionManager;
		if (!sessionManager) throw new Error("Expected the harness session to have durable state");
		const controls = { scope: ["src/**"], effort: "standard" as const, includeOptional: false };
		const priorSnapshot = await createSnapshotRepository(harness);
		snapshots.push(priorSnapshot);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport() as never), {
				stopReason: "toolUse",
			}),
		]);
		const priorOutcome = await executeReviewWorkflow({
			prepared: {
				workflowId: "review:prior-anchor",
				action: "review.uncommitted",
				target: { kind: "uncommitted" },
				controls: { ...controls, scopeMode: "full" },
				resolution: priorSnapshot,
				model: harness.getModel(),
				verifierModel: harness.getModel(),
				startedAt: 1,
				incrementalPlan: {
					mode: "full",
					changedPaths: priorSnapshot.changedFiles.map((file) => file.path),
					priorOpenFindings: [],
					suppressedDismissedFingerprints: [],
				},
			},
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			sessionManager,
		});
		snapshots.splice(snapshots.indexOf(priorSnapshot), 1);
		expect(priorOutcome.status).toBe("completed");
		if (priorOutcome.status !== "completed") throw new Error(`Prior review ended with ${priorOutcome.status}`);
		const priorFinding = priorOutcome.parsed.findings[0]!;

		writeFileSync(
			join(harness.tempDir, "src", "value.ts"),
			"export function divide(amount: number, divisor: number) {\n\t// shifted after the prior review\n\tif (divisor === 0) return amount;\n\treturn amount / divisor;\n}\n",
		);
		const prepared = await prepareReviewWorkflow({
			target: { kind: "uncommitted" },
			controls: { ...controls, scopeMode: "incremental" },
			cwd: harness.tempDir,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			currentModel: harness.getModel(),
			sessionManager,
		});
		snapshots.push(prepared.resolution);
		expect(prepared.incrementalPlan).toMatchObject({
			mode: "incremental",
			changedPaths: ["src/value.ts"],
			priorOpenFindings: [],
		});

		const rediscovered = candidateReport();
		rediscovered.candidates[0]!.changeLocation = { path: "src/value.ts", side: "head", startLine: 3, endLine: 3 };
		let verificationMessages = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("report_review_candidates", rediscovered as never), {
				stopReason: "toolUse",
			}),
			(context) => {
				verificationMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport() as never), {
				stopReason: "toolUse",
			}),
		]);
		const currentOutcome = await executeReviewWorkflow({
			prepared,
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			sessionManager,
		});
		snapshots.splice(snapshots.indexOf(prepared.resolution), 1);
		expect(currentOutcome.status).toBe("completed");
		if (currentOutcome.status !== "completed") throw new Error(`Current review ended with ${currentOutcome.status}`);
		expect(verificationMessages).toContain("<prior_open_findings>[]</prior_open_findings>");
		expect(currentOutcome.parsed.findings).toHaveLength(1);
		expect(currentOutcome.parsed.findings[0]).toMatchObject({
			changeLocation: { path: "src/value.ts", startLine: 3, endLine: 3 },
		});
		expect(currentOutcome.parsed.findings[0]?.fingerprint).not.toBe(priorFinding.fingerprint);
		expect(currentOutcome.parsed.findings[0]?.id).not.toBe(priorFinding.id);
	});

	it("keeps a committed incomplete review authoritative when cancellation races durability", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		const originManager = SessionManager.create(harness.tempDir, join(harness.tempDir, "origin-sessions"));
		const originFile = originManager.getSessionFile()!;
		const originalMaterialize = originManager.materialize.bind(originManager);
		let markMaterializeStarted!: () => void;
		const materializeStarted = new Promise<void>((resolve) => {
			markMaterializeStarted = resolve;
		});
		let releaseMaterialize!: () => void;
		const materializeGate = new Promise<void>((resolve) => {
			releaseMaterialize = resolve;
		});
		vi.spyOn(originManager, "materialize").mockImplementation(async () => {
			markMaterializeStarted();
			await materializeGate;
			await originalMaterialize();
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport() as never), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("review_changed_files", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/value.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("report_review_verification", verificationReport("incomplete") as never), {
				stopReason: "toolUse",
			}),
		]);

		const workflowId = "review:durable-origin";
		const prepared = {
			workflowId,
			action: "review.uncommitted",
			target: { kind: "uncommitted" as const },
			controls: { scope: [], effort: "standard" as const, includeOptional: false, scopeMode: "full" as const },
			resolution: snapshot,
			model: harness.getModel(),
			verifierModel: harness.getModel(),
			startedAt: 1,
			incrementalPlan: {
				mode: "full" as const,
				changedPaths: ["src/value.ts"],
				priorOpenFindings: [],
				suppressedDismissedFingerprints: [],
			},
		};
		const events: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => events.push(event) });
		let settled = false;
		const started = manager.start({
			prepared,
			execute: async (hooks) => {
				const outcome = await executeReviewWorkflow({
					prepared,
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					modelRegistry: harness.session.modelRegistry,
					settingsManager: harness.settingsManager,
					sessionManager: originManager,
					signal: hooks.signal,
					onEvent: hooks.onEvent,
				});
				settled = true;
				return outcome;
			},
		});
		started.launch();
		await materializeStarted;
		try {
			expect(settled).toBe(false);
			expect(existsSync(originFile)).toBe(false);
			manager.cancel(workflowId);
		} finally {
			releaseMaterialize();
		}

		await manager.waitForIdle();
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(manager.get(workflowId)).toMatchObject({
			status: "completed",
			completionStatus: "incomplete",
		});
		expect(events.at(-1)).toMatchObject({
			type: "workflow_end",
			status: "completed",
			message: expect.stringContaining("Review incomplete"),
		});
		const reopened = SessionManager.open(originFile);
		expect(getReviewRun(reopened, workflowId)).toMatchObject({
			runId: workflowId,
			status: "incomplete",
		});
	});

	it("makes exactly one corrective report attempt and then fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport("missing.ts") as never), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("report_review_candidates", candidateReport("still-missing.ts") as never), {
				stopReason: "toolUse",
			}),
		]);
		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full" },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(run.errorMessage).toMatch(/discovery report validation failed/);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("always runs verification for zero candidates and withholds correctness without coverage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const snapshot = await createSnapshotRepository(harness);
		snapshots.push(snapshot);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("report_review_candidates", { summary: "No candidates.", candidates: [], limitations: [] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("report_review_verification", {
					summary: "No omission found.",
					assessment: "complete",
					decisions: [],
					priorFindingDecisions: [],
					limitations: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const run = await runReview({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resolved: snapshot,
			controls: { scopeMode: "full" },
		});
		snapshots.splice(snapshots.indexOf(snapshot), 1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(run.parsed?.completionStatus).toBe("incomplete");
		expect(run.parsed?.overallCorrectness).toBeUndefined();
	});
});

describe("review presentation and repository helpers", () => {
	it("formats durable structured findings without legacy file/line fields", () => {
		const parsed = {
			completionStatus: "complete" as const,
			summary: "One issue.",
			findings: [
				{
					...candidateReport().candidates[0],
					id: "finding-1",
					fingerprint: "f".repeat(64),
					status: "open" as const,
					verification: {
						outcome: "accepted" as const,
						method: "Exact blobs",
						rationale: "Present",
						confidence: 0.9,
					},
				},
			],
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: ["src/value.ts"],
				hunksInspected: ["h1"],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
			overallCorrectness: "incorrect" as const,
			overallExplanation: "A verified issue remains.",
		};
		const text = formatReviewForNewSession({ description: "the change", diffCommand: "git diff base..head" }, parsed);
		expect(text).toContain("finding-1");
		expect(text).toContain("src/value.ts:2-2, head");
	});

	it("lists likely base branches and recent commits", async () => {
		const harness = await createHarness();
		try {
			git(harness.tempDir, "init", "--initial-branch=main");
			git(harness.tempDir, "config", "user.email", "review@example.com");
			git(harness.tempDir, "config", "user.name", "Review Test");
			writeFileSync(join(harness.tempDir, "file.txt"), "value\n");
			git(harness.tempDir, "add", "file.txt");
			git(harness.tempDir, "commit", "-m", "initial value");
			git(harness.tempDir, "branch", "develop");
			expect(await listBaseBranches(harness.tempDir)).toEqual(["main", "develop"]);
			expect(await listRecentCommits(harness.tempDir, 1)).toMatchObject([{ subject: "initial value" }]);
		} finally {
			harness.cleanup();
		}
	});

	it("selects configured discovery models and verifier settings independently", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setReviewModel(`${harness.getModel().provider}/${harness.getModel().id}`);
			harness.settingsManager.setReviewVerifierModel(`${harness.getModel().provider}/${harness.getModel().id}`);
			expect(
				resolveReviewModel({
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
					currentModel: harness.session.model,
				}).model?.id,
			).toBe(harness.getModel().id);
			expect(harness.settingsManager.getReviewVerifierModel()).toContain(harness.getModel().id);
		} finally {
			harness.cleanup();
		}
	});
});
