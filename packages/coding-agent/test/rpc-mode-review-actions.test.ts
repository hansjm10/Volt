import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import { ReviewWorkflowManager } from "../src/core/review-workflows.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { SessionManager } from "../src/core/session-manager.ts";

interface ExecuteReviewWorkflowMockOptions {
	prepared: { workflowId: string; action: string };
	fastModeEnabled?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: Record<string, unknown>) => void;
}

interface PreparedReviewWorkflowMock {
	workflowId: string;
	action: string;
	target: { kind: string };
	resolution: { description: string; diffCommand: string; diff: string; truncated: boolean };
	model: { id: string; provider: string };
	modelWarning?: string;
}

type ExecuteReviewWorkflowMockResult =
	| { status: "cancelled" }
	| { status: "failed"; errorMessage: string }
	| {
			status: "completed";
			raw: string;
			parsed?: { findings: Array<{ title: string; body: string; priority?: number }> };
			findingsCount?: number;
	  };

const reviewMocks = vi.hoisted(() => {
	const defaultResolution = {
		description: "uncommitted changes",
		diffCommand: "git diff HEAD",
		diff: "diff",
		truncated: false,
	};
	const emitStandardEvents = (options: ExecuteReviewWorkflowMockOptions): void => {
		const { workflowId, action } = options.prepared;
		options.onEvent?.({
			type: "tool_execution_start",
			workflowId,
			workflowKind: "review",
			workflowAction: action,
			toolCallId: `${workflowId}:tool-1`,
			toolName: "read",
			args: { path: "src/file.ts" },
		});
		options.onEvent?.({
			type: "tool_execution_end",
			workflowId,
			workflowKind: "review",
			workflowAction: action,
			toolCallId: `${workflowId}:tool-1`,
			toolName: "read",
			isError: false,
		});
	};
	const emitWorkflowStart = (options: ExecuteReviewWorkflowMockOptions): void => {
		options.onEvent?.({
			type: "workflow_start",
			workflowId: options.prepared.workflowId,
			kind: "review",
			action: options.prepared.action,
			title: "Review",
			message: "Reviewing uncommitted changes.",
			status: "running",
		});
	};
	return {
		defaultResolution,
		emitStandardEvents,
		emitWorkflowStart,
		prepareReviewWorkflow: vi.fn(
			async (options: { target: { kind: string } }): Promise<PreparedReviewWorkflowMock> => ({
				workflowId: "review:test",
				action: "review.uncommitted",
				target: options.target,
				resolution: defaultResolution,
				model: { id: "test-model", provider: "test" },
			}),
		),
		executeReviewWorkflow: vi.fn(
			async (options: ExecuteReviewWorkflowMockOptions): Promise<ExecuteReviewWorkflowMockResult> => {
				emitWorkflowStart(options);
				emitStandardEvents(options);
				return {
					status: "completed",
					raw: "raw reviewer output",
					parsed: {
						findings: [{ title: "Fix the bug", body: "The bug is real.", priority: 1 }],
					},
					findingsCount: 1,
				};
			},
		),
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

function runRpcMode(runtimeHost: AgentSessionRuntime, options?: Parameters<typeof runRpcModeImpl>[1]): Promise<void> {
	if (typeof runtimeHost.runWithStableSession !== "function") {
		Object.assign(runtimeHost, {
			async runWithStableSession<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
				return operation(runtimeHost.session);
			},
		});
	}
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
	const transport: RpcTransport = {
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
	};
	return {
		transport,
		writes,
		getLineHandler: () => {
			if (!lineHandler) {
				throw new Error("RPC line handler was not installed");
			}
			return lineHandler;
		},
		getCloseHandler: () => closeHandler,
	};
}

function makeSession(sessionId: string, initialFastModeEnabled = false) {
	let fastModeEnabled = initialFastModeEnabled;
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
		steeringMode: "all",
		followUpMode: "all",
		autoCompactionEnabled: false,
		messages: [],
		pendingMessageCount: 0,
		modelRegistry: { authStorage: {} },
		settingsManager: {},
		sessionFile: `/sessions/${sessionId}.jsonl`,
		sessionId,
		sessionManager: { flush: vi.fn(async () => {}) },
	};
}

function makeRuntimeHost(options: { seedMessages?: object[]; fastModeEnabled?: boolean } = {}) {
	let currentSession = makeSession("initial-session", options.fastModeEnabled);
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
				withSession?: (ctx: unknown) => Promise<void>;
			}) => {
				const sessionManager = SessionManager.inMemory("/workspace");
				await newSessionOptions?.setup?.(sessionManager);
				currentSession = makeSession("review-session", sessionManager.buildSessionContext().fastMode.enabled);
				await newSessionOptions?.withSession?.({
					sendMessage: async (message: object) => {
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
	} as unknown as AgentSessionRuntime;
	return runtimeHost;
}

async function startMode(
	runtimeHost: AgentSessionRuntime,
	transport: RpcTransport,
	options: Partial<Parameters<typeof runRpcModeImpl>[1]> = {},
): Promise<{ modePromise: Promise<void> }> {
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const modePromise = runRpcMode(runtimeHost, {
		transport,
		exitProcess: false,
		onReady: resolveReady,
		...options,
	});
	await ready;
	return { modePromise };
}

function findWriteIndex(writes: object[], predicate: (value: Record<string, unknown>) => boolean): number {
	return writes.findIndex((value) => predicate(value as Record<string, unknown>));
}

afterEach(() => {
	reviewMocks.prepareReviewWorkflow.mockClear();
	reviewMocks.executeReviewWorkflow.mockClear();
	restoreStdout();
});

describe("RPC mode detached review actions", () => {
	test("preserves a usable invocation id and retags malformed invocation ids as uncorrelated", async () => {
		const runtimeHost = makeRuntimeHost();
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		lineHandler(
			JSON.stringify({
				id: "invoke-malformed-args",
				type: "invoke_ui_action",
				action: "review.uncommitted",
				args: [],
			}),
		);
		for (const id of [undefined, 7, "", "   ", "é".repeat(129)]) {
			lineHandler(
				JSON.stringify({
					...(id === undefined ? {} : { id }),
					type: "invoke_ui_action",
					action: "review.uncommitted",
				}),
			);
		}

		await vi.waitFor(() => {
			expect(writes).toContainEqual({
				id: "invoke-malformed-args",
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: 'Invalid RPC command payload: "args" must be an object',
			});
			const uncorrelatedFailures = writes.filter(
				(value) => (value as Record<string, unknown>).command === "invalid",
			);
			expect(uncorrelatedFailures).toHaveLength(5);
			for (const failure of uncorrelatedFailures) {
				expect(failure).not.toHaveProperty("id");
				expect(failure).toMatchObject({
					type: "response",
					command: "invalid",
					success: false,
				});
			}
		});
		expect(reviewMocks.prepareReviewWorkflow).not.toHaveBeenCalled();

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("returns an accepted response before workflow events and serves other commands mid-review", async () => {
		let releaseReview: () => void = () => {};
		const reviewGate = new Promise<void>((resolve) => {
			releaseReview = resolve;
		});
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteReviewWorkflowMockOptions) => {
			reviewMocks.emitWorkflowStart(options);
			await reviewGate;
			reviewMocks.emitStandardEvents(options);
			return {
				status: "completed" as const,
				raw: "raw reviewer output",
				parsed: { findings: [{ title: "Fix the bug", body: "The bug is real.", priority: 1 }] },
				findingsCount: 1,
			};
		});

		const runtimeHost = makeRuntimeHost({ fastModeEnabled: true });
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));

		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "review-1",
				type: "response",
				command: "invoke_ui_action",
				success: true,
				data: expect.objectContaining({
					action: "review.uncommitted",
					status: "accepted",
					workflowId: "review:test",
				}),
			}),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual(expect.objectContaining({ type: "workflow_start", workflowId: "review:test" })),
		);
		expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({ fastModeEnabled: true }),
		);
		// The accepted response must precede workflow_start on the wire.
		const responseIndex = findWriteIndex(writes, (value) => value.command === "invoke_ui_action");
		const startIndex = findWriteIndex(writes, (value) => value.type === "workflow_start");
		expect(responseIndex).toBeGreaterThanOrEqual(0);
		expect(responseIndex).toBeLessThan(startIndex);

		// Fast can be changed on the parent session while the detached review is running.
		lineHandler(
			JSON.stringify({
				id: "fast-off",
				type: "invoke_ui_action",
				action: "thinking.fast_mode",
				args: { enabled: false },
			}),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "fast-off",
					command: "invoke_ui_action",
					success: true,
				}),
			),
		);
		expect(runtimeHost.session.fastModeEnabled).toBe(false);

		// Other commands are served while the review is still running.
		lineHandler(JSON.stringify({ id: "state-1", type: "get_state" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "state-1",
					command: "get_state",
					data: expect.objectContaining({ sessionId: "initial-session" }),
				}),
			),
		);

		// A running review is visible to clients before it completes.
		lineHandler(JSON.stringify({ id: "list-running", type: "list_review_workflows" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "list-running",
					command: "list_review_workflows",
					data: {
						workflows: [expect.objectContaining({ workflowId: "review:test", status: "running" })],
					},
				}),
			),
		);

		releaseReview();
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ type: "workflow_end", workflowId: "review:test", status: "completed" }),
			),
		);
		expect(runtimeHost.reviewWorkflows.get("review:test")?.fastModeEnabled).toBe(true);
		expect(writes).toContainEqual(
			expect.objectContaining({
				type: "tool_execution_start",
				workflowId: "review:test",
				toolName: "read",
				args: { path: "src/file.ts" },
			}),
		);

		// Completion no longer force-switches the client's session.
		expect(runtimeHost.newSession).not.toHaveBeenCalled();

		// Findings are fetched on demand.
		lineHandler(JSON.stringify({ id: "result-1", type: "get_review_result", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "result-1",
					command: "get_review_result",
					success: true,
					data: expect.objectContaining({
						workflowId: "review:test",
						status: "completed",
						findingsCount: 1,
						target: { description: "uncommitted changes", diffCommand: "git diff HEAD" },
						findings: [{ title: "Fix the bug", body: "The bug is real.", priority: 1 }],
					}),
				}),
			),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("cancels a registered review when accepted-response durability fails", async () => {
		const runtimeHost = makeRuntimeHost();
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const flushFailure = new Error("ENOSPC: accepted response is not durable");
		vi.spyOn(runtimeHost.session.sessionManager, "flush").mockRejectedValueOnce(flushFailure);

		getLineHandler()(
			JSON.stringify({ id: "review-flush-failure", type: "invoke_ui_action", action: "review.uncommitted" }),
		);

		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "review-flush-failure",
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: flushFailure.message,
			}),
		);
		expect(reviewMocks.executeReviewWorkflow).not.toHaveBeenCalled();
		expect(runtimeHost.reviewWorkflows.hasActiveWorkflows).toBe(false);
		expect(runtimeHost.reviewWorkflows.get("review:test")).toMatchObject({
			workflowId: "review:test",
			status: "cancelled",
		});
		expect(writes).not.toContainEqual(expect.objectContaining({ type: "workflow_start" }));

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("returns pull request preflight failures without accepting or emitting workflow events", async () => {
		reviewMocks.prepareReviewWorkflow.mockRejectedValueOnce(
			new Error("PR number must be a canonical positive decimal no greater than 2147483647."),
		);
		const runtimeHost = makeRuntimeHost();
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport, { requireRemoteSafeUiActions: true });

		getLineHandler()(
			JSON.stringify({
				id: "review-pr-invalid",
				type: "invoke_ui_action",
				action: "review.pr",
				args: { number: "--repo" },
			}),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "review-pr-invalid",
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: "PR number must be a canonical positive decimal no greater than 2147483647.",
			}),
		);
		expect(reviewMocks.prepareReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { kind: "pr", number: "--repo" },
				requireProjectTrust: true,
				sanitizeRemoteErrors: true,
			}),
		);
		expect(writes).not.toContainEqual(expect.objectContaining({ type: "workflow_start" }));
		expect(writes).not.toContainEqual(
			expect.objectContaining({ data: expect.objectContaining({ status: "accepted" }) }),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps model and provider diagnostics out of remote accepted responses and retained failures", async () => {
		reviewMocks.prepareReviewWorkflow.mockResolvedValueOnce({
			workflowId: "review:private-errors",
			action: "review.uncommitted",
			target: { kind: "uncommitted" },
			resolution: reviewMocks.defaultResolution,
			model: { id: "test-model", provider: "test" },
			modelWarning: 'reviewModel "private/provider-model" not found or not authenticated',
		});
		reviewMocks.executeReviewWorkflow.mockResolvedValueOnce({
			status: "failed",
			errorMessage: "provider https://private-provider.example rejected secret-model",
		});
		const runtimeHost = makeRuntimeHost();
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport, { requireRemoteSafeUiActions: true });
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-private", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "review-private",
					success: true,
					data: expect.objectContaining({ status: "accepted", message: "Review started" }),
				}),
			),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					type: "workflow_end",
					workflowId: "review:private-errors",
					status: "failed",
					message: "Review failed: The review could not be completed.",
				}),
			),
		);
		lineHandler(JSON.stringify({ id: "list-private", type: "list_review_workflows" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "list-private",
					success: true,
					data: {
						workflows: [expect.objectContaining({ errorMessage: "The review could not be completed." })],
					},
				}),
			),
		);
		expect(JSON.stringify(writes)).not.toContain("private/provider-model");
		expect(JSON.stringify(writes)).not.toContain("private-provider.example");
		expect(JSON.stringify(writes)).not.toContain("secret-model");

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("cancel_workflow aborts a running review", async () => {
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteReviewWorkflowMockOptions) => {
			reviewMocks.emitWorkflowStart(options);
			await new Promise<void>((resolve) => {
				if (options.signal?.aborted) {
					resolve();
					return;
				}
				options.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { status: "cancelled" as const };
		});

		const runtimeHost = makeRuntimeHost();
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(expect.objectContaining({ type: "workflow_start", workflowId: "review:test" })),
		);

		lineHandler(JSON.stringify({ id: "cancel-1", type: "cancel_workflow", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ id: "cancel-1", command: "cancel_workflow", success: true }),
			),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ type: "workflow_end", workflowId: "review:test", status: "cancelled" }),
			),
		);

		lineHandler(JSON.stringify({ id: "result-1", type: "get_review_result", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "result-1",
					command: "get_review_result",
					success: true,
					data: expect.objectContaining({ workflowId: "review:test", status: "cancelled" }),
				}),
			),
		);

		// Cancelling an already-finished workflow fails loudly.
		lineHandler(JSON.stringify({ id: "cancel-2", type: "cancel_workflow", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "cancel-2",
					command: "cancel_workflow",
					success: false,
					error: "No running review workflow: review:test",
				}),
			),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("open_review_session seeds a fresh session with the findings on demand", async () => {
		const seedMessages: Array<{ customType?: string; content?: string }> = [];
		const runtimeHost = makeRuntimeHost({ seedMessages, fastModeEnabled: true });
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const sessionChanges: string[] = [];
		const { modePromise } = await startMode(runtimeHost, transport, {
			onSessionChanged: (session) => {
				sessionChanges.push(session.sessionId);
			},
		});
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ type: "workflow_end", workflowId: "review:test", status: "completed" }),
			),
		);
		expect(runtimeHost.newSession).not.toHaveBeenCalled();

		// Opening uses the review's launch-time snapshot, not the parent's current policy.
		runtimeHost.session.setFastModeEnabled(false);
		expect(runtimeHost.session.fastModeEnabled).toBe(false);
		lineHandler(JSON.stringify({ id: "open-1", type: "open_review_session", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "open-1",
					command: "open_review_session",
					success: true,
					data: { cancelled: false },
				}),
			),
		);
		expect(runtimeHost.newSession).toHaveBeenCalledOnce();
		expect(seedMessages).toEqual([
			expect.objectContaining({
				customType: "review",
				content: expect.stringContaining("Fix the bug"),
			}),
		]);
		await vi.waitFor(() => expect(sessionChanges).toContain("review-session"));
		expect(runtimeHost.session.fastModeEnabled).toBe(true);

		// The acted-on review is consumed from the retained ring: listings stop
		// advertising it, so reconciling clients cannot re-surface an "open
		// findings" affordance that would seed a duplicate session.
		lineHandler(JSON.stringify({ id: "list-1", type: "list_review_workflows" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "list-1",
					command: "list_review_workflows",
					success: true,
					data: { workflows: [] },
				}),
			),
		);

		// The findings live in the seeded session now; the record is gone.
		lineHandler(JSON.stringify({ id: "result-1", type: "get_review_result", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "result-1",
					command: "get_review_result",
					success: false,
					error: "Unknown review workflow: review:test",
				}),
			),
		);

		// Re-opening the consumed review fails like any unknown workflow.
		lineHandler(JSON.stringify({ id: "open-2", type: "open_review_session", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "open-2",
					command: "open_review_session",
					success: false,
					error: "Unknown review workflow: review:test",
				}),
			),
		);
		expect(runtimeHost.newSession).toHaveBeenCalledOnce();

		// Opening an unknown or unfinished workflow fails loudly.
		lineHandler(JSON.stringify({ id: "open-3", type: "open_review_session", workflowId: "review:unknown" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "open-3",
					command: "open_review_session",
					success: false,
					error: "Unknown review workflow: review:unknown",
				}),
			),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("a declined open keeps the review available in the retained ring", async () => {
		const runtimeHost = makeRuntimeHost();
		vi.mocked(runtimeHost.newSession).mockResolvedValue({ cancelled: true, seeded: false });
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ type: "workflow_end", workflowId: "review:test", status: "completed" }),
			),
		);

		lineHandler(JSON.stringify({ id: "open-1", type: "open_review_session", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "open-1",
					command: "open_review_session",
					success: true,
					data: { cancelled: true },
				}),
			),
		);

		// A declined open must not consume the record: the review stays listed
		// and its findings stay fetchable and openable.
		lineHandler(JSON.stringify({ id: "list-1", type: "list_review_workflows" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "list-1",
					command: "list_review_workflows",
					success: true,
					data: expect.objectContaining({
						workflows: [expect.objectContaining({ workflowId: "review:test", status: "completed" })],
					}),
				}),
			),
		);
		lineHandler(JSON.stringify({ id: "result-1", type: "get_review_result", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "result-1",
					command: "get_review_result",
					success: true,
					data: expect.objectContaining({ workflowId: "review:test", status: "completed" }),
				}),
			),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("a skipped seed fails the open and keeps the review available in the retained ring", async () => {
		const runtimeHost = makeRuntimeHost();
		// Simulate the recovered-client-input gate: the replacement session was
		// applied, but the withSession seed callback was skipped.
		vi.mocked(runtimeHost.newSession).mockResolvedValue({ cancelled: false, seeded: false });
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ type: "workflow_end", workflowId: "review:test", status: "completed" }),
			),
		);

		lineHandler(JSON.stringify({ id: "open-1", type: "open_review_session", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "open-1",
					command: "open_review_session",
					success: false,
					error: expect.stringContaining("the seed was skipped"),
				}),
			),
		);

		// The findings were never seeded into the replacement session, so the
		// record must stay retained: listings keep advertising the review and its
		// result stays fetchable so clients can retry the open.
		lineHandler(JSON.stringify({ id: "list-1", type: "list_review_workflows" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "list-1",
					command: "list_review_workflows",
					success: true,
					data: expect.objectContaining({
						workflows: [expect.objectContaining({ workflowId: "review:test", status: "completed" })],
					}),
				}),
			),
		);
		lineHandler(JSON.stringify({ id: "result-1", type: "get_review_result", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "result-1",
					command: "get_review_result",
					success: true,
					data: expect.objectContaining({ workflowId: "review:test", status: "completed" }),
				}),
			),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("a failed seed keeps the review available in the retained ring", async () => {
		const runtimeHost = makeRuntimeHost();
		vi.mocked(runtimeHost.newSession).mockRejectedValue(new Error("seed exploded"));
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ type: "workflow_end", workflowId: "review:test", status: "completed" }),
			),
		);

		lineHandler(JSON.stringify({ id: "open-1", type: "open_review_session", workflowId: "review:test" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "open-1",
					command: "open_review_session",
					success: false,
					error: "seed exploded",
				}),
			),
		);

		// The failed open must not consume the record: the findings were never
		// seeded anywhere, so the review stays listed and its result fetchable.
		lineHandler(JSON.stringify({ id: "list-1", type: "list_review_workflows" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "list-1",
					command: "list_review_workflows",
					success: true,
					data: expect.objectContaining({
						workflows: [expect.objectContaining({ workflowId: "review:test", status: "completed" })],
					}),
				}),
			),
		);

		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("rejects starting more reviews than the concurrency cap", async () => {
		let prepareCount = 0;
		reviewMocks.prepareReviewWorkflow.mockImplementation(async (options: { target: { kind: string } }) => {
			prepareCount++;
			return {
				workflowId: `review:cap-${prepareCount}`,
				action: "review.uncommitted",
				target: options.target,
				resolution: reviewMocks.defaultResolution,
				model: { id: "test-model", provider: "test" },
			};
		});
		let releaseReviews: () => void = () => {};
		const reviewGate = new Promise<void>((resolve) => {
			releaseReviews = resolve;
		});
		reviewMocks.executeReviewWorkflow.mockImplementation(async (options: ExecuteReviewWorkflowMockOptions) => {
			reviewMocks.emitWorkflowStart(options);
			await reviewGate;
			return { status: "completed" as const, raw: "raw", parsed: { findings: [] }, findingsCount: 0 };
		});

		const runtimeHost = makeRuntimeHost();
		const { transport, writes, getLineHandler, getCloseHandler } = createCollectingTransport();
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		for (let index = 1; index <= 3; index++) {
			lineHandler(JSON.stringify({ id: `review-${index}`, type: "invoke_ui_action", action: "review.uncommitted" }));
			await vi.waitFor(() =>
				expect(writes).toContainEqual(
					expect.objectContaining({
						id: `review-${index}`,
						command: "invoke_ui_action",
						success: true,
						data: expect.objectContaining({ status: "accepted", workflowId: `review:cap-${index}` }),
					}),
				),
			);
		}

		lineHandler(JSON.stringify({ id: "review-4", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "review-4",
					command: "invoke_ui_action",
					success: false,
					error: expect.stringContaining("Too many running reviews"),
				}),
			),
		);

		releaseReviews();
		await vi.waitFor(() =>
			expect(
				writes.filter(
					(value) =>
						(value as { type?: string; status?: string }).type === "workflow_end" &&
						(value as { status?: string }).status === "completed",
				),
			).toHaveLength(3),
		);

		reviewMocks.prepareReviewWorkflow.mockReset();
		reviewMocks.executeReviewWorkflow.mockReset();
		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps a detached review running and observable after the transport closes", async () => {
		let releaseReview: () => void = () => {};
		const reviewGate = new Promise<void>((resolve) => {
			releaseReview = resolve;
		});
		reviewMocks.executeReviewWorkflow.mockImplementationOnce(async (options: ExecuteReviewWorkflowMockOptions) => {
			reviewMocks.emitWorkflowStart(options);
			await reviewGate;
			reviewMocks.emitStandardEvents(options);
			return { status: "completed" as const, raw: "raw", parsed: { findings: [] }, findingsCount: 0 };
		});

		const runtimeHost = makeRuntimeHost();
		const { transport, getLineHandler, getCloseHandler } = createCollectingTransport();
		const workflowEvents: string[] = [];
		const { modePromise } = await startMode(runtimeHost, transport, {
			disposeRuntimeOnClose: false,
			onWorkflowEvent: (event) => {
				workflowEvents.push(event.type);
			},
		});
		const lineHandler = getLineHandler();

		lineHandler(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));
		await vi.waitFor(() => expect(workflowEvents).toContain("workflow_start"));

		// The transport closes while the review is still running; the mode
		// settles without waiting for the detached workflow.
		getCloseHandler()?.();
		await expect(modePromise).resolves.toBeUndefined();
		expect(runtimeHost.dispose).not.toHaveBeenCalled();

		releaseReview();
		await vi.waitFor(() => expect(workflowEvents).toContain("workflow_end"));
		expect(workflowEvents).toEqual(
			expect.arrayContaining(["workflow_start", "tool_execution_start", "workflow_end"]),
		);
		// The findings remain fetchable from the runtime-scoped manager.
		expect(runtimeHost.reviewWorkflows.get("review:test")).toEqual(
			expect.objectContaining({ workflowId: "review:test", status: "completed" }),
		);
	});

	test("caps pending ordinary commands while control responses bypass the cap", async () => {
		const { transport, getLineHandler } = createCollectingTransport();
		let releaseBash: () => void = () => {};
		const bashGate = new Promise<void>((resolve) => {
			releaseBash = resolve;
		});
		let bashFinished = false;
		const session = {
			...makeSession("queue-bound"),
			executeBash: vi.fn(async () => {
				await bashGate;
				bashFinished = true;
				return { output: "", exitCode: 0, cancelled: false, truncated: false };
			}),
		};
		const runtimeHost = {
			cwd: "/workspace",
			services: { agentDir: "/tmp/agent" },
			session,
			reviewWorkflows: new ReviewWorkflowManager(),
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		const { modePromise } = await startMode(runtimeHost, transport);
		const lineHandler = getLineHandler();

		await lineHandler(JSON.stringify({ id: "queue-blocker", type: "bash", command: "sleep 1000" }));
		await vi.waitFor(() => expect(session.executeBash).toHaveBeenCalled());
		for (let index = 0; index < 63; index++) {
			await lineHandler(JSON.stringify({ id: `queued-${index}`, type: "get_state" }));
		}

		await lineHandler(JSON.stringify({ type: "extension_ui_response", id: "unknown-control", confirmed: true }));
		expect(transport.close).not.toHaveBeenCalled();

		let modeSettled = false;
		void modePromise.catch(() => {
			modeSettled = true;
		});
		const overflowHandling = Promise.resolve(lineHandler(JSON.stringify({ id: "overflow", type: "get_state" })));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(modeSettled).toBe(false);
		expect(transport.close).not.toHaveBeenCalled();

		releaseBash();
		await overflowHandling;
		await vi.waitFor(() => expect(bashFinished).toBe(true));
		await expect(modePromise).rejects.toThrow("RPC input queue exceeds 64 tasks");
		expect(transport.close).toHaveBeenCalledOnce();
	});
});
