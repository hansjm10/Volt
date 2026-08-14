import { AgentHarness, type AgentMessage } from "@hansjm10/volt-agent-core";
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

	it("keeps participant-owned atomic input canonical exactly once while Harness persists ordinary output", async () => {
		const manager = SessionManager.inMemory("/workspace");
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: "/workspace" }),
			session: createSessionManagerHarnessSession(manager),
			model: registration.getModel(),
			persistActiveToolChanges: false,
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						await manager.appendAtomically(
							() => {
								for (const message of delivery.messages) appendCanonicalMessage(manager, message);
							},
							() => {},
						);
						return { outcome: "committed" };
					},
				},
			}),
		});

		await harness.setActiveTools([]);
		await harness.runPrompt("durable input");

		const messages = manager.getEntries().filter((entry) => entry.type === "message");
		expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
		expect(messages.filter((entry) => entry.message.role === "user")).toHaveLength(1);
		expect(registration.state.callCount).toBe(1);
	});
});

function appendCanonicalMessage(manager: SessionManager, message: AgentMessage): void {
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		throw new Error(`Unexpected summary delivery: ${message.role}`);
	}
	manager.appendMessage(message);
}
