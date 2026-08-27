import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CodeHostProvider,
	githubCliCodeHostProvider,
	type ReviewCodeHostPublishRequest,
} from "../src/core/code-host/index.ts";
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
					providerId: "github",
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
	const pathEnvironmentKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const originalPath = process.env[pathEnvironmentKey];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (originalPath === undefined) delete process.env[pathEnvironmentKey];
		else process.env[pathEnvironmentKey] = originalPath;
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
		const fixturePath = join(bin, "fake-gh.mjs");
		writeFileSync(
			fixturePath,
			`import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, args.join(" ") + "\\n");
switch (args.slice(0, 2).join(" ")) {
	case "pr view":
		process.stdout.write(${JSON.stringify(`${JSON.stringify({ headRefOid: options.headOid ?? "head-oid" })}\n`)});
		break;
	case "repo view":
		process.stdout.write(${JSON.stringify(`${JSON.stringify({ nameWithOwner: "volt-hq/Volt" })}\n`)});
		break;
	case "api --method": {
		let input = "";
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) input += chunk;
		if (${options.failApi === true}) {
			process.stderr.write("rejected\\n");
			process.exitCode = 1;
		} else {
			writeFileSync(${JSON.stringify(payloadPath)}, input);
			process.stdout.write(${JSON.stringify(`${JSON.stringify({ id: 99, html_url: "https://example.test/review/99" })}\n`)});
		}
		break;
	}
	default:
		process.stderr.write("unexpected gh invocation\\n");
		process.exitCode = 2;
}
`,
		);
		if (process.platform === "win32") {
			writeFileSync(join(bin, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`);
		} else {
			const executable = join(bin, "gh");
			writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`);
			chmodSync(executable, 0o755);
		}
		process.env[pathEnvironmentKey] = `${bin}${delimiter}${originalPath ?? ""}`;
		return { cwd, payloadPath, callsPath };
	}

	it("rechecks the head and submits one atomic review with unsafe anchors in the summary", async () => {
		const privateMarker = "private-github-discussion-marker";
		const fixture = installGh();
		const run = reviewRun();
		if (!run.target.identity.pullRequest) throw new Error("Expected a PR review fixture");
		run.target.identity.pullRequest.body = privateMarker;
		const published = await publishReviewRun(fixture.cwd, run);
		expect(published).toEqual({
			reviewId: 99,
			url: "https://example.test/review/99",
			inlineFindingIds: ["finding-inline"],
			summaryOnlyFindingIds: ["finding-summary"],
		});
		const payload = JSON.parse(readFileSync(fixture.payloadPath, "utf8")) as {
			commit_id: string;
			body: string;
			comments: Array<{ path: string }>;
		};
		expect(payload.commit_id).toBe("head-oid");
		expect(payload.comments).toEqual([expect.objectContaining({ path: "src/value.ts" })]);
		expect(payload.body).toContain("finding-summary");
		expect(JSON.stringify(payload)).not.toContain(privateMarker);
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

	it("publishes normalized review data through an injected code-host provider", async () => {
		const run = reviewRun();
		if (!run.target.identity.pullRequest) throw new Error("Expected a PR review fixture");
		run.target.identity.pullRequest.providerId = "test-host";
		let verifiedHead: string | undefined;
		let publishRequest: ReviewCodeHostPublishRequest | undefined;
		const provider: CodeHostProvider = {
			id: "test-host",
			displayName: "Test Host",
			probeCurrentPullRequest: async () => undefined,
			capturePullRequestContext: async () => ({ ok: false, error: "unused" }),
			getPullRequestFetchPlan: () => {
				throw new Error("unused");
			},
			verifyPullRequestHead: async (_cwd, pullRequest) => {
				verifiedHead = pullRequest.headRefOid;
			},
			publishPullRequestReview: async (request) => {
				publishRequest = request;
				return { reviewId: 101, url: "https://example.test/reviews/101" };
			},
		};

		const published = await publishReviewRun("/workspace", run, provider);

		expect(verifiedHead).toBe("head-oid");
		expect(publishRequest).toMatchObject({
			cwd: "/workspace",
			pullRequest: { providerId: "test-host", number: 7 },
			comments: [
				{
					path: "src/value.ts",
					side: "head",
					startLine: 2,
					endLine: 2,
				},
			],
		});
		expect(published).toEqual({
			reviewId: 101,
			url: "https://example.test/reviews/101",
			inlineFindingIds: ["finding-inline"],
			summaryOnlyFindingIds: ["finding-summary"],
		});
	});

	it("describes GitHub pull request refs through the provider fetch plan", () => {
		const run = reviewRun();
		const pullRequest = run.target.identity.pullRequest;
		if (!pullRequest) throw new Error("Expected a PR review fixture");
		expect(githubCliCodeHostProvider.getPullRequestFetchPlan(pullRequest)).toEqual({
			remote: "origin",
			base: { remoteRef: "refs/heads/main", localRef: "refs/review/base" },
			head: { remoteRef: "refs/pull/7/head", localRef: "refs/review/head" },
			diffCommand: "gh pr diff 7",
		});
	});
});
