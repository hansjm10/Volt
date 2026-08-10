import type { CommandAdapter, CommandResult } from "./command.ts";

const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_THREAD_CONTEXT_BYTES = 16 * 1024;
const MAX_THREAD_COMMENT_BODY_BYTES = 1_400;
const MAX_VOLT_FINDING_ID_BYTES = 256;
const MAX_ACTIONS_LOG_BYTES = 32 * 1024;
const MAX_ANNOTATIONS = 50;

export interface PullRequestIdentity {
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	isCrossRepository: boolean;
	headRefName: string;
	headRefOid: string;
	headRepository: string;
	baseRefName: string;
}

export interface SubmittedReview {
	id: string;
	state: string;
	commitOid?: string;
	author?: string;
	body: string;
	submittedAt?: string;
	voltRunId?: string;
}

export interface ReviewComment {
	id: string;
	author?: string;
	body: string;
	createdAt: string;
	url: string;
	marker?: VoltMarker;
}

export interface ReviewThread {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	path: string;
	line?: number;
	startLine?: number;
	comments: ReviewComment[];
	latestCommentId: string;
	originalVoltFindingId?: string;
}

export type RequiredCheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface CheckAnnotation {
	path?: string;
	startLine?: number;
	endLine?: number;
	annotationLevel?: string;
	message: string;
	title?: string;
}

export interface RequiredCheck {
	name: string;
	workflow?: string;
	state: string;
	bucket: RequiredCheckBucket;
	link?: string;
	checkRunId?: number;
	annotations: CheckAnnotation[];
	failedLogExcerpt?: string;
	joinError?: string;
}

export interface VoltMarker {
	kind: "thread-reply" | "lgtm";
	head: string;
	job?: string;
	commentId?: string;
	threadId?: string;
}

export interface GitHubSnapshot {
	repository: string;
	viewerLogin: string;
	pullRequest: PullRequestIdentity;
	reviews: SubmittedReview[];
	threads: ReviewThread[];
	requiredChecks: RequiredCheck[];
	markers: VoltMarker[];
}

export interface GitHubAdapter {
	assertAuthenticated(): Promise<void>;
	resolveRepository(): Promise<{ repository: string; viewerLogin: string }>;
	getPullRequest(prNumber: number, repository: string): Promise<PullRequestIdentity>;
	getSnapshot(prNumber: number, repository?: string): Promise<GitHubSnapshot>;
	postThreadReply(threadId: string, body: string): Promise<{ commentId?: string }>;
	resolveThread(threadId: string): Promise<void>;
	postIssueComment(prNumber: number, repository: string, body: string): Promise<{ commentId?: number }>;
}

interface GitHubCommandAdapterOptions {
	commands: CommandAdapter;
	cwd: string;
}

interface PageInfo {
	hasNextPage: boolean;
	endCursor?: string;
}

interface ThreadAccumulator {
	thread: Omit<ReviewThread, "comments" | "latestCommentId" | "originalVoltFindingId">;
	first?: ReviewComment;
	latest: ReviewComment[];
	pageInfo: PageInfo;
}

export class GhCliAdapter implements GitHubAdapter {
	private readonly commands: CommandAdapter;
	private readonly cwd: string;
	private repository?: string;
	private viewerLogin?: string;

	constructor(options: GitHubCommandAdapterOptions) {
		this.commands = options.commands;
		this.cwd = options.cwd;
	}

	async assertAuthenticated(): Promise<void> {
		const result = await this.commands.run("gh", ["auth", "status", "--active"], { cwd: this.cwd });
		if (result.code !== 0) throw new Error(`GitHub CLI authentication is required: ${result.stderr.trim()}`);
	}

	async resolveRepository(): Promise<{ repository: string; viewerLogin: string }> {
		if (this.repository && this.viewerLogin) return { repository: this.repository, viewerLogin: this.viewerLogin };
		const repositoryResult = await this.runJson(["repo", "view", "--json", "nameWithOwner"], "gh repo view");
		const repository = expectString(expectRecord(repositoryResult, "gh repo view").nameWithOwner, "nameWithOwner");
		if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("gh repo view returned an invalid repository name");
		const viewerResult = await this.runJson(["api", "user"], "gh api user");
		const viewerLogin = expectString(expectRecord(viewerResult, "gh api user").login, "viewer login");
		this.repository = repository;
		this.viewerLogin = viewerLogin;
		return { repository, viewerLogin };
	}

	async getPullRequest(prNumber: number, repository: string): Promise<PullRequestIdentity> {
		const result = await this.runJson(
			[
				"pr",
				"view",
				String(prNumber),
				"--repo",
				repository,
				"--json",
				"state,isDraft,isCrossRepository,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName",
			],
			"gh pr view",
		);
		const record = expectRecord(result, "gh pr view");
		const headRepository = expectRecord(record.headRepository, "PR headRepository");
		const reportedNameWithOwner = headRepository.nameWithOwner;
		const headRepositoryName =
			typeof reportedNameWithOwner === "string" && reportedNameWithOwner.trim().length > 0
				? reportedNameWithOwner
				: `${expectString(expectRecord(record.headRepositoryOwner, "PR headRepositoryOwner").login, "PR headRepositoryOwner.login")}/${expectString(headRepository.name, "PR headRepository.name")}`;
		const identity: PullRequestIdentity = {
			number: prNumber,
			state: expectEnum(record.state, "PR state", ["OPEN", "CLOSED", "MERGED"]),
			isDraft: expectBoolean(record.isDraft, "PR isDraft"),
			isCrossRepository: expectBoolean(record.isCrossRepository, "PR isCrossRepository"),
			headRefName: expectString(record.headRefName, "PR headRefName"),
			headRefOid: expectSha(record.headRefOid, "PR headRefOid"),
			headRepository: headRepositoryName,
			baseRefName: expectString(record.baseRefName, "PR baseRefName"),
		};
		assertEligiblePullRequest(identity, repository);
		return identity;
	}

	async getSnapshot(prNumber: number, repository?: string): Promise<GitHubSnapshot> {
		const resolved = await this.resolveRepository();
		const targetRepository = repository ?? resolved.repository;
		if (targetRepository !== resolved.repository) throw new Error("Requested repository does not match the current repository");
		const pullRequest = await this.getPullRequest(prNumber, targetRepository);
		const [reviews, threads, requiredChecks, issueMarkers] = await Promise.all([
			this.getReviews(prNumber, targetRepository),
			this.getThreads(prNumber, targetRepository, resolved.viewerLogin),
			this.getRequiredChecks(prNumber, targetRepository, pullRequest.headRefOid),
			this.getIssueMarkers(prNumber, targetRepository, resolved.viewerLogin),
		]);
		const finalIdentity = await this.getPullRequest(prNumber, targetRepository);
		if (!samePullRequestIdentity(pullRequest, finalIdentity)) {
			throw new Error("PR eligibility or head changed while the poll snapshot was being captured");
		}
		const threadMarkers = threads.flatMap((thread) =>
			thread.comments.flatMap((comment) =>
				comment.author === resolved.viewerLogin && comment.marker
					? [{ ...comment.marker, commentId: comment.id, threadId: thread.id }]
					: [],
			),
		);
		return {
			repository: targetRepository,
			viewerLogin: resolved.viewerLogin,
			pullRequest,
			reviews,
			threads,
			requiredChecks,
			markers: [...issueMarkers, ...threadMarkers],
		};
	}

	async postThreadReply(threadId: string, body: string): Promise<{ commentId?: string }> {
		const query = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
		const result = await this.graphql(query, { threadId, body });
		const data = expectRecord(expectRecord(result, "thread reply").data, "thread reply data");
		const reply = expectRecord(data.addPullRequestReviewThreadReply, "thread reply result");
		const comment = expectRecord(reply.comment, "thread reply comment");
		return typeof comment.id === "string" ? { commentId: comment.id } : {};
	}

	async resolveThread(threadId: string): Promise<void> {
		const query = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
		const result = await this.graphql(query, { threadId });
		const data = expectRecord(expectRecord(result, "resolve thread").data, "resolve thread data");
		const resolved = expectRecord(data.resolveReviewThread, "resolve thread result");
		const thread = expectRecord(resolved.thread, "resolved thread");
		if (thread.isResolved !== true) throw new Error(`GitHub did not resolve thread ${threadId}`);
	}

	async postIssueComment(prNumber: number, repository: string, body: string): Promise<{ commentId?: number }> {
		const result = await this.runJson(
			["api", "--method", "POST", `repos/${repository}/issues/${prNumber}/comments`, "--input", "-"],
			"post PR comment",
			bodyAsJson(body),
		);
		const record = expectRecord(result, "post PR comment");
		return typeof record.id === "number" ? { commentId: record.id } : {};
	}

	private async getReviews(prNumber: number, repository: string): Promise<SubmittedReview[]> {
		const [owner, repo] = splitRepository(repository);
		const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(first:100,after:$cursor){nodes{id state body submittedAt author{login} commit{oid}} pageInfo{hasNextPage endCursor}}}}}`;
		const reviews: SubmittedReview[] = [];
		let cursor: string | undefined;
		const seen = new Set<string>();
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const result = await this.graphql(query, { owner, repo, number: prNumber, ...(cursor ? { cursor } : {}) });
			const connection = graphqlConnection(result, ["repository", "pullRequest", "reviews"], "reviews");
			for (const value of connection.nodes) {
				const review = expectRecord(value, "review");
				const id = expectString(review.id, "review id");
				const body = expectStringValue(review.body, "review body");
				reviews.push({
					id,
					state: expectString(review.state, "review state"),
					...(review.commit === null || review.commit === undefined
						? {}
						: { commitOid: expectSha(expectRecord(review.commit, "review commit").oid, "review commit oid") }),
					...(review.author === null || review.author === undefined
						? {}
						: { author: expectString(expectRecord(review.author, "review author").login, "review author login") }),
					body: boundUtf8(body, 8 * 1024),
					...(typeof review.submittedAt === "string" ? { submittedAt: review.submittedAt } : {}),
					...parseVoltReviewRun(body),
				});
			}
			cursor = nextCursor(connection.pageInfo, seen, "reviews");
			if (!cursor) return reviews;
		}
		throw new Error("Review pagination exceeded 100 pages");
	}

	private async getThreads(prNumber: number, repository: string, viewerLogin: string): Promise<ReviewThread[]> {
		const [owner, repo] = splitRepository(repository);
		const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line startLine comments(first:100){nodes{id body createdAt url author{login}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;
		const accumulators: ThreadAccumulator[] = [];
		let cursor: string | undefined;
		const seen = new Set<string>();
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const result = await this.graphql(query, { owner, repo, number: prNumber, ...(cursor ? { cursor } : {}) });
			const connection = graphqlConnection(result, ["repository", "pullRequest", "reviewThreads"], "threads");
			for (const value of connection.nodes) {
				const record = expectRecord(value, "review thread");
				const comments = parseCommentConnection(record.comments, "thread comments", viewerLogin);
				const accumulator: ThreadAccumulator = {
					thread: {
						id: expectString(record.id, "thread id"),
						isResolved: expectBoolean(record.isResolved, "thread isResolved"),
						isOutdated: expectBoolean(record.isOutdated, "thread isOutdated"),
						path: expectString(record.path, "thread path"),
						...(typeof record.line === "number" ? { line: record.line } : {}),
						...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
					},
					first: comments.comments[0],
					latest: comments.comments.slice(-8),
					pageInfo: comments.pageInfo,
				};
				accumulators.push(accumulator);
			}
			cursor = nextCursor(connection.pageInfo, seen, "review threads");
			if (!cursor) break;
			if (page === MAX_PAGES - 1) throw new Error("Review-thread pagination exceeded 100 pages");
		}

		for (const accumulator of accumulators) {
			if (accumulator.pageInfo.hasNextPage) await this.pageThreadComments(accumulator, viewerLogin);
		}
		return accumulators.map((accumulator) => finalizeThread(accumulator));
	}

	private async pageThreadComments(accumulator: ThreadAccumulator, viewerLogin: string): Promise<void> {
		const query = `query($threadId:ID!,$cursor:String){node(id:$threadId){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id body createdAt url author{login}} pageInfo{hasNextPage endCursor}}}}}`;
		let cursor = accumulator.pageInfo.endCursor;
		const seen = new Set<string>();
		if (cursor) seen.add(cursor);
		for (let page = 1; page < MAX_PAGES; page += 1) {
			if (!cursor) throw new Error(`Thread ${accumulator.thread.id} pagination omitted a cursor`);
			const result = await this.graphql(query, { threadId: accumulator.thread.id, cursor });
			const root = expectRecord(result, "thread comments result");
			const data = expectRecord(root.data, "thread comments data");
			const node = expectRecord(data.node, "thread comments node");
			const connection = parseCommentConnection(node.comments, "thread comments", viewerLogin);
			for (const comment of connection.comments) {
				accumulator.first ??= comment;
				accumulator.latest.push(comment);
				if (accumulator.latest.length > 8) accumulator.latest.shift();
			}
			cursor = nextCursor(connection.pageInfo, seen, `thread ${accumulator.thread.id} comments`);
			if (!cursor) return;
		}
		throw new Error(`Thread ${accumulator.thread.id} comment pagination exceeded 100 pages`);
	}

	private async getRequiredChecks(
		prNumber: number,
		repository: string,
		headSha: string,
	): Promise<RequiredCheck[]> {
		const result = await this.commands.run(
			"gh",
			[
				"pr",
				"checks",
				String(prNumber),
				"--repo",
				repository,
				"--required",
				"--json",
				"bucket,completedAt,description,event,link,name,startedAt,state,workflow",
			],
			{ cwd: this.cwd },
		);
		const parsed = parseJson(result.stdout, "gh pr checks");
		if (!Array.isArray(parsed)) throw new Error("gh pr checks returned non-array JSON");
		if (result.code !== 0 && result.code !== 1 && result.code !== 8) {
			throw new Error(`gh pr checks failed with exit ${String(result.code)}: ${result.stderr.trim()}`);
		}
		const checks = parsed.map((value, index) => parseRequiredCheck(value, index));
		const failed = checks.filter((check) => check.bucket === "fail");
		if (failed.length === 0) return checks;
		const checkRuns = await this.getCheckRuns(repository, headSha);
		for (const check of failed) {
			const matches = checkRuns.filter((run) =>
				run.name === check.name && (!check.link || !run.detailsUrl || normalizeUrl(run.detailsUrl) === normalizeUrl(check.link)),
			);
			if (matches.length !== 1) {
				check.joinError = `Required check ${check.name} matched ${matches.length} REST check runs`;
				continue;
			}
			const run = matches[0]!;
			check.checkRunId = run.id;
			check.annotations = await this.getAnnotations(repository, run.id);
			const actionsRunId = parseActionsRunId(run.detailsUrl ?? check.link);
			if (actionsRunId) check.failedLogExcerpt = await this.getFailedActionsLog(repository, actionsRunId);
		}
		return checks;
	}

	private async getCheckRuns(repository: string, sha: string): Promise<Array<{ id: number; name: string; detailsUrl?: string }>> {
		const runs: Array<{ id: number; name: string; detailsUrl?: string }> = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const result = await this.runJson(
				[
					"api",
					"--method",
					"GET",
					`repos/${repository}/commits/${sha}/check-runs`,
					"-f",
					"filter=latest",
					"-f",
					`per_page=${PAGE_SIZE}`,
					"-f",
					`page=${page}`,
				],
				"list check runs",
			);
			const record = expectRecord(result, "check runs");
			const values = expectArray(record.check_runs, "check_runs");
			for (const value of values) {
				const run = expectRecord(value, "check run");
				runs.push({
					id: expectPositiveInteger(run.id, "check run id"),
					name: expectString(run.name, "check run name"),
					...(typeof run.details_url === "string" ? { detailsUrl: run.details_url } : {}),
				});
			}
			if (values.length < PAGE_SIZE) return runs;
		}
		throw new Error("Check-run pagination exceeded 100 pages");
	}

	private async getAnnotations(repository: string, checkRunId: number): Promise<CheckAnnotation[]> {
		const result = await this.runJson(
			[
				"api",
				"--method",
				"GET",
				`repos/${repository}/check-runs/${checkRunId}/annotations`,
				"-f",
				`per_page=${MAX_ANNOTATIONS}`,
			],
			"check-run annotations",
		);
		return expectArray(result, "check-run annotations").slice(0, MAX_ANNOTATIONS).map((value) => {
			const record = expectRecord(value, "check annotation");
			return {
				...(typeof record.path === "string" ? { path: boundUtf8(record.path, 1_024) } : {}),
				...(typeof record.start_line === "number" ? { startLine: record.start_line } : {}),
				...(typeof record.end_line === "number" ? { endLine: record.end_line } : {}),
				...(typeof record.annotation_level === "string" ? { annotationLevel: record.annotation_level } : {}),
				message: boundUtf8(expectStringValue(record.message, "annotation message"), 2_048),
				...(typeof record.title === "string" ? { title: boundUtf8(record.title, 512) } : {}),
			};
		});
	}

	private async getFailedActionsLog(repository: string, runId: string): Promise<string | undefined> {
		const result = await this.commands.run("gh", ["run", "view", runId, "--repo", repository, "--log-failed"], {
			cwd: this.cwd,
			maxOutputBytes: 2 * 1024 * 1024,
		});
		if (result.code !== 0) return undefined;
		return boundUtf8(result.stdout, MAX_ACTIONS_LOG_BYTES);
	}

	private async getIssueMarkers(prNumber: number, repository: string, viewerLogin: string): Promise<VoltMarker[]> {
		const markers: VoltMarker[] = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const result = await this.runJson(
				[
					"api",
					"--method",
					"GET",
					`repos/${repository}/issues/${prNumber}/comments`,
					"-f",
					`per_page=${PAGE_SIZE}`,
					"-f",
					`page=${page}`,
				],
				"list PR marker comments",
			);
			const values = expectArray(result, "PR comments");
			for (const value of values) {
				const comment = expectRecord(value, "PR comment");
				const user = comment.user === null ? undefined : expectRecord(comment.user, "PR comment user");
				if (user?.login !== viewerLogin || typeof comment.body !== "string") continue;
				const marker = parseVoltMarker(comment.body);
				if (marker) markers.push({ ...marker, commentId: String(comment.id) });
			}
			if (values.length < PAGE_SIZE) return markers;
		}
		throw new Error("PR marker-comment pagination exceeded 100 pages");
	}

	private async graphql(query: string, variables: Record<string, string | number>): Promise<unknown> {
		const args = ["api", "graphql", "-f", `query=${query}`];
		for (const [key, value] of Object.entries(variables)) {
			args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
		}
		return this.runJson(args, "gh api graphql");
	}

	private async runJson(args: readonly string[], label: string, stdin?: string): Promise<unknown> {
		const result = await this.commands.run("gh", args, { cwd: this.cwd, ...(stdin === undefined ? {} : { stdin }) });
		if (result.code !== 0) throw commandError(result, label);
		return parseJson(result.stdout, label);
	}
}

export function assertEligiblePullRequest(pullRequest: PullRequestIdentity, repository: string): void {
	if (pullRequest.state !== "OPEN") throw new Error(`PR #${pullRequest.number} is not open`);
	if (pullRequest.isDraft) throw new Error(`PR #${pullRequest.number} is a draft`);
	if (pullRequest.isCrossRepository) throw new Error(`PR #${pullRequest.number} is cross-repository`);
	if (pullRequest.headRepository !== repository) {
		throw new Error(`PR head repository ${pullRequest.headRepository} does not match ${repository}`);
	}
}

export function hasSubmittedCurrentHeadReview(snapshot: GitHubSnapshot): boolean {
	return snapshot.reviews.some(
		(review) =>
			review.commitOid === snapshot.pullRequest.headRefOid &&
			review.state !== "DISMISSED" &&
			review.state !== "PENDING" &&
			(review.state !== "COMMENTED" || review.body.trim().length > 0 || review.voltRunId !== undefined),
	);
}

export function requiredChecksStatus(snapshot: GitHubSnapshot): "green" | "pending" | "failed" | "manual" {
	if (snapshot.requiredChecks.some((check) => check.bucket === "cancel" || check.joinError)) return "manual";
	if (snapshot.requiredChecks.some((check) => check.bucket === "fail")) return "failed";
	if (snapshot.requiredChecks.some((check) => check.bucket === "pending")) return "pending";
	return "green";
}

export function formatThreadConcern(thread: ReviewThread): string {
	return boundUtf8(
		JSON.stringify({
			threadId: thread.id,
			path: thread.path,
			line: thread.line,
			startLine: thread.startLine,
			isOutdated: thread.isOutdated,
			comments: thread.comments,
		}),
		MAX_THREAD_CONTEXT_BYTES,
	);
}

export function formatCheckConcern(check: RequiredCheck): string {
	return boundUtf8(
		JSON.stringify({
			name: check.name,
			workflow: check.workflow,
			state: check.state,
			checkRunId: check.checkRunId,
			annotations: check.annotations.slice(0, MAX_ANNOTATIONS),
			failedLogExcerpt: check.failedLogExcerpt,
		}),
		48 * 1024,
	);
}

export function createThreadReplyBody(head: string, jobId: string, integratedCommit: string): string {
	return [
		`Volt fixed this thread in integrated commit \`${integratedCommit}\` on head \`${head}\`.`,
		"",
		`<!-- volt-swarm kind=thread-reply head=${head} job=${encodeURIComponent(jobId)} -->`,
	].join("\n");
}

export function createLgtmBody(head: string): string {
	return [
		`LGTM — Volt reviewed \`${head}\`; all required checks passed.`,
		"",
		`<!-- volt-swarm kind=lgtm head=${head} -->`,
	].join("\n");
}

export function parseVoltMarker(body: string): VoltMarker | undefined {
	const match = /<!--\s*volt-swarm\s+([^>]+?)\s*-->/.exec(body);
	if (!match) return undefined;
	const fields = new Map<string, string>();
	for (const token of match[1]!.trim().split(/\s+/)) {
		const separator = token.indexOf("=");
		if (separator <= 0) return undefined;
		fields.set(token.slice(0, separator), token.slice(separator + 1));
	}
	const kind = fields.get("kind");
	const head = fields.get("head");
	if ((kind !== "thread-reply" && kind !== "lgtm") || !head || !/^[0-9a-f]{40}$/.test(head)) return undefined;
	const jobValue = fields.get("job");
	let job: string | undefined;
	if (jobValue) {
		try {
			job = decodeURIComponent(jobValue);
		} catch {
			return undefined;
		}
	}
	return { kind, head, ...(job === undefined ? {} : { job }) };
}

export function boundUtf8(value: string, maximumBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	const suffix = "…";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	let truncated = bytes.subarray(0, Math.max(0, maximumBytes - suffixBytes)).toString("utf8");
	while (Buffer.byteLength(truncated + suffix, "utf8") > maximumBytes) truncated = truncated.slice(0, -1);
	return truncated + suffix;
}

function parseCommentConnection(value: unknown, label: string, viewerLogin: string): { comments: ReviewComment[]; pageInfo: PageInfo } {
	const record = expectRecord(value, label);
	const nodes = expectArray(record.nodes, `${label}.nodes`);
	return {
		comments: nodes.map((entry) => parseReviewComment(entry, viewerLogin)),
		pageInfo: parsePageInfo(record.pageInfo, `${label}.pageInfo`),
	};
}

function parseReviewComment(value: unknown, viewerLogin: string): ReviewComment {
	const record = expectRecord(value, "review comment");
	const author =
		record.author === null || record.author === undefined
			? undefined
			: expectString(expectRecord(record.author, "comment author").login, "comment author login");
	const rawBody = expectStringValue(record.body, "comment body");
	const originalFindingId = author === viewerLogin ? parseOriginalVoltFindingId(rawBody) : undefined;
	const marker = author === viewerLogin ? parseVoltMarker(rawBody) : undefined;
	const body = boundReviewCommentBody(rawBody, originalFindingId);
	return {
		id: expectString(record.id, "comment id"),
		...(author === undefined ? {} : { author }),
		body,
		createdAt: expectString(record.createdAt, "comment createdAt"),
		url: expectString(record.url, "comment url"),
		...(marker ? { marker } : {}),
	};
}

function boundReviewCommentBody(body: string, originalFindingId: string | undefined): string {
	const bounded = boundUtf8(body, MAX_THREAD_COMMENT_BODY_BYTES);
	if (!originalFindingId || parseOriginalVoltFindingId(bounded) === originalFindingId) return bounded;
	const suffix = `\nVolt finding: ${originalFindingId}`;
	const prefixBytes = MAX_THREAD_COMMENT_BODY_BYTES - Buffer.byteLength(suffix, "utf8");
	return `${boundUtf8(body, prefixBytes)}${suffix}`;
}

function parseOriginalVoltFindingId(body: string): string | undefined {
	const match = /(?:^|\n)Volt finding:\s*([^\s]+)\s*(?:\n|$)/.exec(body);
	const id = match?.[1];
	if (!id || Buffer.byteLength(id, "utf8") > MAX_VOLT_FINDING_ID_BYTES) return undefined;
	return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : undefined;
}

function finalizeThread(accumulator: ThreadAccumulator): ReviewThread {
	if (!accumulator.first) throw new Error(`Review thread ${accumulator.thread.id} has no comments`);
	const comments = [accumulator.first, ...accumulator.latest.filter((comment) => comment.id !== accumulator.first!.id)];
	const latest = comments[comments.length - 1]!;
	const originalFindingId = parseOriginalVoltFindingId(accumulator.first.body);
	const result: ReviewThread = {
		...accumulator.thread,
		comments,
		latestCommentId: latest.id,
		...(originalFindingId ? { originalVoltFindingId: originalFindingId } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_THREAD_CONTEXT_BYTES) {
		throw new Error(`Bounded review thread ${result.id} exceeded ${MAX_THREAD_CONTEXT_BYTES} bytes`);
	}
	return result;
}

function graphqlConnection(
	result: unknown,
	path: readonly string[],
	label: string,
): { nodes: unknown[]; pageInfo: PageInfo } {
	let current: unknown = expectRecord(result, `${label} result`).data;
	for (const part of path) current = expectRecord(current, `${label}.${part}`)[part];
	const record = expectRecord(current, `${label} connection`);
	return { nodes: expectArray(record.nodes, `${label}.nodes`), pageInfo: parsePageInfo(record.pageInfo, `${label}.pageInfo`) };
}

function parsePageInfo(value: unknown, label: string): PageInfo {
	const record = expectRecord(value, label);
	const hasNextPage = expectBoolean(record.hasNextPage, `${label}.hasNextPage`);
	const endCursor = typeof record.endCursor === "string" && record.endCursor.length > 0 ? record.endCursor : undefined;
	if (hasNextPage && !endCursor) throw new Error(`${label} omitted endCursor while hasNextPage is true`);
	return { hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) };
}

function nextCursor(pageInfo: PageInfo, seen: Set<string>, label: string): string | undefined {
	if (!pageInfo.hasNextPage) return undefined;
	const cursor = pageInfo.endCursor;
	if (!cursor) throw new Error(`${label} pagination omitted a cursor`);
	if (seen.has(cursor)) throw new Error(`${label} pagination repeated cursor ${cursor}`);
	seen.add(cursor);
	return cursor;
}

function parseRequiredCheck(value: unknown, index: number): RequiredCheck {
	const record = expectRecord(value, `required check ${index}`);
	return {
		name: expectString(record.name, "required check name"),
		...(typeof record.workflow === "string" && record.workflow.length > 0 ? { workflow: record.workflow } : {}),
		state: expectString(record.state, "required check state"),
		bucket: expectEnum(record.bucket, "required check bucket", ["pass", "fail", "pending", "skipping", "cancel"]),
		...(typeof record.link === "string" && record.link.length > 0 ? { link: record.link } : {}),
		annotations: [],
	};
}

function parseVoltReviewRun(body: string): { voltRunId?: string } {
	const match = /(?:^|\n)Volt review \(([^)\s]+)\)(?:\n|$)/.exec(body);
	return match ? { voltRunId: match[1] } : {};
}

function parseActionsRunId(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return /\/actions\/runs\/(\d+)/.exec(url)?.[1];
}

function normalizeUrl(url: string): string {
	return url.replace(/[?#].*$/, "").replace(/\/$/, "");
}

function samePullRequestIdentity(left: PullRequestIdentity, right: PullRequestIdentity): boolean {
	return (
		left.state === right.state &&
		left.isDraft === right.isDraft &&
		left.isCrossRepository === right.isCrossRepository &&
		left.headRefName === right.headRefName &&
		left.headRefOid === right.headRefOid &&
		left.headRepository === right.headRepository &&
		left.baseRefName === right.baseRefName
	);
}

function bodyAsJson(body: string): string {
	return JSON.stringify({ body });
}

function splitRepository(repository: string): [string, string] {
	const parts = repository.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Invalid repository ${repository}`);
	return [parts[0], parts[1]];
}

function commandError(result: CommandResult, label: string): Error {
	return new Error(`${label} failed with exit ${String(result.code)}: ${result.stderr.trim() || result.stdout.trim()}`);
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function expectStringValue(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
	return value;
}

function expectPositiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
	return value;
}

function expectSha(value: unknown, label: string): string {
	const sha = expectString(value, label);
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a full lowercase SHA`);
	return sha;
}

function expectEnum<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is invalid`);
	return value as Values[number];
}
