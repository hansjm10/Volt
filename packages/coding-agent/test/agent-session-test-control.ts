import type {
	AgentDelivery,
	AgentDeliveryCommitContext,
	AgentDeliveryOwner,
	AgentDeliveryPreparationContext,
	AgentHarness,
	AgentHarnessNextActionPolicy,
	AgentMessage,
	AgentTool,
	StreamFn,
	ToolCallEvent,
	ToolCallResult,
	ToolResultEvent,
	ToolResultPatch,
} from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonObject, JsonValue, Model, TextContent } from "@hansjm10/volt-ai";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { SessionManagerHarnessStorage } from "../src/core/harness-session-adapter.ts";

export type LegacyDeliveryParticipantOutcome =
	| { outcome: "committed" }
	| { outcome: "retained"; error: Error }
	| { outcome: "terminally_failed"; error: Error };

export interface LegacyDeliveryPreparation {
	messages: readonly AgentMessage[];
	participant?: {
		settle(context: {
			messages: readonly AgentMessage[];
			systemPrompt: string;
			tools: readonly AgentTool[];
			signal: AbortSignal;
			requestAbort: AgentDeliveryCommitContext["requestAbort"];
			requestClose: AgentDeliveryCommitContext["requestClose"];
		}): LegacyDeliveryParticipantOutcome | Promise<LegacyDeliveryParticipantOutcome>;
	};
}

export type LegacyPrepareDelivery = (
	delivery: AgentDelivery,
	signal: AbortSignal,
) => LegacyDeliveryPreparation | Promise<LegacyDeliveryPreparation>;

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
	_streamOptions: ReturnType<AgentHarness["getStreamOptions"]>;
	_deliveryOwner: AgentDeliveryOwner;
	_harnessSessionStorage: SessionManagerHarnessStorage;
	_legacyDeliveryRevoked?: (delivery: AgentDelivery) => void;
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
	const baseOwner = sessionInternals._deliveryOwner;
	const basePrepare = baseOwner.prepareLogical.bind(baseOwner);
	const baseCommit = baseOwner.commitAttempt.bind(baseOwner);
	const baseFinish = baseOwner.finish.bind(baseOwner);
	const legacyPreparations = new Map<string, LegacyDeliveryPreparation>();
	const deliveries = new Map<string, AgentDelivery>();
	let prepareDelivery: LegacyPrepareDelivery | undefined;
	baseOwner.prepareLogical = async (context: AgentDeliveryPreparationContext) => {
		const delivery: AgentDelivery = {
			deliveryId: context.deliveryId,
			kind: context.kind,
			messages: structuredClone(context.sourceMessages),
			epoch: context.epoch,
		};
		deliveries.set(context.deliveryId, delivery);
		if (!prepareDelivery) return await basePrepare(context);
		const legacy = await prepareDelivery(delivery, context.signal);
		legacyPreparations.set(context.deliveryId, {
			...legacy,
			messages: structuredClone(legacy.messages),
		});
		return await basePrepare({ ...context, sourceMessages: structuredClone(legacy.messages) });
	};
	baseOwner.commitAttempt = async (context) => {
		const legacy = legacyPreparations.get(context.deliveryId);
		const outcome = await legacy?.participant?.settle({
			messages: structuredClone(context.preparedMessages),
			systemPrompt: session.systemPrompt,
			tools: session.state.tools,
			signal: context.signal,
			requestAbort: context.requestAbort,
			requestClose: context.requestClose,
		});
		if (outcome?.outcome === "retained") {
			return {
				...outcome,
				noEffectReceipt: await sessionInternals._harnessSessionStorage.retainOwnedDelivery(
					context,
					context.preparedMessages,
				),
			};
		}
		if (outcome?.outcome === "terminally_failed") return outcome;
		return await baseCommit(context);
	};
	baseOwner.finish = async (context) => {
		await baseFinish(context);
		if (context.outcome === "revoked") {
			const delivery = deliveries.get(context.deliveryId);
			if (delivery) sessionInternals._legacyDeliveryRevoked?.(delivery);
		}
		if (context.outcome !== "retained") {
			legacyPreparations.delete(context.deliveryId);
			deliveries.delete(context.deliveryId);
		}
	};
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
		setPrepareDelivery: (nextPrepareDelivery: LegacyPrepareDelivery) => {
			prepareDelivery = nextPrepareDelivery;
		},
		getDeliveryRevoked: () => sessionInternals._legacyDeliveryRevoked,
		setDeliveryRevoked: (deliveryRevoked: ((delivery: AgentDelivery) => void) | undefined) => {
			sessionInternals._legacyDeliveryRevoked = deliveryRevoked;
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
		getStreamOptions: () => structuredClone(sessionInternals._streamOptions),
		getInferenceSpeed: () => sessionInternals._streamOptions.inferenceSpeed,
		getActiveTools: () => harness.getActiveTools(),
	};
}
