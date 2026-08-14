import { type AssistantMessage, getModel, type Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestAgentSessionRuntimeConfig, createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(totalTokens: number): Usage {
	const cost = totalTokens / 1_000_000;
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: cost,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

function createAssistantMessage(
	text: string,
	totalTokens: number,
	timestamp: number,
	toolCallCount = 0,
): AssistantMessage {
	const content: AssistantMessage["content"] = [{ type: "text", text }];
	for (let index = 0; index < toolCallCount; index++) {
		content.push({
			type: "toolCall",
			id: `tool-${timestamp}-${index}`,
			name: "read",
			arguments: {},
		});
	}
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		...createTestAgentSessionRuntimeConfig({ model, thinkingLevel: "high" }),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});

	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getSessionStats", () => {
	it("exposes the current context usage alongside token totals", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toEqual(session.getContextUsage());
			expect(stats.contextUsage?.tokens).toBe(200);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.percent).toBe((200 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("reports unknown current context usage immediately after compaction", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4, 1));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats).toMatchObject({
				userMessages: 3,
				assistantMessages: 2,
				toolCalls: 3,
				toolResults: 0,
				totalMessages: 5,
				tokens: { input: 375_000, total: 375_000 },
			});
			expect(stats.cost).toBeCloseTo(0.375);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBeNull();
			expect(stats.contextUsage?.percent).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("uses post-compaction usage for current context instead of stale kept usage", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4, 1));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6, 1));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats).toMatchObject({
				userMessages: 3,
				assistantMessages: 3,
				toolCalls: 4,
				toolResults: 0,
				totalMessages: 6,
				tokens: { input: 400_000, total: 400_000 },
			});
			expect(stats.cost).toBeCloseTo(0.4);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe((25_000 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});
});
