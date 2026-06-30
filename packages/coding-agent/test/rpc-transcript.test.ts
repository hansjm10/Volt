import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/volt-ai";
import { describe, expect, test } from "vitest";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp,
	};
}

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

describe("RPC transcript projection", () => {
	test("returns UI-ready transcript items without raw internal payloads", () => {
		const session = SessionManager.inMemory("/Users/jordan/project");
		const firstUserEntryId = session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "image-bytes", mimeType: "image/png" },
			],
			timestamp: 10,
		});
		session.appendMessage(
			assistant(
				[
					{ type: "thinking", thinking: "hidden thought" },
					{ type: "text", text: "I can help." },
					{
						type: "toolCall",
						id: "read-call",
						name: "read",
						arguments: { path: "/Users/jordan/project/src/secret.ts" },
					},
				],
				20,
			),
		);
		const readResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "secret file contents".repeat(100) }],
			isError: false,
			timestamp: 30,
		};
		session.appendMessage(readResult);
		session.appendCompaction("summary ".repeat(500), firstUserEntryId, 1234);
		session.appendMessage(
			assistant(
				[
					{ type: "text", text: "I will edit it." },
					{
						type: "toolCall",
						id: "edit-call",
						name: "edit",
						arguments: { path: "src/secret.ts" },
					},
				],
				40,
			),
		);
		const editResult: ToolResultMessage<{ diff: string; patch: string }> = {
			role: "toolResult",
			toolCallId: "edit-call",
			toolName: "edit",
			content: [{ type: "text", text: "Successfully replaced 1 block in src/secret.ts." }],
			details: { diff: `diff ${"x".repeat(5000)}`, patch: `patch ${"y".repeat(5000)}` },
			isError: false,
			timestamp: 50,
		};
		session.appendMessage(editResult);
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command: "cat /Users/jordan/project/src/secret.ts",
			output: "PRIVATE KEY",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 60,
		};
		session.appendMessage(bashMessage);

		const transcript = projectSessionTranscript(session);

		expect(transcript.sessionId).toBe(session.getSessionId());
		expect(transcript.hasMore).toBe(false);
		expect(transcript.nextBeforeEntryId).toBeNull();
		expect(transcript.items.map((item) => item.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"summary",
			"assistant",
			"tool",
			"tool",
		]);
		expect(transcript.items[0]).toMatchObject({ role: "user", text: "hello" });
		expect(transcript.items[1]).toMatchObject({ role: "assistant", text: "I can help." });
		expect(transcript.items[2]).toMatchObject({
			role: "tool",
			toolName: "read",
			status: "completed",
			path: "/Users/jordan/project/src/secret.ts",
			summary: "Read /Users/jordan/project/src/secret.ts (completed)",
		});
		expect(transcript.items[3]).toMatchObject({ role: "summary", title: "Conversation compacted" });
		expect(transcript.items[5]).toMatchObject({ role: "tool", toolName: "edit", path: "src/secret.ts" });
		if (transcript.items[5].role !== "tool") {
			throw new Error("expected edit tool item");
		}
		expect(transcript.items[5].diffPreview).toContain("[truncated]");
		expect(transcript.items[5].patchPreview).toContain("[truncated]");
		expect(transcript.items[6]).toMatchObject({
			role: "tool",
			toolName: "bash",
			status: "completed",
			summary: "Ran command: cat /Users/jordan/project/src/secret.ts; exit 0",
		});

		const serialized = JSON.stringify(transcript);
		expect(serialized).not.toContain("secret file contents");
		expect(serialized).not.toContain("PRIVATE KEY");
		expect(serialized).not.toContain("hidden thought");
		expect(serialized).not.toContain("image-bytes");
	});

	test("projects bounded subagent args and details for rich remote transcript rendering", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendMessage(
			assistant(
				[
					{ type: "text", text: "Delegating." },
					{
						type: "toolCall",
						id: "subagent-call",
						name: "subagent",
						arguments: {
							agent: "general",
							task: "Review the implementation",
						},
					},
				],
				20,
			),
		);
		const subagentResult: ToolResultMessage<{
			mode: string;
			status: string;
			agent: { name: string; source: string };
			summary: { total: number; completed: number; failed: number; aborted: number; running: number };
			output: { text: string; bytes: number; truncated: boolean; maxBytes: number };
		}> = {
			role: "toolResult",
			toolCallId: "subagent-call",
			toolName: "subagent",
			content: [{ type: "text", text: "model-visible child output" }],
			details: {
				mode: "single",
				status: "completed",
				agent: { name: "general", source: "built-in" },
				summary: { total: 1, completed: 1, failed: 0, aborted: 0, running: 0 },
				output: {
					text: `Child answer ${"x".repeat(1_500)}`,
					bytes: 1_513,
					truncated: false,
					maxBytes: 50_000,
				},
			},
			isError: false,
			timestamp: 30,
		};
		session.appendMessage(subagentResult);

		const transcript = projectSessionTranscript(session);
		const toolItem = transcript.items.find((item) => item.role === "tool");

		expect(toolItem).toMatchObject({
			role: "tool",
			toolName: "subagent",
			status: "completed",
			args: { agent: "general", task: "Review the implementation" },
			details: {
				mode: "single",
				status: "completed",
				agent: { name: "general", source: "built-in" },
				summary: { total: 1, completed: 1, failed: 0, aborted: 0, running: 0 },
				output: {
					bytes: 1_513,
					truncated: false,
					maxBytes: 50_000,
				},
			},
		});
		if (!toolItem || toolItem.role !== "tool") {
			throw new Error("expected subagent tool item");
		}
		const output = (toolItem.details?.output as { text?: unknown } | undefined)?.text;
		expect(output).toEqual(expect.stringContaining("Child answer"));
		expect(output).toEqual(expect.stringContaining("[truncated]"));
		expect(JSON.stringify(transcript)).not.toContain("model-visible child output");
	});

	test("projects displayed review seed messages so remote clients can continue from findings", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendCustomMessageEntry("review", "Automated review result\n\nFindings:\n1. Fix the bug", true, {
			findings: [{ title: "Fix the bug" }],
		});
		session.appendCustomMessageEntry("review", "Hidden review context", false);
		session.appendCustomMessageEntry("extension.note", "Displayed extension note", true);

		const transcript = projectSessionTranscript(session);

		expect(transcript.items).toEqual([
			expect.objectContaining({
				role: "assistant",
				text: "Automated review result\n\nFindings:\n1. Fix the bug",
			}),
		]);
		expect(JSON.stringify(transcript)).not.toContain("Hidden review context");
		expect(JSON.stringify(transcript)).not.toContain("Displayed extension note");
	});

	test("caps limits and paginates older items with beforeEntryId", () => {
		const session = SessionManager.inMemory("/workspace");
		for (let index = 0; index < 205; index++) {
			session.appendMessage(user(`message ${index}`, index));
		}

		const capped = projectSessionTranscript(session, { limit: 1_000 });

		expect(capped.items).toHaveLength(200);
		expect(capped.items[0]).toMatchObject({ role: "user", text: "message 5" });
		expect(capped.items.at(-1)).toMatchObject({ role: "user", text: "message 204" });
		expect(capped.hasMore).toBe(true);
		expect(capped.nextBeforeEntryId).toBe(capped.items[0].id);

		const older = projectSessionTranscript(session, {
			limit: 3,
			beforeEntryId: capped.nextBeforeEntryId ?? undefined,
		});

		expect(older.items.map((item) => (item.role === "user" ? item.text : item.role))).toEqual([
			"message 2",
			"message 3",
			"message 4",
		]);
		expect(older.hasMore).toBe(true);
		expect(older.nextBeforeEntryId).toBe(older.items[0].id);
	});
});
