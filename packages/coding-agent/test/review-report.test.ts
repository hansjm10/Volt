import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildParsedReview,
	createReviewCandidateReportCollector,
	createReviewPresentationReportCollector,
	createReviewVerificationReportCollector,
	declassifyReviewFindings,
	type ReviewCandidateReport,
	type ReviewPresentationReport,
	type ReviewVerificationReport,
	validateReviewCandidates,
	validateReviewPresentations,
	validateReviewVerification,
} from "../src/core/review-report.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../src/core/review-snapshot.ts";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

describe("structured review reports", () => {
	const directories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(maxBlobBytes?: number): Promise<ReviewSnapshot> {
		const directory = join(tmpdir(), `volt-review-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(directory, "src"), { recursive: true });
		mkdirSync(join(directory, "docs"), { recursive: true });
		directories.push(directory);
		git(directory, "init", "--initial-branch=main");
		git(directory, "config", "user.email", "review@example.com");
		git(directory, "config", "user.name", "Review Test");
		writeFileSync(
			join(directory, "src", "divide.ts"),
			"export function divide(amount: number, divisor: number) {\n\treturn amount / divisor;\n}\n",
		);
		writeFileSync(join(directory, "docs", "context.txt"), "x".repeat(512));
		git(directory, "add", ".");
		git(directory, "commit", "-m", "initial");
		writeFileSync(
			join(directory, "src", "divide.ts"),
			"export function divide(amount: number, divisor: number) {\n\tif (divisor === 0) return amount;\n\treturn amount / divisor;\n}\n",
		);
		const result = await resolveReviewSnapshot({ kind: "uncommitted" }, directory, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: 2_147_483_647,
			...(maxBlobBytes === undefined ? {} : { limits: { maxBlobBytes } }),
		});
		if ("error" in result) throw new Error(result.error);
		snapshots.push(result);
		return result;
	}

	function report(overrides: Partial<ReviewCandidateReport["candidates"][number]> = {}): ReviewCandidateReport {
		return {
			summary: "One candidate was discovered.",
			limitations: [],
			candidates: [
				{
					candidateId: "candidate-1",
					title: "Zero divisor returns the numerator",
					body: "The new branch returns a non-result instead of preserving the division contract.",
					trigger: "Call divide with a zero divisor.",
					impact: "Callers receive the numerator as a valid-looking result.",
					category: "correctness",
					rootCauseKey: "zero-divisor-returns-input",
					priority: 2,
					confidence: 0.95,
					changeLocation: { path: "src/divide.ts", side: "head", startLine: 2, endLine: 2 },
					evidenceLocations: [{ path: "src/divide.ts", side: "base", startLine: 1, endLine: 3 }],
					...overrides,
				},
			],
		};
	}

	function validationOptions(
		snapshot: ReviewSnapshot,
		inScopeHunkIds = new Set(snapshot.changedFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id))),
	) {
		return { includeOptional: false, inScopeHunkIds };
	}

	it("collects reports only through terminating typed tools", async () => {
		const candidates = createReviewCandidateReportCollector();
		const candidateResult = await candidates.tool.execute("call", report(), undefined, undefined, {} as never);
		expect(candidateResult.disposition).toBe("stop");
		expect(candidates.getReport()?.candidates[0]?.candidateId).toBe("candidate-1");

		const verification = createReviewVerificationReportCollector();
		const verificationReport: ReviewVerificationReport = {
			summary: "The candidate is verified.",
			assessment: "complete",
			decisions: [
				{
					candidateId: "candidate-1",
					outcome: "accept",
					method: "Inspected both blob revisions.",
					rationale: "The added branch returns amount.",
					confidence: 0.98,
				},
			],
			priorFindingDecisions: [],
			limitations: [],
		};
		const verificationResult = await verification.tool.execute(
			"call",
			verificationReport,
			undefined,
			undefined,
			{} as never,
		);
		expect(verificationResult.disposition).toBe("stop");
		expect(verification.getReport()).toEqual(verificationReport);
	});

	it("declassifies PR analysis before building the public presentation", async () => {
		const privateMarker = "private-github-discussion-marker";
		const snapshot = await setup();
		const privateReport = report({
			title: privateMarker,
			body: privateMarker,
			trigger: privateMarker,
			impact: privateMarker,
			category: privateMarker,
			rootCauseKey: privateMarker,
			confidence: 0.956,
		});
		privateReport.summary = privateMarker;
		privateReport.limitations = [privateMarker];
		const validation = await validateReviewCandidates(snapshot, privateReport, validationOptions(snapshot));
		expect(validation.errors).toEqual([]);
		const verification: ReviewVerificationReport = {
			summary: privateMarker,
			assessment: "complete",
			decisions: [
				{
					candidateId: "candidate-1",
					outcome: "accept",
					method: privateMarker,
					rationale: privateMarker,
					confidence: 0.987,
				},
			],
			priorFindingDecisions: [],
			limitations: [privateMarker],
		};
		const declassified = declassifyReviewFindings(validation.candidates, verification);
		expect(declassified).toHaveLength(1);
		expect(declassified[0]?.confidence).toBe(0.96);
		expect(JSON.stringify(declassified)).not.toContain(privateMarker);
		const presentation: ReviewPresentationReport = {
			findings: [
				{
					presentationId: declassified[0]!.presentationId,
					title: "Zero divisor returns the numerator",
					body: "The new guard returns the numerator instead of a division result.",
					trigger: "Call divide with a zero divisor.",
					impact: "Callers receive a plausible but incorrect value.",
					category: "correctness",
					rootCauseKey: "zero-divisor-returns-input",
					rationale: "The changed branch directly returns amount.",
				},
			],
		};
		const collector = createReviewPresentationReportCollector();
		await collector.tool.execute("call", presentation, undefined, undefined, {} as never);
		expect(collector.getReport()).toEqual(presentation);
		expect(validateReviewPresentations(declassified, presentation)).toEqual([]);
		expect(
			validateReviewPresentations(declassified, presentation, {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: [],
				searchesRun: 0,
				treePagesRead: 0,
				diffFilesFullyRead: [],
			}).join(" "),
		).toContain("did not inspect changed hunk");

		snapshot.codeHostContext = {
			manifest: {
				status: "complete",
				capturedAt: "2026-01-01T00:00:00Z",
				linkedIssueCount: 0,
				discussionEntryCount: 1,
				renderedLinkedIssueCount: 0,
				renderedDiscussionEntryCount: 1,
				renderedBytes: 100,
				limitations: [],
				fingerprint: "d".repeat(64),
			},
			linkedIssues: [],
			discussionEntries: [{ id: "comment-1", kind: "pr-comment", body: privateMarker }],
			rendered: privateMarker,
		};
		const hunkIds = snapshot.changedFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id));
		const observed = {
			changedFileInventoryComplete: true,
			contextInspectionComplete: true,
			contextPagesRead: 1,
			filesRead: [],
			hunksInspected: hunkIds,
			searchesRun: 0,
			treePagesRead: 0,
			diffFilesFullyRead: ["src/divide.ts"],
		};
		const parsed = buildParsedReview({
			snapshot,
			candidateReport: privateReport,
			validatedCandidates: validation.candidates,
			verificationReport: verification,
			declassifiedFindings: declassified,
			presentationReport: presentation,
			discoveryCoverage: observed,
			verificationCoverage: observed,
			commandsRun: [privateMarker],
			failedVerificationAttempts: [privateMarker],
			excludedPaths: [],
		});
		expect(JSON.stringify(parsed)).not.toContain(privateMarker);
		expect(parsed).toMatchObject({
			summary: "Review completed with 1 verified finding.",
			findings: [
				{
					title: "Zero divisor returns the numerator",
					confidence: 0.96,
					verification: {
						outcome: "accepted",
						method:
							"Independent verification accepted this finding; a separate context-blind pass rendered the code-based rationale.",
						rationale: "The changed branch directly returns amount.",
						confidence: 0.96,
					},
				},
			],
			coverage: {
				commandsRun: ["1 bash command(s) completed during review."],
				failedVerificationAttempts: ["1 verification tool attempt(s) failed."],
				modelReportedLimitations: [
					"Discovery reported 1 model limitation(s).",
					"Verification reported 1 model limitation(s).",
				],
			},
		});
	});

	it("validates changed-side anchors and computes stable host fingerprints", async () => {
		const snapshot = await setup();
		const first = await validateReviewCandidates(snapshot, report(), validationOptions(snapshot));
		const second = await validateReviewCandidates(snapshot, report(), validationOptions(snapshot));
		expect(first.errors).toEqual([]);
		expect(first.candidates[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(first.candidates[0]?.fingerprint).toBe(second.candidates[0]?.fingerprint);

		const outOfScope = await validateReviewCandidates(snapshot, report(), validationOptions(snapshot, new Set()));
		expect(outOfScope.errors.join(" ")).toContain("outside the effective review scope");
		expect(outOfScope.candidates).toEqual([]);
		const unchangedAnchor = await validateReviewCandidates(
			snapshot,
			report({ changeLocation: { path: "src/divide.ts", side: "head", startLine: 1, endLine: 1 } }),
			validationOptions(snapshot),
		);
		expect(unchangedAnchor.errors.join(" ")).toContain("changed head line");
		const traversal = await validateReviewCandidates(
			snapshot,
			report({ changeLocation: { path: "../secret", side: "head", startLine: 2, endLine: 2 } }),
			validationOptions(snapshot),
		);
		expect(traversal.errors.join(" ")).toMatch(/relative|traverse/);
		const optional = await validateReviewCandidates(snapshot, report({ priority: 3 }), validationOptions(snapshot));
		expect(optional.errors.join(" ")).toContain("P3");
	});

	it("rejects unavailable evidence locations", async () => {
		const snapshot = await setup(256);
		const validation = await validateReviewCandidates(
			snapshot,
			report({
				evidenceLocations: [{ path: "docs/context.txt", side: "base", startLine: 1, endLine: 1 }],
			}),
			validationOptions(snapshot),
		);
		expect(validation.errors.join(" ")).toMatch(/unavailable content.*256 bytes/i);
	});

	it("rejects duplicate root-cause anchors and incomplete verifier decision sets", async () => {
		const snapshot = await setup();
		const duplicated = report();
		duplicated.candidates.push({
			...duplicated.candidates[0],
			candidateId: "candidate-2",
			title: "Duplicate symptom",
		});
		const validation = await validateReviewCandidates(snapshot, duplicated, validationOptions(snapshot));
		expect(validation.errors.join(" ")).toContain("duplicate root-cause anchor");

		const valid = await validateReviewCandidates(snapshot, report(), validationOptions(snapshot));
		expect(
			validateReviewVerification(valid.candidates, {
				summary: "Missing the decision.",
				assessment: "complete",
				decisions: [],
				priorFindingDecisions: [],
				limitations: [],
			})
				.join(" ")
				.toLowerCase(),
		).toContain("missing verification decision");
	});

	it("derives completeness, correctness, and coverage from host observations", async () => {
		const snapshot = await setup();
		const validated = await validateReviewCandidates(snapshot, report(), validationOptions(snapshot));
		const verification: ReviewVerificationReport = {
			summary: "The candidate is accepted.",
			assessment: "complete",
			decisions: [
				{
					candidateId: "candidate-1",
					outcome: "accept",
					method: "Compared exact blobs.",
					rationale: "The trigger is present.",
					confidence: 0.98,
				},
			],
			priorFindingDecisions: [],
			limitations: [],
		};
		const hunkIds = snapshot.changedFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id));
		const complete = buildParsedReview({
			snapshot,
			candidateReport: report(),
			validatedCandidates: validated.candidates,
			verificationReport: verification,
			discoveryCoverage: {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: hunkIds,
				searchesRun: 0,
				treePagesRead: 0,
				diffFilesFullyRead: ["src/divide.ts"],
			},
			verificationCoverage: {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: hunkIds,
				searchesRun: 1,
				treePagesRead: 1,
				diffFilesFullyRead: ["src/divide.ts"],
			},
			commandsRun: ["npm run focused-check"],
			failedVerificationAttempts: ["bash: npm run missing"],
			excludedPaths: [],
		});
		expect(complete).toMatchObject({ completionStatus: "complete", overallCorrectness: "incorrect" });
		expect(complete.coverage).toMatchObject({
			filesInspected: ["src/divide.ts"],
			commandsRun: ["npm run focused-check"],
			failedVerificationAttempts: ["bash: npm run missing"],
		});
		expect(complete.findings[0]).toMatchObject({
			confidence: 0.95,
			verification: {
				outcome: "accepted",
				method: "Compared exact blobs.",
				rationale: "The trigger is present.",
				confidence: 0.98,
			},
		});
		expect(complete.findings[0]).not.toHaveProperty("file");

		const incomplete = buildParsedReview({
			snapshot,
			candidateReport: { summary: "No findings.", candidates: [], limitations: [] },
			validatedCandidates: [],
			verificationReport: {
				summary: "No omission found.",
				assessment: "complete",
				decisions: [],
				priorFindingDecisions: [],
				limitations: [],
			},
			discoveryCoverage: {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: [],
				searchesRun: 0,
				treePagesRead: 0,
				diffFilesFullyRead: [],
			},
			verificationCoverage: {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: [],
				searchesRun: 0,
				treePagesRead: 0,
				diffFilesFullyRead: [],
			},
			commandsRun: [],
			failedVerificationAttempts: [],
			excludedPaths: [],
		});
		expect(incomplete.completionStatus).toBe("incomplete");
		expect(incomplete.overallCorrectness).toBeUndefined();
		expect(incomplete.coverage.uncheckedAreas).toHaveLength(1);
	});

	it("withholds correctness when PR context capture or either pass inspection is incomplete", async () => {
		const snapshot = await setup();
		snapshot.codeHostContext = {
			manifest: {
				status: "incomplete",
				capturedAt: "2026-01-01T00:00:00Z",
				linkedIssueCount: 1,
				discussionEntryCount: 2,
				renderedLinkedIssueCount: 1,
				renderedDiscussionEntryCount: 2,
				renderedBytes: 100,
				limitations: [{ code: "api-error", source: "review-threads", count: 1 }],
				fingerprint: "c".repeat(64),
			},
			linkedIssues: [],
			discussionEntries: [],
			rendered: "untrusted GitHub context",
		};
		const hunkIds = snapshot.changedFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id));
		const candidateReport: ReviewCandidateReport = { summary: "No findings.", candidates: [], limitations: [] };
		const verificationReport: ReviewVerificationReport = {
			summary: "No omission found.",
			assessment: "complete",
			decisions: [],
			priorFindingDecisions: [],
			limitations: [],
		};
		const observed = (contextInspectionComplete: boolean) => ({
			changedFileInventoryComplete: true,
			contextInspectionComplete,
			contextPagesRead: contextInspectionComplete ? 1 : 0,
			filesRead: [],
			hunksInspected: hunkIds,
			searchesRun: 0,
			treePagesRead: 0,
			diffFilesFullyRead: ["src/divide.ts"],
		});
		const parsed = buildParsedReview({
			snapshot,
			candidateReport,
			validatedCandidates: [],
			verificationReport,
			discoveryCoverage: observed(false),
			verificationCoverage: observed(true),
			commandsRun: [],
			failedVerificationAttempts: [],
			excludedPaths: [],
		});
		expect(parsed.completionStatus).toBe("incomplete");
		expect(parsed.overallCorrectness).toBeUndefined();
		expect(parsed.coverage.context).toMatchObject({
			captureStatus: "incomplete",
			discoveryInspectionComplete: false,
			verificationInspectionComplete: true,
			limitationCodes: ["api-error"],
		});
		expect(parsed.coverage.uncheckedAreas).toEqual(
			expect.arrayContaining([
				"Code-host pull request context capture was incomplete.",
				"Discovery did not page code-host pull request context to completion.",
			]),
		);
	});

	it("marks unsupported in-scope changes incomplete unless they are excluded", async () => {
		const directory = join(
			tmpdir(),
			`volt-review-report-binary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(directory, { recursive: true });
		directories.push(directory);
		git(directory, "init", "--initial-branch=main");
		git(directory, "config", "user.email", "review@example.com");
		git(directory, "config", "user.name", "Review Test");
		writeFileSync(join(directory, "README.md"), "Binary review fixture.\n");
		git(directory, "add", "README.md");
		git(directory, "commit", "-m", "initial");
		writeFileSync(join(directory, "asset.bin"), Buffer.from([0, 1, 2, 3]));
		const result = await resolveReviewSnapshot({ kind: "uncommitted" }, directory, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: 2_147_483_647,
		});
		if ("error" in result) throw new Error(result.error);
		snapshots.push(result);
		expect(result.changedFiles).toMatchObject([{ path: "asset.bin", binary: true, reviewable: false, hunks: [] }]);

		const candidateReport: ReviewCandidateReport = { summary: "No findings.", candidates: [], limitations: [] };
		const verificationReport: ReviewVerificationReport = {
			summary: "No omission found.",
			assessment: "complete",
			decisions: [],
			priorFindingDecisions: [],
			limitations: [],
		};
		const options = {
			snapshot: result,
			candidateReport,
			validatedCandidates: [],
			verificationReport,
			discoveryCoverage: {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: [],
				searchesRun: 0,
				treePagesRead: 1,
				diffFilesFullyRead: [],
			},
			verificationCoverage: {
				changedFileInventoryComplete: true,
				contextInspectionComplete: false,
				contextPagesRead: 0,
				filesRead: [],
				hunksInspected: [],
				searchesRun: 0,
				treePagesRead: 1,
				diffFilesFullyRead: [],
			},
			commandsRun: [],
			failedVerificationAttempts: [],
		};
		const unsupported = buildParsedReview({ ...options, excludedPaths: [] });
		expect(unsupported.completionStatus).toBe("incomplete");
		expect(unsupported.overallCorrectness).toBeUndefined();
		expect(unsupported.coverage.uncheckedAreas).toEqual(["asset.bin: Binary content has no reviewable text hunks."]);

		const exclusion = { path: "asset.bin", reason: "Binary fixture is outside the requested path scope." };
		const excluded = buildParsedReview({ ...options, excludedPaths: [exclusion] });
		expect(excluded).toMatchObject({
			completionStatus: "complete",
			overallCorrectness: "correct",
			coverage: { exclusions: [exclusion], uncheckedAreas: [] },
		});
	});
});
