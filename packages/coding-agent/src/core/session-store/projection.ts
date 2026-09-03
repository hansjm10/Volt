import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { Message } from "@hansjm10/volt-ai";
import { cloneCanonicalData } from "../canonical-data.ts";
import type { RpcGitContext } from "../rpc/types.ts";
import { RPC_SESSION_QUEUE_MAX_ITEMS } from "../rpc/wire-limits.ts";
import {
	CLIENT_INPUT_ERROR_MAX_SCALARS,
	digestClientInputPayload,
	isHostOnlySessionEntryType,
	normalizeClientInputPayload,
	normalizeClientInputQueuedPayload,
} from "../session-entry-codec.ts";
import type {
	ClientInputQueuedPayload,
	ClientInputRecord,
	SessionEntry,
	SessionHeader,
	SubagentSpawnEntry,
} from "../session-manager.ts";
import type {
	SessionStoreClientInputWrite,
	SessionStoreJsonValue,
	SessionStoreSearchChunkWrite,
	SessionStoreSessionProjection,
	SessionStoreSnapshot,
} from "./types.ts";

export const CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES = RPC_SESSION_QUEUE_MAX_ITEMS;
export const CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES = CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES;
export const CLIENT_INPUT_MAX_OUTSTANDING_BYTES = 16 * 1024 * 1024;

export interface SessionMessageSummaryAccumulator {
	messageCount: number;
	firstUserMessage: string;
	firstFallbackMessage: string;
	lastActivityTime: number | undefined;
}

export interface SessionDerivedState {
	headerTimestamp: string;
	messageSummary: SessionMessageSummaryAccumulator;
	hasPlanningState: boolean;
	name: string | undefined;
	startingGitContext: RpcGitContext | null | undefined;
	labelsById: Map<string, string>;
	labelTimestampsById: Map<string, string>;
	clientInputsById: Map<string, ClientInputRecord>;
	clientInputIdByEntryId: Map<string, string>;
	subagentSpawns: SubagentSpawnEntry[];
	searchChunks: SessionStoreSearchChunkWrite[];
	searchChunkByEntryId: Map<string, SessionStoreSearchChunkWrite>;
	leafId: string | null;
	nextOrdinal: number;
	nextSearchChunkIndex: number;
	canonicalRevision: number;
}

export interface SessionEntrySummary {
	messageCount: number;
	firstMessage: string;
	lastActivityTime?: number;
}

function createSessionMessageSummaryAccumulator(): SessionMessageSummaryAccumulator {
	return {
		messageCount: 0,
		firstUserMessage: "",
		firstFallbackMessage: "",
		lastActivityTime: undefined,
	};
}

function cloneStartingGitContext(value: RpcGitContext | null | undefined): RpcGitContext | null | undefined {
	return value === undefined ? undefined : cloneCanonicalData(value, "Session starting Git context projection");
}

export function createSessionDerivedState(header: SessionHeader): SessionDerivedState {
	return {
		headerTimestamp: header.timestamp,
		messageSummary: createSessionMessageSummaryAccumulator(),
		hasPlanningState: false,
		name: undefined,
		startingGitContext: undefined,
		labelsById: new Map(),
		labelTimestampsById: new Map(),
		clientInputsById: new Map(),
		clientInputIdByEntryId: new Map(),
		subagentSpawns: [],
		searchChunks: [],
		searchChunkByEntryId: new Map(),
		leafId: null,
		nextOrdinal: 1,
		nextSearchChunkIndex: 0,
		canonicalRevision: 0,
	};
}

export function cloneClientInputRecord(record: ClientInputRecord): ClientInputRecord {
	return {
		...record,
		input: { ...record.input, images: record.input.images.map((image) => ({ ...image })) },
		...(record.queuedInput === undefined
			? {}
			: {
					queuedInput: {
						...record.queuedInput,
						images: record.queuedInput.images.map((image) => ({ ...image })),
					},
				}),
	};
}

export function cloneSessionDerivedState(state: SessionDerivedState): SessionDerivedState {
	return {
		headerTimestamp: state.headerTimestamp,
		messageSummary: { ...state.messageSummary },
		hasPlanningState: state.hasPlanningState,
		name: state.name,
		startingGitContext: cloneStartingGitContext(state.startingGitContext),
		labelsById: new Map(state.labelsById),
		labelTimestampsById: new Map(state.labelTimestampsById),
		clientInputsById: new Map(
			[...state.clientInputsById].map(([clientMessageId, record]) => [
				clientMessageId,
				cloneClientInputRecord(record),
			]),
		),
		clientInputIdByEntryId: new Map(state.clientInputIdByEntryId),
		subagentSpawns: [...state.subagentSpawns],
		searchChunks: [...state.searchChunks],
		searchChunkByEntryId: new Map(state.searchChunkByEntryId),
		leafId: state.leafId,
		nextOrdinal: state.nextOrdinal,
		nextSearchChunkIndex: state.nextSearchChunkIndex,
		canonicalRevision: state.canonicalRevision,
	};
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContentFromContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function extractTextContent(message: Message): string {
	return extractTextContentFromContent(message.content);
}

function entryTimestamp(entry: SessionEntry): number | undefined {
	const timestamp = new Date(entry.timestamp).getTime();
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function messageActivityTime(entry: Extract<SessionEntry, { type: "message" }>): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
	return typeof message.timestamp === "number" ? message.timestamp : entryTimestamp(entry);
}

function accumulateMessageSummary(accumulator: SessionMessageSummaryAccumulator, entry: SessionEntry): void {
	if (entry.type === "message") {
		accumulator.messageCount++;
		const activityTime = messageActivityTime(entry);
		if (activityTime !== undefined) {
			accumulator.lastActivityTime = Math.max(accumulator.lastActivityTime ?? 0, activityTime);
		}
		const message = entry.message;
		if (!isMessageWithContent(message) || (message.role !== "user" && message.role !== "assistant")) return;
		const text = extractTextContent(message);
		if (!text) return;
		if (!accumulator.firstUserMessage && message.role === "user") accumulator.firstUserMessage = text;
		if (!accumulator.firstFallbackMessage && message.role === "assistant") {
			accumulator.firstFallbackMessage = text;
		}
		return;
	}
	if (entry.type !== "custom_message" || !entry.display) return;
	accumulator.messageCount++;
	const activityTime = entryTimestamp(entry);
	if (activityTime !== undefined) {
		accumulator.lastActivityTime = Math.max(accumulator.lastActivityTime ?? 0, activityTime);
	}
	const text = extractTextContentFromContent(entry.content);
	if (text && !accumulator.firstFallbackMessage) accumulator.firstFallbackMessage = text;
}

function messageSummary(accumulator: SessionMessageSummaryAccumulator): SessionEntrySummary {
	return {
		messageCount: accumulator.messageCount,
		firstMessage: accumulator.firstUserMessage || accumulator.firstFallbackMessage || "(no messages)",
		...(accumulator.lastActivityTime === undefined ? {} : { lastActivityTime: accumulator.lastActivityTime }),
	};
}

export function sessionEntrySummary(state: Pick<SessionDerivedState, "messageSummary">): SessionEntrySummary {
	return messageSummary(state.messageSummary);
}

export function summarizeSessionEntries(entries: Iterable<SessionEntry>): SessionEntrySummary {
	const accumulator = createSessionMessageSummaryAccumulator();
	for (const entry of entries) accumulateMessageSummary(accumulator, entry);
	return messageSummary(accumulator);
}

function measureClientInputPayloadBytes(value: ClientInputRecord["input"] | ClientInputQueuedPayload): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function outstandingClientInputBytes(records: Iterable<ClientInputRecord>): number {
	let total = 0;
	for (const record of records) {
		if (record.state === "completed" || record.state === "failed") continue;
		total += measureClientInputPayloadBytes(record.input);
		if (record.queuedInput) total += measureClientInputPayloadBytes(record.queuedInput);
	}
	return total;
}

function outstandingClientInputCount(records: Iterable<ClientInputRecord>): number {
	let total = 0;
	for (const record of records) {
		if (record.state !== "completed" && record.state !== "failed") total++;
	}
	return total;
}

function recoverableQueuedClientInputCount(records: Iterable<ClientInputRecord>): number {
	let total = 0;
	for (const record of records) {
		if (record.state === "accepted" && record.queuedInput !== undefined) total++;
	}
	return total;
}

export function assertClientInputOutstandingCount(
	records: Iterable<ClientInputRecord>,
	additionalEntries: number,
): void {
	if (outstandingClientInputCount(records) + additionalEntries > CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES) {
		throw new Error(`Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES}-entry limit`);
	}
}

export function assertClientInputOutstandingBudget(
	records: Iterable<ClientInputRecord>,
	additionalBytes: number,
): void {
	if (outstandingClientInputBytes(records) + additionalBytes > CLIENT_INPUT_MAX_OUTSTANDING_BYTES) {
		throw new Error(
			`Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_BYTES}-byte aggregate limit`,
		);
	}
}

export function assertRecoverableClientInputQueueCapacity(records: Iterable<ClientInputRecord>): void {
	if (recoverableQueuedClientInputCount(records) >= CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES) {
		throw new Error(`Recoverable client input queue exceeds ${CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES} entries`);
	}
}

export function requireStartedClientInputReceipt(
	records: ReadonlyMap<string, ClientInputRecord>,
	clientMessageId: string,
): ClientInputRecord {
	const record = records.get(clientMessageId);
	if (!record) {
		throw new Error(`Canonical client input ${JSON.stringify(clientMessageId)} has no matching durable receipt`);
	}
	if (record.state !== "started") {
		throw new Error(
			`Canonical client input ${JSON.stringify(clientMessageId)} requires a started receipt; found ${record.state}`,
		);
	}
	return record;
}

export function expectedClientInputQueuedDelivery(record: ClientInputRecord): "steer" | "follow_up" | undefined {
	if (record.command === "steer") return "steer";
	if (record.command === "follow_up") return "follow_up";
	if (record.input.streamingBehavior === "steer") return "steer";
	if (record.input.streamingBehavior === "followUp") return "follow_up";
	return undefined;
}

function reduceClientInputEntry(state: SessionDerivedState, entry: SessionEntry): ClientInputRecord | undefined {
	if (entry.type === "client_input_receipt") {
		if (state.clientInputsById.has(entry.clientMessageId)) {
			throw new Error(`Client input id ${JSON.stringify(entry.clientMessageId)} has duplicate durable receipts`);
		}
		const input = normalizeClientInputPayload(entry.command, entry.input);
		if (entry.semanticDigest !== digestClientInputPayload(entry.command, input)) {
			throw new Error(`Client input receipt ${entry.id} has a mismatched semantic digest`);
		}
		assertClientInputOutstandingCount(state.clientInputsById.values(), 1);
		assertClientInputOutstandingBudget(state.clientInputsById.values(), measureClientInputPayloadBytes(input));
		return {
			receiptId: entry.id,
			clientMessageId: entry.clientMessageId,
			command: entry.command,
			semanticDigest: entry.semanticDigest,
			input,
			state: "accepted",
		};
	}
	if (entry.type === "client_input_queued") {
		const existing = state.clientInputsById.get(entry.clientMessageId);
		if (!existing || existing.receiptId !== entry.receiptId) {
			throw new Error(`Queued client input ${entry.id} has no matching receipt`);
		}
		if (existing.state !== "accepted" && existing.state !== "started") {
			throw new Error(`Queued client input ${entry.id} was persisted after dispatch started`);
		}
		if (existing.queuedInput) {
			throw new Error(`Client input id ${JSON.stringify(entry.clientMessageId)} has duplicate queued entries`);
		}
		const queuedInput = normalizeClientInputQueuedPayload(entry.queuedInput);
		if (queuedInput.delivery !== expectedClientInputQueuedDelivery(existing)) {
			throw new Error(`Queued client input ${entry.id} conflicts with its requested delivery`);
		}
		assertRecoverableClientInputQueueCapacity(state.clientInputsById.values());
		assertClientInputOutstandingBudget(state.clientInputsById.values(), measureClientInputPayloadBytes(queuedInput));
		return {
			...cloneClientInputRecord(existing),
			queuedEntryId: entry.id,
			queuedInput,
			state: "accepted",
			error: undefined,
		};
	}
	if (entry.type === "client_input_state") {
		const existing = state.clientInputsById.get(entry.clientMessageId);
		if (!existing || existing.receiptId !== entry.receiptId) {
			throw new Error(`Client input state ${entry.id} has no matching receipt`);
		}
		if (existing.state === "completed" || existing.state === "failed") {
			throw new Error(`Client input state ${entry.id} follows a terminal state`);
		}
		if (entry.state === "started" && existing.state !== "accepted") {
			throw new Error(`Client input state ${entry.id} repeats the started boundary`);
		}
		if (entry.state === "accepted" && existing.state !== "started") {
			throw new Error(`Client input state ${entry.id} cannot roll back from ${existing.state}`);
		}
		if (
			(entry.error !== undefined && entry.state !== "failed") ||
			(entry.error !== undefined && Array.from(entry.error).length > CLIENT_INPUT_ERROR_MAX_SCALARS)
		) {
			throw new Error(`Client input state ${entry.id} has an invalid error`);
		}
		return {
			...cloneClientInputRecord(existing),
			state: entry.state,
			...(entry.state === "failed" && entry.error !== undefined ? { error: entry.error } : { error: undefined }),
		};
	}
	if (entry.type !== "message" || entry.message.role !== "user" || entry.message.clientMessageId === undefined) {
		return undefined;
	}
	const existing = requireStartedClientInputReceipt(state.clientInputsById, entry.message.clientMessageId);
	return {
		...cloneClientInputRecord(existing),
		state: "completed",
		error: undefined,
		canonicalEntryId: entry.id,
	};
}

function searchableText(entry: SessionEntry): string {
	if (entry.type === "message" && isMessageWithContent(entry.message)) {
		if (entry.message.role === "user" || entry.message.role === "assistant") {
			return extractTextContent(entry.message);
		}
	}
	if (entry.type === "custom_message" && entry.display) return extractTextContentFromContent(entry.content);
	return "";
}

/** Apply one already codec-validated canonical entry to all derived state. */
export function applySessionEntry(state: SessionDerivedState, entry: SessionEntry & { ordinal: number }): void {
	if (entry.ordinal !== state.nextOrdinal) {
		throw new Error(`Session entry ${entry.id} has a non-contiguous ordinal`);
	}
	if (entry.type === "session_start_git_context" && state.startingGitContext !== undefined) {
		throw new Error("Session contains more than one starting Git context entry");
	}
	const nextMessageSummary = { ...state.messageSummary };
	accumulateMessageSummary(nextMessageSummary, entry);
	const clientInput = reduceClientInputEntry(state, entry);
	const text = searchableText(entry);
	const searchChunk = text ? { chunkIndex: state.nextSearchChunkIndex, entryId: entry.id, text } : undefined;

	state.messageSummary = nextMessageSummary;
	if (entry.type === "planning_state_change") state.hasPlanningState = true;
	if (entry.type === "session_info") state.name = entry.name?.trim() || undefined;
	if (entry.type === "session_start_git_context") {
		state.startingGitContext = cloneStartingGitContext(entry.gitContext);
	}
	if (entry.type === "label") {
		if (entry.label) {
			state.labelsById.set(entry.targetId, entry.label);
			state.labelTimestampsById.set(entry.targetId, entry.timestamp);
		} else {
			state.labelsById.delete(entry.targetId);
			state.labelTimestampsById.delete(entry.targetId);
		}
	}
	if (clientInput) {
		state.clientInputsById.set(clientInput.clientMessageId, clientInput);
		state.clientInputIdByEntryId.set(entry.id, clientInput.clientMessageId);
	}
	if (entry.type === "subagent_spawn") state.subagentSpawns.push(entry);
	if (searchChunk) {
		state.searchChunks.push(searchChunk);
		state.searchChunkByEntryId.set(entry.id, searchChunk);
		state.nextSearchChunkIndex++;
	}
	if (entry.type === "leaf") state.leafId = entry.targetId;
	else if (!isHostOnlySessionEntryType(entry.type)) state.leafId = entry.id;
	if (entry.type === "leaf" || !isHostOnlySessionEntryType(entry.type)) state.canonicalRevision++;
	state.nextOrdinal++;
}

export function replaySessionEntries(
	header: SessionHeader,
	entries: readonly (SessionEntry & { ordinal: number })[],
): SessionDerivedState {
	const state = createSessionDerivedState(header);
	for (const entry of entries) applySessionEntry(state, entry);
	return state;
}

export function sessionStoreProjection(state: SessionDerivedState): SessionStoreSessionProjection {
	const summary = sessionEntrySummary(state);
	const updatedAt =
		typeof summary.lastActivityTime === "number" && summary.lastActivityTime > 0
			? new Date(summary.lastActivityTime).toISOString()
			: state.headerTimestamp;
	return {
		updatedAt,
		startingGitContextRecorded: state.startingGitContext !== undefined,
		startingGitContext: cloneStartingGitContext(state.startingGitContext) ?? null,
		name: state.name ?? null,
		visible: summary.messageCount > 0 || state.hasPlanningState,
		leafId: state.leafId,
		messageCount: summary.messageCount,
		firstMessage: summary.firstMessage === "(no messages)" ? "" : summary.firstMessage,
	};
}

function clientInputWrite(record: ClientInputRecord): SessionStoreClientInputWrite {
	return {
		clientMessageId: record.clientMessageId,
		receiptEntryId: record.receiptId,
		command: record.command,
		semanticDigest: record.semanticDigest,
		input: record.input as unknown as SessionStoreJsonValue,
		queuedEntryId: record.queuedEntryId ?? null,
		queuedInput: (record.queuedInput ?? null) as unknown as SessionStoreJsonValue | null,
		state: record.state,
		error: record.error ?? null,
		canonicalEntryId: record.canonicalEntryId ?? null,
	};
}

export function allSessionStoreClientInputs(state: SessionDerivedState): SessionStoreClientInputWrite[] {
	return [...state.clientInputsById.values()]
		.sort((left, right) =>
			left.clientMessageId < right.clientMessageId ? -1 : left.clientMessageId > right.clientMessageId ? 1 : 0,
		)
		.map(clientInputWrite);
}

export function sessionStoreClientInputsForEntries(
	state: SessionDerivedState,
	entries: readonly SessionEntry[],
): SessionStoreClientInputWrite[] {
	const affectedIds = new Set<string>();
	for (const entry of entries) {
		const clientMessageId = state.clientInputIdByEntryId.get(entry.id);
		if (clientMessageId) affectedIds.add(clientMessageId);
	}
	return [...affectedIds]
		.map((clientMessageId) => state.clientInputsById.get(clientMessageId))
		.filter((record): record is ClientInputRecord => record !== undefined)
		.map(clientInputWrite);
}

export function sessionStoreSearchChunksForEntries(
	state: SessionDerivedState,
	entries: readonly SessionEntry[],
): SessionStoreSearchChunkWrite[] {
	return entries
		.map((entry) => state.searchChunkByEntryId.get(entry.id))
		.filter((chunk): chunk is SessionStoreSearchChunkWrite => chunk !== undefined);
}

export class SessionStoreProjectionIntegrityError extends Error {
	readonly code = "session_store_projection_integrity";

	constructor(component: "summary" | "client_inputs" | "search_chunks") {
		super(`Session store ${component} projection does not match canonical entries`);
		this.name = "SessionStoreProjectionIntegrityError";
	}
}

export function verifySessionStoreProjections(state: SessionDerivedState, snapshot: SessionStoreSnapshot): void {
	const summary = snapshot.session;
	const actualSummary: SessionStoreSessionProjection = {
		updatedAt: summary.updatedAt,
		startingGitContextRecorded: summary.startingGitContextRecorded,
		startingGitContext: summary.startingGitContext,
		name: summary.name,
		visible: summary.visible,
		leafId: summary.leafId,
		messageCount: summary.messageCount,
		firstMessage: summary.firstMessage,
	};
	if (!isDeepStrictEqual(sessionStoreProjection(state), actualSummary)) {
		throw new SessionStoreProjectionIntegrityError("summary");
	}
	if (!isDeepStrictEqual(allSessionStoreClientInputs(state), snapshot.clientInputs)) {
		throw new SessionStoreProjectionIntegrityError("client_inputs");
	}
	if (!isDeepStrictEqual(state.searchChunks, snapshot.searchChunks)) {
		throw new SessionStoreProjectionIntegrityError("search_chunks");
	}
}
