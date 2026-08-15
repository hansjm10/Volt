import { AgentHarness, type SessionMutationReceipt } from "@hansjm10/volt-agent-core";
import { NodeExecutionEnv } from "@hansjm10/volt-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSessionManagerHarnessSession,
	SessionManagerHarnessStorage,
} from "../src/core/harness-session-adapter.ts";
import { DEFAULT_PLANNING_STATE } from "../src/core/planning.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

describe("SessionManager Harness adapter", () => {
	it("maps canonical entry identities and ordinary writes through SessionManager", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const session = createSessionManagerHarnessSession(manager);
		const user = { role: "user", content: "hello", timestamp: Date.now() } as const;

		const messageId = await session.appendMessage(user);
		const thinkingId = await session.appendThinkingLevelChange("high");
		const modelId = await session.appendModelChange("faux", "test-model");
		const customId = await session.appendCustomEntry("test", { value: 1 });

		expect(manager.getEntries().map((entry) => entry.id)).toEqual([messageId, thinkingId, modelId, customId]);
		expect(await session.getEntry(messageId)).toMatchObject({
			type: "message",
			id: messageId,
			parentId: null,
			message: user,
		});
		expect(await session.getLeafId()).toBe(customId);
		expect(await session.getMetadata()).toEqual({
			id: manager.getSessionId(),
			createdAt: manager.getHeader()?.timestamp,
		});
	});

	it("filters Coding-only policy and WAL entries while preserving visible parent chains and context", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendFastModeChange(true);
		manager.appendPlanningState(DEFAULT_PLANNING_STATE);
		manager.reserveClientInput("adapter-private-wal", "prompt", { message: "private" });
		manager.appendThinkingLevelChange("medium");
		manager.appendModelChange("faux", "test-model");
		const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const storage = new SessionManagerHarnessStorage(manager);
		const session = createSessionManagerHarnessSession(manager);

		const entries = await storage.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"message",
			"thinking_level_change",
			"model_change",
			"message",
		]);
		expect(entries.at(-1)).toMatchObject({ id: secondId, parentId: entries[2]?.id });
		expect(await storage.getEntry(secondId)).toMatchObject({ id: secondId, parentId: entries[2]?.id });
		expect(await storage.getEntry(firstId)).toMatchObject({ id: firstId, parentId: null });
		expect(await storage.getLeafId()).toBe(secondId);

		const context = await session.buildContext();
		expect(context).toMatchObject({
			thinkingLevel: "medium",
			model: { provider: "faux", modelId: "test-model" },
			activeToolNames: null,
		});
		expect(context.messages.map((message) => ("content" in message ? message.content : undefined))).toEqual([
			"first",
			"second",
		]);
	});

	it("remaps filtered compaction boundaries to the first visible retained entry", async () => {
		const manager = SessionManager.inMemory("/workspace");
		manager.appendMessage({ role: "user", content: "summarized", timestamp: 1 });
		const canonicalBoundaryId = manager.appendFastModeChange(true);
		manager.appendPlanningState(DEFAULT_PLANNING_STATE);
		const retainedId = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
		const compactionId = manager.appendCompaction("summary", canonicalBoundaryId, 100);
		const storage = new SessionManagerHarnessStorage(manager);
		const session = createSessionManagerHarnessSession(manager);

		expect(manager.getEntry(compactionId)).toMatchObject({
			type: "compaction",
			firstKeptEntryId: canonicalBoundaryId,
		});
		for (const projected of [
			await storage.getEntry(compactionId),
			(await storage.getEntries()).find((entry) => entry.id === compactionId),
			(await storage.getPathToRoot(compactionId)).at(-1),
		]) {
			expect(projected).toMatchObject({
				type: "compaction",
				firstKeptEntryId: retainedId,
			});
		}

		const canonicalContext = manager.buildSessionContext();
		const projectedContext = await session.buildContext();
		expect(projectedContext.messages).toHaveLength(canonicalContext.messages.length);
		expect(projectedContext.messages).toEqual([
			expect.objectContaining({ role: "compactionSummary", summary: "summary" }),
			expect.objectContaining({ role: "user", content: "retained" }),
		]);
	});

	it("maps generic leaf movement and summaries onto SessionManager branching", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const session = createSessionManagerHarnessSession(manager);
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendFastModeChange(true);
		const secondId = manager.appendMessage(fauxAssistantMessage("second"));

		expect(await session.getLeafId()).toBe(secondId);
		await session.moveTo(null);
		expect(manager.getLeafId()).toBeNull();
		expect(await session.getBranch()).toEqual([]);

		const summaryId = await session.moveTo(firstId, { summary: "abandoned branch", fromHook: true });
		expect(summaryId).toBe(manager.getLeafId());
		expect(await session.getEntry(summaryId!)).toMatchObject({
			type: "branch_summary",
			parentId: firstId,
			summary: "abandoned branch",
			fromHook: true,
		});
		expect((await session.getBranch()).map((entry) => entry.id)).toEqual([firstId, summaryId]);
	});

	it("commits guarded canonical batches and authenticates their receipts", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const storage = new SessionManagerHarnessStorage(manager);
		const basis = await storage.getBranchSnapshot();
		const basisReread = await storage.getBranchSnapshot(basis.cursor);
		expect(basisReread).not.toBe(basis);
		expect(basisReread.entries).not.toBe(basis.entries);
		expect(Object.isFrozen(basisReread.entries)).toBe(true);
		const committed = await storage.commitBatch({
			guard: { kind: "exact", cursor: basis.cursor },
			mutations: [
				{
					kind: "append",
					entry: { type: "custom", customType: "inert", data: { value: 1 } },
				},
				{
					kind: "append",
					entry: { type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
				},
			],
		});

		expect(committed.outcome).toBe("committed");
		if (committed.outcome !== "committed") throw new Error("Expected commit");
		expect(committed.record.before.cursor).toBe(basis.cursor);
		expect(committed.record.after.entries.map((entry) => entry.type)).toEqual(["custom", "message"]);
		expect(committed.record.appendedEntryIds).toHaveLength(2);
		const resolved = storage.resolveMutationReceipt(committed.receipt);
		expect(resolved).toEqual(committed.record);
		expect(resolved).not.toBe(committed.record);
		expect(resolved?.after).not.toBe(committed.record.after);
		expect(Object.isFrozen(resolved?.after.entries[0])).toBe(true);
		expect(storage.resolveMutationReceipt(Object.freeze({}) as SessionMutationReceipt)).toBeUndefined();

		const stale = await storage.commitBatch({
			guard: { kind: "exact", cursor: basis.cursor },
			mutations: [{ kind: "append", entry: { type: "custom", customType: "stale" } }],
		});
		expect(stale).toMatchObject({ outcome: "rolled_back", error: { code: "conflict" } });
	});

	it("bridges delivery attempts into Session mutation receipts", async () => {
		const manager = SessionManager.inMemory("/workspace");
		manager.reserveClientInput("client-1", "prompt", { message: "hello" });
		const storage = new SessionManagerHarnessStorage(manager);
		const identity = { deliveryId: "delivery-1", epoch: 1, attemptId: "attempt-1" };
		const receipt = await storage.commitOwnedDelivery({
			...identity,
			messages: [
				{
					role: "user",
					content: "hello",
					clientMessageId: "client-1",
					timestamp: 1,
				},
			],
		});
		const record = storage.resolveMutationReceipt(receipt);

		expect(record?.after.entries.map((entry) => entry.type)).toEqual(["message"]);
		expect(record?.appendedEntryIds).toHaveLength(2);
		expect(manager.getClientInput("client-1")?.state).toBe("completed");

		const noEffect = await storage.attestOwnedDeliveryNoEffect({ ...identity, attemptId: "attempt-2" });
		expect(storage.resolveMutationReceipt(noEffect)).toMatchObject({
			before: record?.after,
			after: record?.after,
			appendedEntryIds: [],
		});
	});

	it("serializes exact guards and receipt evidence against direct SessionManager writers", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const storage = new SessionManagerHarnessStorage(manager);
		const basis = await storage.getBranchSnapshot();
		const commit = storage.commitBatch({
			guard: { kind: "exact", cursor: basis.cursor },
			mutations: [
				{ kind: "append", entry: { type: "message", message: { role: "user", content: "owned", timestamp: 1 } } },
			],
		});

		expect(() => manager.appendMessage({ role: "user", content: "racing", timestamp: 2 })).toThrow(
			"atomic session append",
		);
		const committed = await commit;
		expect(committed.outcome).toBe("committed");
		if (committed.outcome !== "committed") throw new Error("Expected commit");
		const evidence = storage.resolveMutationReceipt(committed.receipt);
		expect(evidence?.before.entries).toEqual([]);
		expect(evidence?.after.entries.map((entry) => entry.type)).toEqual(["message"]);
	});

	it("rejects an exact guard after an unobserved A-to-B-to-A branch cycle", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const secondId = manager.appendMessage(fauxAssistantMessage("second"));
		manager.branch(firstId);
		const storage = new SessionManagerHarnessStorage(manager);
		const basis = await storage.getBranchSnapshot();

		manager.branch(secondId);
		manager.branch(firstId);
		const result = await storage.commitBatch({
			guard: { kind: "exact", cursor: basis.cursor },
			mutations: [
				{ kind: "append", entry: { type: "message", message: { role: "user", content: "stale", timestamp: 2 } } },
			],
		});

		expect(result.outcome).toBe("rolled_back");
		expect(manager.getBranch().map((entry) => entry.id)).toEqual([firstId]);
	});

	it("keeps participant-owned atomic input canonical exactly once while Harness persists ordinary output", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const storage = new SessionManagerHarnessStorage(manager);
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: "/workspace" }),
			session: createSessionManagerHarnessSession(manager, () => false, storage),
			model: registration.getModel(),
			persistActiveToolChanges: false,
			deliveryOwner: {
				prepareLogical: (context) => ({ outcome: "prepared", messages: context.sourceMessages }),
				commitAttempt: async (context) => ({
					outcome: "committed",
					receipt: await storage.commitOwnedDelivery({
						deliveryId: context.deliveryId,
						epoch: context.epoch,
						attemptId: context.attemptId,
						messages: context.preparedMessages,
					}),
				}),
				finish: () => {},
			},
		});

		await harness.setActiveTools([]);
		await harness.runPrompt("durable input");

		const messages = manager.getEntries().filter((entry) => entry.type === "message");
		expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
		expect(messages.filter((entry) => entry.message.role === "user")).toHaveLength(1);
		expect(registration.state.callCount).toBe(1);
	});
});
