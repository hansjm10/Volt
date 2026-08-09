import type { Buffer } from "node:buffer";
import { spawnProcess } from "../utils/child-process.ts";
import type { ReviewFinding } from "./review-report.ts";
import type { ReviewRunRecord } from "./review-state.ts";

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runGh(cwd: string, args: string[], input?: string): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawnProcess("gh", args, {
			cwd,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message }));
		child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
		if (input !== undefined) child.stdin?.end(input);
	});
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(`${label} returned malformed JSON.`);
	}
}

function findingText(finding: ReviewFinding): string {
	return [
		`**[P${finding.priority}] ${finding.title}**`,
		"",
		finding.body,
		"",
		`Trigger: ${finding.trigger}`,
		`Impact: ${finding.impact}`,
		`Verification: ${finding.verification.method} — ${finding.verification.rationale}`,
		`Volt finding: ${finding.id}`,
	].join("\n");
}

function inlineComment(finding: ReviewFinding, run: ReviewRunRecord): Record<string, unknown> | undefined {
	const location = finding.changeLocation;
	const file = run.target.files.find((candidate) => candidate.path === location.path);
	if (!file || location.endLine < location.startLine || location.endLine - location.startLine + 1 > 10)
		return undefined;
	if (location.side === "head" && !file.headOid) return undefined;
	if (location.side === "base" && !file.baseOid) return undefined;
	const side = location.side === "head" ? "RIGHT" : "LEFT";
	return {
		path: location.path,
		line: location.endLine,
		side,
		...(location.startLine === location.endLine ? {} : { start_line: location.startLine, start_side: side }),
		body: findingText(finding),
	};
}

export interface ReviewPublishResult {
	reviewId?: number;
	url?: string;
	inlineFindingIds: string[];
	summaryOnlyFindingIds: string[];
}

export async function publishReviewRun(cwd: string, run: ReviewRunRecord): Promise<ReviewPublishResult> {
	const pullRequest = run.target.identity.pullRequest;
	if (run.status !== "completed" || run.result?.completionStatus !== "complete") {
		throw new Error("Only complete review results can be published.");
	}
	if (run.target.identity.kind !== "pr" || !pullRequest)
		throw new Error("Only pull request reviews can be published.");
	const currentResult = await runGh(cwd, ["pr", "view", String(pullRequest.number), "--json", "headRefOid"]);
	if (!currentResult.ok) throw new Error(`Could not verify the pull request head: ${currentResult.stderr.trim()}`);
	const current = parseJsonObject(currentResult.stdout, "gh pr view");
	if (current.headRefOid !== pullRequest.headRefOid) {
		throw new Error(
			"The pull request head moved after this review was captured. Run a new review before publishing.",
		);
	}
	const repositoryResult = await runGh(cwd, ["repo", "view", "--json", "nameWithOwner"]);
	if (!repositoryResult.ok)
		throw new Error(`Could not resolve the GitHub repository: ${repositoryResult.stderr.trim()}`);
	const repository = parseJsonObject(repositoryResult.stdout, "gh repo view");
	if (typeof repository.nameWithOwner !== "string" || !repository.nameWithOwner.includes("/")) {
		throw new Error("gh repo view did not return a repository name.");
	}
	const comments: Record<string, unknown>[] = [];
	const inlineFindingIds: string[] = [];
	const summaryOnlyFindingIds: string[] = [];
	for (const finding of run.result.findings.filter(
		(candidate) => candidate.status !== "fixed" && candidate.status !== "dismissed",
	)) {
		const comment = inlineComment(finding, run);
		if (comment) {
			comments.push(comment);
			inlineFindingIds.push(finding.id);
		} else summaryOnlyFindingIds.push(finding.id);
	}
	const summaryOnly = run.result.findings
		.filter((finding) => summaryOnlyFindingIds.includes(finding.id))
		.map((finding) => findingText(finding));
	const body = [
		`Volt review (${run.runId})`,
		"",
		run.result.summary,
		"",
		`Verdict: ${run.result.overallCorrectness ?? "unavailable"} — ${run.result.overallExplanation}`,
		...(summaryOnly.length > 0 ? ["", "Findings without a safe inline anchor:", "", ...summaryOnly] : []),
	].join("\n");
	const payload = JSON.stringify({ commit_id: pullRequest.headRefOid, body, event: "COMMENT", comments });
	const published = await runGh(
		cwd,
		[
			"api",
			"--method",
			"POST",
			`repos/${repository.nameWithOwner}/pulls/${pullRequest.number}/reviews`,
			"--input",
			"-",
		],
		payload,
	);
	if (!published.ok)
		throw new Error(`GitHub rejected the review; nothing was marked published: ${published.stderr.trim()}`);
	const response = parseJsonObject(published.stdout, "gh api");
	return {
		...(typeof response.id === "number" ? { reviewId: response.id } : {}),
		...(typeof response.html_url === "string" ? { url: response.html_url } : {}),
		inlineFindingIds,
		summaryOnlyFindingIds,
	};
}
