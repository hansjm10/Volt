import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishReviewRun } from "../src/core/review-publish.ts";
import type { ReviewRunRecord } from "../src/core/review-state.ts";

function reviewRun(headRefOid = "head-oid"): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId: "review:publish",
		workflowAction: "review.pr",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "PR #7",
			diffCommand: "gh pr diff 7",
			identity: {
				kind: "pr",
				baseTree: "base-tree",
				headTree: "head-tree",
				pullRequest: {
					number: 7,
					title: "Fix values",
					body: "Body",
					url: "https://example.test/pr/7",
					baseRefName: "main",
					headRefName: "feature",
					baseRefOid: "base-oid",
					headRefOid,
				},
			},
			files: [
				{ path: "src/value.ts", baseOid: "base-blob", headOid: "head-blob", hunkIds: ["h1"], reviewable: true },
				{ path: "deleted.ts", baseOid: "deleted-blob", hunkIds: ["h2"], reviewable: true },
			],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "Two findings were verified.",
			findings: [
				{
					id: "finding-inline",
					fingerprint: "a".repeat(64),
					status: "open",
					title: "Wrong value",
					body: "The changed branch returns the wrong value.",
					trigger: "Call divide with zero.",
					impact: "The caller receives incorrect data.",
					category: "correctness",
					rootCauseKey: "wrong-zero-value",
					priority: 2,
					confidence: 0.9,
					changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
					evidenceLocations: [],
					verification: {
						outcome: "accepted",
						method: "Exact blob comparison",
						rationale: "The branch is present.",
						confidence: 0.95,
					},
				},
				{
					id: "finding-summary",
					fingerprint: "b".repeat(64),
					status: "open",
					title: "Unsafe anchor",
					body: "This retained finding cannot be safely anchored inline.",
					trigger: "Run the affected path.",
					impact: "The operation fails.",
					category: "correctness",
					rootCauseKey: "unsafe-anchor",
					priority: 2,
					confidence: 0.8,
					changeLocation: { path: "missing.ts", side: "head", startLine: 1, endLine: 1 },
					evidenceLocations: [],
					verification: {
						outcome: "accepted",
						method: "Exact blob comparison",
						rationale: "The trigger was reproduced.",
						confidence: 0.85,
					},
				},
			],
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: ["src/value.ts"],
				hunksInspected: ["h1", "h2"],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
			overallCorrectness: "incorrect",
			overallExplanation: "Verified findings remain.",
		},
	};
}

describe("pull request review publishing", () => {
	const directories: string[] = [];
	const originalPath = process.env.PATH;

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	});

	function installGh(options: { headOid?: string; failApi?: boolean } = {}): {
		cwd: string;
		payloadPath: string;
		callsPath: string;
	} {
		const cwd = join(tmpdir(), `volt-review-publish-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const bin = join(cwd, "bin");
		mkdirSync(bin, { recursive: true });
		directories.push(cwd);
		const payloadPath = join(cwd, "payload.json");
		const callsPath = join(cwd, "calls.txt");
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsPath}'\ncase "$1 $2" in\n  "pr view") printf '%s\\n' '{"headRefOid":"${options.headOid ?? "head-oid"}"}' ;;\n  "repo view") printf '%s\\n' '{"nameWithOwner":"volt-hq/Volt"}' ;;\n  "api --method") ${options.failApi ? "cat >/dev/null; printf '%s\\n' 'rejected' >&2; exit 1" : `cat > '${payloadPath}'; printf '%s\\n' '{"id":99,"html_url":"https://example.test/review/99"}'`} ;;\n  *) printf '%s\\n' 'unexpected gh invocation' >&2; exit 2 ;;\nesac\n`,
		);
		chmodSync(join(bin, "gh"), 0o755);
		process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
		return { cwd, payloadPath, callsPath };
	}

	it("rechecks the head and submits one atomic review with unsafe anchors in the summary", async () => {
		const fixture = installGh();
		const published = await publishReviewRun(fixture.cwd, reviewRun());
		expect(published).toEqual({
			reviewId: 99,
			url: "https://example.test/review/99",
			inlineFindingIds: ["finding-inline"],
			summaryOnlyFindingIds: ["finding-summary"],
		});
		const payload = JSON.parse(readFileSync(fixture.payloadPath, "utf8")) as {
			body: string;
			comments: Array<{ path: string }>;
		};
		expect(payload.comments).toEqual([expect.objectContaining({ path: "src/value.ts" })]);
		expect(payload.body).toContain("finding-summary");
		expect(
			readFileSync(fixture.callsPath, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("api ")),
		).toHaveLength(1);
	});

	it("refuses stale heads before publishing", async () => {
		const fixture = installGh({ headOid: "moved-head" });
		await expect(publishReviewRun(fixture.cwd, reviewRun())).rejects.toThrow(/head moved/);
		expect(readFileSync(fixture.callsPath, "utf8")).not.toContain("api --method");
	});

	it("surfaces an atomic API failure", async () => {
		const fixture = installGh({ failApi: true });
		await expect(publishReviewRun(fixture.cwd, reviewRun())).rejects.toThrow(/nothing was marked published/);
	});

	it("refuses incomplete and non-PR runs", async () => {
		const fixture = installGh();
		const incomplete = reviewRun();
		incomplete.status = "incomplete";
		if (incomplete.result) incomplete.result.completionStatus = "incomplete";
		await expect(publishReviewRun(fixture.cwd, incomplete)).rejects.toThrow(/Only complete/);
		const branch = reviewRun();
		branch.target.identity = { kind: "branch", baseTree: "base", headTree: "head" };
		await expect(publishReviewRun(fixture.cwd, branch)).rejects.toThrow(/Only pull request/);
	});
});
