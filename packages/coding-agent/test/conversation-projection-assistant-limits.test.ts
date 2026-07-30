import type { AssistantMessage, AssistantMessageEvent, ToolCall, Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import {
	ConversationProjectionFeed,
	type ConversationProjectionSnapshotBuilder,
	type ConversationProjectionSource,
} from "../src/core/rpc/conversation-projection-feed.ts";
import {
	assertConversationProjectionAssistantSnapshotWithinLimits,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
} from "../src/core/rpc/conversation-projection-limits.ts";
import { measureRpcJsonBytes } from "../src/core/rpc/session-state.ts";
import { StreamProjectionDecoder, StreamProjector } from "../src/core/rpc/stream-projection.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 1,
		...extra,
	};
}

function messageUpdate(event: AssistantMessageEvent): object {
	if (!("snapshot" in event)) throw new Error("Expected snapshot-bearing assistant event");
	return { type: "message_update", message: event.snapshot, assistantMessageEvent: event };
}

class TestSource implements ConversationProjectionSource {
	private readonly listeners = new Set<(event: object) => void>();

	subscribe(listener: (event: object) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: object): void {
		for (const listener of this.listeners) listener(event);
	}
}

const snapshotBuilder: ConversationProjectionSnapshotBuilder = (context) => ({
	conversation: { workspaceName: "scratch", sessionId: "assistant-limits" },
	state: {
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		fastModeEnabled: false,
		planning: { mode: "build", plan: null },
		gitContext: null,
		isStreaming: context.activeAssistant !== null,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "assistant-limits",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		steeringQueue: [],
		followUpQueue: [],
	},
	transcript: {
		sessionId: "assistant-limits",
		items: [],
		hasMore: false,
		nextBeforeEntryId: null,
		projectionVersion: 3,
		branchEpoch: context.branchEpoch,
		head: null,
	},
	activeAssistant: context.activeAssistant,
	activeWorkflows: [],
});

describe("assistant projection resource contract", () => {
	it("accepts exact block, cumulative content, tool JSON, and snapshot budgets but rejects one more", () => {
		const exactBlocks = assistant(
			Array.from({ length: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS }, () => ({
				type: "text" as const,
				text: "",
			})),
		);
		expect(assertConversationProjectionAssistantSnapshotWithinLimits(exactBlocks).contentBytes).toHaveLength(
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
		);
		expect(() =>
			assertConversationProjectionAssistantSnapshotWithinLimits(
				assistant([...exactBlocks.content, { type: "text", text: "" }]),
			),
		).toThrow("128-block content limit");

		const exactText = "x".repeat(DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES);
		expect(
			assertConversationProjectionAssistantSnapshotWithinLimits(assistant([{ type: "text", text: exactText }]))
				.cumulativeContentBytes,
		).toBe(DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES);
		expect(() =>
			assertConversationProjectionAssistantSnapshotWithinLimits(
				assistant([{ type: "text", text: `${exactText}y` }]),
			),
		).toThrow("cumulative content limit");

		const baseTool: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "read",
			arguments: { payload: "" },
		};
		const baseToolBytes = measureRpcJsonBytes(baseTool)!;
		const exactTool: ToolCall = {
			...baseTool,
			arguments: {
				payload: "t".repeat(
					DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES - baseToolBytes,
				),
			},
		};
		expect(measureRpcJsonBytes(exactTool)).toBe(
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
		);
		expect(assertConversationProjectionAssistantSnapshotWithinLimits(assistant([exactTool])).contentBytes).toEqual([
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
		]);
		expect(() =>
			assertConversationProjectionAssistantSnapshotWithinLimits(
				assistant([{ ...exactTool, arguments: { payload: `${exactTool.arguments.payload}u` } }]),
			),
		).toThrow("65536-byte serialized limit");

		const baseSnapshot = assistant([], { responseId: "" });
		const baseSnapshotBytes = measureRpcJsonBytes(baseSnapshot)!;
		const exactSnapshot = assistant([], {
			responseId: "s".repeat(
				DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES - baseSnapshotBytes,
			),
		});
		expect(measureRpcJsonBytes(exactSnapshot)).toBe(
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
		);
		expect(() => assertConversationProjectionAssistantSnapshotWithinLimits(exactSnapshot)).not.toThrow();
		expect(() =>
			assertConversationProjectionAssistantSnapshotWithinLimits({
				...exactSnapshot,
				responseId: `${exactSnapshot.responseId}v`,
			}),
		).toThrow("393216-byte snapshot limit");
	});

	it("fences producer and decoder state before concatenating past the cumulative text budget", () => {
		const exactText = "x".repeat(DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES);
		const projector = new StreamProjector({}, "idle");
		projector.push({ type: "message_start", message: assistant([]) });
		projector.push(
			messageUpdate({
				type: "text_start",
				seq: 1,
				contentIndex: 0,
				snapshot: assistant([{ type: "text", text: "" }]),
				toolState: [],
			}),
		);
		projector.push(
			messageUpdate({
				type: "text_delta",
				seq: 2,
				contentIndex: 0,
				delta: exactText,
				snapshot: assistant([{ type: "text", text: exactText }]),
				toolState: [],
			}),
		);
		expect(projector.state.emitted.get(0)).toBe(exactText);
		expect(() =>
			projector.push(
				messageUpdate({
					type: "text_delta",
					seq: 3,
					contentIndex: 0,
					delta: "y",
					snapshot: assistant([{ type: "text", text: `${exactText}y` }]),
					toolState: [],
				}),
			),
		).toThrow("cumulative content limit");
		expect(projector.state.lastSeq).toBe(2);
		expect(projector.state.emitted.get(0)).toBe(exactText);

		const diagnostics: string[] = [];
		const decoder = new StreamProjectionDecoder({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code) });
		decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant([]) });
		decoder.decode({
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		const exact = decoder.decode({
			type: "message_update",
			stream: { epoch: 1, seq: 2 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: exactText },
		});
		expect((exact as { message: AssistantMessage }).message.content[0]).toEqual({ type: "text", text: exactText });
		expect(
			decoder.decode({
				type: "message_update",
				stream: { epoch: 1, seq: 3 },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y" },
			}),
		).toBeUndefined();
		expect(diagnostics).toContain("invalid_delta_payload");
	});

	it("poisons cached source truth before an oversized assistant can mint an attach cursor", () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: () => "assistant-limit-id" });
		source.emit({
			type: "message_start",
			message: assistant(
				Array.from({ length: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS + 1 }, () => ({
					type: "text" as const,
					text: "",
				})),
			),
		});

		const writes: object[] = [];
		expect(() =>
			feed.attach({
				write: (value) => {
					writes.push(value);
				},
				buildSnapshot: snapshotBuilder,
			}),
		).toThrow("generation is poisoned: Assistant projection exceeded its 128-block content limit");
		expect(writes).toEqual([]);
		feed.dispose();
	});
});
