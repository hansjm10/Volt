import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcGitContext } from "../../../src/core/rpc/types.ts";
import {
	CLIENT_INPUT_MAX_OUTSTANDING_BYTES,
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES,
	createClientInputSemanticDigest,
	type SessionCanonicalMutation,
	SessionManager,
	type SessionTreeNode,
} from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	digestSessionStoreTransactionPayload,
	SESSION_STORE_DATABASE_FILENAME,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInputWrite,
	type SessionStoreEntryWrite,
	type SessionStoreJsonValue,
	type SessionStoreSessionProjection,
	type SessionStoreTransactionPayload,
	SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import { createSessionManagerTestOwner } from "../../session-manager-owner.ts";

const CREATED_AT = "2026-09-03T12:00:00.000Z";
const SECOND_AT = "2026-09-03T12:01:00.000Z";
const LARGE_CLIENT_INPUT_TEXT = "x".repeat(500_000);
const PROJECTION_PROPERTY_SEED = 329_103;

interface ClientInputFixture {
	readonly entries: readonly SessionStoreEntryWrite[];
	readonly projection: SessionStoreClientInputWrite;
}

interface OpenLowLevelStore {
	readonly client: SQLiteSessionStoreClient;
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

const managerOwner = createSessionManagerTestOwner();
const clients: SQLiteSessionStoreClient[] = [];
const leases = new Set<SQLiteSessionStoreLease>();
let root = "";

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string | undefined {
	return error instanceof Error ? error.message : undefined;
}

function captureError(operation: () => unknown): unknown {
	try {
		operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function captureAsyncError(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

function generationFor(sessionId: string): string {
	return `generation:${sessionId}:1`;
}

function sessionProjection(overrides: Partial<SessionStoreSessionProjection> = {}): SessionStoreSessionProjection {
	return {
		updatedAt: CREATED_AT,
		startingGitContextRecorded: false,
		startingGitContext: null,
		name: null,
		visible: false,
		leafId: null,
		messageCount: 0,
		firstMessage: "",
		...overrides,
	};
}

function storePayload(
	options: {
		readonly session?: Partial<SessionStoreSessionProjection>;
		readonly entries?: readonly SessionStoreEntryWrite[];
		readonly clientInputs?: readonly SessionStoreClientInputWrite[];
		readonly searchChunks?: SessionStoreTransactionPayload["searchChunks"];
	} = {},
): SessionStoreTransactionPayload {
	return {
		session: sessionProjection(options.session),
		entries: options.entries ?? [],
		clientInputs: options.clientInputs ?? [],
		searchChunks: options.searchChunks ?? [],
	};
}

function transaction(
	sessionId: string,
	sessionGeneration: string,
	expectedRevision: number,
	commitId: string,
	payload: SessionStoreTransactionPayload,
): SessionStoreApplyTransactionInput {
	return {
		sessionId,
		sessionGeneration,
		expectedRevision,
		commitId,
		digest: digestSessionStoreTransactionPayload(payload),
		payload,
	};
}

function entryWrite(entry: SessionStoreJsonValue): SessionStoreEntryWrite {
	return { entry };
}

function acceptedReceiptFixture(prefix: string, index: number, ordinal: number, message: string): ClientInputFixture {
	const clientMessageId = `${prefix}-client-${index}`;
	const receiptEntryId = `${prefix}-receipt-${index}`;
	const input = { message, images: [] };
	const semanticDigest = createClientInputSemanticDigest("steer", input);
	return {
		entries: [
			entryWrite({
				type: "client_input_receipt",
				id: receiptEntryId,
				parentId: null,
				timestamp: CREATED_AT,
				ordinal,
				clientMessageId,
				command: "steer",
				semanticDigest,
				input,
			}),
		],
		projection: {
			clientMessageId,
			receiptEntryId,
			command: "steer",
			semanticDigest,
			input,
			queuedEntryId: null,
			queuedInput: null,
			state: "accepted",
			error: null,
			canonicalEntryId: null,
		},
	};
}

function queuedReceiptFixture(
	prefix: string,
	index: number,
	firstOrdinal: number,
	message: string,
): ClientInputFixture {
	const clientMessageId = `${prefix}-client-${index}`;
	const receiptEntryId = `${prefix}-receipt-${index}`;
	const queuedEntryId = `${prefix}-queued-${index}`;
	const input = { message, images: [] };
	const queuedInput = { delivery: "steer" as const, message, images: [] };
	const semanticDigest = createClientInputSemanticDigest("steer", input);
	return {
		entries: [
			entryWrite({
				type: "client_input_receipt",
				id: receiptEntryId,
				parentId: null,
				timestamp: CREATED_AT,
				ordinal: firstOrdinal,
				clientMessageId,
				command: "steer",
				semanticDigest,
				input,
			}),
			entryWrite({
				type: "client_input_queued",
				id: queuedEntryId,
				parentId: null,
				timestamp: CREATED_AT,
				ordinal: firstOrdinal + 1,
				receiptId: receiptEntryId,
				clientMessageId,
				queuedInput,
			}),
		],
		projection: {
			clientMessageId,
			receiptEntryId,
			command: "steer",
			semanticDigest,
			input,
			queuedEntryId,
			queuedInput,
			state: "accepted",
			error: null,
			canonicalEntryId: null,
		},
	};
}

function fixturesPayload(fixtures: readonly ClientInputFixture[]): SessionStoreTransactionPayload {
	return storePayload({
		entries: fixtures.flatMap((fixture) => fixture.entries),
		clientInputs: fixtures.map((fixture) => fixture.projection),
	});
}

function clientInputProjectionBytes(fixture: ClientInputFixture): number {
	return (
		Buffer.byteLength(JSON.stringify(fixture.projection.input), "utf8") +
		(fixture.projection.queuedInput === null
			? 0
			: Buffer.byteLength(JSON.stringify(fixture.projection.queuedInput), "utf8"))
	);
}

async function openLowLevelStore(name: string): Promise<OpenLowLevelStore> {
	const sessionDirectory = join(root, name);
	const sessionId = `${name}-session`;
	const sessionGeneration = generationFor(sessionId);
	const client = await SQLiteSessionStoreClient.open(sessionDirectory);
	clients.push(client);
	await client.createHiddenSession({
		id: sessionId,
		sessionGeneration,
		formatVersion: 5,
		cwd: root,
		createdAt: CREATED_AT,
		parentSessionDirectory: null,
		parentStoreId: null,
		parentSessionId: null,
		parentSessionGeneration: null,
		origin: null,
	});
	return { client, sessionId, sessionGeneration };
}

function userMessageWrite(
	id: string,
	ordinal: number,
	content: string,
	timestamp: string,
	parentId: string | null,
): SessionStoreEntryWrite {
	return entryWrite({
		type: "message",
		id,
		parentId,
		timestamp,
		ordinal,
		message: { role: "user", content, timestamp: Date.parse(timestamp) },
	});
}

function firstSearchableMessagePayload(): SessionStoreTransactionPayload {
	return storePayload({
		session: {
			visible: true,
			leafId: "message-1",
			messageCount: 1,
			firstMessage: "first searchable",
		},
		entries: [userMessageWrite("message-1", 1, "first searchable", CREATED_AT, null)],
		searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
	});
}

interface TransactionProjectionMismatchCase {
	readonly name: string;
	malformedPayload(canonical: SessionStoreTransactionPayload): SessionStoreTransactionPayload;
}

const TRANSACTION_PROJECTION_MISMATCH_CASES: readonly TransactionProjectionMismatchCase[] = [
	{
		name: "rejects omission of the canonical message's required search chunk",
		malformedPayload: (canonical) => ({ ...canonical, searchChunks: [] }),
	},
	{
		name: "rejects a supplied search chunk whose text disagrees with the canonical message",
		malformedPayload: (canonical) => ({
			...canonical,
			searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "different search text" }],
		}),
	},
];

async function seedSearchableMessage(store: OpenLowLevelStore): Promise<void> {
	const payload = firstSearchableMessagePayload();
	const result = await store.client.applyTransaction(
		transaction(store.sessionId, store.sessionGeneration, 0, `${store.sessionId}-seed`, payload),
	);
	if (result.status !== "committed") throw new Error("Could not seed low-level searchable session");
}

function findTreeNode(manager: SessionManager, entryId: string): SessionTreeNode | undefined {
	const pending = [...manager.getTree()];
	while (pending.length > 0) {
		const node = pending.shift()!;
		if (node.entry.id === entryId) return node;
		pending.push(...node.children);
	}
	return undefined;
}

function clearedLabelState(manager: SessionManager, targetId: string): object {
	const treeNode = findTreeNode(manager, targetId);
	return {
		label: manager.getLabel(targetId),
		treeLabel: treeNode?.label,
		treeLabelTimestamp: treeNode?.labelTimestamp,
		leafType: manager.getLeafEntry()?.type,
		labelEntries: manager
			.getEntries()
			.filter((entry) => entry.type === "label")
			.map((entry) => ({ targetId: entry.targetId, label: entry.label })),
		summary: manager.getSessionEntrySummary(),
		messages: manager.buildSessionContext().messages.map((message) => ({
			role: message.role,
			text: messageText(message),
		})),
	};
}

function replayComparableState(manager: SessionManager, targetId: string, clientMessageId?: string): object {
	return {
		entries: manager.getEntries(),
		leafId: manager.getLeafId(),
		tree: manager.getTree(),
		summary: manager.getSessionEntrySummary(),
		name: manager.getSessionName(),
		startingGitContext: manager.getStartingGitContext(),
		context: manager.buildSessionContext(),
		label: manager.getLabel(targetId),
		subagentSpawns: manager.getSubagentSpawnEntries(),
		clientInput: clientMessageId === undefined ? undefined : manager.getClientInput(clientMessageId),
		recovery: manager.getClientInputRecoveryPlan(),
	};
}

async function expectReplayMatches(manager: SessionManager, targetId: string, clientMessageId?: string): Promise<void> {
	await manager.flush();
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("Expected persisted session reference");
	const reopened = await SessionManager.open(ref);
	try {
		expect(replayComparableState(reopened, targetId, clientMessageId)).toEqual(
			replayComparableState(manager, targetId, clientMessageId),
		);
	} finally {
		await reopened.closePersistence();
	}
}

type PropertyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ProjectionPropertyScenario {
	readonly label: string;
	readonly clearWithEmpty: boolean;
	readonly thinkingLevel: PropertyThinkingLevel;
	readonly modelId: string;
	readonly fastModeEnabled: boolean;
	readonly gitContextKind: "null" | "value";
	readonly gitRevision: number;
	readonly clientInputMessage: string;
	readonly completeClientInput: boolean;
	readonly failure: string;
	readonly batchWidths: readonly number[];
}

const propertyToken = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
const projectionPropertyScenario: fc.Arbitrary<ProjectionPropertyScenario> = fc.record({
	label: propertyToken,
	clearWithEmpty: fc.boolean(),
	thinkingLevel: fc.constantFrom("off", "minimal", "low", "medium", "high", "xhigh", "max"),
	modelId: propertyToken.map((suffix) => `property-model-${suffix}`),
	fastModeEnabled: fc.boolean(),
	gitContextKind: fc.constantFrom("null", "value"),
	gitRevision: fc.integer({ min: 1, max: 10 }),
	clientInputMessage: propertyToken.map((suffix) => `queued-${suffix}`),
	completeClientInput: fc.boolean(),
	failure: propertyToken.map((suffix) => `failure-${suffix}`),
	batchWidths: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 }),
});

function partitionMutations(rootEntryId: string, scenario: ProjectionPropertyScenario): SessionCanonicalMutation[] {
	return [
		{ kind: "append", entry: { type: "label", targetId: rootEntryId, label: scenario.label } },
		{ kind: "move", leafId: null },
		{ kind: "move", leafId: rootEntryId },
		{
			kind: "move_with_summary",
			leafId: rootEntryId,
			summary: { summary: "retained branch summary", details: { source: "partition" }, fromHook: true },
		},
		{
			kind: "append",
			entry: { type: "thinking_level_change", thinkingLevel: scenario.thinkingLevel },
		},
		{ kind: "append", entry: { type: "model_change", provider: "property-provider", modelId: scenario.modelId } },
		{
			kind: "append",
			entry: {
				type: "custom_message",
				customType: "partition-visible",
				content: [{ type: "text", text: "partition visible text" }],
				display: true,
				details: { retained: true },
			},
		},
		{
			kind: "append",
			entry: {
				type: "custom_message",
				customType: "partition-hidden",
				content: "partition hidden text",
				display: false,
			},
		},
		{ kind: "append", entry: { type: "session_info", name: "Partition name" } },
		{ kind: "append", entry: { type: "session_info", name: "" } },
		{ kind: "append", entry: { type: "planning_state_change", planning: { mode: "plan", plan: null } } },
		{
			kind: "append",
			entry: {
				type: "label",
				targetId: rootEntryId,
				...(scenario.clearWithEmpty ? { label: "" } : {}),
			},
		},
		{ kind: "append", entry: { type: "custom", customType: "partition-data", data: { retained: true } } },
		{
			kind: "append",
			entry: {
				type: "compaction",
				summary: "partition compaction",
				firstKeptEntryId: rootEntryId,
				tokensBefore: 42,
				details: { retained: true },
				fromHook: true,
			},
		},
	];
}

function partitionByWidths<T>(values: readonly T[], widths: readonly number[]): T[][] {
	const partitions: T[][] = [];
	let offset = 0;
	let widthIndex = 0;
	while (offset < values.length) {
		const width = widths[widthIndex % widths.length]!;
		partitions.push(values.slice(offset, offset + width));
		offset += width;
		widthIndex++;
	}
	return partitions;
}

function propertyGitContext(scenario: ProjectionPropertyScenario): RpcGitContext | null {
	if (scenario.gitContextKind === "null") return null;
	const emptyChanges = { added: 0, modified: 0, deleted: 0, renamed: 0 };
	return {
		repository: "projection-property",
		head: { kind: "branch", name: "main", oid: "a".repeat(40) },
		upstream: null,
		base: null,
		status: {
			staged: emptyChanges,
			unstaged: emptyChanges,
			untracked: 0,
			conflicted: 0,
			total: 0,
			clean: true,
		},
		operation: null,
		revision: scenario.gitRevision,
		observedAt: CREATED_AT,
		stale: false,
	};
}

function partitionFinalState(manager: SessionManager, rootEntryId: string, clientMessageId: string): object {
	const context = manager.buildSessionContext();
	const clientInput = manager.getClientInput(clientMessageId);
	return {
		entryTypes: manager.getEntries().map((entry) => entry.type),
		leafType: manager.getLeafEntry()?.type,
		summary: {
			messageCount: manager.getSessionEntrySummary().messageCount,
			firstMessage: manager.getSessionEntrySummary().firstMessage,
		},
		name: manager.getSessionName(),
		label: manager.getLabel(rootEntryId),
		startingGitContext: manager.getStartingGitContext(),
		context: {
			thinkingLevel: context.thinkingLevel,
			model: context.model,
			fastMode: context.fastMode,
			planning: context.planning,
			messages: context.messages.map((message) => ({ role: message.role, text: messageText(message) })),
		},
		subagentSpawns: manager.getSubagentSpawnEntries().map((entry) => ({
			toolCallId: entry.toolCallId,
			subagentId: entry.subagentId,
			agent: entry.agent,
			childSessionId: entry.childSessionId,
			requestKey: entry.requestKey,
		})),
		clientInput:
			clientInput === undefined
				? undefined
				: {
						clientMessageId: clientInput.clientMessageId,
						command: clientInput.command,
						input: clientInput.input,
						queuedInput: clientInput.queuedInput,
						state: clientInput.state,
						error: clientInput.error,
					},
		recoveryKind: manager.getClientInputRecoveryPlan().kind,
	};
}

async function runProjectionPropertyPartition(
	caseId: number,
	variant: string,
	scenario: ProjectionPropertyScenario,
	batchWidths: readonly number[],
): Promise<object> {
	const cwd = join(root, `property-${caseId}-${variant}-workspace`);
	const sessionDir = join(root, `property-${caseId}-${variant}-sessions`);
	const sessionId = `property-${caseId}-${variant}`;
	mkdirSync(cwd, { recursive: true });
	const manager = await SessionManager.create(cwd, sessionDir, { id: sessionId });
	const rootEntryId = manager.appendMessage({
		role: "user",
		content: "partition root",
		timestamp: Date.parse(CREATED_AT),
	});
	await expectReplayMatches(manager, rootEntryId);

	const mutations = partitionMutations(rootEntryId, scenario);
	for (const batch of partitionByWidths(mutations, batchWidths)) {
		const projection = manager.issueCanonicalProjection();
		await manager.commitCanonicalCommand({
			guard: { kind: "exact", token: projection.token },
			mutations: batch,
		});
		await expectReplayMatches(manager, rootEntryId);
	}

	manager.appendFastModeChange(scenario.fastModeEnabled);
	await expectReplayMatches(manager, rootEntryId);
	expect(manager.recordStartingGitContext(manager.getSessionId(), propertyGitContext(scenario))).toBe(true);
	await expectReplayMatches(manager, rootEntryId);
	manager.appendSubagentSpawn({
		toolCallId: `property-call-${caseId}`,
		subagentId: `sa_property_${caseId}`,
		agent: "researcher",
		childSessionId: `property-child-${caseId}`,
		requestKey: `property-request-${caseId}`,
	});
	await expectReplayMatches(manager, rootEntryId);
	const clientMessageId = `property-client-${caseId}`;
	manager.reserveClientInput(clientMessageId, "steer", { message: scenario.clientInputMessage });
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	manager.markClientInputQueued(clientMessageId, {
		delivery: "steer",
		message: scenario.clientInputMessage,
	});
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	manager.transitionClientInput(clientMessageId, "started");
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	manager.rollbackClientInput(clientMessageId);
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	manager.transitionClientInput(clientMessageId, "started");
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	if (scenario.completeClientInput) {
		manager.appendMessage({
			role: "user",
			content: scenario.clientInputMessage,
			timestamp: Date.parse(SECOND_AT),
			clientMessageId,
		});
	} else {
		manager.transitionClientInput(clientMessageId, "failed", scenario.failure);
	}
	await expectReplayMatches(manager, rootEntryId, clientMessageId);

	const beforeRollback = replayComparableState(manager, rootEntryId, clientMessageId);
	const originalApplyTransaction = SQLiteSessionStoreClient.prototype.applyTransaction;
	let injectedRollback = false;
	const applyTransaction = vi
		.spyOn(SQLiteSessionStoreClient.prototype, "applyTransaction")
		.mockImplementation(function (this: SQLiteSessionStoreClient, input) {
			if (!injectedRollback && input.sessionId === manager.getSessionId()) {
				injectedRollback = true;
				return Promise.reject(new Error("Injected pre-commit persistence failure"));
			}
			return originalApplyTransaction.call(this, input);
		});
	const projection = manager.issueCanonicalProjection();
	let rollbackError: unknown;
	try {
		rollbackError = await captureAsyncError(() =>
			manager.commitCanonicalCommand({
				guard: { kind: "exact", token: projection.token },
				mutations: [
					{
						kind: "append",
						entry: { type: "custom", customType: "must-roll-back", data: { caseId } },
					},
				],
			}),
		);
	} finally {
		applyTransaction.mockRestore();
	}
	expect(injectedRollback).toBe(true);
	expect(rollbackError).toMatchObject({ effect: "rolled_back", authority: "available" });
	expect(replayComparableState(manager, rootEntryId, clientMessageId)).toEqual(beforeRollback);
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	expect(
		(await SessionManager.search(cwd, "partition visible text", sessionDir)).map((session) => session.id),
	).toEqual([sessionId]);
	return partitionFinalState(manager, rootEntryId, clientMessageId);
}

beforeEach(() => {
	managerOwner.start();
	root = mkdtempSync(join(tmpdir(), "volt-329-projection-reducer-"));
});

afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	try {
		await managerOwner.drain();
	} catch (error) {
		cleanupErrors.push(error);
	}
	for (const lease of [...leases]) {
		try {
			await lease.release();
		} catch (error) {
			cleanupErrors.push(error);
		}
		leases.delete(lease);
	}
	for (const client of clients.splice(0).reverse()) {
		try {
			await client.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
	if (cleanupErrors.length === 1) throw cleanupErrors[0];
	if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Projection reducer test cleanup failed");
});

describe("PR #329 projection reducer contract", () => {
	describe("low-level client-input admission", () => {
		it("rejects an outstanding receipt beyond the incremental reducer count limit without mutation", async () => {
			const store = await openLowLevelStore("count-limit");
			const atLimit = Array.from({ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES }, (_, index) =>
				acceptedReceiptFixture("count", index, index + 1, `message-${index}`),
			);
			const seeded = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, "count-at-limit", fixturesPayload(atLimit)),
			);

			const incrementalOracle = SessionManager.inMemory(root);
			for (let index = 0; index < CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES; index++) {
				incrementalOracle.reserveClientInput(`count-oracle-${index}`, "steer", { message: `message-${index}` });
			}
			const oracleError = captureError(() =>
				incrementalOracle.reserveClientInput("count-oracle-overflow", "steer", { message: "overflow" }),
			);

			const overflow = acceptedReceiptFixture(
				"count",
				CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
				CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES + 1,
				"overflow",
			);
			const lowLevelError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "count-overflow", fixturesPayload([overflow])),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				seedStatus: seeded.status,
				oracleRejected: oracleError instanceof Error,
				lowLevelErrorCode: errorCode(lowLevelError),
				revision: snapshot?.session.revision,
				clientInputCount: snapshot?.clientInputs.length,
				hasOverflow: snapshot?.clientInputs.some(
					(record) => record.clientMessageId === overflow.projection.clientMessageId,
				),
			}).toEqual({
				seedStatus: "committed",
				oracleRejected: true,
				lowLevelErrorCode: "constraint_failed",
				revision: 1,
				clientInputCount: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
				hasOverflow: false,
			});
		});

		it("rejects aggregate outstanding bytes beyond the incremental reducer budget without mutation", async () => {
			const store = await openLowLevelStore("byte-limit");
			const atLimit = Array.from({ length: 16 }, (_, index) =>
				queuedReceiptFixture("bytes", index, index * 2 + 1, LARGE_CLIENT_INPUT_TEXT),
			);
			const overflow = queuedReceiptFixture(
				"bytes",
				atLimit.length,
				atLimit.length * 2 + 1,
				LARGE_CLIENT_INPUT_TEXT,
			);
			const admittedBytes = atLimit.reduce((total, fixture) => total + clientInputProjectionBytes(fixture), 0);
			const overflowBytes = admittedBytes + clientInputProjectionBytes(overflow);
			expect(admittedBytes).toBeLessThanOrEqual(CLIENT_INPUT_MAX_OUTSTANDING_BYTES);
			expect(overflowBytes).toBeGreaterThan(CLIENT_INPUT_MAX_OUTSTANDING_BYTES);

			const seeded = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, "bytes-at-limit", fixturesPayload(atLimit)),
			);

			const incrementalOracle = SessionManager.inMemory(root);
			for (let index = 0; index < atLimit.length; index++) {
				incrementalOracle.reserveClientInput(`bytes-oracle-${index}`, "steer", {
					message: LARGE_CLIENT_INPUT_TEXT,
				});
				incrementalOracle.markClientInputQueued(`bytes-oracle-${index}`, {
					delivery: "steer",
					message: LARGE_CLIENT_INPUT_TEXT,
				});
			}
			incrementalOracle.reserveClientInput("bytes-oracle-overflow", "steer", {
				message: LARGE_CLIENT_INPUT_TEXT,
			});
			const oracleError = captureError(() =>
				incrementalOracle.markClientInputQueued("bytes-oracle-overflow", {
					delivery: "steer",
					message: LARGE_CLIENT_INPUT_TEXT,
				}),
			);

			const lowLevelError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "bytes-overflow", fixturesPayload([overflow])),
				),
			);
			const summary = await store.client.findSessionSummary(store.sessionId, store.sessionGeneration);

			expect({
				seedStatus: seeded.status,
				oracleRejected: oracleError instanceof Error,
				lowLevelErrorCode: errorCode(lowLevelError),
				revision: summary?.revision,
			}).toEqual({
				seedStatus: "committed",
				oracleRejected: true,
				lowLevelErrorCode: "constraint_failed",
				revision: 1,
			});
		}, 60_000);

		it("keeps recoverable queued inputs within the externally shared outstanding-entry bound", async () => {
			const store = await openLowLevelStore("queue-limit");
			const sharedBound = Math.min(CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES, CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES);
			const atLimit = Array.from({ length: sharedBound }, (_, index) =>
				queuedReceiptFixture("queue", index, index * 2 + 1, `queued-${index}`),
			);
			const seeded = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, "queue-at-limit", fixturesPayload(atLimit)),
			);

			// Every recoverable queued item is also outstanding. This black-box case
			// verifies their shared external bound, not which equal internal guard fires first.
			const overflow = queuedReceiptFixture("queue", sharedBound, sharedBound * 2 + 1, "overflow");
			const lowLevelError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "queue-overflow", fixturesPayload([overflow])),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);
			const recoverableCount = snapshot?.clientInputs.filter(
				(record) => record.state === "accepted" && record.queuedInput !== null,
			).length;

			expect({
				seedStatus: seeded.status,
				lowLevelErrorCode: errorCode(lowLevelError),
				revision: snapshot?.session.revision,
				recoverableCount,
			}).toEqual({
				seedStatus: "committed",
				lowLevelErrorCode: "constraint_failed",
				revision: 1,
				recoverableCount: sharedBound,
			});
		});
	});

	describe("malformed retained projection classification", () => {
		it.each([
			{
				component: "summary" as const,
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare("UPDATE sessions SET updated_at = 'not-a-timestamp' WHERE id = ?")
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt retained summary projection");
				},
			},
			{
				component: "client_inputs" as const,
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare(
							`UPDATE client_inputs SET input_json = '{ "images":[],"message":"pending"}' WHERE session_id = ?`,
						)
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt retained client-input projection");
				},
			},
			{
				component: "search_chunks" as const,
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare("UPDATE search_chunks SET chunk_index = 9007199254740992 WHERE session_id = ?")
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt retained search projection");
				},
			},
		])("classifies malformed $component data and releases the failed-open lease", async ({ component, mutate }) => {
			const cwd = join(root, `corruption-${component}-workspace`);
			const sessionDir = join(root, `corruption-${component}-sessions`);
			mkdirSync(cwd, { recursive: true });
			const manager = await SessionManager.create(cwd, sessionDir, { id: `malformed-${component}` });
			manager.appendMessage({ role: "user", content: "searchable", timestamp: Date.parse(CREATED_AT) });
			manager.reserveClientInput(`pending-${component}`, "prompt", { message: "pending" });
			await manager.flush();
			const ref = manager.getSessionRef();
			if (!ref) throw new Error("Expected persisted corruption reference");
			await manager.closePersistence();

			const database = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
			let foreignKeysValid = false;
			try {
				mutate(database, ref.sessionId);
				foreignKeysValid = database.prepare("PRAGMA foreign_key_check").all().length === 0;
			} finally {
				database.close();
			}

			const openError = await captureAsyncError(() => SessionManager.open(ref));
			const probeLease = await acquireSharedSQLiteSessionStore(sessionDir);
			leases.add(probeLease);
			const close = vi.spyOn(probeLease.client, "close");
			await probeLease.release();
			leases.delete(probeLease);
			const releasedFinalLease = close.mock.calls.length === 1;
			if (!releasedFinalLease) await probeLease.client.close();

			expect({
				foreignKeysValid,
				openErrorCode: errorCode(openError),
				openErrorMessage: errorMessage(openError),
				releasedFinalLease,
			}).toEqual({
				foreignKeysValid: true,
				openErrorCode: "session_store_projection_integrity",
				openErrorMessage: `Session store ${component} projection does not match canonical entries`,
				releasedFinalLease: true,
			});
		});
	});

	describe("batch-local canonical search projection agreement", () => {
		it.each(TRANSACTION_PROJECTION_MISMATCH_CASES)("$name at write time", async ({ name, malformedPayload }) => {
			const store = await openLowLevelStore(
				`projection-${TRANSACTION_PROJECTION_MISMATCH_CASES.findIndex((testCase) => testCase.name === name)}`,
			);
			const canonicalPayload = firstSearchableMessagePayload();
			const rejection = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(
						store.sessionId,
						store.sessionGeneration,
						0,
						`${store.sessionId}-malformed`,
						malformedPayload(canonicalPayload),
					),
				),
			);
			const afterRejection = await store.client.loadSession(store.sessionId, store.sessionGeneration);
			const corrected = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, `${store.sessionId}-corrected`, canonicalPayload),
			);
			const afterCorrected = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				errorCode: errorCode(rejection),
				rejectedRevision: afterRejection?.session.revision,
				rejectedSummary: afterRejection
					? {
							visible: afterRejection.session.visible,
							leafId: afterRejection.session.leafId,
							messageCount: afterRejection.session.messageCount,
							firstMessage: afterRejection.session.firstMessage,
						}
					: undefined,
				rejectedEntryIds: afterRejection?.entries.map((entry) => entry.id),
				rejectedChunks: afterRejection?.searchChunks,
				correctedStatus: corrected.status,
				correctedRevision: afterCorrected?.session.revision,
				correctedSummary: afterCorrected
					? {
							visible: afterCorrected.session.visible,
							leafId: afterCorrected.session.leafId,
							messageCount: afterCorrected.session.messageCount,
							firstMessage: afterCorrected.session.firstMessage,
						}
					: undefined,
				correctedEntryIds: afterCorrected?.entries.map((entry) => entry.id),
				correctedChunks: afterCorrected?.searchChunks,
			}).toEqual({
				errorCode: "constraint_failed",
				rejectedRevision: 0,
				rejectedSummary: { visible: false, leafId: null, messageCount: 0, firstMessage: "" },
				rejectedEntryIds: [],
				rejectedChunks: [],
				correctedStatus: "committed",
				correctedRevision: 1,
				correctedSummary: {
					visible: true,
					leafId: "message-1",
					messageCount: 1,
					firstMessage: "first searchable",
				},
				correctedEntryIds: ["message-1"],
				correctedChunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
			});
		});
	});

	describe("search chunk canonical identity", () => {
		it("rejects rewriting an existing search chunk without a corresponding canonical entry", async () => {
			const store = await openLowLevelStore("search-rewrite");
			await seedSearchableMessage(store);
			const rewritePayload = storePayload({
				session: {
					visible: true,
					leafId: "message-1",
					messageCount: 1,
					firstMessage: "first searchable",
				},
				searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "rewritten text" }],
			});
			const rewriteError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "rewrite-existing-chunk", rewritePayload),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				errorCode: errorCode(rewriteError),
				revision: snapshot?.session.revision,
				chunks: snapshot?.searchChunks,
			}).toEqual({
				errorCode: "constraint_failed",
				revision: 1,
				chunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
			});
		});

		it("rejects a new chunk whose entry identity differs from its canonical searchable entry", async () => {
			const store = await openLowLevelStore("search-identity");
			await seedSearchableMessage(store);
			const invalidIdentityPayload = storePayload({
				session: {
					updatedAt: SECOND_AT,
					visible: true,
					leafId: "message-2",
					messageCount: 2,
					firstMessage: "first searchable",
				},
				entries: [userMessageWrite("message-2", 2, "second searchable", SECOND_AT, "message-1")],
				searchChunks: [{ chunkIndex: 1, entryId: "message-1", text: "second searchable" }],
			});
			const identityError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "wrong-search-entry", invalidIdentityPayload),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				errorCode: errorCode(identityError),
				revision: snapshot?.session.revision,
				entryIds: snapshot?.entries.map((entry) => entry.id),
				chunks: snapshot?.searchChunks,
			}).toEqual({
				errorCode: "constraint_failed",
				revision: 1,
				entryIds: ["message-1"],
				chunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
			});
		});
	});

	describe("fork and import label clearing", () => {
		it("preserves a committed cleared label through fork construction and reopen", async () => {
			const cwd = join(root, "fork-source-workspace");
			const sourceDir = join(root, "fork-source-sessions");
			mkdirSync(cwd, { recursive: true });
			const source = await SessionManager.create(cwd, sourceDir, { id: "clear-label-fork-source" });
			const targetId = source.appendMessage({
				role: "user",
				content: "fork retained",
				timestamp: Date.parse(CREATED_AT),
			});
			source.appendLabelChange(targetId, "temporary");
			source.appendLabelChange(targetId, undefined);
			await source.flush();
			const committedPrefix = clearedLabelState(source, targetId);
			const sourceRef = source.getSessionRef();
			if (!sourceRef) throw new Error("Expected source reference");

			const forkCwd = join(root, "fork-target-workspace");
			const forkDir = join(root, "fork-target-sessions");
			mkdirSync(forkCwd, { recursive: true });
			const forked = await SessionManager.forkFrom(sourceRef, forkCwd, forkDir, { id: "clear-label-fork" });
			await forked.flush();
			const reopened = await SessionManager.open(forked.getSessionRef()!);

			expect(committedPrefix).toEqual({
				label: undefined,
				treeLabel: undefined,
				treeLabelTimestamp: undefined,
				leafType: "label",
				labelEntries: [
					{ targetId, label: "temporary" },
					{ targetId, label: undefined },
				],
				summary: { messageCount: 1, firstMessage: "fork retained", lastActivityTime: Date.parse(CREATED_AT) },
				messages: [{ role: "user", text: "fork retained" }],
			});
			expect(clearedLabelState(forked, targetId)).toEqual(committedPrefix);
			expect(clearedLabelState(reopened, targetId)).toEqual(committedPrefix);
			expect((await SessionManager.search(forkCwd, "fork retained", forkDir)).map((session) => session.id)).toEqual([
				"clear-label-fork",
			]);
		});

		it("preserves a committed empty-cleared label through snapshot import and reopen", async () => {
			const cwd = join(root, "import-source-workspace");
			const sourceDir = join(root, "import-source-sessions");
			mkdirSync(cwd, { recursive: true });
			const source = await SessionManager.create(cwd, sourceDir, { id: "clear-label-import-source" });
			const targetId = source.appendMessage({
				role: "user",
				content: "import retained",
				timestamp: Date.parse(CREATED_AT),
			});
			source.appendLabelChange(targetId, "temporary");
			source.appendLabelChange(targetId, "");
			await source.flush();
			const committedPrefix = clearedLabelState(source, targetId);
			const sourceRef = source.getSessionRef();
			if (!sourceRef) throw new Error("Expected source reference");

			const snapshotPath = join(root, "clear-label.jsonl");
			await SessionManager.exportJsonlSnapshot(sourceRef, snapshotPath);
			const importCwd = join(root, "import-target-workspace");
			const importDir = join(root, "import-target-sessions");
			mkdirSync(importCwd, { recursive: true });
			const imported = await SessionManager.importFromJsonl(snapshotPath, importCwd, importDir, {
				id: "clear-label-import",
			});
			await imported.flush();
			const reopened = await SessionManager.open(imported.getSessionRef()!);

			expect(committedPrefix).toEqual({
				label: undefined,
				treeLabel: undefined,
				treeLabelTimestamp: undefined,
				leafType: "label",
				labelEntries: [
					{ targetId, label: "temporary" },
					{ targetId, label: "" },
				],
				summary: { messageCount: 1, firstMessage: "import retained", lastActivityTime: Date.parse(CREATED_AT) },
				messages: [{ role: "user", text: "import retained" }],
			});
			expect(clearedLabelState(imported, targetId)).toEqual(committedPrefix);
			expect(clearedLabelState(reopened, targetId)).toEqual(committedPrefix);
			expect(
				(await SessionManager.search(importCwd, "import retained", importDir)).map((session) => session.id),
			).toEqual(["clear-label-import"]);
		});
	});

	it(`keeps generated legal partitions and stateful rollback replay-equivalent (seed ${PROJECTION_PROPERTY_SEED})`, async () => {
		let caseId = 0;
		await fc.assert(
			fc.asyncProperty(projectionPropertyScenario, async (scenario) => {
				const currentCaseId = caseId++;
				const oneBatch = await runProjectionPropertyPartition(currentCaseId, "one-batch", scenario, [
					Number.MAX_SAFE_INTEGER,
				]);
				const generatedPartition = await runProjectionPropertyPartition(
					currentCaseId,
					"generated",
					scenario,
					scenario.batchWidths,
				);
				expect(generatedPartition).toEqual(oneBatch);
			}),
			{ seed: PROJECTION_PROPERTY_SEED, numRuns: 8 },
		);
	}, 60_000);
});
