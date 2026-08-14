import type {
	AgentDelivery,
	AgentDeliveryPreparation,
	AgentHarness,
	AgentHarnessNextActionPolicy,
	AgentMessage,
	StreamFn,
	ToolCallEvent,
	ToolCallResult,
	ToolResultEvent,
	ToolResultPatch,
} from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonObject, JsonValue, Model, TextContent } from "@hansjm10/volt-ai";
import type { AgentSession } from "../src/core/agent-session.ts";

type HarnessTestInternals = {
	streamFn: StreamFn;
	emitContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
	emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined>;
	emitToolResult(
		event: ToolResultEvent,
	): Promise<
		Required<Pick<ToolResultEvent, "content" | "isError">> &
			Pick<ToolResultEvent, "details"> & { disposition?: "stop" | "final_response" }
	>;
};

type SessionTestInternals = {
	_streamFn: StreamFn;
	_upstreamPrepareDelivery: (
		delivery: AgentDelivery,
		signal: AbortSignal,
	) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation;
	_upstreamDeliveryRevoked: ((delivery: AgentDelivery) => void) | undefined;
};

function getHarness(session: AgentSession): AgentHarness {
	return (session as unknown as { _harness: AgentHarness })._harness;
}

function getHarnessInternals(session: AgentSession): HarnessTestInternals {
	return getHarness(session) as unknown as HarnessTestInternals;
}

function getSessionInternals(session: AgentSession): SessionTestInternals {
	return session as unknown as SessionTestInternals;
}

/** Centralized test-only controls for faults and bounded Harness operations. */
export function createAgentSessionTestControl(session: AgentSession) {
	const harness = getHarness(session);
	const harnessInternals = getHarnessInternals(session);
	const sessionInternals = getSessionInternals(session);
	return {
		run: (input: AgentMessage | readonly AgentMessage[]) => harness.run(input),
		continue: (options?: { drainFollowUps?: boolean; context?: readonly AgentMessage[] }) =>
			harness.continue(options),
		queueSteer: (message: AgentMessage) => harness.queueSteer(message),
		queueFollowUp: (message: AgentMessage) => harness.queueFollowUp(message),
		failNextQueue: (kind: "steer" | "followUp", error: Error) => {
			if (kind === "steer") {
				const original = harness.queueSteer.bind(harness);
				harness.queueSteer = (_message) => {
					harness.queueSteer = original;
					throw error;
				};
				return;
			}
			const original = harness.queueFollowUp.bind(harness);
			harness.queueFollowUp = (_message) => {
				harness.queueFollowUp = original;
				throw error;
			};
		},
		hasQueuedMessages: () => harness.hasQueuedMessages(),
		hasPendingPrompt: () => harness.hasPendingPrompt(),
		clearSteeringQueue: () => harness.clearSteeringQueue(),
		clearFollowUpQueue: () => harness.clearFollowUpQueue(),
		discardPendingPrompt: () => harness.discardPendingPrompt(),
		getStreamFn: () => sessionInternals._streamFn,
		setStreamFn: (streamFn: StreamFn) => {
			sessionInternals._streamFn = streamFn;
			harnessInternals.streamFn = streamFn;
		},
		setPrepareDelivery: (
			prepareDelivery: (
				delivery: AgentDelivery,
				signal: AbortSignal,
			) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation,
		) => {
			sessionInternals._upstreamPrepareDelivery = prepareDelivery;
		},
		getDeliveryRevoked: () => sessionInternals._upstreamDeliveryRevoked,
		setDeliveryRevoked: (deliveryRevoked: ((delivery: AgentDelivery) => void) | undefined) => {
			sessionInternals._upstreamDeliveryRevoked = deliveryRevoked;
		},
		onToolCall: (
			handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined> | ToolCallResult | undefined,
		) => harness.on("tool_call", handler),
		onToolResult: (
			handler: (event: ToolResultEvent) => Promise<ToolResultPatch | undefined> | ToolResultPatch | undefined,
		) => harness.on("tool_result", handler),
		registerNextActionPolicy: (policy: AgentHarnessNextActionPolicy) => harness.registerNextActionPolicy(policy),
		transformContext: (messages: AgentMessage[]) => harnessInternals.emitContext(messages),
		evaluateToolCall: async (event: ToolCallEvent) => {
			const result = await harnessInternals.emitToolCall(event);
			return result?.block === undefined && result?.reason === undefined ? undefined : result;
		},
		evaluateToolCallRequest: async (input: { toolCall: { id: string; name: string }; args: JsonObject }) => {
			const result = await harnessInternals.emitToolCall({
				type: "tool_call",
				toolCallId: input.toolCall.id,
				toolName: input.toolCall.name,
				input: input.args,
			});
			return result?.block === undefined && result?.reason === undefined ? undefined : result;
		},
		evaluateToolResult: (event: ToolResultEvent) => harnessInternals.emitToolResult(event),
		evaluateToolResultRequest: (input: {
			toolCall: { id: string; name: string };
			args: JsonObject;
			result: { content: Array<TextContent | ImageContent>; details?: JsonValue };
			isError: boolean;
		}) =>
			harnessInternals.emitToolResult({
				type: "tool_result",
				toolCallId: input.toolCall.id,
				toolName: input.toolCall.name,
				input: input.args,
				content: input.result.content,
				...(input.result.details === undefined ? {} : { details: input.result.details }),
				isError: input.isError,
			}),

		setModel: (model: Model<any> | undefined) => harness.setModel(model, { persist: false }),
		setThinkingLevel: (level: Parameters<AgentHarness["setThinkingLevel"]>[0]) =>
			harness.setThinkingLevel(level, { persist: false }),
		getStreamOptions: () => harness.getStreamOptions(),
		getInferenceSpeed: () => harness.getStreamOptions().inferenceSpeed,
		getActiveTools: () => harness.getActiveTools(),
	};
}
