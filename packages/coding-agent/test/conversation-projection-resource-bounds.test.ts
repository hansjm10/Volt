import { Buffer } from "node:buffer";
import type { AssistantMessage, AssistantMessageEvent, Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { sanitizeIrohRemoteOutbound } from "../src/core/remote/iroh/outbound-filter.ts";
import {
	ConversationProjectionFeed,
	type ConversationProjectionSnapshotBuilder,
	type ConversationProjectionSource,
} from "../src/core/rpc/conversation-projection-feed.ts";
import { serializeJsonLine } from "../src/core/rpc/jsonl.ts";
import { projectRpcBoundedString, projectRpcQueueUpdate, projectRpcUtf8Prefix } from "../src/core/rpc/session-state.ts";
import { projectSubagentDetails } from "../src/core/rpc/transcript.ts";
import type { RpcConversationActiveAssistant } from "../src/core/rpc/types.ts";
import type { SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import {
	createRemoteConversationExternalProjector,
	createRemoteConversationSnapshotBuilder,
	projectRemoteConversationActiveAssistant,
	REMOTE_CONVERSATION_BOOTSTRAP_MAX_SERIALIZED_BYTES,
	REMOTE_CONVERSATION_WORKFLOW_ARGUMENTS_MAX_SERIALIZED_BYTES,
	REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES,
} from "../src/daemon/conversation-projection.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class TestSource implements ConversationProjectionSource {
	private readonly listeners = new Set<(event: object) => void>();

	subscribe(listener: (event: object) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: object): void {
		for (const listener of this.listeners) listener(event);
	}
}

function createAuthorization(): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["scratch"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "scratch", path: "/tmp/scratch" },
		workspaceNames: ["scratch"],
		workspaces: [{ name: "scratch", status: "available" }],
	};
}

function createRuntime(largePayload: string): AgentSessionRuntime {
	const branch = Array.from({ length: 120 }, (_, index) => ({
		type: "message",
		id: `assistant-${index}`,
		ordinal: index + 1,
		timestamp: new Date(index + 1).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "🧪".repeat(12_000) }],
			stopReason: "stop",
		},
	}));
	const pendingToolExecutions = new Map(
		Array.from({ length: 8 }, (_, index) => [
			`session-tool-${index}`,
			{
				toolCallId: `session-tool-${index}`,
				toolName: "read",
				args: { path: `/tmp/scratch/file-${index}`, payload: largePayload },
				latestDetails: { status: "reading", payload: largePayload },
			},
		]),
	);
	return {
		session: {
			activeCompaction: undefined,
			activeToolExecutions: pendingToolExecutions,
			getSteeringMessages: () =>
				Array.from({ length: 3 }, (_, index) => ({
					queueEntryId: `steering-${index}`,
					clientMessageId: `steering-${index}`,
					text: largePayload,
				})),
			getFollowUpMessages: () =>
				Array.from({ length: 3 }, (_, index) => ({
					queueEntryId: `follow-up-${index}`,
					clientMessageId: `follow-up-${index}`,
					text: largePayload,
				})),
			retryAttempt: 0,
			settingsManager: undefined,
			model: undefined,
			thinkingLevel: "off",
			fastModeEnabled: false,
			getPlanningState: () => ({ mode: "build" as const, plan: null }),
			gitContextProvider: { getSnapshot: () => null },
			getAvailableThinkingLevels: () => ["off"],
			isStreaming: true,
			isBusy: true,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionFile: "/tmp/scratch/session.jsonl",
			sessionId: "session-resource-bounds",
			sessionName: "resource bounds",
			autoCompactionEnabled: true,
			messages: [],
			pendingMessageCount: 6,
			sessionManager: createLinearSessionManager(branch as unknown as SessionEntry[]),
		},
	} as unknown as AgentSessionRuntime;
}

function createLinearSessionManager(
	branch: SessionEntry[],
): Pick<SessionManager, "getBranch" | "getBranchWindow" | "getLeafEntry" | "getStartingGitContext"> {
	return {
		getBranch: () => branch,
		getLeafEntry: () => branch.at(-1),
		getStartingGitContext: () => undefined,
		getBranchWindow: ({ beforeEntryId, maxEntries, lookbackEntries = 0 }) => {
			const endIndex =
				beforeEntryId === undefined ? branch.length : branch.findIndex((entry) => entry.id === beforeEntryId);
			if (endIndex < 0) return undefined;
			const entryStart = Math.max(0, endIndex - maxEntries);
			const lookbackStart = Math.max(0, entryStart - lookbackEntries);
			return {
				entries: branch.slice(entryStart, endIndex),
				lookback: branch.slice(lookbackStart, entryStart),
				hasEarlier: lookbackStart > 0,
				visitedEntries: endIndex - lookbackStart,
			};
		},
	};
}

function createActiveWorkflows(largePayload: string): Array<{
	workflowId: string;
	workflowEvent: object;
	activeTools: object[];
}> {
	return Array.from({ length: 4 }, (_, workflowIndex) => ({
		workflowId: `workflow-${workflowIndex}`,
		workflowEvent: {
			type: "workflow_start",
			workflowId: `workflow-${workflowIndex}`,
			kind: "review",
			status: "running",
			message: largePayload,
			pullRequest: { provider: "github", number: 243 },
			details: { payload: largePayload },
		},
		activeTools: Array.from({ length: 4 }, (_, toolIndex) => ({
			type: "tool_execution_start",
			workflowId: `workflow-${workflowIndex}`,
			workflowKind: "review",
			workflowAction: "inspect",
			toolCallId: `workflow-${workflowIndex}-tool-${toolIndex}`,
			toolName: "read",
			args: { path: `/tmp/scratch/file-${toolIndex}`, payload: largePayload },
			details: { payload: largePayload },
		})),
	}));
}

function oversizedToolAssistant(largePayload: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tool-large",
				name: "read",
				arguments: { path: "/tmp/scratch/file", payload: largePayload },
			},
		],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("conversation projection resource bounds", () => {
	it("stops UTF-8 string inspection immediately after the retained prefix", () => {
		const source = "x".repeat(8 * 1024 * 1024);
		const prefix = projectRpcUtf8Prefix(source, 4 * 1024);
		const projected = projectRpcBoundedString(source, 4 * 1024);

		expect(prefix).toMatchObject({
			utf8Bytes: 4 * 1024,
			truncated: true,
			inspectedCodeUnits: 4 * 1024 + 1,
		});
		expect(prefix.value).toHaveLength(4 * 1024);
		expect(projected.projection).toMatchObject({ truncated: true, originalBytes: null });
	});

	it("projects exact queue identities through updates while independently bounding duplicate text", () => {
		const oversizedText = "q".repeat(32 * 1024);
		const projected = projectRpcQueueUpdate({
			type: "queue_update",
			steering: [
				{ queueEntryId: "client-a", clientMessageId: "client-a", text: oversizedText },
				{ queueEntryId: "client-b", clientMessageId: "client-b", text: oversizedText },
			],
			followUp: [],
		}) as {
			steering: Array<{ clientMessageId: string; text: string }>;
			projection: { steering: { truncated: boolean; omittedCount: number } };
		};

		expect(projected.steering.map((entry) => entry.clientMessageId)).toEqual(["client-a", "client-b"]);
		expect(projected.steering[0]?.text).toHaveLength(16 * 1024);
		expect(projected.steering[1]?.text).toBe(projected.steering[0]?.text);
		expect(projected.projection.steering).toMatchObject({ truncated: true, omittedCount: 0 });
	});

	it("retains all 128 queue identities under worst-case escaped text without exceeding the wire budget", () => {
		const escapedText = '"\\\n'.repeat(64 * 1024);
		const steering = Array.from({ length: 128 }, (_, index) => {
			const prefix = `client-${index}-`;
			const clientMessageId = `${prefix}${"x".repeat(256 - prefix.length)}`;
			return { queueEntryId: clientMessageId, clientMessageId, text: escapedText };
		});
		const projected = projectRpcQueueUpdate({
			type: "queue_update",
			steering,
			followUp: [],
		}) as {
			steering: Array<{ clientMessageId: string; text: string }>;
			projection: { steering: { projectedCount: number; omittedCount: number } };
		};

		expect(projected.steering.map((entry) => entry.clientMessageId)).toEqual(
			steering.map((entry) => entry.clientMessageId),
		);
		expect(projected.projection.steering).toMatchObject({ projectedCount: 128, omittedCount: 0 });
		expect(Buffer.byteLength(JSON.stringify(projected.steering), "utf8")).toBeLessThanOrEqual(128 * 1024);
	});

	it("bounds wide subagent arrays and one global tree-node budget", () => {
		const wide = (label: string): Array<Record<string, unknown>> => {
			const value = Array.from({ length: 64 }, (_, index) => ({
				subagentId: `${label}-${index}`,
				status: "running",
			}));
			value.length = 10_000;
			Object.defineProperty(value, 64, {
				get: () => {
					throw new Error(`${label} omitted tail was traversed`);
				},
			});
			return value;
		};
		const tasks: Array<Record<string, unknown>> = [];
		tasks.length = 1;
		Object.defineProperty(tasks, 0, {
			get: () => {
				throw new Error("global subagent node budget was exceeded");
			},
		});

		const projected = projectSubagentDetails({
			childSessions: wide("session"),
			children: wide("child"),
			tasks,
		});
		expect(projected?.childSessions).toHaveLength(64);
		expect(projected?.children).toHaveLength(64);
		expect(projected).not.toHaveProperty("tasks");
	});

	it("bounds adversarial multi-megabyte state and workflows below the full bootstrap envelope", () => {
		const largePayload = "x".repeat(2 * 1024 * 1024);
		const runtime = createRuntime(largePayload);
		const activeWorkflows = createActiveWorkflows(largePayload);
		const source = new TestSource();
		const builder = createRemoteConversationSnapshotBuilder({
			authorization: createAuthorization(),
			runtime,
		});
		const snapshot = builder({
			source,
			subscriptionId: "subscription-resource-bounds",
			branchEpoch: "branch-resource-bounds",
			reason: "bootstrap",
			activeAssistant: null,
			activeWorkflows,
		});
		const bootstrap = {
			type: "conversation_bootstrap",
			delivery: { subscriptionId: "subscription-resource-bounds", cursor: 0 },
			...snapshot,
			reason: "bootstrap",
		};
		const serializedBytes = Buffer.byteLength(JSON.stringify(bootstrap), "utf8");
		const sanitizedBootstrap = sanitizeIrohRemoteOutbound(bootstrap, { workspacePath: "/tmp/scratch" });
		const finalMeasuredBytes = Buffer.byteLength(serializeJsonLine(sanitizedBootstrap), "utf8");

		expect(serializedBytes).toBeLessThan(REMOTE_CONVERSATION_BOOTSTRAP_MAX_SERIALIZED_BYTES);
		expect(finalMeasuredBytes).toBeLessThanOrEqual(REMOTE_CONVERSATION_BOOTSTRAP_MAX_SERIALIZED_BYTES);
		expect(
			(sanitizedBootstrap as { state: { projection?: { activeWorkflows?: { truncated?: boolean } } } }).state
				.projection?.activeWorkflows?.truncated,
		).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(snapshot.transcript), "utf8")).toBeGreaterThan(1024 * 1024);
		expect(snapshot.state.projection?.steeringQueue).toMatchObject({ totalCount: 3, truncated: true });
		expect(snapshot.state.projection?.followUpQueue).toMatchObject({ totalCount: 3, truncated: true });
		expect(snapshot.state.steeringQueue?.map((entry) => entry.clientMessageId)).toEqual([
			"steering-0",
			"steering-1",
			"steering-2",
		]);
		expect(snapshot.state.projection?.activeTools).toMatchObject({
			totalCount: 8,
			projectedCount: 8,
			truncated: true,
		});
		expect(snapshot.state.projection?.activeWorkflows).toMatchObject({
			totalCount: 4,
			projectedCount: 4,
			truncated: true,
		});
		expect(snapshot.state.activeTools?.map((tool) => tool.toolCallId)).toEqual(
			Array.from({ length: 8 }, (_, index) => `session-tool-${index}`),
		);
		expect(snapshot.activeWorkflows.map((workflow) => workflow.workflowId)).toEqual(
			Array.from({ length: 4 }, (_, index) => `workflow-${index}`),
		);
		expect(snapshot.activeWorkflows[0]?.workflowEvent).toMatchObject({
			pullRequest: { provider: "github", number: 243 },
		});
		expect(snapshot.state).not.toHaveProperty("remoteHost");

		const liveProjector = createRemoteConversationExternalProjector({
			authorization: createAuthorization(),
			runtime,
		});
		const liveWorkflow = liveProjector(activeWorkflows[0]!.workflowEvent)!;
		expect(liveWorkflow).toMatchObject({ pullRequest: { provider: "github", number: 243 } });
		expect(liveWorkflow).toEqual(snapshot.activeWorkflows[0]?.workflowEvent);
		const live = liveProjector(activeWorkflows[0]!.activeTools[0]!)!;
		expect(live).toEqual(snapshot.activeWorkflows[0]?.activeTools[0]);
		expect(Buffer.byteLength(JSON.stringify(live), "utf8")).toBeLessThanOrEqual(
			REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES,
		);
		const mediumArgs = liveProjector({
			type: "tool_execution_start",
			workflowId: "workflow-medium",
			workflowKind: "review",
			workflowAction: "inspect",
			toolCallId: "workflow-medium-tool",
			toolName: "read",
			args: { payload: "m".repeat(16 * 1024) },
		}) as Record<string, unknown>;
		expect(mediumArgs.projection).toMatchObject({ truncated: true });
		expect(Buffer.byteLength(JSON.stringify(mediumArgs.args), "utf8")).toBeLessThanOrEqual(
			REMOTE_CONVERSATION_WORKFLOW_ARGUMENTS_MAX_SERIALIZED_BYTES,
		);
	});

	it("rejects pull request references with fields outside the bounded canonical shape", () => {
		const feed = new ConversationProjectionFeed({ subscribe: () => () => {} });
		expect(() =>
			feed.publishExternal({
				type: "workflow_start",
				workflowId: "review:invalid-reference",
				kind: "review",
				pullRequest: { provider: "github", number: 243, title: "must not cross" },
			}),
		).toThrow("Conversation workflow event contains malformed optional fields");
		feed.dispose();
	});

	it("bounds projection traversal before omitted queue, tool, and workflow tails", () => {
		const runtime = createRuntime("small");
		const queue = Array.from({ length: 128 }, (_, index) => ({
			queueEntryId: `queued-${index}`,
			clientMessageId: `queued-${index}`,
			text: `queued-${index}`,
		}));
		queue.length = 10_000;
		Object.defineProperty(queue, 128, {
			get: () => {
				throw new Error("omitted queue tail was traversed");
			},
		});
		const tools = new Map<string, { toolCallId: string; toolName: string; args: Record<string, unknown> }>();
		for (let index = 0; index < 128; index++) {
			tools.set(`tool-${index}`, { toolCallId: `tool-${index}`, toolName: "read", args: { index } });
		}
		const omittedTool = {} as { toolCallId: string; toolName: string; args: Record<string, unknown> };
		Object.defineProperty(omittedTool, "toolCallId", {
			get: () => {
				throw new Error("omitted tool tail was traversed");
			},
		});
		tools.set("tool-128", omittedTool);
		for (let index = 129; index < 10_000; index++) {
			tools.set(`tool-${index}`, { toolCallId: `tool-${index}`, toolName: "read", args: {} });
		}
		const session = runtime.session as unknown as {
			activeToolExecutions: typeof tools;
			getSteeringMessages: () => typeof queue;
			getFollowUpMessages: () => typeof queue;
		};
		Object.defineProperty(session, "activeToolExecutions", { value: tools });
		session.getSteeringMessages = () => queue;
		session.getFollowUpMessages = () => queue;

		const workflows = Array.from({ length: 64 }, (_, index) => ({
			workflowId: `workflow-${index}`,
			workflowEvent: { type: "workflow_start", workflowId: `workflow-${index}` },
			activeTools: [],
		}));
		workflows.length = 10_000;
		Object.defineProperty(workflows, 64, {
			get: () => {
				throw new Error("omitted workflow tail was traversed");
			},
		});
		const source = new TestSource();
		const snapshot = createRemoteConversationSnapshotBuilder({
			authorization: createAuthorization(),
			runtime,
		})({
			source,
			subscriptionId: "bounded-work",
			branchEpoch: "bounded-work",
			reason: "bootstrap",
			activeAssistant: null,
			activeWorkflows: workflows,
		});

		expect(snapshot.state.projection?.steeringQueue).toMatchObject({
			totalCount: 10_000,
			projectedCount: 128,
		});
		expect(snapshot.state.projection?.activeTools).toMatchObject({
			totalCount: 10_000,
			projectedCount: 128,
		});
		expect(snapshot.state.projection?.activeWorkflows).toMatchObject({
			totalCount: 10_000,
			projectedCount: 64,
		});
	});

	it("fails closed before assigning a cursor when active tool arguments cannot be losslessly seeded", () => {
		const largePayload = "x".repeat(1024 * 1024);
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: () => "resource-bound-id" });
		const message = oversizedToolAssistant(largePayload);
		source.emit({ type: "message_start", message });
		const writes: object[] = [];
		const buildSnapshot: ConversationProjectionSnapshotBuilder = (context) => ({
			conversation: { workspaceName: "scratch", sessionId: "session-active-assistant" },
			state: {
				thinkingLevel: "off",
				availableThinkingLevels: ["off"],
				fastModeEnabled: false,
				planning: { mode: "build", plan: null },
				gitContext: null,
				isStreaming: true,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "session-active-assistant",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
				steeringQueue: [],
				followUpQueue: [],
			},
			transcript: {
				sessionId: "session-active-assistant",
				items: [],
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch: context.branchEpoch,
				head: null,
			},
			activeAssistant: projectRemoteConversationActiveAssistant(context.activeAssistant),
			activeWorkflows: [],
		});

		expect(() =>
			feed.attach({
				write: (value) => {
					writes.push(value);
				},
				buildSnapshot,
			}),
		).toThrow("generation is poisoned: Assistant tool call 0 exceeded its 65536-byte serialized limit");
		expect(writes).toEqual([]);

		const completed = oversizedToolAssistant(`${largePayload}tail`);
		const delta: Extract<AssistantMessageEvent, { type: "toolcall_delta" }> = {
			type: "toolcall_delta",
			seq: 1,
			contentIndex: 0,
			argsTextDelta: "tail",
			snapshot: completed,
			toolState: [{ contentIndex: 0, argsText: JSON.stringify(completed.content[0]) }],
		};
		source.emit({ type: "message_update", message: completed, assistantMessageEvent: delta });
		source.emit({ type: "message_end", message: completed });
		expect(writes).toEqual([]);
		feed.dispose();
	});

	it("rejects active tool state that does not uniquely own a canonical toolCall block", () => {
		const toolMessage = oversizedToolAssistant("small");
		const project = (
			message: AssistantMessage,
			toolState: NonNullable<RpcConversationActiveAssistant["toolState"]>,
		) =>
			projectRemoteConversationActiveAssistant({
				stream: { epoch: 1, seq: 1 },
				message,
				toolState,
			});

		expect(() =>
			project(toolMessage, [
				{ contentIndex: 0, argsText: "{}" },
				{ contentIndex: 0, argsText: "{}" },
			]),
		).toThrow("Assistant tool state content index 0 is duplicated");
		expect(() => project(toolMessage, [{ contentIndex: 1, argsText: "{}" }])).toThrow(
			"Assistant tool state content index 1 is outside the message content",
		);
		expect(() =>
			project(
				{
					...toolMessage,
					content: [{ type: "text", text: "not a tool call" }],
				},
				[{ contentIndex: 0, argsText: "{}" }],
			),
		).toThrow("Assistant tool state content index 0 does not reference a canonical toolCall block");
	});

	it("may truncate non-delta assistant metadata while preserving the exact content base", () => {
		const message: AssistantMessage = {
			...oversizedToolAssistant("small"),
			diagnostics: [{ type: "provider", timestamp: 1, details: { payload: "d".repeat(512 * 1024) } }],
		};
		const source: RpcConversationActiveAssistant = {
			stream: { epoch: 3, seq: 7 },
			message,
			toolState: [{ contentIndex: 0, argsText: '{"path":"/tmp/scratch/file"}' }],
		};
		const projected = projectRemoteConversationActiveAssistant(source);
		expect(projected?.message.content).toEqual(message.content);
		expect(projected?.toolState).toEqual(source.toolState);
		expect(projected?.message.diagnostics).toBeUndefined();
		expect(projected?.projection?.fields?.message).toMatchObject({ truncated: true });
	});
});
