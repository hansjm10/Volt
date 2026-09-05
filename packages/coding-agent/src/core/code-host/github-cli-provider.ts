import { runGitHubCli } from "./github-cli.ts";
import { capturePullRequestContextWithGitHubCli } from "./github-cli-context.ts";
import type {
	CodeHostProvider,
	ReviewCodeHostInlineComment,
	ReviewCodeHostPublishRequest,
	ReviewPullRequestIdentity,
} from "./types.ts";

function parseJsonObject(text: string, label: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(`${label} returned malformed JSON.`);
	}
}

function assertGitHubPullRequest(pullRequest: ReviewPullRequestIdentity): void {
	if (pullRequest.providerId !== "github") {
		throw new Error(`GitHub CLI cannot operate on code-host provider ${JSON.stringify(pullRequest.providerId)}.`);
	}
}

function githubInlineComment(comment: ReviewCodeHostInlineComment): Record<string, unknown> {
	const side = comment.side === "head" ? "RIGHT" : "LEFT";
	return {
		path: comment.path,
		line: comment.endLine,
		side,
		...(comment.startLine === comment.endLine ? {} : { start_line: comment.startLine, start_side: side }),
		body: comment.body,
	};
}

async function probeCurrentPullRequest(cwd: string, signal?: AbortSignal) {
	try {
		const result = await runGitHubCli(["pr", "view", "--json", "number,title"], {
			cwd,
			...(signal === undefined ? {} : { signal }),
			stdoutMaxBytes: 16 * 1024,
		});
		if (!result.ok) return undefined;
		const value = parseJsonObject(result.stdout.toString("utf8"), "gh pr view");
		if (
			typeof value.number !== "number" ||
			!Number.isSafeInteger(value.number) ||
			value.number < 1 ||
			typeof value.title !== "string"
		) {
			return undefined;
		}
		return { number: value.number, title: value.title };
	} catch {
		return undefined;
	}
}

async function verifyPullRequestHead(cwd: string, pullRequest: ReviewPullRequestIdentity): Promise<void> {
	assertGitHubPullRequest(pullRequest);
	const result = await runGitHubCli(["pr", "view", String(pullRequest.number), "--json", "headRefOid"], { cwd });
	if (!result.ok) throw new Error(`Could not verify the pull request head: ${result.stderr.trim()}`);
	const current = parseJsonObject(result.stdout.toString("utf8"), "gh pr view");
	if (current.headRefOid !== pullRequest.headRefOid) {
		throw new Error(
			"The pull request head moved after this review was captured. Run a new review before publishing.",
		);
	}
}

async function publishPullRequestReview(request: ReviewCodeHostPublishRequest) {
	assertGitHubPullRequest(request.pullRequest);
	const repositoryResult = await runGitHubCli(["repo", "view", "--json", "nameWithOwner"], {
		cwd: request.cwd,
	});
	if (!repositoryResult.ok) {
		throw new Error(`Could not resolve the GitHub repository: ${repositoryResult.stderr.trim()}`);
	}
	const repository = parseJsonObject(repositoryResult.stdout.toString("utf8"), "gh repo view");
	if (typeof repository.nameWithOwner !== "string" || !repository.nameWithOwner.includes("/")) {
		throw new Error("gh repo view did not return a repository name.");
	}
	const payload = JSON.stringify({
		commit_id: request.pullRequest.headRefOid,
		body: request.body,
		event: "COMMENT",
		comments: request.comments.map(githubInlineComment),
	});
	const published = await runGitHubCli(
		[
			"api",
			"--method",
			"POST",
			`repos/${repository.nameWithOwner}/pulls/${request.pullRequest.number}/reviews`,
			"--input",
			"-",
		],
		{ cwd: request.cwd, input: payload },
	);
	if (!published.ok) {
		throw new Error(`GitHub rejected the review; nothing was marked published: ${published.stderr.trim()}`);
	}
	const response = parseJsonObject(published.stdout.toString("utf8"), "gh api");
	return {
		...(typeof response.id === "number" ? { reviewId: response.id } : {}),
		...(typeof response.html_url === "string" ? { url: response.html_url } : {}),
	};
}

export const githubCliCodeHostProvider: CodeHostProvider = {
	id: "github",
	displayName: "GitHub",
	probeCurrentPullRequest,
	capturePullRequestContext: capturePullRequestContextWithGitHubCli,
	getPullRequestFetchPlan(pullRequest) {
		assertGitHubPullRequest(pullRequest);
		return {
			remote: "origin",
			base: {
				remoteRef: `refs/heads/${pullRequest.baseRefName}`,
				localRef: "refs/review/base",
			},
			head: {
				remoteRef: `refs/pull/${pullRequest.number}/head`,
				localRef: "refs/review/head",
			},
			diffCommand: `gh pr diff ${pullRequest.number}`,
		};
	},
	verifyPullRequestHead,
	publishPullRequestReview,
};
