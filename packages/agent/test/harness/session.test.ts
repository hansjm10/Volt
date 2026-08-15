import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStorage } from "../../src/harness/session/jsonl-storage.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { SessionStorage } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage, getLatestTempDir } from "./session-test-utils.ts";

async function runSessionSuite(
	name: string,
	createStorage: () => SessionStorage | Promise<SessionStorage>,
	inspect?: () => void,
) {
	describe(name, () => {
		it("commits guarded batches and resolves only store-issued receipts", async () => {
			const session = new Session(await createStorage());
			const basis = await session.getBranchSnapshot();
			const result = await session.commitBatch({
				guard: { kind: "exact", cursor: basis.cursor },
				deliveryAttribution: { deliveryId: "delivery-1", epoch: 2, attemptId: "attempt-3" },
				mutations: [
					{ kind: "append", entry: { type: "message", message: createUserMessage("one") } },
					{ kind: "append", entry: { type: "custom", customType: "host-only", data: { ok: true } } },
				],
			});
			expect(result.outcome).toBe("committed");
			if (result.outcome !== "committed") return;
			expect(result.appendedEntryIds).toHaveLength(2);
			expect(result.advance).toMatchObject({
				branchRelation: "descendant",
				messages: { kind: "append", values: [{ role: "user" }] },
			});
			expect(session.resolveMutationReceipt(result.receipt)).toEqual({
				advance: result.advance,
				appendedEntryIds: result.appendedEntryIds,
				deliveryAttribution: { deliveryId: "delivery-1", epoch: 2, attemptId: "attempt-3" },
			});
			const otherSession = new Session(await createStorage());
			expect(otherSession.resolveMutationReceipt(result.receipt)).toBeUndefined();
		});

		it("rolls back stale exact guards and receipts isolate descendant batch effects", async () => {
			const session = new Session(await createStorage());
			const basis = await session.getBranchSnapshot();
			await session.appendMessage(createUserMessage("one"));
			const exact = await session.commitBatch({
				guard: { kind: "exact", cursor: basis.cursor },
				mutations: [{ kind: "append", entry: { type: "custom", customType: "exact" } }],
			});
			expect(exact).toMatchObject({ outcome: "rolled_back", error: { code: "conflict" } });
			const descendant = await session.commitBatch({
				guard: { kind: "descendant", cursor: basis.cursor },
				mutations: [{ kind: "append", entry: { type: "custom", customType: "tail" } }],
			});
			expect(descendant).toMatchObject({
				outcome: "committed",
				advance: { branchRelation: "descendant", messages: { kind: "unchanged" } },
			});
			if (descendant.outcome !== "committed") return;
			expect(session.resolveMutationReceipt(descendant.receipt)?.advance).toMatchObject({
				branchRelation: "descendant",
				messages: { kind: "unchanged" },
			});
			expect(await session.advanceProjection(basis.cursor)).toMatchObject({
				branchRelation: "descendant",
				messages: { kind: "append", values: [{ role: "user" }] },
			});
		});

		it("atomically moves, summarizes, and labels the generated summary", async () => {
			const session = new Session(await createStorage());
			const root = await session.appendMessage(createUserMessage("root"));
			await session.appendMessage(createAssistantMessage("old branch"));
			const basis = await session.getBranchSnapshot();
			const result = await session.commitBatch({
				guard: { kind: "exact", cursor: basis.cursor },
				mutations: [
					{
						kind: "move_with_summary",
						leafId: root,
						summary: { summary: "abandoned work", label: "checkpoint" },
					},
				],
			});
			expect(result.outcome).toBe("committed");
			if (result.outcome !== "committed") return;
			const committedEntries = await Promise.all(result.appendedEntryIds.map((id) => session.getEntry(id)));
			const summary = committedEntries.find((entry) => entry?.type === "branch_summary");
			expect(summary).toMatchObject({ type: "branch_summary", parentId: root, summary: "abandoned work" });
			expect(await session.getLabel(summary!.id)).toBe("checkpoint");
			expect((await session.buildContext()).messages.map((message) => message.role)).toEqual([
				"user",
				"branchSummary",
			]);
		});

		it("issues attributed no-effect receipts without appending entries", async () => {
			const session = new Session(await createStorage());
			const basis = await session.getBranchSnapshot();
			const result = await session.commitBatch({
				guard: { kind: "exact", cursor: basis.cursor },
				deliveryAttribution: { deliveryId: "delivery-1", epoch: 1, attemptId: "attempt-1" },
				mutations: [],
			});
			expect(result).toMatchObject({
				outcome: "committed",
				advance: { branchRelation: "same", messages: { kind: "unchanged" } },
				appendedEntryIds: [],
			});
			if (result.outcome !== "committed") return;
			expect(session.resolveMutationReceipt(result.receipt)?.deliveryAttribution).toEqual({
				deliveryId: "delivery-1",
				epoch: 1,
				attemptId: "attempt-1",
			});
			expect(await session.getEntries()).toEqual([]);
		});

		it("classifies provider-inert policy advances without object identity checks", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			const basis = await session.getBranchSnapshot();
			await session.appendCustomEntry("host-only", { ok: true });
			let advance = await session.advanceProjection(basis.cursor);
			expect(advance).toMatchObject({
				branchRelation: "descendant",
				messages: { kind: "unchanged" },
				persistedPolicyChanged: false,
			});
			await session.appendModelChange("openai", "gpt-4.1");
			advance = await session.advanceProjection(basis.cursor);
			expect(advance).toMatchObject({
				messages: { kind: "unchanged" },
				persistedPolicy: { model: { provider: "openai", modelId: "gpt-4.1" } },
				persistedPolicyChanged: true,
			});
		});

		it("classifies branch divergence and compaction as rewrites", async () => {
			const session = new Session(await createStorage());
			const root = await session.appendMessage(createUserMessage("root"));
			await session.appendMessage(createAssistantMessage("old"));
			const oldBranch = await session.getBranchSnapshot();
			await session.moveTo(root);
			await session.appendMessage(createAssistantMessage("new"));
			expect(await session.advanceProjection(oldBranch.cursor)).toMatchObject({
				branchRelation: "diverged",
				messages: { kind: "rewrite", values: [{ role: "user" }, { role: "assistant" }] },
			});

			const beforeCompaction = await session.getBranchSnapshot();
			await session.appendCompaction("summary", root, 100);
			expect(await session.advanceProjection(beforeCompaction.cursor)).toMatchObject({
				branchRelation: "descendant",
				messages: { kind: "rewrite" },
			});
		});

		it("appends messages and builds context in order", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("tracks model and thinking level changes", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendModelChange("openai", "gpt-4.1");
			await session.appendThinkingLevelChange("high");
			const context = await session.buildContext();
			expect(context.thinkingLevel).toBe("high");
			expect(context.model).toEqual({ provider: "openai", modelId: "gpt-4.1" });
		});

		it("supports branching by moving the leaf and appending a new branch", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			const assistant1 = await session.appendMessage(createAssistantMessage("two"));
			await session.appendMessage(createUserMessage("three"));
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const branch = await session.getBranch();
			expect(branch.map((entry) => entry.id)).toContain(user1);
			expect(branch.map((entry) => entry.id)).not.toContain(assistant1);
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("supports moving the leaf to root", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.moveTo(null);
			expect(await session.getLeafId()).toBeNull();
			expect((await session.buildContext()).messages).toEqual([]);
		});

		it("reconstructs compaction summaries in context", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const user2 = await session.appendMessage(createUserMessage("three"));
			await session.appendMessage(createAssistantMessage("four"));
			await session.appendCompaction("summary", user2, 1234);
			await session.appendMessage(createUserMessage("five"));
			const context = await session.buildContext();
			expect(context.messages[0]?.role).toBe("compactionSummary");
			expect(context.messages).toHaveLength(4);
		});

		it("supports moving with branch summary entries in context", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			const summaryId = await session.moveTo(user1, { summary: "summary text" });
			expect(summaryId).toBeTruthy();
			const summaryEntry = await session.getEntry(summaryId!);
			expect(summaryEntry).toMatchObject({ type: "branch_summary", parentId: user1, fromId: user1 });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("branchSummary");
		});

		it("supports custom message entries in context", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomMessageEntry("custom", "hello", true, { ok: true });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("custom");
		});

		it("supports labels and session info entries without affecting context", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			const entries = await session.getEntries();
			expect(entries.some((entry) => entry.type === "label")).toBe(true);
			expect(entries.some((entry) => entry.type === "session_info")).toBe(true);
			expect(await session.getLabel(user1)).toBe("checkpoint");
			expect(await session.getSessionName()).toBe("name");
			expect((await session.buildContext()).messages).toHaveLength(1);
		});

		it("rejects labels for missing entries", async () => {
			const session = new Session(await createStorage());
			await expect(session.appendLabel("missing", "checkpoint")).rejects.toThrow("Entry missing not found");
		});

		it("persists leaf changes and appended entries via storage", async () => {
			const storage = await createStorage();
			const session = new Session(storage);
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const session2 = new Session(storage);
			const context = await session2.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(await session2.getLabel(user1)).toBe("checkpoint");
			expect(await session2.getSessionName()).toBe("name");
			inspect?.();
		});
	});
}

runSessionSuite("Session with in-memory storage", () => new InMemorySessionStorage());

runSessionSuite(
	"Session with JSONL storage",
	async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		return await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), { cwd: dir, sessionId: "session-1" });
	},
	() => {
		const dir = getLatestTempDir();
		const filePath = join(dir, "session.jsonl");
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThan(1);
		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		const entries = lines.slice(1).map((line) => JSON.parse(line));
		expect(entries.some((entry) => entry.type === "leaf")).toBe(true);
		for (const entry of entries) {
			expect(entry.type).not.toBe("entry");
			expect(typeof entry.id).toBe("string");
		}
	},
);
