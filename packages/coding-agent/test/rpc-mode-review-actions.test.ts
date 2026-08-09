import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import type { ParsedReview } from "../src/core/review-report.ts";
import { appendReviewRun, type ReviewRunRecord } from "../src/core/review-state.ts";
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

interface ExecuteOptions {
	prepared: { workflowId: string; action: string };
	sessionManager?: SessionManager;
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
		agent: { subscribe: vi.fn(() => vi.fn()), state: { pendingToolExecutions: new Map() } },
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
): Promise<{ modePromise: Promise<void> }> {
	let readyResolve: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		readyResolve = resolve;
	});
	const modePromise = runRpcMode(runtimeHost, { transport, exitProcess: false, onReady: readyResolve });
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
	test("returns acceptance before detached events and projects only snapshot tool metadata", async () => {
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
		const modePromise = await startMode(runtimeHost, collecting.transport);
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
		const acceptedIndex = collecting.writes.findIndex((write) => (write as Record<string, unknown>).id === "invoke");
		const eventIndex = collecting.writes.findIndex(
			(write) => (write as Record<string, unknown>).type === "workflow_start",
		);
		expect(acceptedIndex).toBeLessThan(eventIndex);
		release();
		await vi.waitFor(() => expect(runtimeHost.reviewWorkflows.get("review:test")?.status).toBe("completed"));
		await closeMode(collecting, modePromise);
	});

	test("hydrates durable paginated results and exposes the breaking structured contract", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord("review:older"));
		appendReviewRun(manager, { ...durableRecord("review:newer"), endedAt: 3 });
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
		});
		expect(JSON.stringify(getData)).toContain("changeLocation");
		expect(JSON.stringify(getData)).not.toContain('"file"');
		expect(JSON.stringify(getData)).not.toContain("filesReviewed");
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
		expect(
			replacementManagers[0]
				?.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "volt.review.run"),
		).toBe(true);

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
		await closeMode(collecting, modePromise);
	});

	test("accepts an incremental durable rerun and launches it after the response", async () => {
		const manager = SessionManager.inMemory("/workspace");
		appendReviewRun(manager, durableRecord());
		const runtimeHost = makeRuntimeHost({ manager });
		const collecting = createCollectingTransport();
		const modePromise = await startMode(runtimeHost, collecting.transport);
		collecting.getLineHandler()(
			JSON.stringify({ id: "rerun", type: "rerun_review", runId: "review:test", mode: "incremental" }),
		);
		await vi.waitFor(() =>
			expect(response(collecting.writes, "rerun")).toMatchObject({
				success: true,
				data: { status: "accepted", workflowId: "review:test" },
			}),
		);
		await vi.waitFor(() => expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalled());
		expect(reviewMocks.prepareReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				parentRunId: "review:test",
				controls: expect.objectContaining({ scopeMode: "incremental" }),
			}),
		);
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
