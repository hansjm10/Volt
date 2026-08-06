import {
	type ActiveToolCallState,
	type AssistantMessage,
	type AssistantMessageEvent,
	type JsonObject,
	parseStreamingJson,
	type ToolCall,
} from "@hansjm10/volt-ai";
import type { AgentSessionQueuedMessage } from "../agent-session.ts";
import {
	assertConversationProjectionAssistantSnapshotWithinLimits,
	assertConversationProjectionAssistantToolStateWithinLimits,
	assertConversationProjectionCumulativeContentWithinLimits,
	assertConversationProjectionToolArgumentWithinLimits,
	assertConversationProjectionToolCallWithinLimits,
	type ConversationProjectionAssistantSnapshotMetrics,
	ConversationProjectionLimitError,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
	measureConversationProjectionUtf8BytesWithin,
} from "./conversation-projection-limits.ts";
import { projectRpcQueueUpdate } from "./session-state.ts";

export type ProjectionPhase = "idle" | "needs_snapshot" | "synchronized" | "desynchronized" | "terminal";

export interface ProjectionState {
	phase: ProjectionPhase;
	epoch: number;
	lastSeq: number;
	/** Per-content-index accumulation already emitted on this boundary. */
	emitted: ReadonlyMap<number, string>;
	/** Open tool calls whose raw argument text cannot cross this boundary. */
	replaceOnly: ReadonlySet<number>;
}

export interface StreamPos {
	epoch: number;
	seq: number;
}

type StreamUpdateEvent = Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>;
type SlimEvent<Event> = Event extends StreamUpdateEvent ? Omit<Event, "seq" | "snapshot" | "toolState"> : never;
export type SlimAssistantEvent = SlimEvent<StreamUpdateEvent>;

export interface ProjectedMessageStartFrame {
	type: "message_start";
	stream: StreamPos;
	message: AssistantMessage;
}

export interface ProjectedMessageUpdateFrame {
	type: "message_update";
	stream: StreamPos;
	assistantMessageEvent: SlimAssistantEvent;
	message?: AssistantMessage;
	toolState?: readonly ActiveToolCallState[];
}

export interface ProjectedMessageEndFrame {
	type: "message_end";
	stream: StreamPos;
	message: AssistantMessage;
}

export type WireFrame = ProjectedMessageStartFrame | ProjectedMessageUpdateFrame | ProjectedMessageEndFrame;

export type ProjectionInput =
	| { kind: "message_start"; message: AssistantMessage }
	| { kind: "event"; event: AssistantMessageEvent }
	| { kind: "message_end"; message: AssistantMessage }
	| { kind: "discontinuity" }
	| { kind: "run_end" }
	| { kind: "stream_end" };

export interface ProjectionDiagnostic {
	code: string;
	message: string;
	phase: ProjectionPhase;
	contentIndex?: number;
	expectedSeq?: number;
	receivedSeq?: number;
}

/** Field-aware sanitizer used by privacy-boundary projectors. */
export interface ProjectionSanitizer {
	sanitizeText(value: string): string;
	sanitizeValue(value: unknown): unknown;
}

export interface ProjectionConfig {
	sanitizer?: ProjectionSanitizer;
}

export interface ProjectionResult {
	state: ProjectionState;
	frames: readonly WireFrame[];
	diagnostics: readonly ProjectionDiagnostic[];
}

export interface ProjectionBatch {
	frames: readonly object[];
	diagnostics: readonly ProjectionDiagnostic[];
}

export function createProjectionState(phase: "idle" | "needs_snapshot" = "needs_snapshot"): ProjectionState {
	return freezeProjectionState({ phase, epoch: 0, lastSeq: -1, emitted: new Map(), replaceOnly: new Set() });
}

/** Pure producer transition. */
export function project(
	state: ProjectionState,
	input: ProjectionInput,
	config: ProjectionConfig = {},
): ProjectionResult {
	if (state.phase === "terminal") {
		return {
			state,
			frames: [],
			diagnostics: [diagnostic(state, "input_after_stream_end", "Dropped input after stream teardown")],
		};
	}

	switch (input.kind) {
		case "run_end":
			return {
				state: freezeProjectionState({
					phase: "idle",
					epoch: state.epoch,
					lastSeq: -1,
					emitted: new Map(),
					replaceOnly: new Set(),
				}),
				frames: [],
				diagnostics: [],
			};
		case "stream_end":
			return {
				state: freezeProjectionState({
					phase: "terminal",
					epoch: state.epoch,
					lastSeq: -1,
					emitted: new Map(),
					replaceOnly: new Set(),
				}),
				frames: [],
				diagnostics: [],
			};
		case "discontinuity":
			if (state.phase === "idle" || state.phase === "needs_snapshot") {
				return { state, frames: [], diagnostics: [] };
			}
			return {
				state: freezeProjectionState({
					phase: "needs_snapshot",
					epoch: state.epoch,
					lastSeq: -1,
					emitted: new Map(),
					replaceOnly: new Set(),
				}),
				frames: [],
				diagnostics: [],
			};
		case "message_start":
			return projectMessageStart(state, input.message, config);
		case "message_end":
			return projectMessageEnd(state, input.message, config);
		case "event":
			return projectEvent(state, input.event, config);
	}
}

function projectMessageStart(
	state: ProjectionState,
	message: AssistantMessage,
	config: ProjectionConfig,
): ProjectionResult {
	const snapshot = prepareProjectionSnapshot(message, config);
	const seeded = seedProjection(message, [], config);
	const epoch = state.epoch + 1;
	const nextState = freezeProjectionState({
		phase: seeded.replaceOnly.size === 0 ? "synchronized" : "desynchronized",
		epoch,
		lastSeq: 0,
		emitted: seeded.emitted,
		replaceOnly: seeded.replaceOnly,
	});
	const diagnostics =
		state.phase === "synchronized" || state.phase === "desynchronized"
			? [diagnostic(state, "duplicate_message_start", "Treated message_start as an implicit prior message end")]
			: [];
	return {
		state: nextState,
		frames: [
			Object.freeze({
				type: "message_start",
				stream: Object.freeze({ epoch, seq: 0 }),
				message: snapshot,
			}) as ProjectedMessageStartFrame,
		],
		diagnostics,
	};
}

function projectMessageEnd(
	state: ProjectionState,
	message: AssistantMessage,
	config: ProjectionConfig,
): ProjectionResult {
	const snapshot = prepareProjectionSnapshot(message, config);
	const pos = Object.freeze({ epoch: state.epoch, seq: Math.max(state.lastSeq, 0) });
	return {
		state: freezeProjectionState({
			phase: "idle",
			epoch: state.epoch,
			lastSeq: -1,
			emitted: new Map(),
			replaceOnly: new Set(),
		}),
		frames: [
			Object.freeze({
				type: "message_end",
				stream: pos,
				message: snapshot,
			}) as ProjectedMessageEndFrame,
		],
		diagnostics: [],
	};
}

function projectEvent(
	state: ProjectionState,
	event: AssistantMessageEvent,
	config: ProjectionConfig,
): ProjectionResult {
	if (event.type === "start" || event.type === "done" || event.type === "error") {
		return {
			state,
			frames: [],
			diagnostics: [diagnostic(state, "non_update_event", `Dropped ${event.type} on message_update input`)],
		};
	}
	assertAssistantEventWithinLimits(event);

	if (state.phase === "idle" || state.phase === "needs_snapshot") {
		return emitSnapshot(state, event, config, []);
	}

	const expectedSeq = state.lastSeq + 1;
	if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq !== expectedSeq) {
		return emitSnapshot(state, event, config, [
			diagnostic(state, "sequence_gap", "Recovered a normalizer sequence gap with a snapshot", {
				expectedSeq,
				receivedSeq: event.seq,
			}),
		]);
	}

	const contentIndex = event.contentIndex;
	if (state.replaceOnly.has(contentIndex) && event.type !== "toolcall_end") {
		return emitSnapshot(state, event, config, []);
	}

	return projectIncrementalEvent(state, event, config);
}

function projectIncrementalEvent(
	state: ProjectionState,
	event: StreamUpdateEvent,
	config: ProjectionConfig,
): ProjectionResult {
	const emitted = new Map(state.emitted);
	const replaceOnly = new Set(state.replaceOnly);
	const contentIndex = event.contentIndex;
	const snapshotFallback = (code: string, message: string) =>
		emitSnapshot(state, event, config, [diagnostic(state, code, message, { contentIndex })]);

	switch (event.type) {
		case "text_start":
		case "thinking_start": {
			const accumulated = getBlockText(
				event.snapshot,
				contentIndex,
				event.type === "text_start" ? "text" : "thinking",
			);
			if (accumulated === undefined || accumulated !== "") {
				return snapshotFallback("non_empty_block_start", "Block start was not representable as an empty delta");
			}
			emitted.set(contentIndex, "");
			return emitDelta(state, event, config, emitted, replaceOnly);
		}
		case "text_delta":
		case "thinking_delta": {
			const kind = event.type === "text_delta" ? "text" : "thinking";
			const rawAccumulated = getBlockText(event.snapshot, contentIndex, kind);
			const previous = emitted.get(contentIndex);
			if (rawAccumulated === undefined || previous === undefined) {
				return snapshotFallback("missing_accumulator", "Delta arrived without an emitted block accumulator");
			}
			const accumulated = config.sanitizer ? config.sanitizer.sanitizeText(rawAccumulated) : rawAccumulated;
			if (!accumulated.startsWith(previous)) {
				return emitSnapshot(state, event, config, []);
			}
			if (
				!config.sanitizer &&
				(accumulated.length !== previous.length + event.delta.length || !accumulated.endsWith(event.delta))
			) {
				return emitSnapshot(state, event, config, []);
			}
			emitted.set(contentIndex, accumulated);
			return emitDelta(state, event, config, emitted, replaceOnly, { delta: accumulated.slice(previous.length) });
		}
		case "text_end":
		case "thinking_end": {
			const kind = event.type === "text_end" ? "text" : "thinking";
			const rawAccumulated = getBlockText(event.snapshot, contentIndex, kind);
			const previous = emitted.get(contentIndex);
			if (rawAccumulated === undefined || previous === undefined) {
				return snapshotFallback("missing_accumulator", "Block end arrived without an emitted accumulator");
			}
			const accumulated = config.sanitizer ? config.sanitizer.sanitizeText(rawAccumulated) : rawAccumulated;
			if (!accumulated.startsWith(previous)) {
				return emitSnapshot(state, event, config, []);
			}
			emitted.set(contentIndex, accumulated);
			return emitDelta(state, event, config, emitted, replaceOnly, { content: accumulated });
		}
		case "toolcall_start": {
			const toolState = event.toolState.find((entry) => entry.contentIndex === contentIndex);
			if (!toolState || toolState.argsText !== "") {
				return snapshotFallback(
					"non_empty_tool_start",
					"Tool start did not have an empty raw argument accumulator",
				);
			}
			emitted.set(contentIndex, "");
			return emitDelta(state, event, config, emitted, replaceOnly);
		}
		case "toolcall_delta": {
			const toolState = event.toolState.find((entry) => entry.contentIndex === contentIndex);
			const previous = emitted.get(contentIndex);
			if (!toolState || previous === undefined) {
				return snapshotFallback("missing_tool_accumulator", "Tool delta arrived without resumable raw state");
			}
			if (!isToolStateShippable(event.snapshot, toolState, config)) {
				return emitSnapshot(state, event, config, []);
			}
			if (
				toolState.argsText.length !== previous.length + event.argsTextDelta.length ||
				!toolState.argsText.startsWith(previous) ||
				!toolState.argsText.endsWith(event.argsTextDelta)
			) {
				return emitSnapshot(state, event, config, []);
			}
			emitted.set(contentIndex, toolState.argsText);
			return emitDelta(state, event, config, emitted, replaceOnly, {
				argsTextDelta: toolState.argsText.slice(previous.length),
			});
		}
		case "toolcall_end":
			emitted.delete(contentIndex);
			replaceOnly.delete(contentIndex);
			return emitDelta(state, event, config, emitted, replaceOnly);
	}
}

function emitDelta(
	state: ProjectionState,
	event: StreamUpdateEvent,
	config: ProjectionConfig,
	emitted: Map<number, string>,
	replaceOnly: Set<number>,
	overrides: Record<string, unknown> = {},
): ProjectionResult {
	const slimEvent = sanitizeSlimEvent(event, config, overrides);
	return {
		state: freezeProjectionState({
			phase: replaceOnly.size === 0 ? "synchronized" : "desynchronized",
			epoch: state.epoch,
			lastSeq: event.seq,
			emitted,
			replaceOnly,
		}),
		frames: [
			Object.freeze({
				type: "message_update",
				stream: Object.freeze({ epoch: state.epoch, seq: event.seq }),
				assistantMessageEvent: slimEvent,
			}) as ProjectedMessageUpdateFrame,
		],
		diagnostics: [],
	};
}

function emitSnapshot(
	state: ProjectionState,
	event: StreamUpdateEvent,
	config: ProjectionConfig,
	diagnostics: readonly ProjectionDiagnostic[],
): ProjectionResult {
	const snapshot = prepareProjectionSnapshot(event.snapshot, config);
	const seeded = seedProjection(event.snapshot, event.toolState, config);
	const epoch = state.epoch + 1;
	const frame: ProjectedMessageUpdateFrame = {
		type: "message_update",
		stream: Object.freeze({ epoch, seq: event.seq }),
		assistantMessageEvent: sanitizeSlimEvent(event, config),
		message: snapshot,
		...(seeded.shippableToolState.length === 0 ? {} : { toolState: seeded.shippableToolState }),
	};
	return {
		state: freezeProjectionState({
			phase: seeded.replaceOnly.size === 0 ? "synchronized" : "desynchronized",
			epoch,
			lastSeq: event.seq,
			emitted: seeded.emitted,
			replaceOnly: seeded.replaceOnly,
		}),
		frames: [Object.freeze(frame)],
		diagnostics,
	};
}

interface SeededProjection {
	emitted: Map<number, string>;
	replaceOnly: Set<number>;
	shippableToolState: readonly ActiveToolCallState[];
}

function prepareProjectionSnapshot(message: AssistantMessage, config: ProjectionConfig): AssistantMessage {
	const snapshot = sanitizeSnapshot(message, config);
	assertConversationProjectionAssistantSnapshotWithinLimits(snapshot);
	return snapshot;
}

function assertAssistantEventPayloadWithinLimits(event: Record<string, unknown>): void {
	const contentIndex =
		typeof event.contentIndex === "number" && Number.isSafeInteger(event.contentIndex) ? event.contentIndex : 0;
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
			if (
				typeof event.delta === "string" &&
				measureConversationProjectionUtf8BytesWithin(
					event.delta,
					DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
				) === null
			) {
				throw new ConversationProjectionLimitError(
					"assistant_cumulative_content_bytes",
					`Assistant projection delta exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte content limit`,
				);
			}
			return;
		case "text_end":
		case "thinking_end":
			if (
				typeof event.content === "string" &&
				measureConversationProjectionUtf8BytesWithin(
					event.content,
					DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
				) === null
			) {
				throw new ConversationProjectionLimitError(
					"assistant_cumulative_content_bytes",
					`Assistant projection block end exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte content limit`,
				);
			}
			return;
		case "toolcall_delta":
			if (typeof event.argsTextDelta === "string") {
				assertConversationProjectionToolArgumentWithinLimits(event.argsTextDelta, contentIndex);
			}
			return;
		case "toolcall_end":
			if (event.toolCall !== undefined) {
				assertConversationProjectionToolCallWithinLimits(event.toolCall, contentIndex);
			}
			return;
	}
}

function assertAssistantEventWithinLimits(event: StreamUpdateEvent): void {
	const metrics = assertConversationProjectionAssistantSnapshotWithinLimits(event.snapshot, {
		enforceSerializedSnapshot: false,
	});
	assertConversationProjectionAssistantToolStateWithinLimits(event.snapshot, event.toolState, metrics);
	assertAssistantEventPayloadWithinLimits(event as unknown as Record<string, unknown>);
}

/** Validate cached source truth even when no subscriber projector exists yet. */
export function assertConversationProjectionSourceAssistantEventWithinLimits(event: object): void {
	if (!isRecord(event)) return;
	if ((event.type === "message_start" || event.type === "message_end") && isAssistantMessage(event.message)) {
		assertConversationProjectionAssistantSnapshotWithinLimits(event.message, { enforceSerializedSnapshot: false });
		return;
	}
	if (
		event.type === "message_update" &&
		isAssistantMessage(event.message) &&
		isAssistantMessageEvent(event.assistantMessageEvent) &&
		event.assistantMessageEvent.type !== "start" &&
		event.assistantMessageEvent.type !== "done" &&
		event.assistantMessageEvent.type !== "error"
	) {
		assertConversationProjectionAssistantSnapshotWithinLimits(event.message, { enforceSerializedSnapshot: false });
		assertAssistantEventWithinLimits(event.assistantMessageEvent);
	}
}

function seedProjection(
	message: AssistantMessage,
	toolState: readonly ActiveToolCallState[],
	config: ProjectionConfig,
): SeededProjection {
	const metrics = assertConversationProjectionAssistantSnapshotWithinLimits(message, {
		enforceSerializedSnapshot: false,
	});
	assertConversationProjectionAssistantToolStateWithinLimits(message, toolState, metrics);
	const emitted = new Map<number, string>();
	const replaceOnly = new Set<number>();
	for (const [index, block] of message.content.entries()) {
		if (block.type === "text") {
			emitted.set(index, config.sanitizer ? config.sanitizer.sanitizeText(block.text) : block.text);
		} else if (block.type === "thinking") {
			emitted.set(index, config.sanitizer ? config.sanitizer.sanitizeText(block.thinking) : block.thinking);
		}
	}

	const shippableToolState: ActiveToolCallState[] = [];
	for (const entry of toolState) {
		if (isToolStateShippable(message, entry, config)) {
			emitted.set(entry.contentIndex, entry.argsText);
			shippableToolState.push(Object.freeze({ contentIndex: entry.contentIndex, argsText: entry.argsText }));
		} else {
			replaceOnly.add(entry.contentIndex);
		}
	}
	return {
		emitted,
		replaceOnly,
		shippableToolState: Object.freeze(shippableToolState),
	};
}

function isToolStateShippable(
	message: AssistantMessage,
	toolState: ActiveToolCallState,
	config: ProjectionConfig,
): boolean {
	if (!Number.isSafeInteger(toolState.contentIndex) || toolState.contentIndex < 0) {
		return false;
	}
	const block = message.content[toolState.contentIndex];
	if (block?.type !== "toolCall") {
		return false;
	}
	if (!config.sanitizer) {
		return true;
	}
	return (
		config.sanitizer.sanitizeText(toolState.argsText) === toolState.argsText &&
		jsonValueEquals(block.arguments, config.sanitizer.sanitizeValue(block.arguments))
	);
}

function sanitizeSnapshot(message: AssistantMessage, config: ProjectionConfig): AssistantMessage {
	if (!config.sanitizer) {
		return message;
	}
	return cloneAndFreeze(config.sanitizer.sanitizeValue(message)) as AssistantMessage;
}

function sanitizeSlimEvent(
	event: StreamUpdateEvent,
	config: ProjectionConfig,
	overrides: Record<string, unknown> = {},
): SlimAssistantEvent {
	const record = event as unknown as Record<string, unknown>;
	const { seq: _seq, snapshot: _snapshot, toolState: _toolState, ...rawSlimEvent } = record;
	const sanitized = config.sanitizer ? config.sanitizer.sanitizeValue(rawSlimEvent) : rawSlimEvent;
	const sanitizedRecord = isRecord(sanitized) ? sanitized : rawSlimEvent;
	const slimEvent = { ...sanitizedRecord, ...overrides };
	assertAssistantEventPayloadWithinLimits(slimEvent);
	return Object.freeze(slimEvent) as SlimAssistantEvent;
}

function getBlockText(message: AssistantMessage, contentIndex: number, kind: "text" | "thinking"): string | undefined {
	if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
		return undefined;
	}
	const block = message.content[contentIndex];
	if (kind === "text") {
		return block?.type === "text" ? block.text : undefined;
	}
	return block?.type === "thinking" ? block.thinking : undefined;
}

function freezeProjectionState(state: ProjectionState): ProjectionState {
	return Object.freeze({
		...state,
		emitted: new Map(state.emitted),
		replaceOnly: new Set(state.replaceOnly),
	});
}

function diagnostic(
	state: ProjectionState,
	code: string,
	message: string,
	details: Pick<ProjectionDiagnostic, "contentIndex" | "expectedSeq" | "receivedSeq"> = {},
): ProjectionDiagnostic {
	return Object.freeze({ code, message, phase: state.phase, ...details });
}

/** Stateful session-event adapter around the pure producer transition. */
export class StreamProjector {
	private projectionState: ProjectionState;
	private readonly config: ProjectionConfig;

	constructor(config: ProjectionConfig = {}, initialPhase: "idle" | "needs_snapshot" = "needs_snapshot") {
		this.config = config;
		this.projectionState = createProjectionState(initialPhase);
	}

	get state(): ProjectionState {
		return this.projectionState;
	}

	push(event: object): ProjectionBatch {
		if (!isRecord(event)) {
			return { frames: [event], diagnostics: [] };
		}

		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
			const reset = this.transition({ kind: "run_end" });
			return { frames: [event], diagnostics: reset.diagnostics };
		}

		if (event.type === "queue_update" && Array.isArray(event.steering) && Array.isArray(event.followUp)) {
			return {
				frames: [
					projectRpcQueueUpdate({
						type: "queue_update",
						steering: event.steering as AgentSessionQueuedMessage[],
						followUp: event.followUp as AgentSessionQueuedMessage[],
					}),
				],
				diagnostics: [],
			};
		}

		if (event.type === "message_start" && isAssistantMessage(event.message)) {
			return this.transition({ kind: "message_start", message: event.message });
		}
		if (event.type === "message_end" && isAssistantMessage(event.message)) {
			return this.transition({ kind: "message_end", message: event.message });
		}
		if (
			event.type === "message_update" &&
			isAssistantMessage(event.message) &&
			isAssistantMessageEvent(event.assistantMessageEvent)
		) {
			return this.transition({ kind: "event", event: event.assistantMessageEvent });
		}

		return { frames: [event], diagnostics: [] };
	}

	discontinuity(): ProjectionBatch {
		return this.transition({ kind: "discontinuity" });
	}

	endRun(): ProjectionBatch {
		return this.transition({ kind: "run_end" });
	}

	endStream(): ProjectionBatch {
		return this.transition({ kind: "stream_end" });
	}

	private transition(input: ProjectionInput): ProjectionBatch {
		const result = project(this.projectionState, input, this.config);
		this.projectionState = result.state;
		return { frames: result.frames, diagnostics: result.diagnostics };
	}
}

type DecoderPhase = "idle" | "synchronized" | "desynchronized";

interface DecoderStreamState {
	phase: DecoderPhase;
	epoch: number;
	lastSeq: number;
	message?: AssistantMessage;
	argsText: Map<number, string>;
	contentBytes: number[];
	cumulativeContentBytes: number;
}

export interface StreamProjectionDecoderOptions {
	onDiagnostic?: (diagnostic: ProjectionDiagnostic) => void;
}

const SESSION_STREAM_KEY = "session";
const MAX_CONTENT_INDEX = DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS - 1;

/** Mirrored client projection. Malformed delta frames diagnose and drop. */
export class StreamProjectionDecoder {
	private readonly streams = new Map<string, DecoderStreamState>();
	private readonly onDiagnostic: ((diagnostic: ProjectionDiagnostic) => void) | undefined;

	constructor(options: StreamProjectionDecoderOptions = {}) {
		this.onDiagnostic = options.onDiagnostic;
	}

	decode(value: unknown): unknown | undefined {
		if (!isRecord(value)) {
			return value;
		}
		if (value.type === "subagent_event" && typeof value.subagentId === "string" && isRecord(value.event)) {
			const decoded = this.decodeSessionEvent(value.event, `subagent:${value.subagentId}`);
			return decoded === undefined ? undefined : decoded === value.event ? value : { ...value, event: decoded };
		}
		if (
			(value.type === "subagent_end" || value.type === "subagent_disposed") &&
			typeof value.subagentId === "string"
		) {
			this.streams.delete(`subagent:${value.subagentId}`);
			return value;
		}
		return this.decodeSessionEvent(value, SESSION_STREAM_KEY);
	}

	dispose(): void {
		this.streams.clear();
	}

	private decodeSessionEvent(event: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
			this.streams.set(key, createDecoderState());
			return event;
		}
		if (event.type === "message_start" && isAssistantMessage(event.message) && isStreamPos(event.stream)) {
			const metrics = getAssistantSnapshotMetrics(event.message);
			if (!metrics) {
				this.desynchronize(
					key,
					this.streams.get(key) ?? createDecoderState(),
					"assistant_projection_limit",
					"Dropped an oversized assistant snapshot",
				);
				return undefined;
			}
			const message = cloneAndFreeze(event.message);
			this.streams.set(key, {
				phase: "synchronized",
				epoch: event.stream.epoch,
				lastSeq: event.stream.seq,
				message,
				argsText: new Map(),
				contentBytes: [...metrics.contentBytes],
				cumulativeContentBytes: metrics.cumulativeContentBytes,
			});
			return { ...event, message };
		}
		if (event.type === "message_end" && isAssistantMessage(event.message) && isRecord(event.stream)) {
			if (!getAssistantSnapshotMetrics(event.message)) {
				this.desynchronize(
					key,
					this.streams.get(key) ?? createDecoderState(),
					"assistant_projection_limit",
					"Dropped an oversized final assistant snapshot",
				);
				return undefined;
			}
			const message = cloneAndFreeze(event.message);
			this.streams.set(key, createDecoderState());
			return { ...event, message };
		}
		if (event.type !== "message_update" || !isRecord(event.stream) || !isRecord(event.assistantMessageEvent)) {
			return event;
		}

		if (isAssistantMessage(event.message)) {
			return this.adoptSnapshot(event, key);
		}
		return this.applyDelta(event, key);
	}

	private adoptSnapshot(event: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
		const sourceMessage = event.message as AssistantMessage;
		const metrics = getAssistantSnapshotMetrics(sourceMessage);
		if (!metrics) {
			this.desynchronize(
				key,
				this.streams.get(key) ?? createDecoderState(),
				"assistant_projection_limit",
				"Dropped an oversized assistant recovery snapshot",
			);
			return undefined;
		}
		const seeded = seedDecoderToolState(sourceMessage, event.toolState, metrics);
		if (!seeded) {
			this.desynchronize(
				key,
				this.streams.get(key) ?? createDecoderState(),
				"assistant_projection_limit",
				"Dropped oversized assistant tool state",
			);
			return undefined;
		}
		const message = cloneAndFreeze(sourceMessage);
		const pos = isStreamPos(event.stream) ? event.stream : { epoch: 0, seq: 0 };
		if (!isStreamPos(event.stream)) {
			this.report("invalid_snapshot_position", "Adopted a snapshot with an invalid position", "desynchronized");
		}
		this.streams.set(key, {
			phase: isStreamPos(event.stream) ? "synchronized" : "desynchronized",
			epoch: pos.epoch,
			lastSeq: pos.seq,
			message,
			argsText: seeded.argsText,
			contentBytes: seeded.contentBytes,
			cumulativeContentBytes: seeded.cumulativeContentBytes,
		});
		return {
			...event,
			message,
			assistantMessageEvent: Object.freeze({
				...(event.assistantMessageEvent as Record<string, unknown>),
				seq: pos.seq,
				snapshot: message,
				toolState: seeded.toolState,
			}),
		};
	}

	private applyDelta(event: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
		const state = this.streams.get(key) ?? createDecoderState();
		const pos = event.stream;
		if (!isStreamPos(pos)) {
			this.desynchronize(key, state, "invalid_delta_position", "Dropped a delta with an invalid position");
			return undefined;
		}
		if (
			state.phase !== "synchronized" ||
			pos.epoch !== state.epoch ||
			pos.seq !== state.lastSeq + 1 ||
			!state.message
		) {
			this.desynchronize(key, state, "delta_position_gap", "Dropped a stale or discontinuous delta", {
				expectedSeq: state.lastSeq + 1,
				receivedSeq: pos.seq,
			});
			return undefined;
		}

		const applied = applySlimEvent(
			state.message,
			state.argsText,
			state.contentBytes,
			state.cumulativeContentBytes,
			event.assistantMessageEvent as Record<string, unknown>,
		);
		if (!applied) {
			this.desynchronize(key, state, "invalid_delta_payload", "Dropped a malformed delta payload");
			return undefined;
		}
		const toolState = freezeToolState(applied.argsText);
		this.streams.set(key, {
			phase: "synchronized",
			epoch: pos.epoch,
			lastSeq: pos.seq,
			message: applied.message,
			argsText: applied.argsText,
			contentBytes: applied.contentBytes,
			cumulativeContentBytes: applied.cumulativeContentBytes,
		});
		return {
			...event,
			message: applied.message,
			assistantMessageEvent: Object.freeze({
				...(event.assistantMessageEvent as Record<string, unknown>),
				seq: pos.seq,
				snapshot: applied.message,
				toolState,
			}),
		};
	}

	private desynchronize(
		key: string,
		state: DecoderStreamState,
		code: string,
		message: string,
		details: Pick<ProjectionDiagnostic, "expectedSeq" | "receivedSeq"> = {},
	): void {
		this.streams.set(key, { ...state, phase: "desynchronized" });
		this.report(code, message, state.phase, details);
	}

	private report(
		code: string,
		message: string,
		phase: ProjectionPhase,
		details: Pick<ProjectionDiagnostic, "expectedSeq" | "receivedSeq"> = {},
	): void {
		this.onDiagnostic?.(Object.freeze({ code, message, phase, ...details }));
	}
}

interface AppliedDelta {
	message: AssistantMessage;
	argsText: Map<number, string>;
	contentBytes: number[];
	cumulativeContentBytes: number;
}

function applySlimEvent(
	message: AssistantMessage,
	previousArgsText: Map<number, string>,
	previousContentBytes: readonly number[],
	previousCumulativeContentBytes: number,
	event: Record<string, unknown>,
): AppliedDelta | undefined {
	const contentIndex = event.contentIndex;
	if (
		typeof contentIndex !== "number" ||
		!Number.isSafeInteger(contentIndex) ||
		contentIndex < 0 ||
		contentIndex > message.content.length ||
		contentIndex > MAX_CONTENT_INDEX
	) {
		return undefined;
	}

	const content = [...message.content];
	const argsText = new Map(previousArgsText);
	const contentBytes = [...previousContentBytes];
	let cumulativeContentBytes = previousCumulativeContentBytes;
	const replaceContentBytes = (nextBytes: number): boolean => {
		const metrics: ConversationProjectionAssistantSnapshotMetrics = {
			contentBytes,
			cumulativeContentBytes,
		};
		try {
			assertConversationProjectionCumulativeContentWithinLimits(metrics, contentIndex, nextBytes);
		} catch (error: unknown) {
			if (error instanceof ConversationProjectionLimitError) return false;
			throw error;
		}
		const previousBytes = contentBytes[contentIndex] ?? 0;
		cumulativeContentBytes = cumulativeContentBytes - previousBytes + nextBytes;
		contentBytes[contentIndex] = nextBytes;
		return true;
	};
	const existing = content[contentIndex];
	switch (event.type) {
		case "text_start":
			if (contentIndex !== content.length) return undefined;
			content[contentIndex] = Object.freeze({ type: "text", text: "" });
			contentBytes[contentIndex] = 0;
			break;
		case "text_delta": {
			if (existing?.type !== "text" || typeof event.delta !== "string") return undefined;
			const deltaBytes = measureConversationProjectionUtf8BytesWithin(
				event.delta,
				DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
			);
			if (deltaBytes === null) return undefined;
			const nextBytes = (contentBytes[contentIndex] ?? 0) + deltaBytes;
			if (!Number.isSafeInteger(nextBytes) || !replaceContentBytes(nextBytes)) return undefined;
			content[contentIndex] = Object.freeze({ ...existing, text: existing.text + event.delta });
			break;
		}
		case "text_end": {
			if (existing?.type !== "text" || typeof event.content !== "string") return undefined;
			const nextBytes = measureConversationProjectionUtf8BytesWithin(
				event.content,
				DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
			);
			if (nextBytes === null || !replaceContentBytes(nextBytes)) return undefined;
			content[contentIndex] = Object.freeze({ ...existing, text: event.content });
			break;
		}
		case "thinking_start":
			if (contentIndex !== content.length) return undefined;
			content[contentIndex] = Object.freeze({
				type: "thinking",
				thinking: "",
				...(typeof event.redacted === "boolean" ? { redacted: event.redacted } : {}),
			});
			contentBytes[contentIndex] = 0;
			break;
		case "thinking_delta": {
			if (existing?.type !== "thinking" || typeof event.delta !== "string") return undefined;
			const deltaBytes = measureConversationProjectionUtf8BytesWithin(
				event.delta,
				DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
			);
			if (deltaBytes === null) return undefined;
			const nextBytes = (contentBytes[contentIndex] ?? 0) + deltaBytes;
			if (!Number.isSafeInteger(nextBytes) || !replaceContentBytes(nextBytes)) return undefined;
			content[contentIndex] = Object.freeze({ ...existing, thinking: existing.thinking + event.delta });
			break;
		}
		case "thinking_end": {
			if (existing?.type !== "thinking" || typeof event.content !== "string") return undefined;
			const nextBytes = measureConversationProjectionUtf8BytesWithin(
				event.content,
				DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
			);
			if (nextBytes === null || !replaceContentBytes(nextBytes)) return undefined;
			content[contentIndex] = Object.freeze({
				...existing,
				thinking: event.content,
				...(typeof event.redacted === "boolean" ? { redacted: event.redacted } : {}),
			});
			break;
		}
		case "toolcall_start": {
			if (contentIndex !== content.length) return undefined;
			const argumentsValue = Object.freeze({});
			content[contentIndex] = Object.freeze({
				type: "toolCall",
				id: typeof event.id === "string" ? event.id : "",
				name: typeof event.name === "string" ? event.name : "",
				arguments: argumentsValue,
			});
			argsText.set(contentIndex, "");
			contentBytes[contentIndex] = 0;
			break;
		}
		case "toolcall_delta": {
			if (existing?.type !== "toolCall" || typeof event.argsTextDelta !== "string") return undefined;
			const previous = argsText.get(contentIndex);
			if (previous === undefined) return undefined;
			const previousBytes = contentBytes[contentIndex] ?? 0;
			const deltaBytes = measureConversationProjectionUtf8BytesWithin(
				event.argsTextDelta,
				DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
			);
			if (deltaBytes === null) return undefined;
			const nextBytes = previousBytes + deltaBytes;
			if (
				!Number.isSafeInteger(nextBytes) ||
				nextBytes > DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES ||
				!replaceContentBytes(nextBytes)
			) {
				return undefined;
			}
			const next = previous + event.argsTextDelta;
			argsText.set(contentIndex, next);
			content[contentIndex] = Object.freeze({
				...existing,
				...(typeof event.id === "string" ? { id: event.id } : {}),
				...(typeof event.name === "string" ? { name: event.name } : {}),
				arguments: cloneAndFreeze(parseStreamingJson<JsonObject>(next)),
			});
			break;
		}
		case "toolcall_end": {
			if (existing?.type !== "toolCall" || !isToolCall(event.toolCall)) return undefined;
			let nextBytes: number;
			try {
				nextBytes = assertConversationProjectionToolCallWithinLimits(event.toolCall, contentIndex);
			} catch (error: unknown) {
				if (error instanceof ConversationProjectionLimitError) return undefined;
				throw error;
			}
			if (!replaceContentBytes(nextBytes)) return undefined;
			content[contentIndex] = cloneAndFreeze(event.toolCall);
			argsText.delete(contentIndex);
			break;
		}
		default:
			return undefined;
	}

	Object.freeze(content);
	return {
		message: Object.freeze({ ...message, content }),
		argsText,
		contentBytes,
		cumulativeContentBytes,
	};
}

function createDecoderState(): DecoderStreamState {
	return {
		phase: "idle",
		epoch: 0,
		lastSeq: -1,
		argsText: new Map(),
		contentBytes: [],
		cumulativeContentBytes: 0,
	};
}

function getAssistantSnapshotMetrics(
	message: AssistantMessage,
): ConversationProjectionAssistantSnapshotMetrics | undefined {
	try {
		return assertConversationProjectionAssistantSnapshotWithinLimits(message);
	} catch (error: unknown) {
		if (error instanceof ConversationProjectionLimitError) return undefined;
		throw error;
	}
}

function seedDecoderToolState(
	message: AssistantMessage,
	value: unknown,
	metrics: ConversationProjectionAssistantSnapshotMetrics,
):
	| {
			toolState: readonly ActiveToolCallState[];
			argsText: Map<number, string>;
			contentBytes: number[];
			cumulativeContentBytes: number;
	  }
	| undefined {
	const contentBytes = [...metrics.contentBytes];
	let cumulativeContentBytes = metrics.cumulativeContentBytes;
	const argsText = new Map<number, string>();
	if (!Array.isArray(value)) {
		return {
			toolState: Object.freeze([]),
			argsText,
			contentBytes,
			cumulativeContentBytes,
		};
	}
	const entries: ActiveToolCallState[] = [];
	for (const entry of value) {
		if (
			isRecord(entry) &&
			typeof entry.contentIndex === "number" &&
			Number.isSafeInteger(entry.contentIndex) &&
			entry.contentIndex >= 0 &&
			entry.contentIndex <= MAX_CONTENT_INDEX &&
			typeof entry.argsText === "string"
		) {
			let nextBytes: number;
			try {
				nextBytes = assertConversationProjectionToolArgumentWithinLimits(entry.argsText, entry.contentIndex);
				if (message.content[entry.contentIndex]?.type === "toolCall") {
					assertConversationProjectionCumulativeContentWithinLimits(
						{ contentBytes, cumulativeContentBytes },
						entry.contentIndex,
						nextBytes,
					);
					const previousBytes = contentBytes[entry.contentIndex] ?? 0;
					cumulativeContentBytes = cumulativeContentBytes - previousBytes + nextBytes;
					contentBytes[entry.contentIndex] = nextBytes;
				}
			} catch (error: unknown) {
				if (error instanceof ConversationProjectionLimitError) return undefined;
				throw error;
			}
			entries.push(Object.freeze({ contentIndex: entry.contentIndex, argsText: entry.argsText }));
			argsText.set(entry.contentIndex, entry.argsText);
		}
	}
	return {
		toolState: Object.freeze(entries),
		argsText,
		contentBytes,
		cumulativeContentBytes,
	};
}

function freezeToolState(argsText: ReadonlyMap<number, string>): readonly ActiveToolCallState[] {
	return Object.freeze(
		[...argsText.entries()]
			.sort(([left], [right]) => left - right)
			.map(([contentIndex, value]) => Object.freeze({ contentIndex, argsText: value })),
	);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function isAssistantMessageEvent(value: unknown): value is AssistantMessageEvent {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.seq === "number" &&
		("snapshot" in value || value.type === "done" || value.type === "error")
	);
}

function isToolCall(value: unknown): value is ToolCall {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

function isStreamPos(value: unknown): value is StreamPos {
	return (
		isRecord(value) &&
		typeof value.epoch === "number" &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch >= 0 &&
		typeof value.seq === "number" &&
		Number.isSafeInteger(value.seq) &&
		value.seq >= 0
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((entry, index) => jsonValueEquals(entry, right[index]))
		);
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		return (
			leftKeys.length === Object.keys(right).length &&
			leftKeys.every((key) => Object.hasOwn(right, key) && jsonValueEquals(left[key], right[key]))
		);
	}
	return false;
}

function cloneAndFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const clone: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		clone[key] = cloneAndFreeze(entry);
	}
	return Object.freeze(clone) as T;
}
