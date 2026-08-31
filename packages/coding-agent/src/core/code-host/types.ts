export type ReviewCodeHostContextLimitationCode =
	| "api-error"
	| "invalid-api-response"
	| "text-limit"
	| "linked-issue-limit"
	| "discussion-limit"
	| "aggregate-limit";

export interface ReviewCodeHostContextLimitation {
	code: ReviewCodeHostContextLimitationCode;
	source: string;
	count: number;
}

export interface ReviewPullRequestIdentity {
	providerId: string;
	number: number;
	title: string;
	body: string;
	url: string;
	baseRefName: string;
	headRefName: string;
	baseRefOid: string;
	headRefOid: string;
}

export interface ReviewCodeHostActor {
	login: string;
	type: string;
}

export interface ReviewCodeHostLinkedIssue {
	id: string;
	repository: string;
	number: number;
	title: string;
	body: string;
	url: string;
	state: string;
	stateReason?: string;
	relationship: "closing" | "manual" | "unknown";
	author?: ReviewCodeHostActor;
	createdAt?: string;
	updatedAt?: string;
}

export interface ReviewCodeHostDiscussionEntry {
	id: string;
	kind: "pr-comment" | "review-summary" | "review-thread-comment" | "linked-issue-comment";
	body: string;
	url?: string;
	author?: ReviewCodeHostActor;
	authorAssociation?: string;
	createdAt?: string;
	updatedAt?: string;
	state?: string;
	commitOid?: string;
	issue?: { repository: string; number: number };
	thread?: {
		id: string;
		isResolved: boolean;
		isOutdated: boolean;
		path?: string;
		line?: number;
		startLine?: number;
		originalLine?: number;
		originalStartLine?: number;
		diffSide?: string;
	};
	diffHunk?: string;
	isMinimized?: boolean;
	minimizedReason?: string;
	replyToId?: string;
}

export interface ReviewCodeHostContextManifest {
	status: "complete" | "incomplete";
	capturedAt: string;
	linkedIssueCount: number;
	discussionEntryCount: number;
	renderedLinkedIssueCount: number;
	renderedDiscussionEntryCount: number;
	renderedBytes: number;
	limitations: ReviewCodeHostContextLimitation[];
	fingerprint: string;
}

export interface ReviewCodeHostContext {
	manifest: ReviewCodeHostContextManifest;
	linkedIssues: ReviewCodeHostLinkedIssue[];
	discussionEntries: ReviewCodeHostDiscussionEntry[];
	rendered: string;
}

export type ReviewCodeHostContextCaptureResult =
	| { ok: true; pullRequest: ReviewPullRequestIdentity; context: ReviewCodeHostContext }
	| { ok: false; error: string; remoteError?: string };

export interface ReviewCodeHostContextCaptureOptions {
	cwd: string;
	number?: string;
	maxPullRequestNumber: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface CodeHostPullRequestSummary {
	number: number;
	title: string;
}

/** Host-only normalized repository identity. Never project canonicalId to clients. */
export interface CanonicalCodeHostRepository {
	providerId: string;
	host: string;
	owner: string;
	name: string;
	canonicalId: string;
}

export type CodeHostPullRequestStatus = "open" | "draft" | "merged" | "closed";

/** Bounded exact match retained by daemon Work association state. */
export interface CodeHostPullRequestAssociation {
	providerId: string;
	repository: CanonicalCodeHostRepository;
	headRepository: CanonicalCodeHostRepository;
	number: number;
	title: string;
	status: CodeHostPullRequestStatus;
	headBranch: string;
	matchedHeadOid: string;
}

export type CodeHostPullRequestDiscoveryUnavailableReason =
	| "unsupported_repository"
	| "repository_ambiguous"
	| "not_authenticated"
	| "rate_limited"
	| "network"
	| "timeout"
	| "output_limited"
	| "invalid_response"
	| "provider_error"
	| "cancelled";

export type CodeHostPullRequestDiscoveryOutcome =
	| { state: "resolved"; pullRequest: CodeHostPullRequestAssociation }
	| { state: "none" }
	| { state: "ambiguous" }
	| { state: "unavailable"; reason: CodeHostPullRequestDiscoveryUnavailableReason };

export interface CodeHostPullRequestDiscoveryRequest {
	cwd: string;
	branch: string;
	headOid: string;
	signal?: AbortSignal;
}

export interface CodeHostPullRequestDiscoveryProvider {
	readonly id: string;
	discoverPullRequest(request: CodeHostPullRequestDiscoveryRequest): Promise<CodeHostPullRequestDiscoveryOutcome>;
}

export interface PullRequestFetchRef {
	remoteRef: string;
	localRef: string;
}

export interface PullRequestFetchPlan {
	remote: string;
	base: PullRequestFetchRef;
	head: PullRequestFetchRef;
	diffCommand: string;
}

export interface ReviewCodeHostInlineComment {
	path: string;
	side: "base" | "head";
	startLine: number;
	endLine: number;
	body: string;
}

export interface ReviewCodeHostPublishRequest {
	cwd: string;
	pullRequest: ReviewPullRequestIdentity;
	body: string;
	comments: ReviewCodeHostInlineComment[];
}

export interface ReviewCodeHostPublishResult {
	reviewId?: number;
	url?: string;
}

export interface CodeHostProvider {
	readonly id: string;
	readonly displayName: string;
	probeCurrentPullRequest(cwd: string, signal?: AbortSignal): Promise<CodeHostPullRequestSummary | undefined>;
	capturePullRequestContext(options: ReviewCodeHostContextCaptureOptions): Promise<ReviewCodeHostContextCaptureResult>;
	getPullRequestFetchPlan(pullRequest: ReviewPullRequestIdentity): PullRequestFetchPlan;
	verifyPullRequestHead(cwd: string, pullRequest: ReviewPullRequestIdentity): Promise<void>;
	publishPullRequestReview(request: ReviewCodeHostPublishRequest): Promise<ReviewCodeHostPublishResult>;
}
