import { Buffer } from "node:buffer";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent, PromptPreflightResult } from "../src/core/agent-session.ts";
import { type AgentSessionRuntime, isConversationTranscriptCommittedEvent } from "../src/core/agent-session-runtime.ts";
import { REVIEW_UNCOMMITTED_ACTION_ID } from "../src/core/host-actions.ts";
import type { PlanningState } from "../src/core/planning.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemotePresetAccess,
	hashIrohRemotePushToken,
	IrohRemoteAuditLogger,
	IrohRemoteHostStateManager,
	type IrohRemoteLiveActivityContentState,
	type IrohRemoteLiveActivityRegistration,
	type IrohRemoteLiveActivityUpdateIntent,
	IrohRemotePushNotificationDispatcher,
	type IrohRemotePushRelayClient,
	IrohRemotePushRelayHttpClient,
	type IrohRemotePushRelayNotificationRequest,
	type IrohRemotePushTarget,
} from "../src/core/remote/iroh/index.ts";
import type { ExecuteReviewWorkflowResult } from "../src/core/review.ts";
import { ReviewWorkflowManager } from "../src/core/review-workflows.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createRemoteConversationTranscriptEntry } from "../src/daemon/conversation-commands.ts";
import {
	createTestIrohConversationOptions,
	createTestSession,
	isRecord,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
	startIrohRpcMode,
} from "./iroh-stream-doubles.ts";

const reviewMocks = vi.hoisted(() => ({
	prepareReviewWorkflow: vi.fn(async (options: { target: unknown }) => ({
		workflowId: "review:test",
		action: "review.uncommitted",
		target: options.target,
		resolution: {
			description: "uncommitted changes",
			diffCommand: "git diff HEAD",
			diff: "diff",
			truncated: false,
		},
		model: { id: "test-model", provider: "test" },
	})),
	executeReviewWorkflow: vi.fn(async () => ({
		status: "completed" as const,
		raw: "raw reviewer output",
		parsed: { findings: [{ title: "Fix the bug", body: "The bug is real." }] },
		findingsCount: 1,
	})),
}));

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/review.ts")>();
	return {
		...actual,
		prepareReviewWorkflow: reviewMocks.prepareReviewWorkflow,
		executeReviewWorkflow: reviewMocks.executeReviewWorkflow,
	};
});

import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

function createStableSessionRunner<TSession>(getSession: () => TSession) {
	return {
		async runWithStableSession<TResult>(
			operation: (session: TSession) => Promise<TResult> | TResult,
		): Promise<TResult> {
			const session = getSession();
			return operation(session);
		},
	};
}

function getNotifications(send: ManualIrohSendStream): Array<Record<string, unknown>> {
	return parseWrittenObjects(send).filter((record) => record.type === "notification_request");
}

function withCurrentConversationAuthority(send: ManualIrohSendStream, command: object): object {
	const bootstrap = parseWrittenObjects(send)
		.slice()
		.reverse()
		.find((record) => record.type === "conversation_bootstrap");
	const conversation = bootstrap?.conversation;
	const delivery = bootstrap?.delivery;
	const transcript = bootstrap?.transcript;
	if (!isRecord(conversation) || !isRecord(delivery) || !isRecord(transcript)) {
		throw new Error("Conversation bootstrap authority is unavailable");
	}
	if (
		typeof conversation.sessionId !== "string" ||
		typeof delivery.subscriptionId !== "string" ||
		typeof transcript.branchEpoch !== "string"
	) {
		throw new Error("Conversation bootstrap authority is malformed");
	}
	return {
		...command,
		conversationAuthority: {
			sessionId: conversation.sessionId,
			subscriptionId: delivery.subscriptionId,
			branchEpoch: transcript.branchEpoch,
		},
	};
}

class ThrowingIrohSendStream extends ManualIrohSendStream {
	override async writeAll(bytes: Array<number>): Promise<void> {
		if (this.writes.length === 0) {
			await super.writeAll(bytes);
			return;
		}
		throw new Error("send closed");
	}
}

const LIVE_ACTIVITY_TOKEN_HASH = "a".repeat(64);
const TEST_TRANSCRIPT_AUTHORIZATION = {
	ok: true,
	allowTools: "",
	client: {
		nodeId: "test-client",
		label: "test-client",
		allowedWorkspaces: ["workspace"],
		allowedTools: "",
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		pairedAt: 1,
		lastSeenAt: 2,
	},
	paired: true,
	pairingSecretConsumed: false,
	workspace: { name: "workspace", path: "/workspace" },
	workspaceNames: ["workspace"],
	workspaces: [{ name: "workspace", status: "available" }],
} satisfies IrohRemoteClientAuthorizationSuccess;

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

function createAssistantMessage(overrides: Partial<AssistantAgentMessage> = {}): AssistantAgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function createTestTranscriptExternalProjection(runtimeHost: AgentSessionRuntime): (event: object) => object | null {
	return (event) => {
		if (!isConversationTranscriptCommittedEvent(event)) {
			return event;
		}
		const entry = createRemoteConversationTranscriptEntry(event.entry, TEST_TRANSCRIPT_AUTHORIZATION, runtimeHost);
		return entry === undefined ? null : { type: "transcript_entry", entry, final: true };
	};
}

function publishTestTranscriptCommit(runtimeHost: AgentSessionRuntime, entry: SessionEntry): void {
	runtimeHost.publishConversationProjectionEvent({ type: "conversation_transcript_committed", entry });
}

function createLiveActivityContentState(
	overrides: Partial<IrohRemoteLiveActivityContentState> = {},
): IrohRemoteLiveActivityContentState {
	return {
		operationKind: "conversation",
		operationID: "session-one",
		status: "running",
		sessionID: "session-one",
		workspaceName: "volt-app",
		operationStartedAtEpochSeconds: 100,
		updatedAtEpochSeconds: 123,
		...overrides,
	};
}

function startTestReview(
	manager: ReviewWorkflowManager,
	workflowId: string,
): {
	finish(result: ExecuteReviewWorkflowResult): void;
} {
	let finish: (result: ExecuteReviewWorkflowResult) => void = () => {};
	const result = new Promise<ExecuteReviewWorkflowResult>((resolve) => {
		finish = resolve;
	});
	const { launch } = manager.start({
		prepared: {
			workflowId,
			action: "review.uncommitted",
			resolution: {
				description: "private review target",
				workflowDescription: "uncommitted changes",
				diffCommand: "git diff HEAD",
				diff: "private diff",
				truncated: false,
			},
		},
		execute: async (hooks) => {
			hooks.onEvent({
				type: "workflow_start",
				workflowId,
				kind: "review",
				action: "review.uncommitted",
				title: "Review",
				message: "Reviewing uncommitted changes.",
				status: "running",
			});
			return result;
		},
	});
	launch();
	return { finish };
}

function createLiveActivityRegistration(
	overrides: Partial<IrohRemoteLiveActivityRegistration> = {},
): IrohRemoteLiveActivityRegistration {
	return {
		workspaceName: "volt-app",
		sessionId: "session-one",
		activityId: "activity-1",
		tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
		tokenEnvironment: "production",
		platform: "ios",
		pushTargetId: "relay-target-1",
		createdAt: 30,
		updatedAt: 30,
		...overrides,
	};
}

function createStateManagerWithClient(
	pushTargets: IrohRemotePushTarget[] = [],
	liveActivities: IrohRemoteLiveActivityRegistration[] = [],
): IrohRemoteHostStateManager {
	return new IrohRemoteHostStateManager({
		initialState: {
			...createEmptyIrohRemoteHostState(),
			clients: [
				{
					nodeId: "paired-client",
					label: "phone",
					allowedWorkspaces: [],
					allowedTools: "read",
					rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
					pairedAt: 1,
					lastSeenAt: 2,
					...(pushTargets.length > 0 ? { pushTargets } : {}),
					...(liveActivities.length > 0 ? { liveActivities } : {}),
				},
			],
		},
	});
}

function createEnabledPushTarget(overrides: Partial<IrohRemotePushTarget> = {}): IrohRemotePushTarget {
	return {
		id: "relay-target-1",
		provider: "fcm",
		platform: "ios",
		pushTargetAuthToken: "relay-target-auth-token",
		tokenHash: hashIrohRemotePushToken("fcm-token"),
		enabled: true,
		createdAt: 10,
		updatedAt: 10,
		...overrides,
	};
}

function createRelayClient(overrides: Partial<IrohRemotePushRelayClient> = {}): IrohRemotePushRelayClient {
	return {
		sendNotification: vi.fn(async () => ({ status: "sent" as const })),
		...overrides,
	};
}

afterEach(() => {
	reviewMocks.prepareReviewWorkflow.mockClear();
	reviewMocks.executeReviewWorkflow.mockClear();
});

describe("Iroh remote notification requests", () => {
	test("relay HTTP client posts scoped target credentials to the notification endpoint", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendNotification({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				eventId: "event-1",
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				data: { eventId: "event-1", kind: "conversation_completed" },
			}),
		).resolves.toEqual({ status: "sent" });

		expect(fetcher).toHaveBeenCalledWith(
			"https://push.example.test/v1/notifications",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected notification fetch init");
		}
		const body = JSON.parse(String(init.body)) as unknown;
		if (!isRecord(body)) {
			throw new Error("Expected notification body object");
		}
		expect(body).toMatchObject({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "event-1",
		});
	});

	test("relay HTTP client posts Live Activity state to the live activity endpoint", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendLiveActivityUpdate({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				activityId: "activity-1",
				activityPushToken: "activity-token",
				eventId: "event-1",
				kind: "live_activity_update",
				contentState: createLiveActivityContentState({
					operationID: "session-1",
					sessionID: "session-1",
				}),
				staleDateEpochSeconds: 213,
			}),
		).resolves.toEqual({ status: "sent" });

		expect(fetcher).toHaveBeenCalledWith(
			"https://push.example.test/v1/live-activities",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected live activity fetch init");
		}
		const body = JSON.parse(String(init.body)) as unknown;
		if (!isRecord(body)) {
			throw new Error("Expected live activity body object");
		}
		expect(body).toMatchObject({
			activityId: "activity-1",
			activityPushToken: "activity-token",
			contentState: {
				operationKind: "conversation",
				operationID: "session-1",
				status: "running",
				sessionID: "session-1",
				workspaceName: "volt-app",
			},
			eventId: "event-1",
			pushTargetId: "relay-target-1",
		});
	});

	test("relay HTTP client forwards the live activity token environment", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await client.sendLiveActivityUpdate({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			activityId: "activity-1",
			activityPushToken: "activity-token",
			tokenEnvironment: "development",
			eventId: "event-1",
			kind: "live_activity_update",
			contentState: createLiveActivityContentState(),
		});

		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected live activity fetch init");
		}
		const body = JSON.parse(String(init.body)) as unknown;
		if (!isRecord(body)) {
			throw new Error("Expected live activity body object");
		}
		expect(body).toMatchObject({ tokenEnvironment: "development" });
	});

	test("relay HTTP client treats 422 as an invalid target so the channel is pruned", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response(JSON.stringify({ error: "live_activity_environment_unsupported" }), { status: 422 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendLiveActivityUpdate({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				activityId: "activity-1",
				activityPushToken: "activity-token",
				eventId: "event-1",
				kind: "live_activity_update",
				contentState: createLiveActivityContentState(),
			}),
		).resolves.toEqual({ status: "invalid_target" });
	});

	test("relay HTTP client surfaces the relay error body in thrown errors", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response(JSON.stringify({ error: "fcm_send_failed", code: "messaging/invalid-argument" }), {
				status: 502,
			});
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendNotification({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				eventId: "event-1",
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				data: { eventId: "event-1", kind: "conversation_completed" },
			}),
		).rejects.toThrow("Push relay request failed with HTTP 502 (fcm_send_failed: messaging/invalid-argument)");
	});

	test("relay HTTP client sends bearer auth when configured", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({
			authToken: "relay-secret",
			baseUrl: "https://push.example.test",
			fetcher,
		});

		await client.sendNotification({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "event-1",
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			data: { eventId: "event-1", kind: "conversation_completed" },
		});

		const init = fetcher.mock.calls[0]?.[1];
		if (!init || !isRecord(init.headers)) {
			throw new Error("Expected notification fetch headers");
		}
		expect(init.headers).toMatchObject({
			authorization: "Bearer relay-secret",
			"content-type": "application/json",
		});
	});

	test("relay HTTP client ignores client-provided relay URLs when sending host credentials", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({
			authToken: "relay-secret",
			baseUrl: "https://trusted-push.example.test/base",
			fetcher,
		});

		const requestWithClientRelayUrl = {
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			relayUrl: "https://attacker.example.test/steal",
			eventId: "event-1",
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			data: { eventId: "event-1", kind: "conversation_completed" },
		};

		await client.sendNotification(requestWithClientRelayUrl);

		expect(fetcher).toHaveBeenCalledWith(
			"https://trusted-push.example.test/base/v1/notifications",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected notification fetch init");
		}
		expect(fetcher.mock.calls[0]?.[0]).not.toContain("attacker.example.test");
		expect(String(init.body)).not.toContain("attacker.example.test");
	});

	test("register_push_target persists app-issued relay credentials with redacted audit metadata", async () => {
		const now = 100;
		const session = createTestSession("session-one", "before-run");
		const stateManager = createStateManagerWithClient();
		const relayClient = createRelayClient();
		const auditEvents: object[] = [];
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
			clientNodeId: "paired-client",
			now: () => now,
			relayClient,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			registerPushTarget: (args) => dispatcher.registerPushTarget(args),
		});

		// A client-supplied clientNodeId is contract drift: the schema rejects the
		// command outright, so the untrusted identity can never reach the dispatcher.
		recv.pushLine(
			JSON.stringify({
				id: "push-0",
				type: "register_push_target",
				args: {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "relay-target-1",
					pushTargetAuthToken: "secret-target-auth-token",
					enabled: true,
					clientNodeId: "untrusted-client",
				},
			}),
		);
		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				id: "push-0",
				type: "response",
				command: "register_push_target",
				success: false,
				error: 'Invalid RPC command payload: "args.clientNodeId" is not a recognized field',
			}),
		);

		recv.pushLine(
			JSON.stringify({
				id: "push-1",
				type: "register_push_target",
				args: {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "relay-target-1",
					pushTargetAuthToken: "secret-target-auth-token",
					relayUrl: "https://push.example.test",
					tokenHash: hashIrohRemotePushToken("secret-fcm-token"),
					liveActivity: {
						activityId: "activity-1",
						pushToken: "secret-live-activity-token",
						tokenHash: hashIrohRemotePushToken("secret-live-activity-token"),
					},
					enabled: true,
				},
			}),
		);

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				id: "push-1",
				type: "response",
				command: "register_push_target",
				success: true,
				data: { status: "registered", pushTargetId: "relay-target-1" },
			}),
		);
		const state = await stateManager.getState();
		expect(state.clients[0].pushTargets).toEqual([
			{
				id: "relay-target-1",
				provider: "fcm",
				platform: "ios",
				pushTargetAuthToken: "secret-target-auth-token",
				relayUrl: "https://push.example.test",
				tokenHash: hashIrohRemotePushToken("secret-fcm-token"),
				liveActivity: {
					activityId: "activity-1",
					pushToken: "secret-live-activity-token",
					tokenHash: hashIrohRemotePushToken("secret-live-activity-token"),
					updatedAt: 100,
				},
				enabled: true,
				createdAt: 100,
				updatedAt: 100,
			},
		]);
		expect(JSON.stringify(state)).not.toContain("secret-fcm-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-target-auth-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-fcm-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-live-activity-token");
		expect(auditEvents).toContainEqual(
			expect.objectContaining({
				type: "push_target_registered",
				details: expect.objectContaining({ tokenHash: hashIrohRemotePushToken("secret-fcm-token") }),
			}),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps Live Activity open when the agent run will retry", async () => {
		const sessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		const session = {
			autoCompactionEnabled: false,
			bindExtensions: vi.fn(async () => {}),
			followUpMode: "all" as const,
			isCompacting: false,
			isStreaming: false,
			messages: [],
			model: undefined,
			modelRegistry: { authStorage: {} },
			pendingMessageCount: 0,
			sessionFile: "/sessions/session-one.jsonl",
			sessionId: "session-one",
			sessionManager: { flush: vi.fn(async () => {}), getLeafId: () => "run-one" },
			settingsManager: {},
			steeringMode: "all" as const,
			subscribe: vi.fn((handler: (event: AgentSessionEvent) => void) => {
				sessionHandlers.push(handler);
				return () => {};
			}),
			thinkingLevel: "off" as const,
			waitForIdle: vi.fn(async () => {}),
			agent: { subscribe: vi.fn(() => () => {}), waitForIdle: vi.fn(async () => {}) },
		};
		const deliveredUpdates: Array<{ activityEvent?: "update" | "end"; kind: string }> = [];
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const runtimeHost = {
			session,
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const modePromise = runIrohRemoteRpcMode(runtimeHost, {
			...createTestIrohConversationOptions(runtimeHost),
			disposeRuntimeOnClose: false,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update) => {
					deliveredUpdates.push({ activityEvent: update.activityEvent, kind: update.kind });
					return "sent" as const;
				}),
			},
			stream: { recv, send },
			workspaceName: "volt-app",
			workspacePath: "/workspace",
		});

		await vi.waitFor(() => expect(sessionHandlers.length).toBeGreaterThanOrEqual(2));
		expect(parseWrittenObjects(send)[0]).toMatchObject({
			type: "conversation_bootstrap",
			delivery: { cursor: 0 },
			conversation: { sessionId: "session-one" },
		});
		for (const handler of sessionHandlers) {
			handler({ type: "agent_start" });
			handler({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
		}
		await vi.waitFor(() =>
			expect(deliveredUpdates).toContainEqual({ activityEvent: "update", kind: "live_activity_update" }),
		);
		for (const handler of sessionHandlers) {
			handler({ type: "agent_end", messages: [], willRetry: true });
		}
		await new Promise((resolve) => setImmediate(resolve));

		expect(deliveredUpdates).not.toContainEqual({ activityEvent: "end", kind: "live_activity_end" });

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends semantic Live Activity state through the push relay when an activity target exists", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[createLiveActivityRegistration()],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = createLiveActivityContentState();

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:1",
				kind: "live_activity_update",
				contentState,
				staleDateEpochSeconds: 213,
			}),
		).resolves.toBe("sent");

		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledWith({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			activityId: "activity-1",
			activityPushToken: "activity-token",
			tokenEnvironment: "production",
			eventId: "live-activity:session-one:run-1:1",
			kind: "live_activity_update",
			contentState,
			staleDateEpochSeconds: 213,
		});
	});

	test("retries transient Live Activity relay failures with the same semantic update", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[createLiveActivityRegistration()],
		);
		let attempts = 0;
		const sendLiveActivityUpdate = vi.fn(async (_request: unknown) => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error("transient relay failure");
			}
			return { status: "sent" as const };
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient: createRelayClient({ sendLiveActivityUpdate }),
			retryAttempts: 3,
			retryDelayMs: 0,
			stateManager,
		});
		const update: IrohRemoteLiveActivityUpdateIntent = {
			eventId: "live-activity:retry",
			kind: "live_activity_update",
			contentState: createLiveActivityContentState(),
			staleDateEpochSeconds: 213,
		};

		await expect(dispatcher.deliverLiveActivityUpdate(update)).resolves.toBe("sent");
		expect(sendLiveActivityUpdate).toHaveBeenCalledTimes(3);
		expect(sendLiveActivityUpdate.mock.calls[0]?.[0]).toEqual(sendLiveActivityUpdate.mock.calls[2]?.[0]);
	});

	test("sends Live Activity updates when completion notifications are disabled", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					enabled: false,
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[createLiveActivityRegistration()],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = createLiveActivityContentState();

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:2",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("sent");

		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				pushTargetId: "relay-target-1",
				activityPushToken: "activity-token",
				contentState,
			}),
		);
	});

	test("prunes invalid Live Activity targets without disabling completion notifications", async () => {
		const otherTokenHash = "b".repeat(64);
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
				createEnabledPushTarget({
					id: "relay-target-2",
					pushTargetAuthToken: "relay-target-auth-token-2",
					tokenHash: hashIrohRemotePushToken("fcm-token-2"),
					enabled: false,
					liveActivity: {
						activityId: "activity-2",
						pushToken: "activity-token-2",
						tokenHash: otherTokenHash,
						tokenEnvironment: "production",
						updatedAt: 25,
					},
				}),
			],
			[
				createLiveActivityRegistration(),
				createLiveActivityRegistration({
					activityId: "activity-2",
					pushTargetId: "relay-target-2",
					sessionId: "session-two",
					tokenHash: otherTokenHash,
					updatedAt: 31,
				}),
			],
		);
		const sendNotification = vi.fn(async () => ({ status: "sent" as const }));
		const sendLiveActivityUpdate = vi.fn(async () => ({ status: "invalid_target" as const }));
		const relayClient = createRelayClient({ sendNotification, sendLiveActivityUpdate });
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			now: () => 500,
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = createLiveActivityContentState();

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:invalid",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("invalid_target");
		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:after-prune",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("no_push_target");
		expect(sendLiveActivityUpdate).toHaveBeenCalledOnce();

		const state = await stateManager.getState();
		const invalidTarget = state.clients[0].pushTargets?.find((target) => target.id === "relay-target-1");
		expect(invalidTarget).toMatchObject({ enabled: true, updatedAt: 500 });
		expect(invalidTarget).not.toHaveProperty("liveActivity");
		const otherTarget = state.clients[0].pushTargets?.find((target) => target.id === "relay-target-2");
		expect(otherTarget?.liveActivity).toMatchObject({ tokenHash: otherTokenHash });
		expect(state.clients[0].liveActivities).toEqual([
			expect.objectContaining({ activityId: "activity-2", pushTargetId: "relay-target-2" }),
		]);

		await expect(
			dispatcher.deliverNotification({
				eventId: "conversation:session-one:run-1:completed",
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
			}),
		).resolves.toBe("sent");
		expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ pushTargetId: "relay-target-1" }));
	});

	test("routes Live Activity updates through the matching workspace and session registration", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "stale-target-activity",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[
				createLiveActivityRegistration({ activityId: "activity-1", sessionId: "session-one", updatedAt: 30 }),
				createLiveActivityRegistration({ activityId: "activity-2", sessionId: "session-two", updatedAt: 40 }),
			],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = createLiveActivityContentState({
			operationID: "session-two",
			sessionID: "session-two",
		});

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-two:run-1:1",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("sent");

		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				activityId: "activity-2",
				activityPushToken: "activity-token",
				contentState,
			}),
		);
	});

	test("replaces and unregisters stream-bound Live Activity registrations", async () => {
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({
				liveActivity: {
					activityId: "activity-1",
					pushToken: "activity-token",
					tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
					tokenEnvironment: "production",
					updatedAt: 20,
				},
			}),
		]);
		await expect(
			stateManager.findClientLiveActivityDeliveryChannel("paired-client", {
				tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
				tokenEnvironment: "production",
				platform: "ios",
			}),
		).resolves.toMatchObject({ id: "relay-target-1" });
		await expect(
			stateManager.findClientLiveActivityDeliveryChannel("paired-client", {
				tokenHash: "b".repeat(64),
				tokenEnvironment: "production",
				platform: "ios",
			}),
		).resolves.toBeUndefined();

		await stateManager.registerClientLiveActivity(
			"paired-client",
			createLiveActivityRegistration({
				activityId: "activity-1",
				sessionId: "session-one",
				createdAt: 100,
				updatedAt: 100,
			}),
		);
		const replacement = await stateManager.registerClientLiveActivity(
			"paired-client",
			createLiveActivityRegistration({
				activityId: "activity-1",
				sessionId: "session-two",
				createdAt: 200,
				updatedAt: 200,
			}),
		);
		expect(replacement.replacedRegistration).toMatchObject({ sessionId: "session-one" });
		await expect(stateManager.getClient("paired-client")).resolves.toMatchObject({
			liveActivities: [
				expect.objectContaining({ activityId: "activity-1", createdAt: 100, sessionId: "session-two" }),
			],
		});

		await expect(
			stateManager.unregisterClientLiveActivity("paired-client", "volt-app", "session-one", "activity-1"),
		).resolves.toBe(false);
		await expect(
			stateManager.unregisterClientLiveActivity("paired-client", "volt-app", "session-two", "activity-1"),
		).resolves.toBe(true);
		await expect(stateManager.getClient("paired-client")).resolves.not.toHaveProperty("liveActivities");
	});

	test("Live Activity updater projects conversation state, suppresses tool events, and keeps terminal activities updateable", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const sessionHandlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		const emit = (event: AgentSessionEvent) => {
			for (const handler of sessionHandlers) {
				handler(event);
			}
		};

		emit({ type: "agent_start" });
		await vi.waitFor(() => expect(updates).toHaveLength(1));
		const running = updates[0]!;
		expect(running).toMatchObject({
			activityEvent: "update",
			kind: "live_activity_update",
			contentState: {
				operationKind: "conversation",
				operationID: "session-one",
				status: "running",
				sessionID: "session-one",
				workspaceName: "volt-app",
				operationStartedAtEpochSeconds: expect.any(Number),
				updatedAtEpochSeconds: expect.any(Number),
			},
		});
		expect(running.staleDateEpochSeconds).toBe(running.contentState.updatedAtEpochSeconds + 90);

		emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
		emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
		await new Promise((resolve) => setImmediate(resolve));
		expect(updates).toHaveLength(1);

		emit({ type: "agent_end", messages: [], willRetry: false });
		await new Promise((resolve) => setImmediate(resolve));
		expect(updates).toHaveLength(1);
		emit({ type: "agent_start" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(updates).toHaveLength(1);

		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		await vi.waitFor(() => expect(updates).toHaveLength(2));
		expect(updates[1]).toMatchObject({
			activityEvent: "update",
			kind: "live_activity_update",
			contentState: {
				operationKind: "conversation",
				operationID: "session-one",
				status: "completed",
				operationStartedAtEpochSeconds: running.contentState.operationStartedAtEpochSeconds,
			},
		});
		expect(updates).not.toContainEqual(expect.objectContaining({ activityEvent: "end", kind: "live_activity_end" }));
		expect(new Set(updates.map((update) => update.eventId)).size).toBe(updates.length);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater projects Plan creation and bounded title changes with a stable start time", async () => {
		const session = createTestSession("session-one", "plan-run");
		let planning: PlanningState = { mode: "plan", plan: null };
		Object.defineProperty(session, "getPlanningState", { value: () => planning });
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const handlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		const emit = (event: AgentSessionEvent) => {
			for (const handler of handlers) handler(event);
		};

		emit({ type: "agent_start" });
		await vi.waitFor(() => expect(updates).toHaveLength(1));
		expect(updates[0]?.contentState).toMatchObject({
			operationKind: "planCreation",
			operationID: "session-one",
			status: "running",
		});
		expect(updates[0]?.contentState).not.toHaveProperty("subject");
		const startedAt = updates[0]!.contentState.operationStartedAtEpochSeconds;

		const title = "🚀".repeat(100);
		planning = {
			mode: "plan",
			plan: { id: "plan-one", revision: 1, phase: "draft", title, steps: [] },
		};
		emit({ type: "planning_state_changed", planning });
		await vi.waitFor(() => expect(updates).toHaveLength(2));
		expect(updates[1]?.contentState).toMatchObject({
			operationKind: "planCreation",
			operationID: "session-one",
			status: "running",
			operationStartedAtEpochSeconds: startedAt,
			subject: "🚀".repeat(64),
		});
		expect(Buffer.byteLength(updates[1]!.contentState.subject ?? "", "utf8")).toBe(256);

		planning = { ...planning, plan: { ...planning.plan!, revision: 2, title: "Renamed plan" } };
		emit({ type: "planning_state_changed", planning });
		await vi.waitFor(() => expect(updates).toHaveLength(3));
		expect(updates[2]?.contentState).toMatchObject({
			operationStartedAtEpochSeconds: startedAt,
			subject: "Renamed plan",
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater observes detached review-only work and omits review subjects", async () => {
		const session = createTestSession("session-one", "review-run");
		const reviewWorkflows = new ReviewWorkflowManager();
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		const runtimeHost = {
			session,
			reviewWorkflows,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(updates).toEqual([]);

		const review = startTestReview(reviewWorkflows, "review:one");
		await vi.waitFor(() => expect(updates).toHaveLength(1));
		const running = updates[0]!.contentState;
		expect(running).toMatchObject({
			operationKind: "review",
			operationID: "review:one",
			status: "running",
			sessionID: "session-one",
			workspaceName: "volt-app",
		});
		expect(running).not.toHaveProperty("subject");

		review.finish({ status: "completed", raw: "private result", findingsCount: 0 });
		await vi.waitFor(() => expect(updates).toHaveLength(2));
		expect(updates[1]?.contentState).toMatchObject({
			operationKind: "review",
			operationID: "review:one",
			status: "completed",
			operationStartedAtEpochSeconds: running.operationStartedAtEpochSeconds,
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater keeps concurrent reviews running and terminalizes only the last review", async () => {
		const session = createTestSession("session-one", "review-run");
		const reviewWorkflows = new ReviewWorkflowManager();
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		const runtimeHost = {
			session,
			reviewWorkflows,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});

		const first = startTestReview(reviewWorkflows, "review:first");
		await vi.waitFor(() => expect(updates.at(-1)?.contentState.operationID).toBe("review:first"));
		const second = startTestReview(reviewWorkflows, "review:second");
		await vi.waitFor(() => expect(updates.at(-1)?.contentState.operationID).toBe("review:second"));

		second.finish({ status: "cancelled" });
		await vi.waitFor(() =>
			expect(updates.at(-1)?.contentState).toMatchObject({
				operationID: "review:first",
				status: "running",
			}),
		);
		expect(updates).not.toContainEqual(
			expect.objectContaining({
				contentState: expect.objectContaining({ operationID: "review:second", status: "cancelled" }),
			}),
		);

		first.finish({ status: "failed", errorMessage: "private provider failure" });
		await vi.waitFor(() =>
			expect(updates.at(-1)?.contentState).toMatchObject({
				operationID: "review:first",
				status: "failed",
			}),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater falls directly from a finished review to overlapping conversation work", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const reviewWorkflows = new ReviewWorkflowManager();
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		const runtimeHost = {
			session,
			reviewWorkflows,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const handlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		for (const handler of handlers) handler({ type: "agent_start" });
		await vi.waitFor(() => expect(updates.at(-1)?.contentState.operationKind).toBe("conversation"));

		const review = startTestReview(reviewWorkflows, "review:overlap");
		await vi.waitFor(() => expect(updates.at(-1)?.contentState.operationKind).toBe("review"));
		review.finish({ status: "completed", raw: "private result", findingsCount: 1 });
		await vi.waitFor(() =>
			expect(updates.at(-1)?.contentState).toMatchObject({ operationKind: "conversation", status: "running" }),
		);
		expect(updates).not.toContainEqual(
			expect.objectContaining({
				contentState: expect.objectContaining({ operationID: "review:overlap", status: "completed" }),
			}),
		);

		for (const handler of handlers) {
			handler({ type: "agent_end", messages: [], willRetry: false });
			handler({ type: "agent_settled" });
		}
		await vi.waitFor(() =>
			expect(updates.at(-1)?.contentState).toMatchObject({ operationKind: "conversation", status: "completed" }),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("delayed Live Activity settlement cannot deactivate a newer run", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		let releaseFirstTerminal: () => void = () => undefined;
		const firstTerminalRelease = new Promise<void>((resolve) => {
			releaseFirstTerminal = resolve;
		});
		let notifyFirstTerminalStarted: () => void = () => undefined;
		const firstTerminalStarted = new Promise<void>((resolve) => {
			notifyFirstTerminalStarted = resolve;
		});
		let terminalCount = 0;
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					if (update.contentState.status === "completed" && ++terminalCount === 1) {
						notifyFirstTerminalStarted();
						await firstTerminalRelease;
					}
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const handlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		const emit = (event: AgentSessionEvent) => {
			for (const handler of handlers) {
				handler(event);
			}
		};

		emit({ type: "agent_start" });
		await vi.waitFor(() =>
			expect(updates.filter((update) => update.contentState.status === "running")).toHaveLength(1),
		);
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		await firstTerminalStarted;

		emit({ type: "agent_start" });
		releaseFirstTerminal();
		await vi.waitFor(() =>
			expect(updates.filter((update) => update.contentState.status === "running")).toHaveLength(2),
		);
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		await vi.waitFor(() =>
			expect(updates.filter((update) => update.contentState.status === "completed")).toHaveLength(2),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater reports terminal assistant errors as failed", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const updates: Array<IrohRemoteLiveActivityUpdateIntent> = [];
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const sessionHandlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		if (sessionHandlers.length === 0) {
			throw new Error("Expected Live Activity session subscription");
		}

		for (const handler of sessionHandlers) {
			handler({ type: "agent_start" });
		}
		await vi.waitFor(() =>
			expect(updates).toContainEqual(
				expect.objectContaining({ contentState: expect.objectContaining({ status: "running" }) }),
			),
		);
		for (const handler of sessionHandlers) {
			handler({
				type: "agent_end",
				messages: [
					createAssistantMessage({ stopReason: "error", errorMessage: "No API key for provider: openai-codex" }),
				],
				willRetry: false,
			});
			handler({ type: "agent_settled" });
		}
		await vi.waitFor(() =>
			expect(updates).toContainEqual(
				expect.objectContaining({
					activityEvent: "update",
					contentState: expect.objectContaining({
						operationKind: "conversation",
						operationID: "session-one",
						status: "failed",
					}),
					kind: "live_activity_update",
				}),
			),
		);
		expect(updates).not.toContainEqual(
			expect.objectContaining({ contentState: expect.objectContaining({ status: "completed" }) }),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater maps aborted conversation runs to cancelled", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const handlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		for (const handler of handlers) {
			handler({ type: "agent_start" });
			handler({
				type: "agent_end",
				messages: [createAssistantMessage({ stopReason: "aborted" })],
				willRetry: false,
			});
			handler({ type: "agent_settled" });
		}
		await vi.waitFor(() =>
			expect(updates).toContainEqual(
				expect.objectContaining({ contentState: expect.objectContaining({ status: "cancelled" }) }),
			),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater reattaches to active runs without reusing event IDs", async () => {
		let currentSession = createTestSession("session-one", "conversation-run");
		const initialHandlers: Array<(event: AgentSessionEvent) => void> = [];
		currentSession.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			initialHandlers.push(handler);
			return () => {};
		});
		const setRebindSession = vi.fn();
		const updates: Array<{ eventId: string; status: string }> = [];
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession,
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, currentSession, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push({ eventId: update.eventId, status: update.contentState.status });
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const rebindSession = setRebindSession.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
		if (!rebindSession) {
			throw new Error("Expected runIrohRemoteRpcMode to register a session rebind callback");
		}
		await vi.waitFor(() => expect(initialHandlers.length).toBeGreaterThan(0));

		for (const handler of initialHandlers) {
			handler({ type: "agent_start" });
		}
		await vi.waitFor(() => expect(updates).toContainEqual(expect.objectContaining({ status: "running" })));

		const reattachedSession = createTestSession("session-one", "conversation-run");
		reattachedSession.isStreaming = true;
		const reattachedHandlers: Array<(event: AgentSessionEvent) => void> = [];
		reattachedSession.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			reattachedHandlers.push(handler);
			return () => {};
		});
		currentSession = reattachedSession;
		await rebindSession();
		await vi.waitFor(() => expect(updates.filter((update) => update.status === "running")).toHaveLength(2));

		for (const handler of reattachedHandlers) {
			handler({ type: "agent_end", messages: [], willRetry: false });
			handler({ type: "agent_settled" });
		}
		await vi.waitFor(() => expect(updates).toContainEqual(expect.objectContaining({ status: "completed" })));
		expect(new Set(updates.map((update) => update.eventId)).size).toBe(updates.length);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("updates relayed session id before active Live Activity reattach delivery", async () => {
		let currentSession = createTestSession("session-one", "run-one");
		const setRebindSession = vi.fn();
		let relayedSessionId = currentSession.sessionId;
		const deliveries: Array<{ payloadSessionId: string | undefined; relayedSessionId: string }> = [];
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession,
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, currentSession, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					deliveries.push({ payloadSessionId: update.contentState.sessionID, relayedSessionId });
					return "sent" as const;
				}),
			},
			onSessionChanged: async (session) => {
				relayedSessionId = session.sessionId;
			},
			workspaceName: "volt-app",
		});
		const rebindSession = setRebindSession.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
		if (!rebindSession) {
			throw new Error("Expected runIrohRemoteRpcMode to register a session rebind callback");
		}

		const reattachedSession = createTestSession("session-two", "run-two");
		reattachedSession.isStreaming = true;
		currentSession = reattachedSession;
		await rebindSession();

		await vi.waitFor(() =>
			expect(deliveries).toEqual([{ payloadSessionId: "session-two", relayedSessionId: "session-two" }]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends conversation completion notifications through the push relay when a target exists", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({ relayUrl: "https://attacker.example.test/steal" }),
		]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		const expectedNotification: IrohRemotePushRelayNotificationRequest = {
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "conversation:session-one:conversation-run:completed",
			kind: "conversation_completed",
			title: "Volt finished in volt-app",
			body: "Your conversation is ready.",
			workspace: "volt-app",
			data: {
				eventId: "conversation:session-one:conversation-run:completed",
				kind: "conversation_completed",
				sessionId: "session-one",
				workspace: "volt-app",
			},
		};
		await vi.waitFor(() => expect(relayClient.sendNotification).toHaveBeenCalledWith(expectedNotification));
		expect(getNotifications(send)).toEqual([]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends failure notice instead of completion notification when a prompt ends with an assistant error", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
				session.messages = [
					createAssistantMessage({ stopReason: "error", errorMessage: "No API key for provider: openai-codex" }),
				];
			},
		);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({ relayUrl: "https://attacker.example.test/steal" }),
		]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({
					eventId: "conversation:session-one:conversation-run:failed",
					kind: "host_notice",
					title: "Volt needs attention in volt-app",
					body: "Open Volt to view the error.",
				}),
			),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "conversation_completed" }),
		);
		expect(getNotifications(send)).toEqual([]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("does not send a completion notification when a prompt is aborted", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
				session.messages = [createAssistantMessage({ stopReason: "aborted" })];
			},
		);
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({ id: "prompt-1", type: "response", command: "prompt", success: true }),
			),
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(getNotifications(send)).toEqual([]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends push completion notification when accepted prompt response cannot be written", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const recv = new ManualIrohRecvStream();
		const send = new ThrowingIrohSendStream();
		const modePromise = runIrohRemoteRpcMode(runtimeHost, {
			...createTestIrohConversationOptions(runtimeHost),
			disposeRuntimeOnClose: false,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			notificationDelivery: dispatcher,
			stream: { recv, send },
			workspacePath: "/workspace",
		});
		void modePromise.catch(() => {});
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());
		expect(parseWrittenObjects(send)[0]).toMatchObject({
			type: "conversation_bootstrap",
			delivery: { cursor: 0 },
			conversation: { sessionId: "session-one" },
		});

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({ eventId: "conversation:session-one:conversation-run:completed" }),
			),
		);
		await expect(modePromise).rejects.toThrow("send closed");
	});

	test("streams displayed review custom messages as transcript entries after session rebind", async () => {
		const initialSession = createTestSession("initial-session", "initial-entry");
		const reviewSession = createTestSession("review-session", "review-entry");
		const reviewContent = [{ type: "text" as const, text: "Review findings" }];
		const reviewEntry = {
			type: "custom_message",
			id: "review-entry",
			parentId: null,
			ordinal: 1,
			timestamp: "2026-06-27T00:00:00.000Z",
			customType: "review",
			content: reviewContent,
			display: true,
		} as unknown as SessionEntry;
		reviewSession.sessionManager.getBranch.mockReturnValue([reviewEntry]);
		let currentSession = initialSession;
		const setRebindSession = vi.fn();
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession,
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, initialSession, {
			projectConversationExternal: createTestTranscriptExternalProjection(runtimeHost),
		});
		const rebindSession = setRebindSession.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
		if (!rebindSession) {
			throw new Error("Expected runIrohRemoteRpcMode to register a session rebind callback");
		}

		currentSession = reviewSession;
		await rebindSession();
		publishTestTranscriptCommit(runtimeHost, reviewEntry);

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					delivery: expect.objectContaining({ cursor: 1 }),
					entry: {
						entryId: "review-entry",
						ordinal: 1,
						createdAt: "2026-06-27T00:00:00.000Z",
						role: "assistant",
						text: "Review findings",
						truncated: false,
					},
					final: true,
				}),
			),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams assistant transcript entries with preserved Markdown formatting", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const formattedText =
			"Here is the plan:\n\n- Keep Markdown lists\n- Preserve code fences\n\n```swift\nlet value = 1\n```";
		const assistantMessage = createAssistantMessage({
			content: [{ type: "text" as const, text: formattedText }],
		});
		const assistantEntry = {
			type: "message",
			id: "assistant-entry",
			parentId: null,
			ordinal: 1,
			timestamp: "2026-06-27T00:00:00.000Z",
			message: assistantMessage,
		} as unknown as SessionEntry;
		session.sessionManager.getBranch.mockReturnValue([assistantEntry]);
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			projectConversationExternal: createTestTranscriptExternalProjection(runtimeHost),
		});
		publishTestTranscriptCommit(runtimeHost, assistantEntry);

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					delivery: expect.objectContaining({ cursor: 1 }),
					entry: expect.objectContaining({
						entryId: "assistant-entry",
						ordinal: 1,
						createdAt: "2026-06-27T00:00:00.000Z",
						role: "assistant",
						text: formattedText,
						truncated: false,
						parts: [{ type: "text", text: formattedText, truncated: false }],
					}),
					final: true,
				}),
			),
		);

		expect(JSON.stringify(parseWrittenObjects(send))).not.toContain(
			"Here is the plan: - Keep Markdown lists - Preserve code fences",
		);
		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams assistant transcript entries with canonical text across multiple text parts", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const expectedText = ["Here is a plan:", "- Step one", "- Step two", "```swift", "\tlet value = 1", "```"].join(
			"\n",
		);
		// The ordered conversation projection preserves the exact text-part boundaries,
		// while the legacy get_transcript command still inserts a separator between parts.
		const expectedLegacyTranscriptText = [
			"Here is a plan:",
			"- Step one",
			"",
			"- Step two",
			"```swift",
			"\tlet value = 1",
			"```",
		].join("\n");
		const assistantMessage = createAssistantMessage({
			content: [
				{ type: "text" as const, text: "Here is a plan:\n- Step one" },
				{ type: "text" as const, text: "\n- Step two\n```swift\n\tlet value = 1\n```" },
			],
		});
		const assistantEntry = {
			type: "message",
			id: "assistant-entry",
			parentId: null,
			ordinal: 1,
			timestamp: "2026-06-27T00:00:00.000Z",
			message: assistantMessage,
		} as unknown as SessionEntry;
		session.sessionManager.getBranch.mockReturnValue([assistantEntry]);
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			projectConversationExternal: createTestTranscriptExternalProjection(runtimeHost),
		});
		publishTestTranscriptCommit(runtimeHost, assistantEntry);

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					delivery: expect.objectContaining({ cursor: 1 }),
					entry: expect.objectContaining({
						entryId: "assistant-entry",
						ordinal: 1,
						createdAt: "2026-06-27T00:00:00.000Z",
						role: "assistant",
						text: expectedText,
						truncated: false,
						parts: [
							{ type: "text", text: "Here is a plan:\n- Step one", truncated: false },
							{ type: "text", text: "\n- Step two\n```swift\n\tlet value = 1\n```", truncated: false },
						],
					}),
					final: true,
				}),
			),
		);

		recv.pushLine(JSON.stringify({ id: "transcript-1", type: "get_transcript", limit: 10 }));
		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				id: "transcript-1",
				type: "response",
				command: "get_transcript",
				success: true,
				data: {
					sessionId: "session-one",
					items: [
						{
							id: "assistant-entry",
							role: "assistant",
							text: expectedLegacyTranscriptText,
							timestamp: "2026-06-27T00:00:00.000Z",
						},
					],
					hasMore: false,
					nextBeforeEntryId: null,
				},
			}),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams completed tool transcript entries with projected metadata", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "bash-call",
					name: "bash",
					arguments: { command: "pwd && cat /workspace/src/index.ts", timeout: 5 },
				},
				{
					type: "toolCall",
					id: "read-call",
					name: "read",
					arguments: { path: "/workspace/src/index.ts", offset: 3 },
				},
				{
					type: "toolCall",
					id: "registry-call",
					name: "subagent_registry",
					arguments: { list: true, cursor: 50 },
				},
				{
					type: "toolCall",
					id: "follow-call",
					name: "subagent_registry",
					arguments: { follow: "sa_existing" },
				},
			],
			timestamp: 1,
		};
		const bashResult = {
			role: "toolResult",
			toolCallId: "bash-call",
			toolName: "bash",
			content: [{ type: "text", text: "private output" }],
			isError: false,
			timestamp: 2,
		};
		const readResult = {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "private file contents" }],
			isError: false,
			timestamp: 3,
		};
		const registryResult = {
			role: "toolResult",
			toolCallId: "registry-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "bounded registry page" }],
			details: {
				mode: "list",
				status: "completed",
				summary: { total: 120, returned: 50, nextCursor: 20 },
			},
			isError: false,
			timestamp: 4,
		};
		const followResult = {
			role: "toolResult",
			toolCallId: "follow-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "existing result" }],
			details: {
				mode: "follow",
				status: "completed",
				subagentId: "sa_existing",
				agent: { name: "researcher", source: "built-in" },
			},
			isError: false,
			timestamp: 5,
		};
		const branch = [
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				ordinal: 1,
				timestamp: "2026-06-27T00:00:00.000Z",
				message: assistantMessage,
			},
			{
				type: "message",
				id: "bash-entry",
				parentId: "assistant-entry",
				ordinal: 2,
				timestamp: "2026-06-27T00:00:01.000Z",
				message: bashResult,
			},
			{
				type: "message",
				id: "read-entry",
				parentId: "bash-entry",
				ordinal: 3,
				timestamp: "2026-06-27T00:00:02.000Z",
				message: readResult,
			},
			{
				type: "message",
				id: "registry-entry",
				parentId: "read-entry",
				ordinal: 4,
				timestamp: "2026-06-27T00:00:03.000Z",
				message: registryResult,
			},
			{
				type: "message",
				id: "follow-entry",
				parentId: "registry-entry",
				ordinal: 5,
				timestamp: "2026-06-27T00:00:04.000Z",
				message: followResult,
			},
		] as unknown as SessionEntry[];
		session.sessionManager.getBranch.mockReturnValue(branch);
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			projectConversationExternal: createTestTranscriptExternalProjection(runtimeHost),
		});
		for (let index = 1; index < branch.length; index++) {
			const entry = branch[index]!;
			session.leafId = entry.id;
			session.sessionManager.getBranch.mockReturnValue(branch.slice(0, index + 1));
			publishTestTranscriptCommit(runtimeHost, entry);
		}

		await vi.waitFor(() => {
			const objects = parseWrittenObjects(send);
			const transcriptEntries = objects.filter((record) => record.type === "transcript_entry");
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "bash-entry",
						role: "tool",
						toolName: "bash",
						status: "completed",
						summary: "Ran command: pwd && cat /workspace/src/index.ts (completed)",
						args: { command: "pwd && cat /workspace/src/index.ts", timeout: 5 },
						output: "private output",
						outputTruncated: false,
					}),
				}),
			);
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "read-entry",
						role: "tool",
						toolName: "read",
						status: "completed",
						path: "/workspace/src/index.ts",
						args: { path: "/workspace/src/index.ts", offset: 3 },
						output: "private file contents",
						outputTruncated: false,
					}),
				}),
			);
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "registry-entry",
						role: "tool",
						toolName: "subagent_registry",
						status: "completed",
						args: { list: true, cursor: 50 },
						details: {
							mode: "list",
							status: "completed",
							summary: { total: 120, returned: 50, nextCursor: 20 },
						},
						output: "bounded registry page",
						outputTruncated: false,
					}),
				}),
			);
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "follow-entry",
						role: "tool",
						toolName: "subagent_registry",
						status: "completed",
						args: { follow: "sa_existing" },
						details: {
							mode: "follow",
							status: "completed",
							subagentId: "sa_existing",
							agent: { name: "researcher", source: "built-in" },
						},
						output: "existing result",
						outputTruncated: false,
					}),
				}),
			);
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams tool transcript entries advertising imageCount without inline image data", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "read-image-call",
					name: "read",
					arguments: { path: "/workspace/logo.png" },
				},
			],
			timestamp: 1,
		};
		const imageReadResult = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		};
		const branch = [
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				ordinal: 1,
				timestamp: "2026-06-27T00:00:00.000Z",
				message: assistantMessage,
			},
			{
				type: "message",
				id: "read-image-entry",
				parentId: "assistant-entry",
				ordinal: 2,
				timestamp: "2026-06-27T00:00:01.000Z",
				message: imageReadResult,
			},
		] as unknown as SessionEntry[];
		session.sessionManager.getBranch.mockReturnValue(branch);
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			projectConversationExternal: createTestTranscriptExternalProjection(runtimeHost),
		});
		publishTestTranscriptCommit(runtimeHost, branch[1]!);

		await vi.waitFor(() => {
			const objects = parseWrittenObjects(send);
			const transcriptEntries = objects.filter((record) => record.type === "transcript_entry");
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "read-image-entry",
						role: "tool",
						toolName: "read",
						status: "completed",
						imageCount: 1,
					}),
				}),
			);
			// Live transcript frames stay text-only; the blocks are fetched per
			// entry via get_message_images.
			expect(JSON.stringify(transcriptEntries)).not.toContain("aW1hZ2UtYnl0ZXM=");
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("falls back to Iroh notification_request when no push target exists", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient();
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished in volt-app",
					body: "Your conversation is ready.",
					sessionId: "session-one",
					workspace: "volt-app",
				},
			]),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalled();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("does not send duplicate push notifications for the same eventId", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
		});

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);
		await vi.waitFor(() => expect(relayClient.sendNotification).toHaveBeenCalledTimes(1));
		session.leafId = "before-run";
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-2",
					type: "prompt",
					clientMessageId: "client-prompt-2",
					message: "hello again",
				}),
			),
		);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
		await new Promise((resolve) => setImmediate(resolve));
		expect(relayClient.sendNotification).toHaveBeenCalledTimes(1);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("disables push targets reported invalid by the relay", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({
				liveActivity: {
					activityId: "activity-1",
					pushToken: "activity-token",
					tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
					tokenEnvironment: "production",
					updatedAt: 20,
				},
			}),
		]);
		const relayClient = createRelayClient({
			sendNotification: vi.fn(async () => ({ status: "invalid_target" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			now: () => 500,
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
		});

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		await vi.waitFor(async () => {
			const state = await stateManager.getState();
			expect(state.clients[0].pushTargets?.[0]).toMatchObject({ enabled: false, updatedAt: 500 });
			expect(state.clients[0].pushTargets?.[0]).not.toHaveProperty("liveActivity");
		});
		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished",
					body: "Your conversation is ready.",
					sessionId: "session-one",
				},
			]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("emits one conversation completion notification after prompt completion", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
				session.leafId = "conversation-run";
			},
		);
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "prompt-1",
					type: "prompt",
					clientMessageId: "client-prompt-1",
					message: "hello",
				}),
			),
		);

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished",
					body: "Your conversation is ready.",
					sessionId: "session-one",
				},
			]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("emits one review completion notification after a detached remote review completes", async () => {
		const currentSession = createTestSession("initial-session", "initial-run");
		const runtimeHost = {
			...createStableSessionRunner(() => currentSession),
			get session() {
				return currentSession;
			},
			cwd: "/workspace",
			services: { agentDir: "/agent" },
			reviewWorkflows: new ReviewWorkflowManager(),
			newSession: vi.fn(async () => ({ cancelled: false })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const startupSession = currentSession;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, startupSession);

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "review-1",
					type: "invoke_ui_action",
					action: REVIEW_UNCOMMITTED_ACTION_ID,
				}),
			),
		);

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "review:test:completed",
					kind: "review_completed",
					title: "Review complete",
					body: "Open Volt to see the findings.",
					sessionId: "initial-session",
				},
			]),
		);
		expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalledOnce();
		// The detached review never force-switches the client's session.
		expect(runtimeHost.newSession).not.toHaveBeenCalled();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});
});
