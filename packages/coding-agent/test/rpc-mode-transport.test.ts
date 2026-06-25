import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import type { HostInteraction } from "../src/core/host-interaction.ts";
import { isStdoutTakenOver, restoreStdout } from "../src/core/output-guard.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

function createRuntimeHost(): { runtimeHost: AgentSessionRuntime; dispose: ReturnType<typeof vi.fn> } {
	const dispose = vi.fn(async () => {});
	const runtimeHost = {
		session: {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			agent: {
				subscribe: vi.fn(() => () => {}),
			},
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose,
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return { runtimeHost, dispose };
}

afterEach(() => {
	restoreStdout();
});

describe("RPC mode caller-provided transports", () => {
	test("lists sessions and switches by session id", async () => {
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
			},
			sessionFile: `/sessions/${sessionId}.jsonl`,
			sessionId,
		});
		let currentSession = makeSession("initial-session");
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			listSessions: vi.fn(async () => [
				{
					current: true,
					createdAt: "2026-01-01T00:00:00.000Z",
					firstMessage: "hello",
					messageCount: 2,
					modifiedAt: "2026-01-01T00:01:00.000Z",
					sessionId: "initial-session",
					sessionName: "Initial",
				},
			]),
			switchSessionById: vi.fn(async () => {
				currentSession = makeSession("selected-session");
				return { cancelled: false };
			}),
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			onReady: () => {
				resolveReady();
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "list-1", type: "list_sessions" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "list-1",
				type: "response",
				command: "list_sessions",
				success: true,
				data: {
					sessions: [
						{
							current: true,
							createdAt: "2026-01-01T00:00:00.000Z",
							firstMessage: "hello",
							messageCount: 2,
							modifiedAt: "2026-01-01T00:01:00.000Z",
							sessionId: "initial-session",
							sessionName: "Initial",
						},
					],
				},
			}),
		);

		lineHandler?.(JSON.stringify({ id: "switch-1", type: "switch_session_by_id", sessionId: "selected-session" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "switch-1",
				type: "response",
				command: "switch_session_by_id",
				success: true,
				data: { cancelled: false },
			}),
		);
		expect(runtimeHost.switchSessionById).toHaveBeenCalledWith("selected-session");

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("bridges host-initiated action requests over RPC", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		let hostInteraction: HostInteraction | undefined;
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
		const currentSession = {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => detachSession),
			agent: {
				subscribe: vi.fn(() => detachBackpressure),
			},
			sessionId: "session-1",
			sessionFile: "/sessions/session-1.jsonl",
			setHostInteraction: vi.fn((interaction: HostInteraction) => {
				hostInteraction = interaction;
			}),
		};
		const runtimeHost = {
			session: currentSession,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			onReady: () => {
				resolveReady();
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(hostInteraction).toBeDefined());

		await expect(
			hostInteraction!.requestAction({
				id: "no-caps",
				action: "test.action",
				title: "Unavailable action",
			}),
		).resolves.toMatchObject({ decision: "unavailable" });
		expect(writes).not.toContainEqual(expect.objectContaining({ type: "host_action_request", id: "no-caps" }));

		lineHandler?.(
			JSON.stringify({ id: "caps-1", type: "set_client_capabilities", features: ["host_action_requests.v1"] }),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "caps-1",
				type: "response",
				command: "set_client_capabilities",
				success: true,
			}),
		);

		const decisionPromise = hostInteraction!.requestAction({
			id: "host-1",
			action: "test.action",
			title: "Approve test action?",
			message: "This action is blocking.",
			blocking: true,
		});
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				type: "host_action_request",
				id: "host-1",
				action: "test.action",
				title: "Approve test action?",
				message: "This action is blocking.",
				blocking: true,
			}),
		);
		hostInteraction!.updateAction?.({ id: "host-1", action: "test.action", status: "running" });
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				type: "host_action_update",
				id: "host-1",
				action: "test.action",
				status: "running",
			}),
		);

		lineHandler?.(JSON.stringify({ id: "pending-1", type: "get_pending_host_actions" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "pending-1",
				type: "response",
				command: "get_pending_host_actions",
				success: true,
				data: {
					actions: [
						{
							type: "host_action_request",
							id: "host-1",
							action: "test.action",
							title: "Approve test action?",
							message: "This action is blocking.",
							blocking: true,
						},
					],
				},
			}),
		);

		lineHandler?.(JSON.stringify({ type: "host_action_response", id: "host-1", decision: "approved" }));
		await expect(decisionPromise).resolves.toMatchObject({ decision: "approved" });

		const cancelledPromise = hostInteraction!.requestAction({
			id: "host-2",
			action: "test.action",
			title: "Cancelled action",
			blocking: true,
		});
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				type: "host_action_request",
				id: "host-2",
				action: "test.action",
				title: "Cancelled action",
				blocking: true,
			}),
		);
		lineHandler?.(JSON.stringify({ id: "caps-2", type: "set_client_capabilities", features: [] }));
		await expect(cancelledPromise).resolves.toMatchObject({
			decision: "dismissed",
			message: "Host action capability disabled",
		});

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("preserves pending host action requests across retained runtime reconnects", async () => {
		let hostInteraction: HostInteraction | undefined;
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const currentSession = {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => detachSession),
			agent: {
				subscribe: vi.fn(() => detachBackpressure),
			},
			sessionId: "session-1",
			sessionFile: "/sessions/session-1.jsonl",
			setHostInteraction: vi.fn((interaction: HostInteraction) => {
				hostInteraction = interaction;
			}),
		};
		const runtimeHost = {
			session: currentSession,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const startConnection = async () => {
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
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(runtimeHost, {
				disposeRuntimeOnClose: false,
				onReady: resolveReady,
				transport,
			});
			await ready;
			await vi.waitFor(() => expect(lineHandler).toBeDefined());
			return {
				close: () => {
					closeHandler?.();
				},
				modePromise,
				send: (message: object) => {
					if (!lineHandler) {
						throw new Error("RPC line handler was not registered");
					}
					lineHandler(JSON.stringify(message));
				},
				writes,
			};
		};

		const firstConnection = await startConnection();
		firstConnection.send({
			id: "caps-1",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual({
				id: "caps-1",
				type: "response",
				command: "set_client_capabilities",
				success: true,
			}),
		);
		if (!hostInteraction) {
			throw new Error("Host interaction was not installed");
		}
		const retainedHostInteraction = hostInteraction;
		const decisionPromise = retainedHostInteraction.requestAction({
			id: "host-reconnect",
			action: "test.action",
			title: "Approve after reconnect?",
			message: "This request should survive transport close.",
			blocking: true,
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual({
				type: "host_action_request",
				id: "host-reconnect",
				action: "test.action",
				title: "Approve after reconnect?",
				message: "This request should survive transport close.",
				blocking: true,
			}),
		);

		firstConnection.close();
		await expect(firstConnection.modePromise).resolves.toBeUndefined();
		let settled = false;
		void decisionPromise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(runtimeHost.dispose).not.toHaveBeenCalled();

		const secondConnection = await startConnection();
		secondConnection.send({
			id: "caps-2",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				id: "caps-2",
				type: "response",
				command: "set_client_capabilities",
				success: true,
			}),
		);
		secondConnection.send({ id: "pending-2", type: "get_pending_host_actions" });
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				id: "pending-2",
				type: "response",
				command: "get_pending_host_actions",
				success: true,
				data: {
					actions: [
						{
							type: "host_action_request",
							id: "host-reconnect",
							action: "test.action",
							title: "Approve after reconnect?",
							message: "This request should survive transport close.",
							blocking: true,
						},
					],
				},
			}),
		);

		retainedHostInteraction.updateAction?.({
			id: "host-reconnect",
			action: "test.action",
			status: "running",
		});
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				type: "host_action_update",
				id: "host-reconnect",
				action: "test.action",
				status: "running",
			}),
		);

		secondConnection.send({
			type: "host_action_response",
			id: "host-reconnect",
			decision: "approved",
			message: "approved after reconnect",
		});
		await expect(decisionPromise).resolves.toMatchObject({
			decision: "approved",
			message: "approved after reconnect",
		});

		secondConnection.close();
		await expect(secondConnection.modePromise).resolves.toBeUndefined();
	});

	test("dismisses retained host action requests when a reconnect disables host action support", async () => {
		let hostInteraction: HostInteraction | undefined;
		const currentSession = {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			agent: {
				subscribe: vi.fn(() => () => {}),
			},
			sessionId: "session-1",
			setHostInteraction: vi.fn((interaction: HostInteraction) => {
				hostInteraction = interaction;
			}),
		};
		const runtimeHost = {
			session: currentSession,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const startConnection = async () => {
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
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(runtimeHost, {
				disposeRuntimeOnClose: false,
				onReady: resolveReady,
				transport,
			});
			await ready;
			await vi.waitFor(() => expect(lineHandler).toBeDefined());
			return {
				close: () => closeHandler?.(),
				modePromise,
				send: (message: object) => {
					if (!lineHandler) {
						throw new Error("RPC line handler was not registered");
					}
					lineHandler(JSON.stringify(message));
				},
				writes,
			};
		};

		const firstConnection = await startConnection();
		firstConnection.send({
			id: "caps-1",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual(expect.objectContaining({ id: "caps-1", success: true })),
		);
		if (!hostInteraction) {
			throw new Error("Host interaction was not installed");
		}
		const decisionPromise = hostInteraction.requestAction({
			id: "host-disabled-reconnect",
			action: "test.action",
			title: "Approve after reconnect?",
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual(
				expect.objectContaining({ type: "host_action_request", id: "host-disabled-reconnect" }),
			),
		);
		firstConnection.close();
		await expect(firstConnection.modePromise).resolves.toBeUndefined();

		const secondConnection = await startConnection();
		secondConnection.send({ id: "caps-2", type: "set_client_capabilities", features: [] });
		await expect(decisionPromise).resolves.toMatchObject({
			decision: "dismissed",
			message: "Host action capability disabled",
		});
		secondConnection.send({ id: "pending-2", type: "get_pending_host_actions" });
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				id: "pending-2",
				type: "response",
				command: "get_pending_host_actions",
				success: true,
				data: { actions: [] },
			}),
		);

		secondConnection.close();
		await expect(secondConnection.modePromise).resolves.toBeUndefined();
	});

	test("cancels pending host action requests when disposing the runtime", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		let hostInteraction: HostInteraction | undefined;
		let lineHandler: ((line: string) => void) | undefined;
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
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async () => {}),
				subscribe: vi.fn(() => () => {}),
				agent: {
					subscribe: vi.fn(() => () => {}),
				},
				sessionId: "session-1",
				setHostInteraction: vi.fn((interaction: HostInteraction) => {
					hostInteraction = interaction;
				}),
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runRpcMode(runtimeHost, { onReady: resolveReady, transport });
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());
		lineHandler?.(
			JSON.stringify({ id: "caps-1", type: "set_client_capabilities", features: ["host_action_requests.v1"] }),
		);
		await vi.waitFor(() => expect(writes).toContainEqual(expect.objectContaining({ id: "caps-1", success: true })));
		if (!hostInteraction) {
			throw new Error("Host interaction was not installed");
		}
		const decisionPromise = hostInteraction.requestAction({
			id: "host-dispose",
			action: "test.action",
			title: "Dispose?",
		});
		await vi.waitFor(() =>
			expect(writes).toContainEqual(expect.objectContaining({ type: "host_action_request", id: "host-dispose" })),
		);

		closeHandler?.();
		await expect(decisionPromise).resolves.toMatchObject({
			decision: "dismissed",
			message: "RPC mode is shutting down",
		});
		await expect(modePromise).resolves.toBeUndefined();
		expect(runtimeHost.dispose).toHaveBeenCalledOnce();
	});

	test("returns projected transcript items", async () => {
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
		const sessionManager = SessionManager.inMemory("/workspace");
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 10 });
		const currentSession = {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => detachSession),
			agent: {
				subscribe: vi.fn(() => detachBackpressure),
			},
			sessionId: sessionManager.getSessionId(),
			sessionManager,
		};
		const runtimeHost = {
			session: currentSession,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			onReady: () => {
				resolveReady();
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "transcript-1", type: "get_transcript", limit: 10 }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "transcript-1",
				type: "response",
				command: "get_transcript",
				success: true,
				data: {
					sessionId: sessionManager.getSessionId(),
					items: [
						expect.objectContaining({
							role: "user",
							text: "hello",
						}),
					],
					hasMore: false,
					nextBeforeEntryId: null,
				},
			}),
		);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("notifies caller when the active session changes", async () => {
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
			},
			sessionFile: `/sessions/${sessionId}.jsonl`,
			sessionId,
		});
		let currentSession = makeSession("initial-session");
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => {
				currentSession = makeSession("next-session");
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

		lineHandler?.(JSON.stringify({ id: "new-session-1", type: "new_session" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "new-session-1",
				type: "response",
				command: "new_session",
				success: true,
				data: { cancelled: false },
			}),
		);

		expect(sessionChanges).toEqual([
			{ sessionFile: "/sessions/initial-session.jsonl", sessionId: "initial-session" },
			{ sessionFile: "/sessions/next-session.jsonl", sessionId: "next-session" },
		]);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("rejects and closes when a command response write rejects", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "write-failure", type: "unknown_command" }));

		await expect(modePromise).rejects.toBe(writeError);
		expect(transport.write).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("rejects and closes when a fire-and-forget prompt response write rejects", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();
		Object.assign(runtimeHost.session, {
			prompt: vi.fn((_message: string, options: { preflightResult?: (didSucceed: boolean) => void }) => {
				options.preflightResult?.(true);
				return Promise.resolve();
			}),
		});

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "prompt-write-failure", type: "prompt", message: "hello" }));

		await expect(modePromise).rejects.toBe(writeError);
		expect(transport.write).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("agent backpressure subscriber handles write failures by shutting down", async () => {
		let sessionEventHandler: ((event: object) => void) | undefined;
		let backpressureHandler: (() => Promise<void> | void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async () => {}),
				subscribe: vi.fn((handler: (event: object) => void) => {
					sessionEventHandler = handler;
					return detachSession;
				}),
				agent: {
					subscribe: vi.fn((handler: () => Promise<void> | void) => {
						backpressureHandler = handler;
						return detachBackpressure;
					}),
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(sessionEventHandler).toBeDefined());
		await vi.waitFor(() => expect(backpressureHandler).toBeDefined());

		sessionEventHandler?.({ type: "agent_event" });

		await expect(Promise.resolve(backpressureHandler?.())).resolves.toBeUndefined();
		await expect(modePromise).rejects.toBe(writeError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(detachSession).toHaveBeenCalledOnce();
		expect(detachBackpressure).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("does not subscribe after startup close interrupts extension binding", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		let resolveBindExtensions: (() => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const subscribe = vi.fn(() => () => {});
		const agentSubscribe = vi.fn(() => () => {});
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							resolveBindExtensions = resolve;
						}),
				),
				subscribe,
				agent: {
					subscribe: agentSubscribe,
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => {
			expect(closeHandler).toBeDefined();
			expect(runtimeHost.session.bindExtensions).toHaveBeenCalledOnce();
		});

		closeHandler?.();
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
		expect(resolveBindExtensions).toBeDefined();
		resolveBindExtensions?.();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(subscribe).not.toHaveBeenCalled();
		expect(agentSubscribe).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("startup cleanup treats extension shutdown UI requests as cancelled", async () => {
		let uiContext: ExtensionUIContext | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const startupError = new Error("bind failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {
			if (!uiContext) {
				throw new Error("missing extension UI context");
			}
			const confirmed = await uiContext.confirm("Shutdown", "Continue?");
			expect(confirmed).toBe(false);
		});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async (options: { uiContext: ExtensionUIContext }) => {
					uiContext = options.uiContext;
					throw startupError;
				}),
				subscribe: vi.fn(() => () => {}),
				agent: {
					subscribe: vi.fn(() => () => {}),
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		await expect(runRpcMode(runtimeHost, { transport })).rejects.toBe(startupError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(transport.write).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("cleans up when onReady throws", async () => {
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const readyError = new Error("ready failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async () => {}),
				subscribe: vi.fn(() => detachSession),
				agent: {
					subscribe: vi.fn(() => detachBackpressure),
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const modePromise = runRpcMode(runtimeHost, {
			transport,
			onReady: () => {
				throw readyError;
			},
		});

		await expect(modePromise).rejects.toBe(readyError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(detachSession).toHaveBeenCalledOnce();
		expect(detachBackpressure).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("close without exiting the embedding process", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: string | number | null | undefined) => {
			throw new Error("process.exit called");
		}) as typeof process.exit);

		try {
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(runtimeHost, {
				transport,
				onReady: () => {
					resolveReady();
				},
			});
			await ready;
			expect(closeHandler).toBeDefined();

			closeHandler?.();

			await expect(modePromise).resolves.toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalled();
			expect(dispose).toHaveBeenCalledOnce();
			expect(detachInput).toHaveBeenCalledOnce();
			expect(detachClose).toHaveBeenCalledOnce();
			expect(transportClose).toHaveBeenCalledOnce();
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("can close caller-provided transports without disposing the runtime", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			disposeRuntimeOnClose: false,
			transport,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(closeHandler).toBeDefined();

		closeHandler?.();

		await expect(modePromise).resolves.toBeUndefined();
		expect(dispose).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("rejects and closes when the input transport closes with an error", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const inputError = new Error("input failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(closeHandler).toBeDefined());

		closeHandler?.(inputError);

		await expect(modePromise).rejects.toBe(inputError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("closes the transport when shutdown flushing fails", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const flushError = new Error("flush failed");
		const transportClose = vi.fn(async () => {});
		const transportFlush = vi.fn(async () => {
			throw flushError;
		});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => () => {}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return () => {};
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: transportFlush,
			close: transportClose,
		};
		const { runtimeHost } = createRuntimeHost();
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			transport,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(closeHandler).toBeDefined();

		closeHandler?.();

		await expect(modePromise).rejects.toThrow(flushError);
		expect(transportFlush).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});
});

describe("RPC mode stdio transport", () => {
	test("restores stdout when non-exiting stdio mode closes", async () => {
		const initialEndListenerCount = process.stdin.listenerCount("end");
		const { runtimeHost } = createRuntimeHost();
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			exitProcess: false,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(process.stdin.listenerCount("end")).toBeGreaterThan(initialEndListenerCount);
		expect(isStdoutTakenOver()).toBe(true);

		process.stdin.emit("end");

		await expect(modePromise).resolves.toBeUndefined();
		expect(isStdoutTakenOver()).toBe(false);
	});
});
