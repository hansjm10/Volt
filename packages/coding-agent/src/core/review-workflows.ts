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

/** Maximum concurrently running detached reviews per runtime. */
export const MAX_ACTIVE_REVIEW_WORKFLOWS = 3;
/** Maximum retained terminal review results per runtime (oldest evicted first). */
export const MAX_RETAINED_REVIEW_RESULTS = 8;
/** Bound on the retained raw reviewer text for reviews without parseable findings. */
export const MAX_RETAINED_REVIEW_RAW_CHARS = 65_536;

export type ReviewWorkflowLifecycleStatus = "running" | "completed" | "cancelled" | "failed";

export interface ReviewWorkflowDescriptor {
	workflowId: string;
	/** Review host-action id, e.g. `review.branch`. */
	action: string;
	status: ReviewWorkflowLifecycleStatus;
	target: { description: string; diffCommand: string };
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
			Partial<Pick<PreparedReviewWorkflow["resolution"], "dispose">>;
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

		const descriptor: ReviewWorkflowDescriptor = {
			workflowId,
			action,
			status: "running",
			target: {
				description: resolution.workflowDescription ?? resolution.description,
				diffCommand: resolution.diffCommand,
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
			descriptor.target = {
				description: prepared.resolution.workflowDescription ?? prepared.resolution.description,
				diffCommand: prepared.resolution.diffCommand,
			};
			descriptor.startedAt = prepared.startedAt;
			entry.disposePending = () => prepared.resolution.dispose?.() ?? Promise.resolve();
		};

		const launch = (): void => {
			if (entry.launched) {
				return;
			}
			entry.launched = true;
			void (async () => {
				let result: ExecuteReviewWorkflowResult;
				try {
					result = await options.execute({
						signal: entry.abortController.signal,
						onEvent: (event) => this.emit(event),
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
			return { ...activeEntry.descriptor };
		}
		const record = this.results.get(workflowId);
		return record ? { ...record } : undefined;
	}

	/** Active workflows (oldest first) followed by retained terminal results (oldest first). */
	list(): ReviewWorkflowDescriptor[] {
		const toDescriptor = (record: ReviewWorkflowDescriptor): ReviewWorkflowDescriptor => ({
			workflowId: record.workflowId,
			action: record.action,
			status: record.status,
			target: { ...record.target },
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
		});
		entry.settle(record);
	}
}
