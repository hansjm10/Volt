/**
 * Detached review workflows.
 *
 * Reviews invoked over RPC run detached from the RPC command queue: the
 * invocation returns immediately with a workflowId and the review executes in
 * its own isolated in-memory session while the runtime keeps serving other
 * commands. This manager owns those detached executions for one
 * AgentSessionRuntime: it tracks active workflows, guarantees every workflow
 * reaches a terminal `workflow_end` event, retains a bounded window of
 * terminal results for later fetching (`get_review_result`,
 * `open_review_session`), and supports cancellation by workflowId.
 *
 * Event fan-out is runtime-scoped so it survives client detach/reattach:
 * every event is published through `publishEvent` (the runtime conversation
 * projection feed) and to per-mode sinks attached with `attachSink`.
 */

import { Buffer } from "node:buffer";

// Types only: a runtime import edge from this module (reached via
// AgentSessionRuntime) into review.ts would also defeat test doubles that
// replace review.ts for the RPC modes.
import type {
	ExecuteReviewWorkflowResult,
	ParsedReview,
	PreparedReviewWorkflow,
	ReviewWorkflowEvent,
	ReviewWorkflowToolEvent,
} from "./review.ts";
import type { ReviewChangedFile, ReviewPullRequestIdentity, ReviewSnapshotIdentity } from "./review-snapshot.ts";

/** Maximum concurrently running detached reviews per runtime. */
export const MAX_ACTIVE_REVIEW_WORKFLOWS = 3;
/** Maximum retained terminal review results per runtime (oldest evicted first). */
export const MAX_RETAINED_REVIEW_RESULTS = 8;
/** Bound on the retained raw reviewer text for reviews without parseable findings. */
export const MAX_RETAINED_REVIEW_RAW_CHARS = 65_536;

export type ReviewWorkflowLifecycleStatus = "running" | "completed" | "cancelled" | "failed";

export interface ReviewPullRequestReference {
	provider: string;
	number: number;
}

export interface ReviewPullRequestMetadata extends ReviewPullRequestReference {
	title: string;
	url: string;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	author?: { login: string; avatarUrl?: string };
	reviewState?: NonNullable<ReviewPullRequestIdentity["reviewState"]>;
	mergeability?: NonNullable<ReviewPullRequestIdentity["mergeability"]>;
	checks?: NonNullable<ReviewPullRequestIdentity["checks"]>;
	observedAt?: number;
}

export interface ReviewChangedFileMetadata {
	path: string;
	previousPath?: string;
	status: ReviewChangedFile["status"];
	additions: number;
	deletions: number;
}

export interface ReviewFileMetadata {
	totalCount: number;
	projectedCount: number;
	omittedCount: number;
	additions: number;
	deletions: number;
	isComplete: boolean;
	items: ReviewChangedFileMetadata[];
}

export interface ReviewFileSummarySource {
	totalCount: number;
	additions: number;
	deletions: number;
	inventoryComplete: boolean;
}

export interface ReviewFileMetadataSource {
	path: string;
	previousPath?: string;
	status?: ReviewChangedFile["status"];
	additions?: number;
	deletions?: number;
}

const REVIEW_PULL_REQUEST_PROVIDER_MAX_UTF8_BYTES = 64;
const REVIEW_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
const REVIEW_PULL_REQUEST_TITLE_MAX_UTF8_BYTES = 512;
const REVIEW_PULL_REQUEST_URL_MAX_UTF8_BYTES = 2_000;
const REVIEW_PULL_REQUEST_REF_MAX_UTF8_BYTES = 1_024;
const REVIEW_PULL_REQUEST_AUTHOR_MAX_UTF8_BYTES = 256;
const REVIEW_FILE_PATH_MAX_UTF8_BYTES = 4_096;
const REVIEW_FILE_METADATA_MAX_ITEMS = 200;
const REVIEW_FILE_METADATA_MAX_UTF8_BYTES = 64 * 1024;
const REVIEW_FILE_STATUSES: ReadonlySet<ReviewChangedFile["status"]> = new Set([
	"added",
	"modified",
	"deleted",
	"renamed",
	"copied",
	"type-changed",
]);

function boundedUtf8(value: string, maximumBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	const suffix = "…";
	let end = maximumBytes - Buffer.byteLength(suffix, "utf8");
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

function reviewPullRequestReference(
	pullRequest: Pick<ReviewPullRequestIdentity, "providerId" | "number"> | undefined,
): ReviewPullRequestReference | undefined {
	if (!pullRequest) return undefined;
	const provider = pullRequest.providerId;
	if (
		provider.length === 0 ||
		provider !== provider.trim() ||
		Buffer.byteLength(provider, "utf8") > REVIEW_PULL_REQUEST_PROVIDER_MAX_UTF8_BYTES ||
		/[\u0000-\u001f\u007f]/u.test(provider) ||
		!Number.isSafeInteger(pullRequest.number) ||
		pullRequest.number < 1 ||
		pullRequest.number > REVIEW_PULL_REQUEST_NUMBER_MAX
	) {
		return undefined;
	}
	return { provider, number: pullRequest.number };
}

export function createReviewPullRequestReference(
	identity: Pick<ReviewSnapshotIdentity, "pullRequest"> | undefined,
): ReviewPullRequestReference | undefined {
	return reviewPullRequestReference(identity?.pullRequest);
}

function boundedWebUrl(value: string, maximumBytes: number): string | undefined {
	if (Buffer.byteLength(value, "utf8") > maximumBytes) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function boundedAvatarUrl(value: string | undefined, pullRequestUrl: string): string | undefined {
	if (!value || Buffer.byteLength(value, "utf8") > REVIEW_PULL_REQUEST_URL_MAX_UTF8_BYTES) return undefined;
	try {
		const avatar = new URL(value);
		const pullRequest = new URL(pullRequestUrl);
		if (avatar.protocol !== "https:") return undefined;
		if (avatar.hostname !== pullRequest.hostname && avatar.hostname !== "avatars.githubusercontent.com")
			return undefined;
		return avatar.toString();
	} catch {
		return undefined;
	}
}

function validCheckSummary(checks: ReviewPullRequestIdentity["checks"]): boolean {
	if (!checks || !["passing", "pending", "failing", "none", "unknown"].includes(checks.state)) return false;
	const counts = [
		checks.totalCount,
		checks.passedCount,
		checks.pendingCount,
		checks.failedCount,
		checks.neutralCount,
		checks.unknownCount,
	];
	return (
		counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
		checks.totalCount === counts.slice(1).reduce((total, count) => total + count, 0)
	);
}

export function createReviewPullRequestMetadata(
	identity: Pick<ReviewSnapshotIdentity, "pullRequest"> | undefined,
): ReviewPullRequestMetadata | undefined {
	const pullRequest = identity?.pullRequest;
	const reference = reviewPullRequestReference(pullRequest);
	if (!pullRequest || !reference) return undefined;
	const url = boundedWebUrl(pullRequest.url, REVIEW_PULL_REQUEST_URL_MAX_UTF8_BYTES);
	if (
		!url ||
		!pullRequest.title.trim() ||
		!pullRequest.baseRefName.trim() ||
		!pullRequest.headRefName.trim() ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pullRequest.headRefOid)
	) {
		return undefined;
	}
	const observedAt = pullRequest.observedAt;
	const avatarUrl = boundedAvatarUrl(pullRequest.author?.avatarUrl, url);
	return {
		...reference,
		title: boundedUtf8(pullRequest.title.trim(), REVIEW_PULL_REQUEST_TITLE_MAX_UTF8_BYTES),
		url,
		baseRefName: boundedUtf8(pullRequest.baseRefName, REVIEW_PULL_REQUEST_REF_MAX_UTF8_BYTES),
		headRefName: boundedUtf8(pullRequest.headRefName, REVIEW_PULL_REQUEST_REF_MAX_UTF8_BYTES),
		headRefOid: pullRequest.headRefOid,
		...(pullRequest.author?.login.trim()
			? {
					author: {
						login: boundedUtf8(pullRequest.author.login.trim(), REVIEW_PULL_REQUEST_AUTHOR_MAX_UTF8_BYTES),
						...(avatarUrl ? { avatarUrl } : {}),
					},
				}
			: {}),
		...(pullRequest.reviewState ? { reviewState: pullRequest.reviewState } : {}),
		...(pullRequest.mergeability ? { mergeability: pullRequest.mergeability } : {}),
		...(validCheckSummary(pullRequest.checks) ? { checks: { ...pullRequest.checks! } } : {}),
		...(observedAt !== undefined && Number.isSafeInteger(observedAt) && observedAt >= 0 ? { observedAt } : {}),
	};
}

export function createReviewFileMetadata(
	files: readonly ReviewFileMetadataSource[],
	summary?: ReviewFileSummarySource,
	includeItems = true,
): ReviewFileMetadata {
	let sourceComplete = summary?.inventoryComplete ?? true;
	const inferredAdditions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
	const inferredDeletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
	if (files.some((file) => file.additions === undefined || file.deletions === undefined)) sourceComplete = false;
	const validInferredAdditions = Number.isSafeInteger(inferredAdditions) && inferredAdditions >= 0;
	const validInferredDeletions = Number.isSafeInteger(inferredDeletions) && inferredDeletions >= 0;
	const validSummaryTotal =
		summary !== undefined && Number.isSafeInteger(summary.totalCount) && summary.totalCount >= files.length;
	const validSummaryAdditions =
		summary !== undefined && Number.isSafeInteger(summary.additions) && summary.additions >= 0;
	const validSummaryDeletions =
		summary !== undefined && Number.isSafeInteger(summary.deletions) && summary.deletions >= 0;
	if (
		summary &&
		(!validSummaryTotal ||
			!validSummaryAdditions ||
			!validSummaryDeletions ||
			(summary.inventoryComplete && summary.totalCount !== files.length))
	) {
		sourceComplete = false;
	}
	if (!validInferredAdditions || !validInferredDeletions) sourceComplete = false;
	const totalCount = validSummaryTotal ? summary.totalCount : files.length;
	const additions = validSummaryAdditions ? summary.additions : validInferredAdditions ? inferredAdditions : 0;
	const deletions = validSummaryDeletions ? summary.deletions : validInferredDeletions ? inferredDeletions : 0;
	const items: ReviewChangedFileMetadata[] = [];
	let retainedBytes = 2;
	if (includeItems) {
		for (const file of files) {
			if (items.length >= REVIEW_FILE_METADATA_MAX_ITEMS) break;
			if (
				!file.path ||
				file.path.includes("\0") ||
				Buffer.byteLength(file.path, "utf8") > REVIEW_FILE_PATH_MAX_UTF8_BYTES ||
				(file.previousPath !== undefined &&
					(!file.previousPath ||
						file.previousPath.includes("\0") ||
						Buffer.byteLength(file.previousPath, "utf8") > REVIEW_FILE_PATH_MAX_UTF8_BYTES)) ||
				!file.status ||
				!REVIEW_FILE_STATUSES.has(file.status) ||
				typeof file.additions !== "number" ||
				!Number.isSafeInteger(file.additions) ||
				file.additions < 0 ||
				typeof file.deletions !== "number" ||
				!Number.isSafeInteger(file.deletions) ||
				file.deletions < 0
			) {
				sourceComplete = false;
				break;
			}
			const item: ReviewChangedFileMetadata = {
				path: file.path,
				...(file.previousPath ? { previousPath: file.previousPath } : {}),
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
			};
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length === 0 ? 0 : 1);
			if (retainedBytes + itemBytes > REVIEW_FILE_METADATA_MAX_UTF8_BYTES) break;
			items.push(item);
			retainedBytes += itemBytes;
		}
	}
	const projectedCount = items.length;
	const omittedCount = Math.max(0, totalCount - projectedCount);
	return {
		totalCount,
		projectedCount,
		omittedCount,
		additions,
		deletions,
		isComplete: sourceComplete && omittedCount === 0,
		items,
	};
}

function pullRequestReferenceFromMetadata(
	pullRequest: ReviewPullRequestMetadata | undefined,
): ReviewPullRequestReference | undefined {
	return pullRequest ? { provider: pullRequest.provider, number: pullRequest.number } : undefined;
}

function cloneReviewTarget(target: ReviewWorkflowDescriptor["target"]): ReviewWorkflowDescriptor["target"] {
	return {
		...target,
		...(target.pullRequest ? { pullRequest: structuredClone(target.pullRequest) } : {}),
		...(target.files ? { files: { ...target.files, items: target.files.items.map((item) => ({ ...item })) } } : {}),
	};
}

export interface ReviewWorkflowDescriptor {
	workflowId: string;
	/** Review host-action id, e.g. `review.branch`. */
	action: string;
	status: ReviewWorkflowLifecycleStatus;
	target: {
		description: string;
		diffCommand: string;
		pullRequest?: ReviewPullRequestMetadata;
		files?: ReviewFileMetadata;
	};
	findingsCount?: number;
	completionStatus?: ParsedReview["completionStatus"];
	errorMessage?: string;
	startedAt: number;
	endedAt?: number;
}

export interface ReviewWorkflowResultRecord extends ReviewWorkflowDescriptor {
	/** Fast mode snapshot captured when this review started. */
	fastModeEnabled?: boolean;
	parsed?: ParsedReview;
	/**
	 * Bounded reviewer output, retained only when the report had no parseable
	 * findings payload so the raw text is the sole findings source.
	 */
	raw?: string;
}

export type ReviewWorkflowEventSink = (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent) => void;

export interface ReviewWorkflowExecuteHooks {
	signal: AbortSignal;
	onEvent: ReviewWorkflowEventSink;
}

export interface ReviewWorkflowStartOptions {
	/** Allows one metadata replacement while the launched workflow is still preparing. */
	provisional?: boolean;
	prepared: Pick<PreparedReviewWorkflow, "workflowId" | "action" | "startedAt"> & {
		resolution: Pick<PreparedReviewWorkflow["resolution"], "description" | "workflowDescription" | "diffCommand"> &
			Partial<Pick<PreparedReviewWorkflow["resolution"], "dispose" | "identity" | "changedFiles">>;
	};
	fastModeEnabled?: boolean;
	execute: (hooks: ReviewWorkflowExecuteHooks) => Promise<ExecuteReviewWorkflowResult>;
}

export interface StartedReviewWorkflow {
	descriptor: ReviewWorkflowDescriptor;
	/** Manager-owned lifecycle signal, including cancellation before launch. */
	signal: AbortSignal;
	/** Replace provisional target metadata and disposal with the resolved snapshot. */
	updatePrepared: (prepared: ReviewWorkflowStartOptions["prepared"]) => void;
	/**
	 * Begins detached execution. Idempotent. Callers emit their acceptance
	 * response before launching so the response deterministically precedes
	 * workflow_start on shared ordered lanes.
	 */
	launch: () => void;
	/** Resolves with the retained terminal record after workflow_end is emitted. */
	finished: Promise<ReviewWorkflowResultRecord>;
}

interface ActiveReviewWorkflow {
	descriptor: ReviewWorkflowDescriptor;
	abortController: AbortController;
	fastModeEnabled: boolean;
	launched: boolean;
	awaitingPreparation: boolean;
	done: Promise<ReviewWorkflowResultRecord>;
	settle: (record: ReviewWorkflowResultRecord) => void;
	disposePending: () => Promise<void>;
}

function formatRunningReviewMessage(description: string, preparing: boolean): string {
	return preparing ? `${description}.` : `Reviewing ${description}.`;
}

function formatCompletedReviewSummary(
	completionStatus: ParsedReview["completionStatus"],
	findingsCount: number | undefined,
): string {
	if (completionStatus === "incomplete") {
		return `Review incomplete${findingsCount ? `: ${findingsCount} verified finding${findingsCount === 1 ? "" : "s"}` : ""}.`;
	}
	if (findingsCount === undefined) {
		return "Review complete.";
	}
	if (findingsCount === 0) {
		return "Review complete: no issues found.";
	}
	return `Review complete: ${findingsCount} finding${findingsCount === 1 ? "" : "s"}.`;
}

export class ReviewWorkflowManager {
	private readonly active = new Map<string, ActiveReviewWorkflow>();
	private readonly results = new Map<string, ReviewWorkflowResultRecord>();
	private readonly sinks = new Set<ReviewWorkflowEventSink>();
	private readonly publishEvent?: ReviewWorkflowEventSink;

	constructor(options: { publishEvent?: ReviewWorkflowEventSink } = {}) {
		this.publishEvent = options.publishEvent;
	}

	/** Attach a per-mode event sink. Returns a detach function. */
	attachSink(sink: ReviewWorkflowEventSink): () => void {
		this.sinks.add(sink);
		return () => {
			this.sinks.delete(sink);
		};
	}

	get hasActiveWorkflows(): boolean {
		return this.active.size > 0;
	}

	/** Resolves once no review workflow is active. */
	async waitForIdle(): Promise<void> {
		while (this.active.size > 0) {
			await Promise.all(Array.from(this.active.values(), (entry) => entry.done));
		}
	}

	/**
	 * Register a review workflow. The initial metadata may be provisional and
	 * replaced once with `updatePrepared()` while the launched workflow prepares.
	 * Throws when the concurrency cap is reached. Execution does not begin until
	 * `launch()` is invoked.
	 */
	start(options: ReviewWorkflowStartOptions): StartedReviewWorkflow {
		const { workflowId, action, resolution } = options.prepared;
		if (this.active.size >= MAX_ACTIVE_REVIEW_WORKFLOWS) {
			throw new Error(
				`Too many running reviews (max ${MAX_ACTIVE_REVIEW_WORKFLOWS}). Cancel one or wait for it to finish.`,
			);
		}
		if (this.active.has(workflowId) || this.results.has(workflowId)) {
			throw new Error(`Review workflow already exists: ${workflowId}`);
		}

		const initialPullRequest = createReviewPullRequestMetadata(resolution.identity);
		const initialFiles = resolution.changedFiles ? createReviewFileMetadata(resolution.changedFiles) : undefined;
		const descriptor: ReviewWorkflowDescriptor = {
			workflowId,
			action,
			status: "running",
			target: {
				description: resolution.workflowDescription ?? resolution.description,
				diffCommand: resolution.diffCommand,
				...(initialPullRequest ? { pullRequest: initialPullRequest } : {}),
				...(initialFiles ? { files: initialFiles } : {}),
			},
			startedAt: options.prepared.startedAt,
		};
		let settle: (record: ReviewWorkflowResultRecord) => void = () => {};
		const done = new Promise<ReviewWorkflowResultRecord>((resolve) => {
			settle = resolve;
		});
		const entry: ActiveReviewWorkflow = {
			descriptor,
			abortController: new AbortController(),
			fastModeEnabled: options.fastModeEnabled === true,
			launched: false,
			awaitingPreparation: options.provisional === true,
			done,
			settle,
			disposePending: () => options.prepared.resolution.dispose?.() ?? Promise.resolve(),
		};
		this.active.set(workflowId, entry);

		const updatePrepared = (prepared: ReviewWorkflowStartOptions["prepared"]): void => {
			if (prepared.workflowId !== workflowId) {
				throw new Error(`Cannot replace review workflow ${workflowId} with ${prepared.workflowId}`);
			}
			if (this.active.get(workflowId) !== entry || !entry.awaitingPreparation) {
				throw new Error(`Review workflow is no longer awaiting preparation: ${workflowId}`);
			}
			entry.awaitingPreparation = false;
			descriptor.action = prepared.action;
			const pullRequest = createReviewPullRequestMetadata(prepared.resolution.identity);
			const files = prepared.resolution.changedFiles
				? createReviewFileMetadata(prepared.resolution.changedFiles)
				: undefined;
			descriptor.target = {
				description: prepared.resolution.workflowDescription ?? prepared.resolution.description,
				diffCommand: prepared.resolution.diffCommand,
				...(pullRequest ? { pullRequest } : {}),
				...(files ? { files } : {}),
			};
			descriptor.startedAt = prepared.startedAt;
			entry.disposePending = () => prepared.resolution.dispose?.() ?? Promise.resolve();
			if (entry.launched && !entry.abortController.signal.aborted) {
				const eventPullRequest = pullRequestReferenceFromMetadata(descriptor.target.pullRequest);
				this.emit({
					type: "workflow_update",
					workflowId: descriptor.workflowId,
					kind: "review",
					action: descriptor.action,
					title: "Review",
					message: formatRunningReviewMessage(descriptor.target.description, false),
					status: "running",
					startedAt: descriptor.startedAt,
					...(eventPullRequest ? { pullRequest: eventPullRequest } : {}),
				});
			}
		};

		const launch = (): void => {
			if (entry.launched) {
				return;
			}
			entry.launched = true;
			const eventPullRequest = pullRequestReferenceFromMetadata(descriptor.target.pullRequest);
			this.emit({
				type: "workflow_start",
				workflowId: descriptor.workflowId,
				kind: "review",
				action: descriptor.action,
				title: "Review",
				message: formatRunningReviewMessage(descriptor.target.description, entry.awaitingPreparation),
				status: "running",
				startedAt: descriptor.startedAt,
				...(eventPullRequest ? { pullRequest: eventPullRequest } : {}),
			});
			void (async () => {
				let result: ExecuteReviewWorkflowResult;
				try {
					result = await options.execute({
						signal: entry.abortController.signal,
						onEvent: (event) => {
							if (event.type === "workflow_start" && event.workflowId === workflowId) return;
							const forwardedPullRequest = pullRequestReferenceFromMetadata(descriptor.target.pullRequest);
							if (forwardedPullRequest && (event.type === "workflow_update" || event.type === "workflow_end")) {
								this.emit({
									...event,
									pullRequest: { ...forwardedPullRequest },
								});
								return;
							}
							this.emit(event);
						},
					});
				} catch (error) {
					result = {
						status: "failed",
						errorMessage: error instanceof Error ? error.message : String(error),
					};
				}
				// Cancellation wins until the executor commits its terminal record.
				// After that boundary, the durable outcome is authoritative.
				if (
					entry.abortController.signal.aborted &&
					result.status === "completed" &&
					result.durableRecordCommitted !== true
				) {
					result = { status: "cancelled" };
				}
				this.finish(entry, result);
			})();
		};
		return {
			descriptor,
			signal: entry.abortController.signal,
			updatePrepared,
			launch,
			finished: done,
		};
	}

	/** Abort a running review workflow. Throws for unknown or finished workflows. */
	cancel(workflowId: string): void {
		const entry = this.active.get(workflowId);
		if (!entry) {
			throw new Error(`No running review workflow: ${workflowId}`);
		}
		entry.abortController.abort();
		// A registered-but-never-launched workflow has no execution to observe
		// the signal, so finish it here.
		if (!entry.launched) {
			entry.launched = true;
			void entry.disposePending();
			this.finish(entry, { status: "cancelled" });
		}
	}

	/** Terminal result record, or the live descriptor for a running workflow. */
	get(workflowId: string): ReviewWorkflowResultRecord | undefined {
		const activeEntry = this.active.get(workflowId);
		if (activeEntry) {
			return { ...activeEntry.descriptor, target: cloneReviewTarget(activeEntry.descriptor.target) };
		}
		const record = this.results.get(workflowId);
		return record ? { ...record, target: cloneReviewTarget(record.target) } : undefined;
	}

	/** Active workflows (oldest first) followed by retained terminal results (oldest first). */
	list(): ReviewWorkflowDescriptor[] {
		const toDescriptor = (record: ReviewWorkflowDescriptor): ReviewWorkflowDescriptor => ({
			workflowId: record.workflowId,
			action: record.action,
			status: record.status,
			target: cloneReviewTarget(record.target),
			...(record.findingsCount === undefined ? {} : { findingsCount: record.findingsCount }),
			...(record.completionStatus === undefined ? {} : { completionStatus: record.completionStatus }),
			...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
			startedAt: record.startedAt,
			...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
		});
		return [
			...Array.from(this.active.values(), (entry) => toDescriptor(entry.descriptor)),
			...Array.from(this.results.values(), toDescriptor),
		];
	}

	/** Abort every active workflow and wait for launched executions to settle. */
	async abortAll(): Promise<void> {
		const entries = Array.from(this.active.values());
		for (const entry of entries) {
			entry.abortController.abort();
			if (!entry.launched) {
				entry.launched = true;
				void entry.disposePending();
				this.finish(entry, { status: "cancelled" });
			}
		}
		await Promise.all(entries.map((entry) => entry.done));
	}

	private emit(event: ReviewWorkflowEvent | ReviewWorkflowToolEvent): void {
		// Sink failures (disposed feeds, detached transports) must never break a
		// running review or the other sinks.
		try {
			this.publishEvent?.(event);
		} catch {
			// Runtime feed rejected or already disposed.
		}
		for (const sink of this.sinks) {
			try {
				sink(event);
			} catch {
				// Observer errors are the observer's problem.
			}
		}
	}

	private finish(entry: ActiveReviewWorkflow, result: ExecuteReviewWorkflowResult): void {
		const descriptor = entry.descriptor;
		descriptor.status = result.status;
		descriptor.endedAt = Date.now();

		let record: ReviewWorkflowResultRecord = { ...descriptor, fastModeEnabled: entry.fastModeEnabled };
		let message: string;
		if (result.status === "completed") {
			descriptor.findingsCount = result.findingsCount;
			descriptor.completionStatus = result.completionStatus;
			record = {
				...descriptor,
				fastModeEnabled: entry.fastModeEnabled,
				...(result.parsed === undefined
					? { raw: result.raw.slice(0, MAX_RETAINED_REVIEW_RAW_CHARS) }
					: { parsed: result.parsed }),
			};
			message = `${formatCompletedReviewSummary(result.completionStatus, result.findingsCount)} Fetch the findings or open them in a review session.`;
		} else if (result.status === "cancelled") {
			message = "Review cancelled.";
		} else {
			descriptor.errorMessage = result.errorMessage;
			record = { ...descriptor, fastModeEnabled: entry.fastModeEnabled };
			message = `Review failed: ${result.errorMessage}`;
		}

		this.active.delete(descriptor.workflowId);
		this.results.set(descriptor.workflowId, record);
		while (this.results.size > MAX_RETAINED_REVIEW_RESULTS) {
			const oldest = this.results.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.results.delete(oldest);
		}

		const eventPullRequest = pullRequestReferenceFromMetadata(descriptor.target.pullRequest);
		this.emit({
			type: "workflow_end",
			workflowId: descriptor.workflowId,
			kind: "review",
			action: descriptor.action,
			title: "Review",
			message,
			status: result.status,
			startedAt: descriptor.startedAt,
			endedAt: descriptor.endedAt,
			...(eventPullRequest ? { pullRequest: eventPullRequest } : {}),
		});
		entry.settle(record);
	}
}
