import { describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import type { HostInteraction } from "../src/core/host-interaction.ts";
import type { ConversationProjectionFeed } from "../src/core/rpc/conversation-projection-feed.ts";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/loopback-transport.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import {
	createTestModel,
	createTestSession,
	getCurrentConversationAuthority,
	parseWrittenObjects,
	startIrohRpcMode,
	withCurrentConversationAuthority,
} from "./iroh-stream-doubles.ts";

function createStableRuntimeHost(session: ReturnType<typeof createTestSession>): AgentSessionRuntime {
	return {
		session,
		async runWithStableSession<T>(operation: (stableSession: AgentSession) => Promise<T> | T): Promise<T> {
			return operation(session as unknown as AgentSession);
		},
		runSessionInterruption<T>(operation: (stableSession: AgentSession) => T): T {
			return operation(session as unknown as AgentSession);
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSessionById: vi.fn(async () => ({ cancelled: true })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		listSessions: vi.fn(async () => []),
	} as unknown as AgentSessionRuntime;
}

function sourceFor(session: ReturnType<typeof createTestSession>) {
	return {
		subscribe: (listener: (event: object) => void) => session.subscribe((event) => listener(event)),
	};
}

describe("conversation mutation authority", () => {
	test("requires the exact current tuple for every remote conversation mutation", async () => {
		const session = createTestSession("session-one", null);
		const abort = vi.fn(async () => {});
		const steer = vi.fn(async () => {});
		const followUp = vi.fn(async () => {});
		const setModel = vi.fn(async () => {});
		const setThinkingLevel = vi.fn();
		Object.assign(session, {
			abort,
			followUp,
			modelRegistry: {
				authStorage: {},
				getAvailable: vi.fn(async () => [createTestModel("model")]),
			},
			setModel,
			setThinkingLevel,
			steer,
		});
		const runtimeHost = createStableRuntimeHost(session);
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);
		const authority = getCurrentConversationAuthority(send);

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "exact-prompt",
					type: "prompt",
					clientMessageId: "exact-client-prompt",
					message: "exact",
				}),
			),
		);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({ id: "exact-prompt", command: "prompt", success: true }),
			);
		});
		const exactCommands = [
			{ id: "exact-steer", type: "steer", clientMessageId: "exact-client-steer", message: "steer" },
			{
				id: "exact-follow-up",
				type: "follow_up",
				clientMessageId: "exact-client-follow-up",
				message: "follow up",
			},
			{ id: "exact-abort", type: "abort" },
			{ id: "exact-new", type: "new_session" },
			{ id: "exact-switch", type: "switch_session_by_id", sessionId: "other-session" },
			{ id: "exact-model", type: "set_model", provider: "anthropic", modelId: "model" },
			{ id: "exact-thinking", type: "set_thinking_level", level: "low" },
			{ id: "exact-action", type: "invoke_ui_action", action: "session.new" },
		];
		for (const command of exactCommands) {
			recv.pushLine(JSON.stringify({ ...command, conversationAuthority: authority }));
		}
		await vi.waitFor(() => {
			const responses = parseWrittenObjects(send).filter((record) => record.type === "response");
			for (const command of exactCommands) {
				expect(responses).toContainEqual(expect.objectContaining({ id: command.id, success: true }));
			}
		});

		const missingAuthorityCommands = [
			{ id: "missing-prompt", type: "prompt", clientMessageId: "missing-client-prompt", message: "prompt" },
			{ id: "missing-steer", type: "steer", clientMessageId: "missing-client-steer", message: "steer" },
			{
				id: "missing-follow-up",
				type: "follow_up",
				clientMessageId: "missing-client-follow-up",
				message: "follow up",
			},
			{ id: "missing-abort", type: "abort" },
			{ id: "missing-new", type: "new_session" },
			{ id: "missing-switch", type: "switch_session_by_id", sessionId: "other-session" },
			{ id: "missing-model", type: "set_model", provider: "anthropic", modelId: "model" },
			{ id: "missing-thinking", type: "set_thinking_level", level: "low" },
			{ id: "missing-action", type: "invoke_ui_action", action: "session.new" },
			{ id: "missing-review-ack", type: "acknowledge_review", runId: "review:test" },
		];
		for (const command of missingAuthorityCommands) {
			recv.pushLine(JSON.stringify(command));
		}

		for (const [field, value] of [
			["sessionId", "stale-session"],
			["subscriptionId", "stale-subscription"],
			["branchEpoch", "stale-branch"],
		] as const) {
			recv.pushLine(
				JSON.stringify({
					id: `mismatch-${field}`,
					type: "prompt",
					clientMessageId: `mismatch-client-${field}`,
					message: "stale",
					conversationAuthority: { ...authority, [field]: value },
				}),
			);
		}
		recv.pushLine(
			JSON.stringify({
				id: "malformed-authority",
				type: "abort",
				conversationAuthority: { ...authority, extra: "field" },
			}),
		);

		await vi.waitFor(() => {
			const responses = parseWrittenObjects(send).filter((record) => record.type === "response");
			for (const command of missingAuthorityCommands) {
				expect(responses).toContainEqual(
					expect.objectContaining({
						id: command.id,
						success: false,
						errorCode: "stale_conversation_authority",
					}),
				);
			}
			for (const field of ["sessionId", "subscriptionId", "branchEpoch"]) {
				expect(responses).toContainEqual(
					expect.objectContaining({
						id: `mismatch-${field}`,
						success: false,
						errorCode: "stale_conversation_authority",
					}),
				);
			}
			expect(responses).toContainEqual(
				expect.objectContaining({
					id: "malformed-authority",
					success: false,
					error: expect.stringContaining("must contain exactly"),
				}),
			);
		});
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledOnce();
		expect(followUp).toHaveBeenCalledOnce();
		expect(abort).toHaveBeenCalledOnce();
		expect(setModel).toHaveBeenCalledOnce();
		expect(setThinkingLevel).toHaveBeenCalledOnce();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("rejects a co-attached client's queued stale mutations after another client rebinds", async () => {
		const oldSession = createTestSession("old-session", null);
		const newSession = createTestSession("new-session", null);
		const newAbort = vi.fn(async () => {});
		const newSetThinkingLevel = vi.fn();
		Object.assign(newSession, { abort: newAbort, setThinkingLevel: newSetThinkingLevel });

		let currentSession = oldSession;
		let lifecycleTail = Promise.resolve();
		let releaseReplacement = () => {};
		const replacementGate = new Promise<void>((resolve) => {
			releaseReplacement = resolve;
		});
		const willProjectListeners = new Set<(session: AgentSession) => Promise<void> | void>();
		const replacedListeners = new Set<(session: AgentSession) => Promise<void> | void>();
		const runtime = {
			get session() {
				return currentSession;
			},
			async runWithStableSession<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
				const result = lifecycleTail.then(() => operation(currentSession as unknown as AgentSession));
				lifecycleTail = result.then(
					() => undefined,
					() => undefined,
				);
				return result;
			},
			runSessionInterruption<T>(operation: (session: AgentSession) => T): T {
				return operation(currentSession as unknown as AgentSession);
			},
			subscribeSessionWillProject(listener: (session: AgentSession) => Promise<void> | void) {
				willProjectListeners.add(listener);
				return () => willProjectListeners.delete(listener);
			},
			subscribeSessionReplaced(listener: (session: AgentSession) => Promise<void> | void) {
				replacedListeners.add(listener);
				return () => replacedListeners.delete(listener);
			},
			newSession: vi.fn(async (options?: { rebindRequestId?: string }) => {
				await replacementGate;
				const feed = (runtime as { conversationProjectionFeed?: ConversationProjectionFeed })
					.conversationProjectionFeed;
				if (!feed) throw new Error("Missing shared conversation feed");
				feed.beginSourceRebind(sourceFor(newSession));
				currentSession = newSession;
				for (const listener of willProjectListeners) await listener(newSession as unknown as AgentSession);
				feed.commitSourceRebind(options?.rebindRequestId);
				for (const listener of replacedListeners) await listener(newSession as unknown as AgentSession);
				return { cancelled: false };
			}),
			switchSessionById: vi.fn(async () => ({ cancelled: true })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;

		const modeA = await startIrohRpcMode(runtime, oldSession);
		const modeB = await startIrohRpcMode(runtime, oldSession);
		const staleAuthority = getCurrentConversationAuthority(modeA.send);
		modeB.recv.pushLine(
			JSON.stringify(withCurrentConversationAuthority(modeB.send, { id: "rebind", type: "new_session" })),
		);
		await vi.waitFor(() => expect(runtime.newSession).toHaveBeenCalledOnce());

		modeA.recv.pushLine(
			JSON.stringify({
				id: "queued-prompt",
				type: "prompt",
				clientMessageId: "queued-client-prompt",
				message: "must not enter the replacement",
				conversationAuthority: staleAuthority,
			}),
		);
		modeA.recv.pushLine(
			JSON.stringify({
				id: "queued-thinking",
				type: "set_thinking_level",
				level: "high",
				conversationAuthority: staleAuthority,
			}),
		);
		releaseReplacement();

		await vi.waitFor(() => {
			const initiatingFrames = parseWrittenObjects(modeB.send);
			const initiatingBootstrapIndex = initiatingFrames.findIndex(
				(frame) =>
					frame.type === "conversation_bootstrap" &&
					frame.reason === "session_rebind" &&
					frame.requestId === "rebind",
			);
			const initiatingResponseIndex = initiatingFrames.findIndex((frame) => frame.id === "rebind");
			expect(initiatingBootstrapIndex).toBeGreaterThanOrEqual(0);
			expect(initiatingResponseIndex).toBeGreaterThan(initiatingBootstrapIndex);

			const frames = parseWrittenObjects(modeA.send);
			const replacementBootstrapIndex = frames.findIndex(
				(frame) => frame.type === "conversation_bootstrap" && frame.reason === "session_rebind",
			);
			const promptResponseIndex = frames.findIndex((frame) => frame.id === "queued-prompt");
			expect(replacementBootstrapIndex).toBeGreaterThanOrEqual(0);
			expect(promptResponseIndex).toBeGreaterThan(replacementBootstrapIndex);
			for (const id of ["queued-prompt", "queued-thinking"]) {
				expect(frames).toContainEqual(
					expect.objectContaining({ id, success: false, errorCode: "stale_conversation_authority" }),
				);
			}
		});
		modeA.recv.pushLine(JSON.stringify({ id: "stale-abort", type: "abort", conversationAuthority: staleAuthority }));
		await vi.waitFor(() => {
			expect(parseWrittenObjects(modeA.send)).toContainEqual(
				expect.objectContaining({
					id: "stale-abort",
					success: false,
					errorCode: "stale_conversation_authority",
				}),
			);
		});
		expect(newSession.prompt).not.toHaveBeenCalled();
		expect(newSetThinkingLevel).not.toHaveBeenCalled();
		expect(newAbort).not.toHaveBeenCalled();

		modeA.recv.end();
		modeB.recv.end();
		await Promise.all([modeA.modePromise, modeB.modePromise]);
	});

	test("revalidates authority after asynchronous model lookup before mutating the branch", async () => {
		const session = createTestSession("model-race", null);
		let releaseModels = () => {};
		const modelsRelease = new Promise<void>((resolve) => {
			releaseModels = resolve;
		});
		let notifyModelsStarted = () => {};
		const modelsStarted = new Promise<void>((resolve) => {
			notifyModelsStarted = resolve;
		});
		const setModel = vi.fn(async () => {});
		Object.assign(session, {
			modelRegistry: {
				authStorage: {},
				getAvailable: vi.fn(async () => {
					notifyModelsStarted();
					await modelsRelease;
					return [createTestModel("target-model")];
				}),
			},
			setModel,
		});
		const runtimeHost = createStableRuntimeHost(session);
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "model-race",
					type: "set_model",
					provider: "anthropic",
					modelId: "target-model",
				}),
			),
		);
		await modelsStarted;
		(
			runtimeHost as unknown as {
				conversationProjectionFeed: ConversationProjectionFeed;
			}
		).conversationProjectionFeed.rotateForBranchRebase();
		releaseModels();

		await vi.waitFor(() => {
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({
					id: "model-race",
					success: false,
					errorCode: "stale_conversation_authority",
				}),
			);
		});
		expect(setModel).not.toHaveBeenCalled();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps transport-neutral local RPC prompts compatible without authority", async () => {
		const session = createTestSession("local-session", null);
		const runtimeHost = createStableRuntimeHost(session);
		const pair = createLoopbackRpcTransportPair();
		const received: Array<Record<string, unknown>> = [];
		pair.client.onValue?.((value) => {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				received.push(value as Record<string, unknown>);
			}
		});
		const modePromise = runRpcMode(runtimeHost, {
			disposeRuntimeOnClose: false,
			exitProcess: false,
			transport: pair.server,
		});
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());
		pair.client.write({
			id: "local-prompt",
			type: "prompt",
			clientMessageId: "local-client-prompt",
			message: "local",
		});
		await vi.waitFor(() => {
			expect(received).toContainEqual(
				expect.objectContaining({ id: "local-prompt", command: "prompt", success: true }),
			);
		});
		expect(session.prompt).toHaveBeenCalledOnce();
		pair.client.close();
		await expect(modePromise).resolves.toBeUndefined();
	});
});

describe("correlated conversation controls", () => {
	test("retires extension and host-action replies across branch and session authority cuts", async () => {
		const makeSession = (sessionId: string) => {
			const generationListeners = new Set<() => void>();
			let hostInteraction: HostInteraction | undefined;
			const session = Object.assign(createTestSession(sessionId, null), {
				setHostInteraction(interaction: HostInteraction) {
					hostInteraction = interaction;
				},
				subscribeConversationGenerationChanges(listener: () => void) {
					generationListeners.add(listener);
					return () => generationListeners.delete(listener);
				},
			});
			return {
				session,
				generationListeners,
				get hostInteraction() {
					return hostInteraction;
				},
			};
		};

		const old = makeSession("control-old");
		const replacement = makeSession("control-new");
		let current = old.session;
		const willProjectListeners = new Set<(session: AgentSession) => Promise<void> | void>();
		const replacedListeners = new Set<(session: AgentSession) => Promise<void> | void>();
		const runtimeHost = {
			get session() {
				return current;
			},
			async runWithStableSession<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
				return operation(current as unknown as AgentSession);
			},
			runSessionInterruption<T>(operation: (session: AgentSession) => T): T {
				return operation(current as unknown as AgentSession);
			},
			subscribeSessionWillProject(listener: (session: AgentSession) => Promise<void> | void) {
				willProjectListeners.add(listener);
				return () => willProjectListeners.delete(listener);
			},
			subscribeSessionReplaced(listener: (session: AgentSession) => Promise<void> | void) {
				replacedListeners.add(listener);
				return () => replacedListeners.delete(listener);
			},
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const pair = createLoopbackRpcTransportPair();
		const received: Array<Record<string, unknown>> = [];
		const authorityChangeListeners = new Set<() => void>();
		pair.client.onValue?.((value) => {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				received.push(value as Record<string, unknown>);
			}
		});
		const modePromise = runRpcMode(runtimeHost, {
			disposeRuntimeOnClose: false,
			exitProcess: false,
			orderedConversation: {
				subscriptionId: "control-subscription",
				branchEpoch: "control-branch",
				subscribeAuthorityChanges(listener) {
					authorityChangeListeners.add(listener);
					return () => authorityChangeListeners.delete(listener);
				},
				async enqueueControl(value) {
					received.push(value as Record<string, unknown>);
				},
				requestCheckpoint(command) {
					return {
						subscriptionId: "control-subscription",
						requestId: command.id,
						checkpointCursor: 1,
					};
				},
				publishExternal() {},
			},
			transport: pair.server,
		});
		await vi.waitFor(() => expect(old.session.bindExtensions).toHaveBeenCalledOnce());
		pair.client.write({
			id: "capabilities",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(received).toContainEqual(expect.objectContaining({ id: "capabilities", success: true })),
		);

		const startControls = async (suffix: string) => {
			const bindingCalls = (
				old.session.bindExtensions as unknown as {
					mock: { calls: Array<[{ uiContext: ExtensionUIContext }]> };
				}
			).mock.calls;
			const binding = bindingCalls[bindingCalls.length - 1]?.[0] as { uiContext: ExtensionUIContext } | undefined;
			if (!binding || !old.hostInteraction) throw new Error("RPC control bindings are unavailable");
			const extensionResult = binding.uiContext.confirm(`Confirm ${suffix}`, "Proceed?");
			const hostResult = old.hostInteraction.requestAction({
				id: `host-${suffix}`,
				action: "test.action",
				title: `Host ${suffix}`,
			});
			await vi.waitFor(() => {
				expect(received).toContainEqual(
					expect.objectContaining({ type: "extension_ui_request", method: "confirm", title: `Confirm ${suffix}` }),
				);
				expect(received).toContainEqual(
					expect.objectContaining({ type: "host_action_request", id: `host-${suffix}` }),
				);
			});
			const extensionRequest = received
				.slice()
				.reverse()
				.find((record) => record.type === "extension_ui_request" && record.title === `Confirm ${suffix}`);
			if (typeof extensionRequest?.id !== "string") throw new Error("Missing extension request id");
			return { extensionRequestId: extensionRequest.id, extensionResult, hostResult };
		};

		const branchControls = await startControls("branch");
		for (const listener of old.generationListeners) listener();
		await expect(branchControls.extensionResult).resolves.toBe(false);
		await expect(branchControls.hostResult).resolves.toMatchObject({ decision: "dismissed" });
		pair.client.write({
			type: "extension_ui_response",
			id: branchControls.extensionRequestId,
			confirmed: true,
		});
		pair.client.write({ type: "host_action_response", id: "host-branch", decision: "approved" });

		const overflowControls = await startControls("overflow");
		for (const listener of authorityChangeListeners) listener();
		await expect(overflowControls.extensionResult).resolves.toBe(false);
		await expect(overflowControls.hostResult).resolves.toMatchObject({ decision: "dismissed" });
		pair.client.write({
			type: "extension_ui_response",
			id: overflowControls.extensionRequestId,
			confirmed: true,
		});
		pair.client.write({ type: "host_action_response", id: "host-overflow", decision: "approved" });

		const rebindControls = await startControls("rebind");
		for (const listener of willProjectListeners) await listener(replacement.session as unknown as AgentSession);
		current = replacement.session;
		for (const listener of replacedListeners) await listener(replacement.session as unknown as AgentSession);
		await expect(rebindControls.extensionResult).resolves.toBe(false);
		await expect(rebindControls.hostResult).resolves.toMatchObject({ decision: "dismissed" });
		pair.client.write({
			type: "extension_ui_response",
			id: rebindControls.extensionRequestId,
			confirmed: true,
		});
		pair.client.write({ type: "host_action_response", id: "host-rebind", decision: "approved" });
		pair.client.write({ id: "pending-after-cut", type: "get_pending_host_actions" });
		await vi.waitFor(() => {
			expect(received).toContainEqual(
				expect.objectContaining({
					id: "pending-after-cut",
					success: true,
					data: { actions: [] },
				}),
			);
		});

		pair.client.close();
		await expect(modePromise).resolves.toBeUndefined();
	});
});
