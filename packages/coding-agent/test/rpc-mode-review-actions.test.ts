import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";

const reviewMocks = vi.hoisted(() => ({
	runReviewWorkflow: vi.fn(
		async (options: {
			newSession: (options?: unknown) => Promise<{ cancelled: boolean }>;
			onEvent?: (event: Record<string, unknown>) => void;
		}) => {
			options.onEvent?.({
				type: "workflow_start",
				workflowId: "review:test",
				kind: "review",
				action: "review.uncommitted",
				title: "Review",
				message: "Reviewing uncommitted changes.",
				status: "running",
			});
			options.onEvent?.({
				type: "tool_execution_start",
				workflowId: "review:test",
				workflowKind: "review",
				workflowAction: "review.uncommitted",
				toolCallId: "review:test:tool-1",
				toolName: "read",
				args: { path: "src/file.ts" },
			});
			options.onEvent?.({
				type: "tool_execution_end",
				workflowId: "review:test",
				workflowKind: "review",
				workflowAction: "review.uncommitted",
				toolCallId: "review:test:tool-1",
				toolName: "read",
				isError: false,
			});
			const newSessionResult = await options.newSession({});
			options.onEvent?.({
				type: "workflow_end",
				workflowId: "review:test",
				kind: "review",
				action: "review.uncommitted",
				title: "Review",
				message: "Review complete: 1 finding. Opening review session.",
				status: "completed",
			});
			return {
				status: "completed" as const,
				resolution: {
					description: "uncommitted changes",
					diffCommand: "git diff HEAD",
					diff: "diff",
					truncated: false,
				},
				findingsCount: 1,
				sessionSwitchCancelled: newSessionResult.cancelled,
			};
		},
	),
}));

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/review.ts")>();
	return {
		...actual,
		runReviewWorkflow: reviewMocks.runReviewWorkflow,
	};
});

import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

afterEach(() => {
	reviewMocks.runReviewWorkflow.mockClear();
	restoreStdout();
});

describe("RPC mode review actions", () => {
	test("rebinds after a review action creates its post-review session", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writes: object[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const makeSession = (sessionId: string) => ({
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => detachSession),
			agent: {
				subscribe: vi.fn(() => detachBackpressure),
				state: { pendingToolExecutions: new Map() },
			},
			isStreaming: false,
			isCompacting: false,
			thinkingLevel: "off",
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			messages: [],
			pendingMessageCount: 0,
			modelRegistry: { authStorage: {} },
			settingsManager: {},
			sessionFile: `/sessions/${sessionId}.jsonl`,
			sessionId,
		});
		let currentSession = makeSession("initial-session");
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			cwd: "/workspace",
			services: { agentDir: "/workspace/.volt" },
			newSession: vi.fn(async () => {
				currentSession = makeSession("review-session");
				return { cancelled: false };
			}),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const sessionChanges: Array<{ sessionFile?: string; sessionId: string }> = [];
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			onReady: () => {
				resolveReady();
			},
			onSessionChanged: (session) => {
				sessionChanges.push(session);
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: "review.uncommitted" }));

		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "review-1",
				type: "response",
				command: "invoke_ui_action",
				success: true,
				data: expect.objectContaining({
					action: "review.uncommitted",
					status: "completed",
					stateChanged: true,
				}),
			}),
		);

		expect(writes).toContainEqual(
			expect.objectContaining({
				type: "workflow_start",
				workflowId: "review:test",
				kind: "review",
				message: "Reviewing uncommitted changes.",
			}),
		);
		expect(writes).toContainEqual(
			expect.objectContaining({
				type: "tool_execution_start",
				workflowId: "review:test",
				toolName: "read",
				args: { path: "src/file.ts" },
			}),
		);
		expect(writes).toContainEqual(
			expect.objectContaining({
				type: "workflow_end",
				workflowId: "review:test",
				status: "completed",
			}),
		);

		expect(runtimeHost.newSession).toHaveBeenCalledOnce();
		expect(sessionChanges).toEqual([
			{ sessionFile: "/sessions/initial-session.jsonl", sessionId: "initial-session" },
			{ sessionFile: "/sessions/review-session.jsonl", sessionId: "review-session" },
		]);

		lineHandler?.(JSON.stringify({ id: "state-1", type: "get_state" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "state-1",
					command: "get_state",
					data: expect.objectContaining({ sessionId: "review-session" }),
				}),
			),
		);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps review workflow and session-change hooks alive after the transport closes", async () => {
		let lineHandler: ((line: string) => void) | undefined;
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
		const makeSession = (sessionId: string) => ({
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => vi.fn()),
			agent: { subscribe: vi.fn(() => vi.fn()), state: { pendingToolExecutions: new Map() } },
			isStreaming: false,
			isCompacting: false,
			thinkingLevel: "off",
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			messages: [],
			pendingMessageCount: 0,
			modelRegistry: { authStorage: {} },
			settingsManager: {},
			sessionFile: `/sessions/${sessionId}.jsonl`,
			sessionId,
		});
		let continueReview: () => void = () => {};
		const reviewCanFinish = new Promise<void>((resolve) => {
			continueReview = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(
			async (options: {
				newSession: (options?: unknown) => Promise<{ cancelled: boolean }>;
				onEvent?: (event: Record<string, unknown>) => void;
			}) => {
				options.onEvent?.({
					type: "workflow_start",
					workflowId: "review:slow",
					kind: "review",
					action: "review.uncommitted",
					title: "Review",
					message: "Reviewing uncommitted changes.",
					status: "running",
				});
				await reviewCanFinish;
				options.onEvent?.({
					type: "tool_execution_start",
					workflowId: "review:slow",
					workflowKind: "review",
					workflowAction: "review.uncommitted",
					toolCallId: "review:slow:tool-1",
					toolName: "read",
					args: { path: "src/file.ts" },
				});
				const newSessionResult = await options.newSession({});
				options.onEvent?.({
					type: "workflow_end",
					workflowId: "review:slow",
					kind: "review",
					action: "review.uncommitted",
					title: "Review",
					message: "Review complete.",
					status: "completed",
				});
				return {
					status: "completed" as const,
					resolution: {
						description: "uncommitted changes",
						diffCommand: "git diff HEAD",
						diff: "diff",
						truncated: false,
					},
					findingsCount: 1,
					sessionSwitchCancelled: newSessionResult.cancelled,
				};
			},
		);
		let currentSession = makeSession("original-session");
		const runtimeHost = {
			cwd: "/workspace",
			services: { agentDir: "/tmp/agent" },
			get session() {
				return currentSession;
			},
			setRebindSession: vi.fn(),
			newSession: vi.fn(async () => {
				currentSession = makeSession("review-session");
				return { cancelled: false };
			}),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		const sessionChanges: string[] = [];
		const workflowEvents: string[] = [];

		const modePromise = runRpcMode(runtimeHost, {
			transport,
			exitProcess: false,
			disposeRuntimeOnClose: false,
			onSessionChanged: (session) => {
				sessionChanges.push(session.sessionId);
			},
			onWorkflowEvent: (event) => {
				workflowEvents.push(event.type);
			},
		});
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(
			JSON.stringify({
				id: "action-1",
				type: "invoke_ui_action",
				action: "review.uncommitted",
				params: { target: { kind: "uncommitted" } },
			}),
		);
		await vi.waitFor(() =>
			expect(writes.some((value) => (value as { type?: string }).type === "workflow_start")).toBe(true),
		);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
		continueReview();

		await vi.waitFor(() => expect(runtimeHost.newSession).toHaveBeenCalled());
		expect(sessionChanges).toContain("review-session");
		expect(workflowEvents).toEqual(
			expect.arrayContaining(["workflow_start", "tool_execution_start", "workflow_end"]),
		);
	});
});
