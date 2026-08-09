import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildParsedReview,
	createReviewCandidateReportCollector,
	createReviewVerificationReportCollector,
	type ReviewCandidateReport,
	type ReviewVerificationReport,
	validateReviewCandidates,
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
			verificationCoverage: {
				changedFileInventoryComplete: true,
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
			verificationCoverage: {
				changedFileInventoryComplete: true,
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
			verificationCoverage: {
				changedFileInventoryComplete: true,
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
