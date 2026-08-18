import { Buffer } from "node:buffer";
import type { AssistantMessage, ImageContent, ToolResultMessage, UserMessage } from "@hansjm10/volt-ai";
import { describe, expect, test } from "vitest";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import {
	DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
} from "../src/core/rpc/iroh-transport.ts";
import {
	MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
	MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	MESSAGE_IMAGES_PAGE_MAX_ITEMS,
	MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
	MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES,
	projectMessageImages,
	projectSessionTranscript,
} from "../src/core/rpc/transcript.ts";
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
		session.reserveClientInput("client-message-1", "prompt", {
			message: "hello",
			images: [{ type: "image", data: "image-bytes", mimeType: "image/png" }],
		});
		session.transitionClientInput("client-message-1", "started");
		const firstUserEntryId = session.appendMessage({
			role: "user",
			clientMessageId: "client-message-1",
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
		expect(transcript.items[0]).toMatchObject({
			role: "user",
			text: "hello",
			clientMessageId: "client-message-1",
		});
		expect(transcript.items[1]).toMatchObject({ role: "assistant", text: "I can help." });
		expect(transcript.items[2]).toMatchObject({
			role: "tool",
			toolName: "read",
			status: "completed",
			path: "/Users/jordan/project/src/secret.ts",
			args: { path: "/Users/jordan/project/src/secret.ts" },
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
			args: { command: "cat /Users/jordan/project/src/secret.ts" },
			summary: "Ran command: cat /Users/jordan/project/src/secret.ts; exit 0",
		});

		const serialized = JSON.stringify(transcript);
		expect(serialized).not.toContain("secret file contents");
		expect(serialized).not.toContain("PRIVATE KEY");
		expect(serialized).not.toContain("hidden thought");
		expect(serialized).not.toContain("image-bytes");
	});

	test("preserves assistant Markdown text across multiple text content parts", () => {
		const session = SessionManager.inMemory("/workspace");
		const expectedText = ["Here is a plan:", "- Step one", "- Step two", "```swift", "\tlet value = 1", "```"].join(
			"\n",
		);
		const entryId = session.appendMessage(
			assistant(
				[
					{ type: "text", text: "Here is a plan:\n- Step one" },
					{ type: "text", text: "- Step two\n```swift\n\tlet value = 1\n```" },
				],
				20,
			),
		);

		const transcript = projectSessionTranscript(session);

		expect(transcript.items).toContainEqual({
			id: entryId,
			role: "assistant",
			text: expectedText,
			timestamp: expect.any(String),
		});
		expect(JSON.stringify(transcript)).not.toContain("Here is a plan: - Step one - Step two");
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
							confirm: "confirmation-token",
						},
					},
				],
				20,
			),
		);
		const subagentResult: ToolResultMessage<{
			mode: string;
			status: string;
			subagentId: string;
			sessionId: string;
			agent: { name: string; source: string };
			summary: { total: number; completed: number; failed: number; aborted: number; running: number };
			childSessions: Array<{
				index: number;
				subagentId: string;
				sessionId: string;
				agent: { name: string; source: string };
				status: string;
			}>;
			output: { text: string; bytes: number; truncated: boolean; maxBytes: number };
		}> = {
			role: "toolResult",
			toolCallId: "subagent-call",
			toolName: "subagent",
			content: [{ type: "text", text: "model-visible child output" }],
			details: {
				mode: "single",
				status: "completed",
				subagentId: "sa_child",
				sessionId: "child-session",
				agent: { name: "general", source: "built-in" },
				summary: { total: 1, completed: 1, failed: 0, aborted: 0, running: 0 },
				childSessions: [
					{
						index: 0,
						subagentId: "sa_child",
						sessionId: "child-session",
						agent: { name: "general", source: "built-in" },
						status: "completed",
					},
				],
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
				subagentId: "sa_child",
				sessionId: "child-session",
				agent: { name: "general", source: "built-in" },
				summary: { total: 1, completed: 1, failed: 0, aborted: 0, running: 0 },
				childSessions: [
					{
						index: 0,
						subagentId: "sa_child",
						sessionId: "child-session",
						agent: { name: "general", source: "built-in" },
						status: "completed",
					},
				],
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
		// The consumed one-time confirm token is omitted, matching the daemon
		// and iroh projections.
		expect(JSON.stringify(transcript)).not.toContain("confirmation-token");
	});

	test("projects standard subagent registry pagination arguments and summary", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "subagent-list-call",
						name: "subagent_registry",
						arguments: { list: true, cursor: 50 },
					},
				],
				20,
			),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "subagent-list-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "page output" }],
			details: {
				mode: "list",
				status: "completed",
				summary: {
					total: 120,
					completed: 100,
					failed: 10,
					aborted: 5,
					running: 5,
					returned: 50,
					nextCursor: 20,
				},
			},
			isError: false,
			timestamp: 30,
		} as Parameters<typeof session.appendMessage>[0]);

		const transcript = projectSessionTranscript(session);
		const toolItem = transcript.items.find((item) => item.role === "tool");
		expect(toolItem).toMatchObject({
			toolName: "subagent_registry",
			args: { list: true, cursor: 50 },
			details: {
				mode: "list",
				status: "completed",
				summary: { total: 120, returned: 50, nextCursor: 20 },
			},
		});
	});

	test("projects standard subagent registry follow arguments", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "subagent-follow-call",
						name: "subagent_registry",
						arguments: { follow: "sa_existing" },
					},
				],
				20,
			),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "subagent-follow-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "existing result" }],
			details: {
				mode: "follow",
				status: "completed",
				subagentId: "sa_existing",
				agent: { name: "researcher", source: "built-in" },
			},
			isError: false,
			timestamp: 30,
		} as Parameters<typeof session.appendMessage>[0]);

		const transcript = projectSessionTranscript(session);
		const toolItem = transcript.items.find((item) => item.role === "tool");
		expect(toolItem).toMatchObject({
			toolName: "subagent_registry",
			args: { follow: "sa_existing" },
			details: {
				mode: "follow",
				status: "completed",
				subagentId: "sa_existing",
				agent: { name: "researcher", source: "built-in" },
			},
		});
	});

	test("projects nested subagent delegation trees with live fields and a bounded depth", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "subagent-call",
						name: "subagent",
						arguments: { tasks: [{ agent: "researcher", task: "dig" }] },
					},
				],
				20,
			),
		);
		const makeNode = (depth: number): Record<string, unknown> => ({
			subagentId: `sa_depth_${depth}`,
			agent: { name: `agent-${depth}` },
			status: "running",
			task: `level ${depth} task`,
			...(depth < 7 ? { children: [makeNode(depth + 1)] } : {}),
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "subagent-call",
			toolName: "subagent",
			content: [{ type: "text", text: "partial" }],
			details: {
				mode: "parallel",
				status: "running",
				tasks: [
					{
						index: 0,
						subagentId: "sa_task",
						sessionId: "session_task",
						agent: { name: "researcher", source: "built-in" },
						status: "running",
						task: "dig",
						startedAt: 1_000,
						durationMs: 2_500,
						toolCalls: 4,
						tokens: 1_234,
						currentActivity: "read docs/spec.md",
						children: [makeNode(2)],
					},
				],
			},
			isError: false,
			timestamp: 30,
		} as Parameters<typeof session.appendMessage>[0]);

		const transcript = projectSessionTranscript(session);
		const toolItem = transcript.items.find((item) => item.role === "tool");
		if (!toolItem || toolItem.role !== "tool") {
			throw new Error("expected subagent tool item");
		}
		const tasks = (toolItem.details as { tasks?: Array<Record<string, unknown>> }).tasks;
		expect(tasks?.[0]).toMatchObject({
			subagentId: "sa_task",
			status: "running",
			task: "dig",
			startedAt: 1_000,
			durationMs: 2_500,
			toolCalls: 4,
			tokens: 1_234,
			currentActivity: "read docs/spec.md",
		});
		// tasks nest at depth 0; children recurse up to the depth limit of 5.
		let node = tasks?.[0] as { children?: Array<Record<string, unknown>> } | undefined;
		const seen: string[] = [];
		while (node?.children?.[0]) {
			node = node.children[0] as { children?: Array<Record<string, unknown>> };
			seen.push(String((node as { subagentId?: unknown }).subagentId));
		}
		expect(seen).toEqual(["sa_depth_2", "sa_depth_3", "sa_depth_4", "sa_depth_5"]);
		expect(JSON.stringify(transcript)).not.toContain("sa_depth_6");
	});

	test("projects displayed review seed messages so remote clients can continue from findings", () => {
		const privateMarker = "private-github-discussion-marker";
		const session = SessionManager.inMemory("/workspace");
		session.appendCustomMessageEntry("review", "Automated review result\n\nFindings:\n1. Fix the bug", true, {
			findings: [{ title: "Fix the bug" }],
			privateAnalysis: privateMarker,
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
		expect(JSON.stringify(transcript)).not.toContain(privateMarker);
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

	test("advertises imageCount on user items and keeps image-only user messages", () => {
		const session = SessionManager.inMemory("/workspace");
		const withTextEntryId = session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
				{ type: "image", data: "d29ybGQ=", mimeType: "image/png" },
			],
			timestamp: 10,
		});
		const imageOnlyEntryId = session.appendMessage({
			role: "user",
			content: [{ type: "image", data: "b25seQ==", mimeType: "image/jpeg" }],
			timestamp: 20,
		});
		session.appendMessage(user("plain", 30));

		const transcript = projectSessionTranscript(session);

		expect(transcript.items).toEqual([
			{
				id: withTextEntryId,
				role: "user",
				text: "look at this",
				timestamp: expect.any(String),
				imageCount: 2,
			},
			{ id: imageOnlyEntryId, role: "user", text: "", timestamp: expect.any(String), imageCount: 1 },
			expect.objectContaining({ role: "user", text: "plain" }),
		]);
		expect(JSON.stringify(transcript)).not.toContain("aGVsbG8=");
	});

	test("advertises imageCount on tool items with image results and keeps projections text-only", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "read-image-call",
						name: "read",
						arguments: { path: "logo.png" },
					},
				],
				10,
			),
		);
		const imageReadResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 20,
		};
		const toolEntryId = session.appendMessage(imageReadResult);
		const textReadResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [{ type: "text", text: "plain text" }],
			isError: false,
			timestamp: 30,
		};
		session.appendMessage(textReadResult);

		const transcript = projectSessionTranscript(session);
		const toolItems = transcript.items.filter((item) => item.role === "tool");

		expect(toolItems[0]).toMatchObject({ id: toolEntryId, role: "tool", toolName: "read", imageCount: 1 });
		expect(toolItems[1]).not.toHaveProperty("imageCount");
		expect(JSON.stringify(transcript)).not.toContain("aW1hZ2U=");
	});
});

describe("message image recovery", () => {
	function imageWithProjectedBytes(projectedBytes: number, index: number): ImageContent {
		const emptyProjectedImage = { type: "image" as const, data: "", mimeType: "image/png", index };
		const envelopeBytes = Buffer.byteLength(JSON.stringify(emptyProjectedImage), "utf8");
		if (projectedBytes < envelopeBytes) {
			throw new Error("projected image target is smaller than its JSON envelope");
		}
		return { type: "image", data: "A".repeat(projectedBytes - envelopeBytes), mimeType: "image/png" };
	}

	test("keeps an exact-budget image response below the app line cap and rejects one more component byte", () => {
		const emptyProjectedImage = { type: "image", data: "", mimeType: "image/png", index: 0 };
		const emptyProjectedBytes = Buffer.byteLength(JSON.stringify(emptyProjectedImage), "utf8");
		const exactData = "A".repeat(MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES - emptyProjectedBytes);
		const session = SessionManager.inMemory("/workspace");
		const entryId = session.appendMessage({
			role: "user",
			content: [{ type: "image", data: exactData, mimeType: "image/png" }],
			timestamp: 10,
		});

		const exact = projectMessageImages(session.getBranch(), entryId);
		expect(exact.ok).toBe(true);
		if (!exact.ok) throw new Error("expected exact-budget image page");
		expect(Buffer.byteLength(JSON.stringify(exact.images[0]), "utf8")).toBe(MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES);
		const response = {
			id: "image-request",
			type: "response",
			command: "get_message_images",
			success: true,
			data: {
				workspaceName: "scratch",
				sessionId: session.getSessionId(),
				entryId,
				totalImages: exact.totalImages,
				images: exact.images,
				nextImageIndex: exact.nextImageIndex,
			},
		};
		const responseContentBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
		expect(responseContentBytes).toBeLessThanOrEqual(DEFAULT_IROH_RPC_MAX_LINE_BYTES);
		expect(responseContentBytes + 1).toBeLessThanOrEqual(DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES);
		expect(DEFAULT_IROH_RPC_MAX_LINE_BYTES - MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES).toBe(
			MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES,
		);

		const oversized = SessionManager.inMemory("/workspace");
		const oversizedEntryId = oversized.appendMessage({
			role: "user",
			content: [{ type: "image", data: `${exactData}B`, mimeType: "image/png" }],
			timestamp: 10,
		});
		expect(projectMessageImages(oversized.getBranch(), oversizedEntryId)).toEqual({
			ok: false,
			error: "image_too_large",
		});
	});

	test("accepts the exact per-entry serialized image budget and rejects one more byte", () => {
		const imageCount = 5;
		const baseImageBytes = Math.floor(MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES / imageCount);
		const imageByteTargets = Array.from({ length: imageCount }, (_, index) =>
			index === imageCount - 1
				? MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES - baseImageBytes * (imageCount - 1)
				: baseImageBytes,
		);
		expect(Math.max(...imageByteTargets)).toBeLessThan(MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES);

		const exact = SessionManager.inMemory("/workspace");
		const exactEntryId = exact.appendMessage({
			role: "user",
			content: imageByteTargets.map((bytes, index) => imageWithProjectedBytes(bytes, index)),
			timestamp: 10,
		});
		const exactResult = projectMessageImages(exact.getBranch(), exactEntryId);
		expect(exactResult.ok).toBe(true);
		if (!exactResult.ok) throw new Error("expected exact aggregate image budget to be accepted");
		expect(exactResult.totalImages).toBe(imageCount);
		expect(exactResult.images).toHaveLength(1);
		expect(exactResult.nextImageIndex).toBe(1);

		const oversized = SessionManager.inMemory("/workspace");
		const oversizedTargets = [...imageByteTargets];
		oversizedTargets[oversizedTargets.length - 1] += 1;
		const oversizedEntryId = oversized.appendMessage({
			role: "user",
			content: oversizedTargets.map((bytes, index) => imageWithProjectedBytes(bytes, index)),
			timestamp: 10,
		});
		expect(projectMessageImages(oversized.getBranch(), oversizedEntryId)).toEqual({
			ok: false,
			error: "image_bytes_exceeded",
		});
	});

	test("accepts the exact per-entry image count and rejects one more image", () => {
		const exact = SessionManager.inMemory("/workspace");
		const exactEntryId = exact.appendMessage({
			role: "user",
			content: Array.from({ length: MESSAGE_IMAGES_ENTRY_MAX_ITEMS }, (_, index) => ({
				type: "image" as const,
				data: Buffer.from(String(index)).toString("base64"),
				mimeType: "image/png",
			})),
			timestamp: 10,
		});
		const exactResult = projectMessageImages(exact.getBranch(), exactEntryId);
		expect(exactResult.ok).toBe(true);
		if (!exactResult.ok) throw new Error("expected exact image count to be accepted");
		expect(exactResult.totalImages).toBe(MESSAGE_IMAGES_ENTRY_MAX_ITEMS);
		expect(exactResult.images).toHaveLength(MESSAGE_IMAGES_PAGE_MAX_ITEMS);
		expect(exactResult.nextImageIndex).toBe(MESSAGE_IMAGES_PAGE_MAX_ITEMS);

		const oversized = SessionManager.inMemory("/workspace");
		const oversizedEntryId = oversized.appendMessage({
			role: "user",
			content: Array.from({ length: MESSAGE_IMAGES_ENTRY_MAX_ITEMS + 1 }, () => ({
				type: "image" as const,
				data: "QQ==",
				mimeType: "image/png",
			})),
			timestamp: 10,
		});
		expect(projectMessageImages(oversized.getBranch(), oversizedEntryId)).toEqual({
			ok: false,
			error: "image_count_exceeded",
		});
	});

	test("returns the image blocks for an entry with paging metadata", () => {
		const session = SessionManager.inMemory("/workspace");
		const entryId = session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "two shots" },
				{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg" },
				{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
			],
			timestamp: 10,
		});

		const result = projectMessageImages(session.getBranch(), entryId);

		expect(result).toEqual({
			ok: true,
			entryId,
			totalImages: 2,
			images: [
				{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg", index: 0 },
				{ type: "image", data: "c2Vjb25k", mimeType: "image/png", index: 1 },
			],
			nextImageIndex: null,
		});
	});

	test("pages under the serialized byte budget", () => {
		const session = SessionManager.inMemory("/workspace");
		const bigImage = "A".repeat(100);
		const entryId = session.appendMessage({
			role: "user",
			content: [
				{ type: "image", data: bigImage, mimeType: "image/jpeg" },
				{ type: "image", data: bigImage, mimeType: "image/jpeg" },
				{ type: "image", data: "small", mimeType: "image/jpeg" },
			],
			timestamp: 10,
		});

		const firstPage = projectMessageImages(session.getBranch(), entryId, 0, 180);
		expect(firstPage.ok).toBe(true);
		if (!firstPage.ok) {
			throw new Error("expected ok result");
		}
		expect(firstPage.totalImages).toBe(3);
		expect(firstPage.images.map((image) => image.index)).toEqual([0]);
		expect(firstPage.nextImageIndex).toBe(1);

		const secondPage = projectMessageImages(session.getBranch(), entryId, firstPage.nextImageIndex ?? 0, 180);
		expect(secondPage.ok).toBe(true);
		if (!secondPage.ok) {
			throw new Error("expected ok result");
		}
		expect(secondPage.totalImages).toBe(firstPage.totalImages);
		expect(secondPage.images.map((image) => image.index)).toEqual([1]);
		expect(secondPage.nextImageIndex).toBe(2);

		const finalPage = projectMessageImages(session.getBranch(), entryId, secondPage.nextImageIndex ?? 0, 180);
		expect(finalPage.ok).toBe(true);
		if (!finalPage.ok) {
			throw new Error("expected ok result");
		}
		expect(finalPage.totalImages).toBe(firstPage.totalImages);
		expect(finalPage.images.map((image) => image.index)).toEqual([2]);
		expect(finalPage.nextImageIndex).toBeNull();
	});

	test("rejects cursors that cannot produce the next contiguous nonempty page", () => {
		const session = SessionManager.inMemory("/workspace");
		const entryId = session.appendMessage({
			role: "user",
			content: [
				{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg" },
				{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
			],
			timestamp: 10,
		});

		for (const invalidCursor of [-1, 0.5, 2, 3, Number.MAX_SAFE_INTEGER + 1]) {
			expect(projectMessageImages(session.getBranch(), entryId, invalidCursor)).toEqual({
				ok: false,
				error: "invalid_cursor",
			});
		}
	});

	test("rejects a single image that cannot fit in a response page", () => {
		const session = SessionManager.inMemory("/workspace");
		const entryId = session.appendMessage({
			role: "user",
			content: [{ type: "image", data: "A".repeat(1_000), mimeType: "image/jpeg" }],
			timestamp: 10,
		});

		expect(projectMessageImages(session.getBranch(), entryId, 0, 100)).toEqual({
			ok: false,
			error: "image_too_large",
		});
	});

	test("caps the number of images returned in one page", () => {
		const session = SessionManager.inMemory("/workspace");
		const entryId = session.appendMessage({
			role: "user",
			content: Array.from({ length: 40 }, (_, index) => ({
				type: "image" as const,
				data: Buffer.from(String(index)).toString("base64"),
				mimeType: "image/png",
			})),
			timestamp: 10,
		});

		const result = projectMessageImages(session.getBranch(), entryId);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("expected ok result");
		}
		expect(result.images).toHaveLength(32);
		expect(result.nextImageIndex).toBe(32);
	});

	test("returns an empty page for entries without images", () => {
		const session = SessionManager.inMemory("/workspace");
		const entryId = session.appendMessage(user("no images here", 10));

		expect(projectMessageImages(session.getBranch(), entryId)).toEqual({
			ok: true,
			entryId,
			totalImages: 0,
			images: [],
			nextImageIndex: null,
		});
	});

	test("recovers image blocks persisted on a tool result entry", () => {
		const session = SessionManager.inMemory("/workspace");
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 10,
		};
		const entryId = session.appendMessage(toolResult);

		expect(projectMessageImages(session.getBranch(), entryId)).toEqual({
			ok: true,
			entryId,
			totalImages: 1,
			images: [{ type: "image", data: "dG9vbA==", mimeType: "image/png", index: 0 }],
			nextImageIndex: null,
		});
	});

	test("rejects unknown entries", () => {
		const session = SessionManager.inMemory("/workspace");
		session.appendMessage(user("hello", 10));

		expect(projectMessageImages(session.getBranch(), "missing-entry")).toEqual({
			ok: false,
			error: "unknown_entry",
		});
	});
});
