import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import type { ParsedReview } from "../src/core/review-report.ts";
import {
	acknowledgeReviewRun,
	appendReviewRun,
	getReviewRun,
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	type ReviewRunRecord,
} from "../src/core/review-state.ts";
import { ReviewWorkflowManager } from "../src/core/review-workflows.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function parsedReview(): ParsedReview {
	return {
		completionStatus: "complete",
		summary: "One issue was independently verified.",
		findings: [
			{
				id: "finding-1",
				fingerprint: "a".repeat(64),
				status: "open",
				title: "Wrong guard",
				body: "The guard returns the wrong value.",
				trigger: "Call with zero.",
				impact: "The caller receives incorrect data.",
				category: "correctness",
				rootCauseKey: "wrong-zero-guard",
				priority: 2,
				confidence: 0.9,
				changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
				evidenceLocations: [{ path: "src/value.ts", side: "base", startLine: 1, endLine: 3 }],
				verification: {
					outcome: "accepted",
					method: "Exact blob comparison",
					rationale: "The added branch is present.",
					confidence: 0.95,
				},
			},
		],
		coverage: {
			changedFileInventoryComplete: true,
			filesInspected: ["src/value.ts"],
			hunksInspected: ["hunk-1"],
			commandsRun: [],
			failedVerificationAttempts: [],
			exclusions: [],
			uncheckedAreas: [],
			residualRisk: [],
			modelReportedLimitations: [],
		},
		overallCorrectness: "incorrect",
		overallExplanation: "A verified P2 finding remains.",
	};
}

function durableRecord(runId = "review:test"): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "uncommitted changes",
			diffCommand: "git diff exact-base..exact-head",
			identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
			files: [
				{ path: "src/value.ts", baseOid: "base-blob", headOid: "head-blob", hunkIds: ["hunk-1"], reviewable: true },
			],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: parsedReview(),
	};
}

function durableBranchRecord(runId = "review:test"): ReviewRunRecord {
	const record = durableRecord(runId);
	return {
		...record,
		workflowAction: "review.branch",
		target: {
			...record.target,
			description: "branch changes vs origin/main",
			diffCommand: "git diff origin/main...HEAD",
			identity: {
				kind: "branch",
				baseTree: "base-tree",
				headTree: "head-tree",
				baseCommit: "base-commit",
				headCommit: "head-commit",
			},
			branchBase: { kind: "remote", remote: "origin", remoteRef: "refs/heads/main" },
		},
	};
}

interface ExecuteOptions {
	prepared: { workflowId: string; action: string };
	sessionManager?: SessionManager;
	sanitizeRemoteErrors?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: Record<string, unknown>) => void;
}

type ExecuteResult =
	| { status: "cancelled" }
	| { status: "failed"; errorMessage: string }
	| {
			status: "completed";
			raw: string;
			parsed: ParsedReview;
			findingsCount: number;
			completionStatus: ParsedReview["completionStatus"];
			record: ReviewRunRecord;
	  };

const reviewMocks = vi.hoisted(() => {
	const dispose = vi.fn(async () => {});
	const resolution = {
		description: "uncommitted changes",
		diffCommand: "git diff exact-base..exact-head",
		identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
		changedFiles: [],
		root: "/workspace",
		readFile: vi.fn(async () => undefined),
		listFiles: vi.fn(async () => []),
		materializeHead: vi.fn(async () => "/tmp/review"),
		dispose,
	};
	return {
		dispose,
		prepareReviewWorkflow: vi.fn(
			async (options: { target: { kind: string }; controls?: object; parentRunId?: string }) => ({
				workflowId: "review:test",
				action: `review.${options.target.kind}`,
				target: options.target,
				controls: {
					scope: [],
					effort: "standard",
					includeOptional: false,
					scopeMode: "incremental",
					...options.controls,
				},
				resolution,
				model: { id: "test-model", provider: "test" },
				verifierModel: { id: "verify-model", provider: "test" },
				startedAt: 1,
				incrementalPlan: {
					mode: "full",
					changedPaths: [],
					priorOpenFindings: [],
					suppressedDismissedFingerprints: [],
				},
			}),
		),
		executeReviewWorkflow: vi.fn(async (options: ExecuteOptions): Promise<ExecuteResult> => {
			options.onEvent?.({
				type: "workflow_start",
				workflowId: options.prepared.workflowId,
				kind: "review",
				action: options.prepared.action,
				title: "Review",
				message: "Reviewing uncommitted changes.",
				status: "running",
			});
			options.onEvent?.({
				type: "tool_execution_start",
				workflowId: options.prepared.workflowId,
				workflowKind: "review",
				workflowAction: options.prepared.action,
				toolCallId: "tool-1",
				toolName: "review_file",
				args: { path: "src/value.ts" },
			});
			options.onEvent?.({
				type: "tool_execution_end",
				workflowId: options.prepared.workflowId,
				workflowKind: "review",
				workflowAction: options.prepared.action,
				toolCallId: "tool-1",
				toolName: "review_file",
				isError: false,
			});
			const record = durableRecord(options.prepared.workflowId);
			if (options.sessionManager) appendReviewRun(options.sessionManager, record);
			return {
				status: "completed" as const,
				raw: record.result?.summary ?? "",
				parsed: record.result!,
				findingsCount: 1,
				completionStatus: record.result!.completionStatus,
				record,
			};
		}),
	};
});

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/review.ts")>();
	return {
		...actual,
		prepareReviewWorkflow: reviewMocks.prepareReviewWorkflow,
		executeReviewWorkflow: reviewMocks.executeReviewWorkflow,
	};
});

import { runRpcMode as runRpcModeImpl } from "../src/modes/rpc/rpc-mode.ts";

function runRpcMode(runtimeHost: AgentSessionRuntime, options: Parameters<typeof runRpcModeImpl>[1]): Promise<void> {
	return runRpcModeImpl(runtimeHost, options);
}

interface CollectingTransport {
	transport: RpcTransport;
	writes: object[];
	getLineHandler(): RpcLineHandler;
	getCloseHandler(): RpcCloseHandler | undefined;
}

function createCollectingTransport(): CollectingTransport {
	let lineHandler: RpcLineHandler | undefined;
	let closeHandler: RpcCloseHandler | undefined;
	const writes: object[] = [];
	return {
		transport: {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return vi.fn();
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return vi.fn();
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		writes,
		getLineHandler: () => {
			if (!lineHandler) throw new Error("RPC line handler was not installed");
			return lineHandler;
		},
		getCloseHandler: () => closeHandler,
	};
}

function makeSession(sessionId: string, sessionManager = SessionManager.inMemory("/workspace")) {
	let fastModeEnabled = false;
	return {
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => vi.fn()),
		activeToolExecutions: new Map(),
		subscribeRuntimeEvents: vi.fn(() => vi.fn()),
		isStreaming: false,
		isCompacting: false,
		thinkingLevel: "off",
		get fastModeEnabled() {
			return fastModeEnabled;
		},
		setFastModeEnabled: vi.fn((enabled: boolean) => {
			fastModeEnabled = enabled;
		}),
		getAvailableThinkingLevels: vi.fn(() => ["off"]),
		gitContextProvider: { getSnapshot: () => null, retainObservation: () => () => undefined },
		steeringMode: "all",
		followUpMode: "all",
		autoCompactionEnabled: false,
		messages: [],
		pendingMessageCount: 0,
		modelRegistry: { authStorage: {} },
		settingsManager: {},
		resourceLoader: {},
		sessionFile: `/sessions/${sessionId}.jsonl`,
		sessionId,
		sessionManager,
	};
}

function makeRuntimeHost(
	options: { manager?: SessionManager; seedMessages?: object[]; replacementManagers?: SessionManager[] } = {},
) {
	let currentSession = makeSession("initial-session", options.manager);
	const runtimeHost = {
		get session() {
			return currentSession;
		},
		cwd: "/workspace",
		services: { agentDir: "/workspace/.volt" },
		reviewWorkflows: new ReviewWorkflowManager(),
		newSession: vi.fn(
			async (newSessionOptions?: {
				setup?: (sessionManager: SessionManager) => Promise<void>;
				withSession?: (ctx: { sendMessage(message: object): Promise<void> }) => Promise<void>;
			}) => {
				const sessionManager = SessionManager.inMemory("/workspace");
				await newSessionOptions?.setup?.(sessionManager);
				options.replacementManagers?.push(sessionManager);
				currentSession = makeSession("review-session", sessionManager);
				await newSessionOptions?.withSession?.({
					sendMessage: async (message) => {
						options.seedMessages?.push(message);
					},
				});
				return { cancelled: false, seeded: newSessionOptions?.withSession !== undefined };
			},
		),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		async runWithStableSession<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
			return operation(currentSession as unknown as AgentSession);
		},
	} as unknown as AgentSessionRuntime;
	return runtimeHost;
}

async function startMode(
	runtimeHost: AgentSessionRuntime,
	transport: RpcTransport,
	options: { requireRemoteSafeUiActions?: boolean } = {},
): Promise<{ modePromise: Promise<void> }> {
	let readyResolve: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		readyResolve = resolve;
	});
	const modePromise = runRpcMode(runtimeHost, {
		transport,
		exitProcess: false,
		onReady: readyResolve,
		...options,
	});
	await ready;
	return { modePromise };
}

async function closeMode(collecting: CollectingTransport, started: { modePromise: Promise<void> }): Promise<void> {
	collecting.getCloseHandler()?.();
	await expect(started.modePromise).resolves.toBeUndefined();
}

function response(writes: object[], id: string): Record<string, unknown> | undefined {
	return writes.find((write) => (write as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
}

afterEach(() => {
	reviewMocks.prepareReviewWorkflow.mockClear();
	reviewMocks.executeReviewWorkflow.mockClear();
	reviewMocks.dispose.mockClear();
	restoreStdout();
});

describe("RPC durable review actions", () => {
	test("returns acceptance before detached events, sanitizes failures, and projects only snapshot tool metadata", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteOptions) => {
			options.onEvent?.({
				type: "workflow_start",
				workflowId: "review:test",
				kind: "review",
				action: "review.uncommitted",
				title: "Review",
				message: "Reviewing.",
				status: "running",
			});
			await gate;
			const record = durableRecord();
			if (options.sessionManager) appendReviewRun(options.sessionManager, record);
			return {
				status: "completed",
				raw: record.result!.summary,
				parsed: record.result!,
				findingsCount: 1,
				completionStatus: record.result!.completionStatus,
				record,
			};
		});
		const runtimeHost = makeRuntimeHost();
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport, {
			requireRemoteSafeUiActions: true,
		});
		collecting.getLineHandler()(
			JSON.stringify({ id: "invoke", type: "invoke_ui_action", action: "review.uncommitted" }),
		);
		await vi.waitFor(() =>
			expect(response(collecting.writes, "invoke")).toMatchObject({
				success: true,
				data: { status: "accepted", workflowId: "review:test" },
			}),
		);
		await vi.waitFor(() =>
			expect(collecting.writes).toContainEqual(expect.objectContaining({ type: "workflow_start" })),
		);
		expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({ sanitizeRemoteErrors: true }),
		);
		const acceptedIndex = collecting.writes.findIndex((write) => (write as Record<string, unknown>).id === "invoke");
		const eventIndex = collecting.writes.findIndex(
			(write) => (write as Record<string, unknown>).type === "workflow_start",
		);
		expect(acceptedIndex).toBeLessThan(eventIndex);
		release();
		await vi.waitFor(() => expect(runtimeHost.reviewWorkflows.get("review:test")?.status).toBe("completed"));
		await closeMode(collecting, modePromise);
	});

	test("hydrates durable paginated results and exposes structured context coverage without raw GitHub text", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord("review:older"));
		const newer = { ...durableRecord("review:newer"), endedAt: 3 };
		newer.target.context = {
			captureStatus: "complete",
			linkedIssueCount: 2,
			discussionEntryCount: 5,
			renderedLinkedIssueCount: 2,
			renderedDiscussionEntryCount: 5,
			renderedBytes: 1_024,
			limitationCodes: [],
			fingerprint: "c".repeat(64),
		};
		newer.result!.coverage.context = {
			captureStatus: "complete",
			linkedIssueCount: 2,
			discussionEntryCount: 5,
			limitationCodes: [],
			fingerprint: "c".repeat(64),
			discoveryInspectionComplete: true,
			verificationInspectionComplete: true,
		};
		appendReviewRun(manager, newer);
		const runtimeHost = makeRuntimeHost({ manager });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();
		line(JSON.stringify({ id: "list", type: "list_review_workflows", limit: 1 }));
		line(JSON.stringify({ id: "get", type: "get_review_result", runId: "review:newer" }));
		await vi.waitFor(() => expect(response(collecting.writes, "get")).toBeDefined());
		const listData = response(collecting.writes, "list")?.data as {
			runs: Array<{ runId: string }>;
			nextCursor?: string;
		};
		expect(listData.runs).toHaveLength(1);
		expect(listData.nextCursor).toBeTruthy();
		line(JSON.stringify({ id: "next", type: "list_review_workflows", cursor: listData.nextCursor, limit: 1 }));
		line(JSON.stringify({ id: "oversized", type: "list_review_workflows", limit: 101 }));
		await vi.waitFor(() => {
			expect(response(collecting.writes, "next")).toBeDefined();
			expect(response(collecting.writes, "oversized")).toBeDefined();
		});
		expect(response(collecting.writes, "next")?.data).toMatchObject({ runs: [{ runId: "review:older" }] });
		expect(response(collecting.writes, "oversized")).toMatchObject({
			success: false,
			error: expect.stringContaining("limit"),
		});
		const getData = response(collecting.writes, "get")?.data as Record<string, unknown>;
		expect(getData).toMatchObject({
			runId: "review:newer",
			completionStatus: "complete",
			overallCorrectness: "incorrect",
			target: { context: { linkedIssueCount: 2, discussionEntryCount: 5, fingerprint: "c".repeat(64) } },
			coverage: {
				context: {
					discoveryInspectionComplete: true,
					verificationInspectionComplete: true,
				},
			},
		});
		expect(JSON.stringify(getData)).toContain("changeLocation");
		expect(JSON.stringify(getData)).not.toContain('"file"');
		expect(JSON.stringify(getData)).not.toContain("filesReviewed");
		expect(JSON.stringify(getData)).not.toContain("PRIVATE_LINKED_ISSUE_AND_REVIEW_TEXT");
		await closeMode(collecting, modePromise);
	});

	test("records local outcomes, seeds explicit selections, and treats blank fix selections as all findings", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const second = {
			...parsedReview().findings[0],
			id: "finding-2",
			fingerprint: "b".repeat(64),
			title: "Second issue",
		};
		const record = durableRecord();
		record.result!.findings.push(second);
		appendReviewRun(manager, record);
		const seedMessages: object[] = [];
		const replacementManagers: SessionManager[] = [];
		const runtimeHost = makeRuntimeHost({ manager, seedMessages, replacementManagers });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();
		line(
			JSON.stringify({
				id: "label",
				type: "record_review_finding_outcome",
				runId: "review:test",
				findingId: "finding-1",
				status: "dismissed",
				reason: "false_positive",
				note: "Reproduced expected behavior",
			}),
		);
		line(JSON.stringify({ id: "export", type: "export_review_feedback" }));
		await vi.waitFor(() => expect(response(collecting.writes, "export")).toBeDefined());
		expect(response(collecting.writes, "export")?.data).toMatchObject({
			schemaVersion: 1,
			outcomes: [{ findingId: "finding-1", status: "dismissed" }],
		});
		line(
			JSON.stringify({ id: "open", type: "open_review_session", runId: "review:test", findingIds: ["finding-2"] }),
		);
		await vi.waitFor(() =>
			expect(response(collecting.writes, "open")).toMatchObject({ success: true, data: { cancelled: false } }),
		);
		expect(JSON.stringify(seedMessages)).toContain("finding-2");
		expect(JSON.stringify(seedMessages)).not.toContain("finding-1");
		expect(JSON.stringify(seedMessages)).not.toContain("PRIVATE_LINKED_ISSUE_AND_REVIEW_TEXT");
		expect(
			replacementManagers[0]
				?.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "volt.review.run"),
		).toBe(true);
		expect(getReviewRun(manager, "review:test")?.acknowledgedAt).toBeUndefined();
		const openedAcknowledgedAt = getReviewRun(replacementManagers[0]!, "review:test")?.acknowledgedAt;
		expect(openedAcknowledgedAt).toEqual(expect.any(Number));
		line(JSON.stringify({ id: "get-opened", type: "get_review_result", runId: "review:test" }));
		await vi.waitFor(() => expect(response(collecting.writes, "get-opened")).toBeDefined());
		expect(response(collecting.writes, "get-opened")?.data).toMatchObject({
			runId: "review:test",
			acknowledgedAt: expect.any(Number),
			findings: expect.any(Array),
		});

		seedMessages.length = 0;
		line(
			JSON.stringify({
				id: "fix-blank",
				type: "invoke_ui_action",
				action: "review.fix",
				args: { runId: "review:test", findingIds: "" },
			}),
		);
		await vi.waitFor(() =>
			expect(response(collecting.writes, "fix-blank")).toMatchObject({
				success: true,
				data: { status: "completed" },
			}),
		);
		expect(JSON.stringify(seedMessages)).toContain("finding-1");
		expect(JSON.stringify(seedMessages)).toContain("finding-2");
		expect(getReviewRun(replacementManagers[1]!, "review:test")?.acknowledgedAt).toBe(openedAcknowledgedAt);
		await closeMode(collecting, modePromise);
	});

	test("acknowledges full opens in source and target while retaining durable results", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord());
		const replacementManagers: SessionManager[] = [];
		const runtimeHost = makeRuntimeHost({ manager, replacementManagers });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();

		line(JSON.stringify({ id: "open-all", type: "open_review_session", runId: "review:test" }));
		await vi.waitFor(() =>
			expect(response(collecting.writes, "open-all")).toMatchObject({
				success: true,
				data: { cancelled: false },
			}),
		);
		const source = getReviewRun(manager, "review:test");
		const target = getReviewRun(replacementManagers[0]!, "review:test");
		expect(source?.acknowledgedAt).toEqual(expect.any(Number));
		expect(target?.acknowledgedAt).toBe(source?.acknowledgedAt);
		expect(source?.result?.findings).toHaveLength(1);
		expect(target?.result?.findings).toHaveLength(1);

		line(JSON.stringify({ id: "list-opened", type: "list_review_workflows" }));
		line(JSON.stringify({ id: "get-opened", type: "get_review_result", runId: "review:test" }));
		await vi.waitFor(() => {
			expect(response(collecting.writes, "list-opened")).toBeDefined();
			expect(response(collecting.writes, "get-opened")).toBeDefined();
		});
		expect(response(collecting.writes, "list-opened")?.data).toMatchObject({
			runs: [{ runId: "review:test", acknowledgedAt: source?.acknowledgedAt }],
		});
		expect(response(collecting.writes, "get-opened")?.data).toMatchObject({
			runId: "review:test",
			acknowledgedAt: source?.acknowledgedAt,
			findings: expect.any(Array),
		});
		await closeMode(collecting, modePromise);
	});

	test("explicit acknowledgment is idempotent and unsuccessful opens preserve the source", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord());
		const runtimeHost = makeRuntimeHost({ manager });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();

		line(JSON.stringify({ id: "ack-1", type: "acknowledge_review", runId: "review:test" }));
		await vi.waitFor(() => expect(response(collecting.writes, "ack-1")).toBeDefined());
		const acknowledgedAt = (response(collecting.writes, "ack-1")?.data as { acknowledgedAt: number }).acknowledgedAt;
		line(JSON.stringify({ id: "ack-2", type: "acknowledge_review", runId: "review:test" }));
		await vi.waitFor(() => expect(response(collecting.writes, "ack-2")).toBeDefined());
		expect(response(collecting.writes, "ack-2")?.data).toEqual({ runId: "review:test", acknowledgedAt });
		expect(
			manager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE),
		).toHaveLength(1);

		const unacknowledged = durableRecord("review:unacknowledged");
		appendReviewRun(manager, unacknowledged);
		vi.mocked(runtimeHost.newSession).mockResolvedValueOnce({ cancelled: true, seeded: false });
		line(JSON.stringify({ id: "open-cancelled", type: "open_review_session", runId: unacknowledged.runId }));
		await vi.waitFor(() => expect(response(collecting.writes, "open-cancelled")).toBeDefined());
		expect(response(collecting.writes, "open-cancelled")).toMatchObject({
			success: true,
			data: { cancelled: true },
		});
		expect(getReviewRun(manager, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();

		vi.mocked(runtimeHost.newSession).mockResolvedValueOnce({ cancelled: false, seeded: false });
		line(JSON.stringify({ id: "open-skipped", type: "open_review_session", runId: unacknowledged.runId }));
		await vi.waitFor(() => expect(response(collecting.writes, "open-skipped")).toBeDefined());
		expect(response(collecting.writes, "open-skipped")).toMatchObject({
			success: false,
			error: expect.stringContaining("remains available"),
		});
		expect(getReviewRun(manager, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();

		vi.mocked(runtimeHost.newSession).mockRejectedValueOnce(new Error("seed failed"));
		line(JSON.stringify({ id: "open-failed", type: "open_review_session", runId: unacknowledged.runId }));
		await vi.waitFor(() => expect(response(collecting.writes, "open-failed")).toBeDefined());
		expect(response(collecting.writes, "open-failed")).toMatchObject({ success: false, error: "seed failed" });
		expect(getReviewRun(manager, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();

		vi.mocked(runtimeHost.newSession).mockResolvedValueOnce({ cancelled: true, seeded: false });
		line(
			JSON.stringify({
				id: "fix-cancelled",
				type: "invoke_ui_action",
				action: "review.fix",
				args: { runId: unacknowledged.runId, findingIds: "" },
			}),
		);
		await vi.waitFor(() => expect(response(collecting.writes, "fix-cancelled")).toBeDefined());
		expect(response(collecting.writes, "fix-cancelled")).toMatchObject({
			success: true,
			data: { status: "cancelled" },
		});
		expect(getReviewRun(manager, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();

		vi.mocked(runtimeHost.newSession).mockResolvedValueOnce({ cancelled: false, seeded: false });
		line(
			JSON.stringify({
				id: "fix-skipped",
				type: "invoke_ui_action",
				action: "review.fix",
				args: { runId: unacknowledged.runId, findingIds: "" },
			}),
		);
		await vi.waitFor(() => expect(response(collecting.writes, "fix-skipped")).toBeDefined());
		expect(response(collecting.writes, "fix-skipped")).toMatchObject({
			success: false,
			error: expect.stringContaining("opened without the selected findings"),
		});
		expect(getReviewRun(manager, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();

		vi.mocked(runtimeHost.newSession).mockRejectedValueOnce(new Error("fix seed failed"));
		line(
			JSON.stringify({
				id: "fix-failed",
				type: "invoke_ui_action",
				action: "review.fix",
				args: { runId: unacknowledged.runId, findingIds: "" },
			}),
		);
		await vi.waitFor(() => expect(response(collecting.writes, "fix-failed")).toBeDefined());
		expect(response(collecting.writes, "fix-failed")).toMatchObject({ success: false, error: "fix seed failed" });
		expect(getReviewRun(manager, unacknowledged.runId)?.acknowledgedAt).toBeUndefined();
		await closeMode(collecting, modePromise);
	});

	test("preserves a durable review when starting a clear discussion session", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord());
		const acknowledgedAt = acknowledgeReviewRun(manager, "review:test").acknowledgedAt;
		const replacementManagers: SessionManager[] = [];
		const runtimeHost = makeRuntimeHost({ manager, replacementManagers });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();

		line(
			JSON.stringify({
				id: "new-discussion",
				type: "new_session",
				preserveReviewRunId: "review:test",
			}),
		);
		await vi.waitFor(() =>
			expect(response(collecting.writes, "new-discussion")).toMatchObject({
				success: true,
				data: { cancelled: false },
			}),
		);
		expect(runtimeHost.newSession).toHaveBeenCalledWith(
			expect.objectContaining({ rebindRequestId: "new-discussion" }),
		);
		expect(getReviewRun(replacementManagers[0]!, "review:test")).toMatchObject({
			runId: "review:test",
			acknowledgedAt,
			result: { completionStatus: "complete" },
		});

		line(JSON.stringify({ id: "rerun-preserved", type: "rerun_review", runId: "review:test" }));
		await vi.waitFor(() =>
			expect(response(collecting.writes, "rerun-preserved")).toMatchObject({
				success: true,
				data: { status: "accepted" },
			}),
		);

		line(
			JSON.stringify({
				id: "new-missing",
				type: "new_session",
				preserveReviewRunId: "review:missing",
			}),
		);
		await vi.waitFor(() =>
			expect(response(collecting.writes, "new-missing")).toMatchObject({
				success: false,
				error: "Unknown review run: review:missing",
			}),
		);
		expect(replacementManagers).toHaveLength(1);
		await closeMode(collecting, modePromise);
	});

	test("accepts an incremental durable branch rerun through its host-only locator", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableBranchRecord());
		const runtimeHost = makeRuntimeHost({ manager });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();
		line(JSON.stringify({ id: "list-branch", type: "list_review_workflows" }));
		await vi.waitFor(() => expect(response(collecting.writes, "list-branch")).toBeDefined());
		expect(JSON.stringify(response(collecting.writes, "list-branch"))).not.toContain("branchBase");

		line(JSON.stringify({ id: "rerun", type: "rerun_review", runId: "review:test", mode: "incremental" }));
		await vi.waitFor(() =>
			expect(response(collecting.writes, "rerun")).toMatchObject({
				success: true,
				data: { status: "accepted", workflowId: "review:test" },
			}),
		);
		await vi.waitFor(() => expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalled());
		expect(reviewMocks.prepareReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				target: {
					kind: "branch",
					branchBase: { kind: "remote", remote: "origin", remoteRef: "refs/heads/main" },
				},
				parentRunId: "review:test",
				controls: expect.objectContaining({ scopeMode: "incremental" }),
			}),
		);
		await closeMode(collecting, modePromise);
	});

	test("rejects a durable branch rerun without a stored locator", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const record = durableBranchRecord("review:missing-locator");
		delete record.target.branchBase;
		appendReviewRun(manager, record);
		const runtimeHost = makeRuntimeHost({ manager });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		collecting.getLineHandler()(JSON.stringify({ id: "rerun-missing", type: "rerun_review", runId: record.runId }));
		await vi.waitFor(() => expect(response(collecting.writes, "rerun-missing")).toBeDefined());
		expect(response(collecting.writes, "rerun-missing")).toMatchObject({
			success: false,
			error: "Durable branch review run does not retain a base locator.",
		});
		expect(reviewMocks.prepareReviewWorkflow).not.toHaveBeenCalled();
		await closeMode(collecting, modePromise);
	});

	test("cancels a detached run and reaches a terminal state", async () => {
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteOptions) => {
			await new Promise<void>((resolve) =>
				options.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { status: "cancelled" as const };
		});
		const runtimeHost = makeRuntimeHost();
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		const line = collecting.getLineHandler();
		line(JSON.stringify({ id: "invoke", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() => expect(response(collecting.writes, "invoke")).toBeDefined());
		line(JSON.stringify({ id: "cancel", type: "cancel_workflow", workflowId: "review:test" }));
		await vi.waitFor(() => expect(response(collecting.writes, "cancel")).toMatchObject({ success: true }));
		await vi.waitFor(() => expect(runtimeHost.reviewWorkflows.get("review:test")?.status).toBe("cancelled"));
		await closeMode(collecting, modePromise);
	});
});
