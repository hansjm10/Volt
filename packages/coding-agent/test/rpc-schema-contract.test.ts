import type { ActiveToolCallState, AssistantMessage, AssistantMessageEvent, Model, Usage } from "@hansjm10/volt-ai";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import { toIrohRemoteAgentOptionsCatalogModel } from "../src/core/remote/iroh/agent-options.ts";
import { RPC_COMMAND_SCHEMAS } from "../src/core/rpc/schema/commands.ts";
import {
	RpcConversationBootstrapEventSchema,
	RpcMessageEndFrameSchema,
	RpcMessageStartFrameSchema,
	RpcMessageUpdateFrameSchema,
	RpcQueueUpdateEventSchema,
	RpcTranscriptEntryEventSchema,
} from "../src/core/rpc/schema/conversation.ts";
import {
	RpcExtensionUIRequestSchema,
	RpcGitContextChangedEventSchema,
	RpcHostActionRequestSchema,
	RpcHostActionUpdateSchema,
	RpcModelsChangedEventSchema,
} from "../src/core/rpc/schema/events.ts";
import { RpcApiSchema, RpcModelSchema } from "../src/core/rpc/schema/external.ts";
import { RpcGitContextSchema } from "../src/core/rpc/schema/git-context.ts";
import { RpcPlanningStateChangedEventSchema } from "../src/core/rpc/schema/planning.ts";
import { RpcWorkflowEventSchema } from "../src/core/rpc/schema/projections.ts";
import { RPC_RESPONSE_SCHEMAS, RpcErrorResponseSchema } from "../src/core/rpc/schema/responses.ts";
import { RpcCatalogModelSchema } from "../src/core/rpc/schema/session.ts";
import { UiActionCapabilityFeatureSchema, UiActionDescriptorSchema } from "../src/core/rpc/schema/ui-actions.ts";
import { projectRpcQueueUpdate } from "../src/core/rpc/session-state.ts";
import { StreamProjector } from "../src/core/rpc/stream-projection.ts";
import type {
	RpcConversationBootstrapEvent,
	RpcExtensionUIRequest,
	RpcGitContext,
	RpcHostActionRequest,
	RpcHostActionUpdate,
	RpcTranscriptEntryEvent,
	RpcWorkflowEvent,
	UiActionDescriptor,
} from "../src/core/rpc/types.ts";
import { createRpcErrorResponse, createRpcSuccessResponse } from "../src/modes/rpc/rpc-command-dispatcher.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"] = [],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function check(schema: TSchema, value: unknown): boolean {
	return Compile(schema).Check(value);
}

describe("RPC contract schema integrity", () => {
	test("every command schema's type constant equals its map key", () => {
		for (const [key, schema] of Object.entries(RPC_COMMAND_SCHEMAS)) {
			const typeProperty = schema.properties.type as { const?: string };
			expect(typeProperty.const).toBe(key);
		}
	});

	test("every response schema echoes its command key under type: response", () => {
		for (const [key, schema] of Object.entries(RPC_RESPONSE_SCHEMAS)) {
			const properties = schema.properties as Record<string, { const?: unknown }>;
			expect(properties.type?.const).toBe("response");
			expect(properties.command?.const).toBe(key);
			expect(properties.success?.const).toBe(true);
		}
	});

	test("open string enums accept novel values", () => {
		for (const schema of [RpcApiSchema, UiActionCapabilityFeatureSchema]) {
			expect(check(schema, "some-novel-value.v9")).toBe(true);
			expect(check(schema, 7)).toBe(false);
		}
	});

	test("model cost tiers validate through model-bearing RPC schemas", () => {
		const tier = {
			inputTokensAbove: 272_000,
			input: 5,
			output: 22.5,
			cacheRead: 0.5,
			cacheWrite: 0,
		};
		const tieredModel: Model<"openai-responses"> = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2.5,
				output: 15,
				cacheRead: 0.25,
				cacheWrite: 0,
				tiers: [tier],
			},
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const untieredModel: Model<"openai-responses"> = {
			...tieredModel,
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		};
		const catalogModel = toIrohRemoteAgentOptionsCatalogModel(tieredModel);

		expect(check(RpcModelSchema, tieredModel)).toBe(true);
		expect(check(RpcModelSchema, untieredModel)).toBe(true);
		expect(check(RpcCatalogModelSchema, catalogModel)).toBe(true);
		expect(catalogModel.cost.tiers).toEqual([tier]);
		expect(
			check(RPC_RESPONSE_SCHEMAS.get_available_models, {
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [catalogModel] },
			}),
		).toBe(true);
		expect(
			check(RPC_RESPONSE_SCHEMAS.get_agent_options, {
				type: "response",
				command: "get_agent_options",
				success: true,
				data: {
					workspaceName: "workspace",
					models: [catalogModel],
					defaultConfig: {
						model: { provider: catalogModel.provider, modelId: catalogModel.id },
						thinkingLevel: "off",
						fastModeEnabled: false,
						agentMode: "build",
					},
				},
			}),
		).toBe(true);
		expect(
			check(RpcModelSchema, {
				...tieredModel,
				cost: { ...tieredModel.cost, unexpected: true },
			}),
		).toBe(false);
		expect(
			check(RpcModelSchema, {
				...tieredModel,
				cost: { ...tieredModel.cost, tiers: [{ ...tier, unexpected: true }] },
			}),
		).toBe(false);
	});

	test("requires usable correlation for every invoke_ui_action response", () => {
		const command = {
			id: "invoke-exact",
			type: "invoke_ui_action",
			action: "session.new",
		};
		expect(check(RPC_COMMAND_SCHEMAS.invoke_ui_action, command)).toBe(true);
		expect(check(RPC_COMMAND_SCHEMAS.invoke_ui_action, { ...command, id: undefined })).toBe(false);
		expect(check(RPC_COMMAND_SCHEMAS.invoke_ui_action, { ...command, id: "" })).toBe(false);
		expect(check(RPC_COMMAND_SCHEMAS.invoke_ui_action, { ...command, id: " padded " })).toBe(false);

		const success = createRpcSuccessResponse("invoke-exact", "invoke_ui_action", {
			action: "session.new",
			status: "completed",
		});
		expect(check(RPC_RESPONSE_SCHEMAS.invoke_ui_action, success)).toBe(true);
		expect(check(RPC_RESPONSE_SCHEMAS.invoke_ui_action, { ...success, id: undefined })).toBe(false);
		expect(check(RPC_RESPONSE_SCHEMAS.invoke_ui_action, { ...success, id: " padded " })).toBe(false);

		const correlatedFailure = createRpcErrorResponse("invoke-exact", "invoke_ui_action", "UI action not available");
		expect(correlatedFailure).toEqual({
			id: "invoke-exact",
			type: "response",
			command: "invoke_ui_action",
			success: false,
			error: "UI action not available",
		});
		expect(check(RpcErrorResponseSchema, correlatedFailure)).toBe(true);

		for (const id of [undefined, "", " padded ", "x".repeat(257)]) {
			const uncorrelated = createRpcErrorResponse(id, "invoke_ui_action", "Invalid invocation id");
			expect(uncorrelated).toEqual({
				type: "response",
				command: "invalid",
				success: false,
				error: "Invalid invocation id",
			});
			expect(check(RpcErrorResponseSchema, uncorrelated)).toBe(true);
		}

		expect(
			check(RpcErrorResponseSchema, {
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: 'Invalid RPC command payload: "id" is required',
			}),
		).toBe(false);
		expect(
			check(RpcErrorResponseSchema, {
				id: " padded ",
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: "Invalid invocation id",
			}),
		).toBe(false);
		expect(
			check(RpcErrorResponseSchema, {
				type: "response",
				command: "invalid",
				success: false,
				error: 'Invalid RPC command payload: "id" is required',
			}),
		).toBe(true);
		expect(() =>
			createRpcSuccessResponse("x".repeat(257), "invoke_ui_action", {
				action: "session.new",
				status: "completed",
			}),
		).toThrow("invoke_ui_action success responses require a usable correlation id");
	});
});

describe("RPC contract emission conformance", () => {
	test("StreamProjector frames validate against the stream frame schemas", () => {
		const projector = new StreamProjector();
		const startValidator = Compile(RpcMessageStartFrameSchema);
		const updateValidator = Compile(RpcMessageUpdateFrameSchema);
		const endValidator = Compile(RpcMessageEndFrameSchema);

		const snapshot = assistant([{ type: "text", text: "" }]);
		const toolState: readonly ActiveToolCallState[] = [];
		const update = (assistantMessageEvent: AssistantMessageEvent) => ({
			type: "message_update",
			message:
				assistantMessageEvent.type === "done" || assistantMessageEvent.type === "error" ? undefined : snapshot,
			assistantMessageEvent,
		});
		const events: object[] = [
			{ type: "message_start", message: snapshot },
			update({ type: "text_start", seq: 1, contentIndex: 0, snapshot, toolState }),
			update({ type: "text_delta", seq: 2, contentIndex: 0, delta: "hel", snapshot, toolState }),
			update({
				type: "text_end",
				seq: 3,
				contentIndex: 0,
				content: "hello",
				snapshot: assistant([{ type: "text", text: "hello" }]),
				toolState,
			}),
			{ type: "message_end", message: assistant([{ type: "text", text: "hello" }]) },
		];

		const frames = events.flatMap((event) => projector.push(event).frames) as Array<{ type?: string }>;
		expect(frames.length).toBeGreaterThanOrEqual(3);
		for (const frame of frames) {
			const validator =
				frame.type === "message_start"
					? startValidator
					: frame.type === "message_update"
						? updateValidator
						: endValidator;
			expect(validator.Errors(frame)).toEqual([]);
		}
	});

	test("projectRpcQueueUpdate output validates against the queue_update schema", () => {
		const projected = projectRpcQueueUpdate({
			type: "queue_update",
			steering: [{ queueEntryId: "local-queue:1", clientMessageId: "m-1", text: "steer this" }],
			followUp: [{ queueEntryId: "local-queue:2", text: "later" }],
		});
		expect(Compile(RpcQueueUpdateEventSchema).Errors(projected)).toEqual([]);
	});

	test("dispatcher-built responses validate against the response schemas", () => {
		const success = createRpcSuccessResponse("id-1", "set_thinking_level", { level: "high" });
		expect(Compile(RPC_RESPONSE_SCHEMAS.set_thinking_level).Errors(success)).toEqual([]);

		const voidSuccess = createRpcSuccessResponse(undefined, "abort");
		expect(Compile(RPC_RESPONSE_SCHEMAS.abort).Errors(voidSuccess)).toEqual([]);

		const failure = createRpcErrorResponse("id-2", "prompt", 'Invalid RPC command payload: "message" is required');
		expect(Compile(RpcErrorResponseSchema).Errors(failure)).toEqual([]);

		const coded = createRpcErrorResponse("id-3", "prompt", "conflict", { code: "client_input_conflict" });
		expect(Compile(RpcErrorResponseSchema).Errors(coded)).toEqual([]);
	});

	test("Git context and full-replacement events enforce path-free field bounds", () => {
		const gitContext: RpcGitContext = {
			repository: "workspace",
			head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
			upstream: { ref: "origin/main", ahead: 2, behind: 1 },
			base: { ref: "main", ahead: 3, behind: 0 },
			status: {
				staged: { added: 1, modified: 2, deleted: 3, renamed: 4 },
				unstaged: { added: 4, modified: 3, deleted: 2, renamed: 1 },
				untracked: 5,
				conflicted: 1,
				total: 12,
				clean: false,
			},
			operation: { kind: "rebase", step: 2, total: 4 },
			revision: 7,
			observedAt: "2026-07-29T00:00:00.000Z",
			stale: false,
		};
		expect(check(RpcGitContextSchema, gitContext)).toBe(true);
		expect(
			check(RpcGitContextChangedEventSchema, {
				type: "git_context_changed",
				gitContext,
				delivery: { subscriptionId: "sub-1", cursor: 8 },
			}),
		).toBe(true);
		expect(check(RpcGitContextChangedEventSchema, { type: "git_context_changed", gitContext: null })).toBe(true);
		expect(check(RpcGitContextSchema, { ...gitContext, repository: "r".repeat(257) })).toBe(false);
		expect(
			check(RpcGitContextSchema, {
				...gitContext,
				head: { kind: "detached", oid: "not-an-object-id" },
			}),
		).toBe(false);
	});

	test("planning events require complete phase-consistent snapshots", () => {
		const execution = {
			id: "execution-1",
			approvedRevision: 2,
			strategy: "retain_context",
			sourceSessionId: "session-1",
			targetSessionId: "session-1",
		};
		const event = {
			type: "planning_state_changed",
			planning: {
				mode: "build",
				plan: {
					id: "plan-1",
					revision: 3,
					phase: "active",
					title: "Ship Plan mode",
					summary: "Implement and verify the native workflow.",
					steps: [{ id: "step-1", text: "Implement", status: "in_progress" }],
					execution,
				},
			},
			delivery: { subscriptionId: "sub-1", cursor: 4 },
		};
		const validator = Compile(RpcPlanningStateChangedEventSchema);
		expect(validator.Errors(event)).toEqual([]);
		expect(
			validator.Check({
				...event,
				planning: {
					...event.planning,
					plan: { ...event.planning.plan, execution: undefined },
				},
			}),
		).toBe(false);
		expect(
			validator.Check({
				...event,
				planning: {
					...event.planning,
					plan: { ...event.planning.plan, phase: "ready" },
				},
			}),
		).toBe(false);
		expect(validator.Check({ ...event, unexpected: true })).toBe(false);
	});

	test("typed event payloads validate against their schemas", () => {
		// Typechecked construction + runtime Check proves the compiled schema
		// accepts exactly what the derived static types describe.
		const bootstrap: RpcConversationBootstrapEvent = {
			type: "conversation_bootstrap",
			delivery: { subscriptionId: "sub-1", cursor: 0 },
			conversation: { workspaceName: "workspace", sessionId: "session-1" },
			state: {
				thinkingLevel: "high",
				availableThinkingLevels: ["off", "high"],
				fastModeEnabled: true,
				planning: { mode: "build", plan: null },
				gitContext: null,
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "session-1",
				autoCompactionEnabled: true,
				messageCount: 2,
				pendingMessageCount: 0,
				steeringQueue: [{ clientMessageId: "m-1", text: "queued" }],
				followUpQueue: [],
			},
			transcript: {
				sessionId: "session-1",
				items: [
					{
						entryId: "entry-1",
						ordinal: 1,
						createdAt: "2026-07-20T00:00:00.000Z",
						role: "assistant",
						text: "hello",
						truncated: false,
						parts: [{ type: "text", text: "hello", truncated: false }],
						stopReason: "stop",
					},
				],
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch: "epoch-1",
				head: { entryId: "entry-1", ordinal: 1 },
			},
			activeAssistant: {
				stream: { epoch: 1, seq: 4 },
				message: assistant([{ type: "text", text: "hello" }]),
				toolState: [],
			},
			activeWorkflows: [],
			reason: "bootstrap",
		};
		expect(Compile(RpcConversationBootstrapEventSchema).Errors(bootstrap)).toEqual([]);

		const transcriptEntry: RpcTranscriptEntryEvent = {
			type: "transcript_entry",
			entry: {
				entryId: "entry-2",
				ordinal: 2,
				createdAt: "2026-07-20T00:00:01.000Z",
				role: "tool",
				text: "",
				truncated: false,
				toolName: "bash",
				status: "completed",
				summary: "ls",
				output: "README.md",
			},
			final: true,
			delivery: { subscriptionId: "sub-1", cursor: 7 },
		};
		expect(Compile(RpcTranscriptEntryEventSchema).Errors(transcriptEntry)).toEqual([]);

		const workflowEvent: RpcWorkflowEvent = {
			type: "workflow_start",
			workflowId: "review:1",
			kind: "review",
			action: "review.branch",
			title: "Reviewing branch",
			status: "running",
		};
		expect(Compile(RpcWorkflowEventSchema).Errors(workflowEvent)).toEqual([]);

		const hostActionRequest: RpcHostActionRequest = {
			type: "host_action_request",
			id: "action-1",
			action: "session.new",
			title: "Start a new session?",
			blocking: true,
			metadata: { source: "test", attempts: 1, urgent: false, note: null },
		};
		expect(Compile(RpcHostActionRequestSchema).Errors(hostActionRequest)).toEqual([]);

		const hostActionUpdate: RpcHostActionUpdate = {
			type: "host_action_update",
			id: "action-1",
			action: "session.new",
			status: "completed",
			exitCode: null,
		};
		expect(Compile(RpcHostActionUpdateSchema).Errors(hostActionUpdate)).toEqual([]);

		const extensionRequest: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "ui-1",
			method: "select",
			title: "Pick one",
			options: ["a", "b"],
			timeout: 5000,
		};
		expect(Compile(RpcExtensionUIRequestSchema).Errors(extensionRequest)).toEqual([]);

		expect(Compile(RpcModelsChangedEventSchema).Errors({ type: "models_changed" })).toEqual([]);

		const descriptor: UiActionDescriptor = {
			schemaVersion: 1,
			id: "review.branch",
			label: "Review branch",
			source: "builtin",
			category: "review",
			enabled: true,
			remoteSafe: true,
			streamingBehavior: ["queueSteer", "queueFollowUp"],
			state: { type: "boolean", value: true },
		};
		expect(Compile(UiActionDescriptorSchema).Errors(descriptor)).toEqual([]);
	});
});
