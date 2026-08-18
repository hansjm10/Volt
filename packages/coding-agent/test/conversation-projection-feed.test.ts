import { Buffer } from "node:buffer";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type JsonObject,
	parseStreamingJson,
	type ToolCall,
	type Usage,
} from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	ConversationProjectionFeed,
	type ConversationProjectionRecoveryRequest,
	type ConversationProjectionSnapshotBuilder,
	type ConversationProjectionSource,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS,
	DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_EVENT_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_TRANSCRIPT_CURSORS,
} from "../src/core/rpc/conversation-projection-feed.ts";
import { type ProjectionSanitizer, StreamProjectionDecoder } from "../src/core/rpc/stream-projection.ts";
import type {
	RpcCommandType,
	RpcConversationAssistantPart,
	RpcConversationBootstrapEvent,
	RpcConversationTranscriptItem,
	RpcGitContext,
	RpcSessionState,
	RpcWorkflowEvent,
	RpcWorkflowToolEvent,
} from "../src/core/rpc/types.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const AUTHORITY_SCOPED_RESPONSE_COMMANDS = [
	"get_fork_messages",
	"get_last_assistant_text",
	"get_message_images",
	"get_messages",
	"get_session_stats",
	"get_session_tree",
	"get_state",
	"get_transcript",
	"get_transcript_entry_text",
] as const satisfies readonly RpcCommandType[];

const TEST_GIT_CONTEXT: RpcGitContext = {
	repository: "workspace",
	head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
	upstream: null,
	base: null,
	status: {
		staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		untracked: 0,
		conflicted: 0,
		total: 0,
		clean: true,
	},
	operation: null,
	revision: 1,
	observedAt: "2026-07-29T00:00:00.000Z",
	stale: false,
};

class TestSource implements ConversationProjectionSource {
	private readonly listeners = new Set<(event: object) => void>();
	private readonly authorityListeners = new Set<(error: Error) => void>();
	private readonly branchListeners = new Set<() => void>();
	revision = 0;
	observationCount = 0;

	subscribe(listener: (event: object) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	retainObservation(): () => void {
		this.observationCount++;
		return () => {
			this.observationCount--;
		};
	}

	subscribeAuthorityLoss(listener: (error: Error) => void): () => void {
		this.authorityListeners.add(listener);
		return () => this.authorityListeners.delete(listener);
	}

	subscribeGenerationChanges(listener: () => void): () => void {
		this.branchListeners.add(listener);
		return () => this.branchListeners.delete(listener);
	}

	emit(event: object): void {
		this.revision++;
		for (const listener of this.listeners) listener(event);
	}

	rebase(): void {
		this.revision++;
		for (const listener of this.branchListeners) listener();
	}

	loseAuthority(error: Error): void {
		for (const listener of this.authorityListeners) listener(error);
	}
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: 1,
	};
}

function textDelta(seq: number, text: string, delta: string): Extract<AssistantMessageEvent, { type: "text_delta" }> {
	return {
		type: "text_delta",
		seq,
		contentIndex: 0,
		delta,
		snapshot: assistant(text),
		toolState: [],
	};
}

function messageUpdate(event: AssistantMessageEvent): object {
	if (!("snapshot" in event)) throw new Error("Expected a snapshot-bearing event");
	return { type: "message_update", message: event.snapshot, assistantMessageEvent: event };
}

function makeIds(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}-${++next}`;
}

function recoveryRequest(requestId: string, lastAppliedCursor = 0): ConversationProjectionRecoveryRequest {
	return { requestId, lastAppliedCursor, reason: "cursor_gap" };
}

function snapshotBuilder(source: TestSource, label = "test"): ConversationProjectionSnapshotBuilder {
	return ({ activeAssistant, branchEpoch }) => ({
		conversation: { workspaceName: label, sessionId: `session-${label}` },
		state: {
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			fastModeEnabled: false,
			planning: { mode: "build", plan: null },
			gitContext: null,
			isStreaming: activeAssistant !== null,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionId: `session-${label}`,
			autoCompactionEnabled: true,
			messageCount: source.revision,
			pendingMessageCount: 0,
			steeringQueue: [],
			followUpQueue: [],
			revision: source.revision,
			branchEpoch,
		} as RpcSessionState & { revision: number; branchEpoch: string },
		transcript: {
			sessionId: `session-${label}`,
			items: [],
			hasMore: false,
			nextBeforeEntryId: null,
			projectionVersion: 3,
			branchEpoch,
			head: null,
		},
		activeAssistant,
		activeWorkflows: [],
	});
}

function paddedSnapshotBuilder(source: TestSource, paddingBytes: number): ConversationProjectionSnapshotBuilder {
	return (context) => {
		const snapshot = snapshotBuilder(source)(context);
		return { ...snapshot, state: { ...snapshot.state, testPadding: "s".repeat(paddingBytes) } };
	};
}

function prepareJsonl(value: object): { value: object; bytes: number } {
	return { value, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") + 1 };
}

function delivery(value: object): { subscriptionId: string; cursor: number } {
	return (value as { delivery: { subscriptionId: string; cursor: number } }).delivery;
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function replacingSanitizer(from: string, to: string): ProjectionSanitizer {
	const replace = (value: unknown): unknown => {
		if (typeof value === "string") return value.replaceAll(from, to);
		if (Array.isArray(value)) return value.map(replace);
		if (typeof value === "object" && value !== null) {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
		}
		return value;
	};
	return {
		sanitizeText: (value) => value.replaceAll(from, to),
		sanitizeValue: replace,
	};
}

const OUTER_FEED_PROPERTY_SEED = 0x51a77ac;

interface GeneratedFeedConversation {
	thinkingChunks: string[];
	textChunks: string[];
	toolPathSuffix: string;
	toolChunkWidths: number[];
	redactedThinking: boolean;
	boundary: "active" | "stop" | "aborted";
	activePrefixSeed: number;
}

interface AssistantOracleState {
	activeAssistant: AssistantMessage | null;
	finalAssistant: AssistantMessage | null;
}

const generatedToken = fc
	.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), { minLength: 1, maxLength: 8 })
	.map((characters) => characters.join(""));

const generatedFeedConversation = fc.record({
	thinkingChunks: fc.array(generatedToken, { minLength: 1, maxLength: 3 }),
	textChunks: fc.array(generatedToken, { minLength: 1, maxLength: 4 }),
	toolPathSuffix: generatedToken,
	toolChunkWidths: fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 5 }),
	redactedThinking: fc.boolean(),
	boundary: fc.constantFrom("active", "stop", "aborted"),
	activePrefixSeed: fc.nat(),
}) satisfies fc.Arbitrary<GeneratedFeedConversation>;

class OracleTestSource extends TestSource {
	finalAssistant: AssistantMessage | null = null;

	override emit(event: object): void {
		const record = event as { type?: string; message?: AssistantMessage };
		if (record.type === "message_start") {
			this.finalAssistant = null;
		} else if (record.type === "message_end" && record.message?.role === "assistant") {
			this.finalAssistant = record.message;
		}
		super.emit(event);
	}
}

function splitGeneratedValue(value: string, widths: readonly number[]): string[] {
	const chunks: string[] = [];
	let offset = 0;
	let widthIndex = 0;
	while (offset < value.length) {
		const width = widths[widthIndex % widths.length] ?? 1;
		chunks.push(value.slice(offset, offset + width));
		offset += width;
		widthIndex++;
	}
	return chunks;
}

function assistantWithContent(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: 1,
	};
}

function generatedConversationEvents(value: GeneratedFeedConversation): object[] {
	const events: object[] = [];
	let seq = 0;
	let thinking = "";
	let text = "";
	let textStarted = false;
	let toolCall: ToolCall | undefined;
	let toolArgsText = "";

	const currentContent = (): AssistantMessage["content"] => [
		{
			type: "thinking",
			thinking,
			redacted: value.redactedThinking,
		},
		...(textStarted ? [{ type: "text" as const, text }] : []),
		...(toolCall === undefined ? [] : [toolCall]),
	];
	const currentAssistant = (): AssistantMessage => assistantWithContent(currentContent());
	const pushUpdate = (event: AssistantMessageEvent): void => {
		events.push(messageUpdate(event));
	};

	events.push({ type: "message_start", message: assistantWithContent([]) });
	pushUpdate({
		type: "thinking_start",
		seq: ++seq,
		contentIndex: 0,
		redacted: value.redactedThinking,
		snapshot: currentAssistant(),
		toolState: [],
	});
	for (const [index, rawChunk] of value.thinkingChunks.entries()) {
		const chunk = index === 0 ? `/secret/${rawChunk}` : rawChunk;
		thinking += chunk;
		pushUpdate({
			type: "thinking_delta",
			seq: ++seq,
			contentIndex: 0,
			delta: chunk,
			snapshot: currentAssistant(),
			toolState: [],
		});
	}
	pushUpdate({
		type: "thinking_end",
		seq: ++seq,
		contentIndex: 0,
		content: thinking,
		redacted: value.redactedThinking,
		snapshot: currentAssistant(),
		toolState: [],
	});

	textStarted = true;
	pushUpdate({
		type: "text_start",
		seq: ++seq,
		contentIndex: 1,
		snapshot: currentAssistant(),
		toolState: [],
	});
	for (const [index, rawChunk] of value.textChunks.entries()) {
		const chunk = index === 0 ? `/secret/${rawChunk}` : rawChunk;
		text += chunk;
		pushUpdate({
			type: "text_delta",
			seq: ++seq,
			contentIndex: 1,
			delta: chunk,
			snapshot: currentAssistant(),
			toolState: [],
		});
	}
	pushUpdate({
		type: "text_end",
		seq: ++seq,
		contentIndex: 1,
		content: text,
		snapshot: currentAssistant(),
		toolState: [],
	});

	toolCall = { type: "toolCall", id: "property-tool", name: "read", arguments: {} };
	pushUpdate({
		type: "toolcall_start",
		seq: ++seq,
		contentIndex: 2,
		id: toolCall.id,
		name: toolCall.name,
		snapshot: currentAssistant(),
		toolState: [{ contentIndex: 2, argsText: "" }],
	});
	const finalArguments = { path: `/secret/${value.toolPathSuffix}.txt`, encoding: "utf8" };
	const finalArgsText = JSON.stringify(finalArguments);
	for (const argsTextDelta of splitGeneratedValue(finalArgsText, value.toolChunkWidths)) {
		toolArgsText += argsTextDelta;
		toolCall = {
			type: "toolCall",
			id: "property-tool",
			name: "read",
			arguments: parseStreamingJson<JsonObject>(toolArgsText),
		};
		pushUpdate({
			type: "toolcall_delta",
			seq: ++seq,
			contentIndex: 2,
			argsTextDelta,
			snapshot: currentAssistant(),
			toolState: [{ contentIndex: 2, argsText: toolArgsText }],
		});
	}
	toolCall = { type: "toolCall", id: "property-tool", name: "read", arguments: finalArguments };
	pushUpdate({
		type: "toolcall_end",
		seq: ++seq,
		contentIndex: 2,
		toolCall,
		snapshot: currentAssistant(),
		toolState: [],
	});

	if (value.boundary === "active") {
		const activeLength = 1 + (value.activePrefixSeed % events.length);
		return events.slice(0, activeLength);
	}

	events.push({
		type: "message_end",
		message: assistantWithContent(currentContent(), value.boundary),
	});
	return events;
}

function directlyReduceAssistantEvents(events: readonly object[]): AssistantOracleState {
	let activeAssistant: AssistantMessage | null = null;
	let finalAssistant: AssistantMessage | null = null;
	for (const event of events) {
		const record = event as { type?: string; message?: AssistantMessage };
		if (record.type === "message_start" || record.type === "message_update") {
			activeAssistant = record.message ?? activeAssistant;
			if (record.type === "message_start") finalAssistant = null;
		} else if (record.type === "message_end") {
			activeAssistant = null;
			finalAssistant = record.message ?? null;
		}
	}
	return { activeAssistant, finalAssistant };
}

function sanitizeAssistantOracle(state: AssistantOracleState, sanitizer: ProjectionSanitizer): AssistantOracleState {
	return {
		activeAssistant:
			state.activeAssistant === null ? null : (sanitizer.sanitizeValue(state.activeAssistant) as AssistantMessage),
		finalAssistant:
			state.finalAssistant === null ? null : (sanitizer.sanitizeValue(state.finalAssistant) as AssistantMessage),
	};
}

function oracleSnapshotBuilder(
	source: OracleTestSource,
	sanitizer: ProjectionSanitizer,
	label: string,
): ConversationProjectionSnapshotBuilder {
	return (context) => {
		const sanitizedFinal =
			source.finalAssistant === null ? null : (sanitizer.sanitizeValue(source.finalAssistant) as AssistantMessage);
		const finalItem: RpcConversationTranscriptItem | undefined = sanitizedFinal
			? {
					entryId: `${label}-final`,
					ordinal: 1,
					createdAt: "2026-07-17T00:00:00.000Z",
					role: "assistant",
					text: sanitizedFinal.content
						.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
						.map((part) => part.text)
						.join(""),
					truncated: false,
					parts: sanitizedFinal.content.flatMap<RpcConversationAssistantPart>((part) => {
						if (part.type === "text") return [{ type: "text" as const, text: part.text, truncated: false }];
						if (part.type === "thinking") {
							return [
								{
									type: "thinking" as const,
									text: part.thinking,
									truncated: false,
									...(part.redacted === undefined ? {} : { redacted: part.redacted }),
								},
							];
						}
						return [];
					}),
					stopReason: sanitizedFinal.stopReason,
				}
			: undefined;
		return {
			conversation: { workspaceName: label, sessionId: `session-${label}` },
			state: {
				thinkingLevel: "off",
				availableThinkingLevels: ["off"],
				fastModeEnabled: false,
				planning: { mode: "build", plan: null },
				gitContext: null,
				isStreaming: context.activeAssistant !== null,
				isCompacting: false,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				sessionId: `session-${label}`,
				autoCompactionEnabled: true,
				messageCount: source.revision,
				pendingMessageCount: 0,
				steeringQueue: [],
				followUpQueue: [],
				revision: source.revision,
				oracleFinalAssistant: sanitizedFinal,
			} as RpcSessionState & { revision: number; oracleFinalAssistant: AssistantMessage | null },
			transcript: {
				sessionId: `session-${label}`,
				items: finalItem === undefined ? [] : [finalItem],
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch: context.branchEpoch,
				head: finalItem === undefined ? null : { entryId: finalItem.entryId, ordinal: finalItem.ordinal },
			},
			activeAssistant: context.activeAssistant,
			activeWorkflows: [],
		};
	};
}

function reduceDeliveredAssistantState(writes: readonly object[]): AssistantOracleState {
	const bootstrap = writes[0] as RpcConversationBootstrapEvent;
	const decoder = new StreamProjectionDecoder();
	let activeAssistant: AssistantMessage | null = null;
	let finalAssistant =
		((bootstrap.state as unknown as Record<string, unknown>).oracleFinalAssistant as
			| AssistantMessage
			| null
			| undefined) ?? null;

	if (bootstrap.activeAssistant !== null) {
		const seeded = decoder.decode({
			type: "message_update",
			stream: bootstrap.activeAssistant.stream,
			message: bootstrap.activeAssistant.message,
			toolState: bootstrap.activeAssistant.toolState ?? [],
			assistantMessageEvent: { type: "property_bootstrap_seed", contentIndex: 0 },
		}) as { message?: AssistantMessage } | undefined;
		activeAssistant = seeded?.message ?? null;
	}

	for (const frame of writes.slice(1)) {
		const decoded = decoder.decode(frame) as { type?: string; message?: AssistantMessage } | undefined;
		expect(decoded).toBeDefined();
		if (decoded?.type === "message_start" || decoded?.type === "message_update") {
			activeAssistant = decoded.message ?? activeAssistant;
		} else if (decoded?.type === "message_end") {
			activeAssistant = null;
			finalAssistant = decoded.message ?? null;
		}
	}
	return { activeAssistant, finalAssistant };
}

describe("ConversationProjectionFeed", () => {
	it("rejects non-canonical or oversized generated authority identifiers", () => {
		expect(() => new ConversationProjectionFeed(new TestSource(), { createId: () => " padded " })).toThrow(
			/branchEpoch factory returned an invalid id/,
		);
		expect(() => new ConversationProjectionFeed(new TestSource(), { createId: () => "x".repeat(257) })).toThrow(
			/branchEpoch factory returned an invalid id/,
		);
		expect(
			() =>
				new ConversationProjectionFeed(new TestSource(), {
					maxQueuedEnvelopes: 513,
				}),
		).toThrow(/maxQueuedEnvelopes must not exceed the hard maximum of 512/);
		expect(
			() =>
				new ConversationProjectionFeed(new TestSource(), {
					maxQueuedBytes: 4 * 1024 * 1024 + 1,
				}),
		).toThrow(/maxQueuedBytes must not exceed the hard maximum of 4194304/);

		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source);
		expect(() =>
			feed.attach({
				write: () => {},
				buildSnapshot: snapshotBuilder(source),
				maxQueuedEnvelopes: 513,
			}),
		).toThrow(/maxQueuedEnvelopes must not exceed/);
		expect(() =>
			feed.attach({
				write: () => {},
				buildSnapshot: snapshotBuilder(source),
				maxQueuedBytes: 4 * 1024 * 1024 + 1,
			}),
		).toThrow(/maxQueuedBytes must not exceed/);
		feed.dispose();
	});

	it("retains expensive source observation only while subscribers are attached", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source);
		expect(source.observationCount).toBe(0);
		const first = feed.attach({ write: () => {}, buildSnapshot: snapshotBuilder(source) });
		const second = feed.attach({ write: () => {}, buildSnapshot: snapshotBuilder(source) });
		await Promise.all([first.ready, second.ready]);
		expect(source.observationCount).toBe(1);
		first.detach();
		expect(source.observationCount).toBe(1);
		second.detach();
		expect(source.observationCount).toBe(0);
		feed.dispose();
	});

	it("enqueues bootstrap first at cursor zero, then contiguous top-level delivery", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("first") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
		});

		await subscription.ready;
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "bootstrap",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
			activeAssistant: null,
		});

		feed.publishExternal({ type: "workflow_update", workflowId: "wf-1", kind: "review" });
		await subscription.flush();
		expect(writes[1]).toEqual({
			type: "workflow_update",
			workflowId: "wf-1",
			kind: "review",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 1 },
		});
		feed.dispose();
	});

	it("bootstraps Git context and carries full replacements in ordered stream position", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("git") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: (context) => {
				const snapshot = snapshotBuilder(source)(context);
				return { ...snapshot, state: { ...snapshot.state, gitContext: TEST_GIT_CONTEXT } };
			},
		});
		await subscription.ready;
		expect(writes[0]).toMatchObject({
			type: "conversation_bootstrap",
			state: { gitContext: TEST_GIT_CONTEXT },
			delivery: { cursor: 0 },
		});

		const replacement: RpcGitContext = {
			...TEST_GIT_CONTEXT,
			status: { ...TEST_GIT_CONTEXT.status, untracked: 1, total: 1, clean: false },
			revision: 2,
			observedAt: "2026-07-29T00:00:01.000Z",
		};
		source.emit({ type: "git_context_changed", gitContext: replacement });
		await subscription.flush();
		expect(writes[1]).toEqual({
			type: "git_context_changed",
			gitContext: replacement,
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 1 },
		});
		feed.dispose();
	});

	it("seeds a mid-stream subscriber from cached raw state and emits a compact tail", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("mid") });
		source.emit({ type: "message_start", message: assistant("") });
		source.emit(messageUpdate(textDelta(1, "H", "H")));
		source.emit(messageUpdate(textDelta(2, "Hel", "el")));

		const writes: object[] = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;

		expect(writes[0]).toMatchObject({
			type: "conversation_bootstrap",
			activeAssistant: {
				stream: { epoch: 1, seq: 2 },
				message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
			},
		});

		source.emit(messageUpdate(textDelta(3, "Hello", "lo")));
		await subscription.flush();
		expect(writes[1]).toMatchObject({
			type: "message_update",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 1 },
			stream: { epoch: 1, seq: 3 },
			assistantMessageEvent: { type: "text_delta", delta: "lo" },
		});
		expect(writes[1]).not.toHaveProperty("message");
		feed.dispose();
	});

	it("emits immediate active and idle recovery checkpoints without a later source event", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("recovery") });
		source.emit(messageUpdate(textDelta(1, "active", "active")));
		const writes: object[] = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;

		const activeReceipt = subscription.requestCheckpoint(recoveryRequest("request-active"));
		await subscription.flush();
		expect(activeReceipt).toEqual({
			subscriptionId: subscription.subscriptionId,
			requestId: "request-active",
			checkpointCursor: 1,
		});
		expect(writes[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "resync",
			requestId: "request-active",
			delivery: { cursor: 1 },
			activeAssistant: { message: { content: [{ type: "text", text: "active" }] } },
		});

		source.emit({ type: "message_end", message: assistant("active") });
		await subscription.flush();
		const idleReceipt = subscription.requestCheckpoint(recoveryRequest("request-idle"));
		await subscription.flush();
		expect(idleReceipt.checkpointCursor).toBe(3);
		expect(writes[3]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "resync",
			requestId: "request-idle",
			activeAssistant: null,
		});
		feed.dispose();
	});

	it(`matches direct authorized reduction across randomized atomic attach cuts (seed ${OUTER_FEED_PROPERTY_SEED})`, async () => {
		await fc.assert(
			fc.asyncProperty(generatedFeedConversation, fc.nat(), async (generated, cutSeed) => {
				const events = generatedConversationEvents(generated);
				const cut = cutSeed % (events.length + 1);
				const source = new OracleTestSource();
				const feed = new ConversationProjectionFeed(source, { createId: makeIds("property") });
				const primarySanitizer = replacingSanitizer("/secret", "/workspace");
				const shadowSanitizer = replacingSanitizer("/secret", "/shadow");
				const primaryWrites: object[] = [];
				const shadowWrites: object[] = [];
				const primaryDiagnostics: string[] = [];
				const shadowDiagnostics: string[] = [];
				const bootstrapWrite = deferredVoid();

				try {
					for (const event of events.slice(0, cut)) source.emit(event);

					const primary = feed.attach({
						write: (value) => {
							primaryWrites.push(value);
							return primaryWrites.length === 1 ? bootstrapWrite.promise : Promise.resolve();
						},
						buildSnapshot: oracleSnapshotBuilder(source, primarySanitizer, "primary"),
						sanitizer: primarySanitizer,
						onDiagnostic: (diagnostic) => primaryDiagnostics.push(diagnostic.code),
					});
					const shadow = feed.attach({
						write: (value) => {
							shadowWrites.push(value);
						},
						buildSnapshot: oracleSnapshotBuilder(source, shadowSanitizer, "shadow"),
						sanitizer: shadowSanitizer,
						onDiagnostic: (diagnostic) => shadowDiagnostics.push(diagnostic.code),
					});

					expect(primary.subscriptionId).not.toBe(shadow.subscriptionId);
					for (const event of events.slice(cut)) source.emit(event);
					// The primary bootstrap is physically blocked, so every suffix frame
					// must still be pending behind its already-admitted cursor-zero cut.
					expect(primaryWrites).toHaveLength(1);

					bootstrapWrite.resolve();
					await Promise.all([primary.ready, shadow.ready]);
					await Promise.all([primary.flush(), shadow.flush()]);

					const expectedTailTypes = events.slice(cut).map((event) => (event as { type: string }).type);
					for (const [subscription, writes] of [
						[primary, primaryWrites],
						[shadow, shadowWrites],
					] as const) {
						expect(writes[0]).toMatchObject({
							type: "conversation_bootstrap",
							reason: "bootstrap",
							delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
							state: { revision: cut },
						});
						expect(writes.slice(1).map((value) => (value as { type: string }).type)).toEqual(expectedTailTypes);
						expect(writes).toHaveLength(1 + events.length - cut);
						expect(writes.map((value) => delivery(value))).toEqual(
							Array.from({ length: writes.length }, (_, cursor) => ({
								subscriptionId: subscription.subscriptionId,
								cursor,
							})),
						);
					}

					const direct = directlyReduceAssistantEvents(events);
					expect(reduceDeliveredAssistantState(primaryWrites)).toEqual(
						sanitizeAssistantOracle(direct, primarySanitizer),
					);
					expect(reduceDeliveredAssistantState(shadowWrites)).toEqual(
						sanitizeAssistantOracle(direct, shadowSanitizer),
					);
					expect(primaryDiagnostics).toEqual([]);
					expect(shadowDiagnostics).toEqual([]);
				} finally {
					bootstrapWrite.resolve();
					feed.dispose();
				}
			}),
			{ numRuns: 75, seed: OUTER_FEED_PROPERTY_SEED },
		);
	});

	it("uses independent subscription cursors and sanitizer projectors", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("multi") });
		source.emit(messageUpdate(textDelta(1, "/secret/a", "/secret/a")));
		const firstWrites: object[] = [];
		const secondWrites: object[] = [];
		const first = feed.attach({
			write: (value) => {
				firstWrites.push(value);
			},
			buildSnapshot: snapshotBuilder(source, "first"),
			sanitizer: replacingSanitizer("/secret", "/first"),
		});
		const second = feed.attach({
			write: (value) => {
				secondWrites.push(value);
			},
			buildSnapshot: snapshotBuilder(source, "second"),
			sanitizer: replacingSanitizer("/secret", "/second"),
		});
		await Promise.all([first.ready, second.ready]);

		expect(first.subscriptionId).not.toBe(second.subscriptionId);
		expect(firstWrites[0]).toMatchObject({
			activeAssistant: { message: { content: [{ text: "/first/a" }] } },
		});
		expect(secondWrites[0]).toMatchObject({
			activeAssistant: { message: { content: [{ text: "/second/a" }] } },
		});

		first.requestCheckpoint(recoveryRequest("only-first"));
		await first.flush();
		source.emit(messageUpdate(textDelta(2, "/secret/ab", "b")));
		await Promise.all([first.flush(), second.flush()]);
		expect(delivery(firstWrites.at(-1)!)).toEqual({ subscriptionId: first.subscriptionId, cursor: 2 });
		expect(delivery(secondWrites.at(-1)!)).toEqual({ subscriptionId: second.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("projects or omits canonical external events per subscriber before allocating a cursor", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("external") });
		const authorizedWrites: object[] = [];
		const filteredWrites: object[] = [];
		const authorized = feed.attach({
			write: (value) => {
				authorizedWrites.push(value);
			},
			buildSnapshot: snapshotBuilder(source, "authorized"),
			projectExternal: (event) => ({
				type: "transcript_entry",
				entry: (event as { entry: object }).entry,
				visiblePath: "/authorized/file",
			}),
		});
		const filtered = feed.attach({
			write: (value) => {
				filteredWrites.push(value);
			},
			buildSnapshot: snapshotBuilder(source, "filtered"),
			projectExternal: () => null,
		});
		await Promise.all([authorized.ready, filtered.ready]);

		feed.publishExternal({
			type: "conversation_transcript_committed",
			entry: {
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-07-17T00:00:00.000Z",
				ordinal: 1,
				customType: "test",
				data: { text: "host truth", hostPath: "/private/file" },
			},
		});
		await Promise.all([authorized.flush(), filtered.flush()]);
		expect(authorizedWrites[1]).toMatchObject({
			type: "transcript_entry",
			visiblePath: "/authorized/file",
			delivery: { subscriptionId: authorized.subscriptionId, cursor: 1 },
		});
		expect(filteredWrites).toHaveLength(1);

		filtered.requestCheckpoint(recoveryRequest("no-gap"));
		await filtered.flush();
		expect(delivery(filteredWrites[1]!)).toEqual({ subscriptionId: filtered.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("poisons a generation before allocating a cursor for unknown or malformed external events", async () => {
		const source = new TestSource();
		const failed = vi.fn();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("external-poison") });
		const subscription = feed.attach({
			write: () => {},
			buildSnapshot: snapshotBuilder(source),
			onError: failed,
		});
		await subscription.ready;

		expect(() => feed.publishExternal({ type: "transcript_entry" })).toThrow(/Unsupported.*external event/);
		expect(failed).toHaveBeenCalledOnce();
		expect(() => feed.publishExternal({ type: "workflow_update", workflowId: "wf-after-poison" })).toThrow(
			/generation is poisoned/,
		);
		feed.rotateForBranchRebase();
		expect(() => feed.publishExternal({ type: "workflow_update", workflowId: " padded " })).toThrow(
			/canonical workflow id/,
		);
		feed.dispose();
	});

	it.each([
		[
			"prototype-inherited external schema",
			() =>
				Object.assign(Object.create({ type: "workflow_update", workflowId: "wf-1", kind: "review" }), {
					message: "own payload",
				}) as object,
			/malformed event/,
		],
		[
			"toJSON-transformed external schema",
			() => ({
				type: "workflow_update",
				workflowId: "wf-1",
				kind: "review",
				toJSON: () => ({ type: "workflow_update", message: "changed shape" }),
			}),
			/canonical limit/,
		],
		[
			"transcript identity",
			() => ({
				type: "conversation_transcript_committed",
				entry: {
					type: "custom",
					id: "entry-1",
					timestamp: "2026-07-17T00:00:00.000Z",
					ordinal: 1,
					customType: "test",
				},
			}),
			/persisted-entry identity/,
		],
		[
			"transcript entry schema",
			() => ({
				type: "conversation_transcript_committed",
				entry: {
					type: "future_entry",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-07-17T00:00:00.000Z",
					ordinal: 1,
				},
			}),
			/Unsupported conversation transcript entry type/,
		],
		[
			"assistant content schema",
			() => ({
				type: "conversation_transcript_committed",
				entry: {
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-07-17T00:00:00.000Z",
					ordinal: 1,
					message: {
						...assistant("valid"),
						content: [{ type: "text", text: 7 }],
					},
				},
			}),
			/assistant-message commit is malformed/,
		],
		[
			"assistant usage schema",
			() => ({
				type: "conversation_transcript_committed",
				entry: {
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-07-17T00:00:00.000Z",
					ordinal: 1,
					message: { ...assistant("valid"), usage: { ...EMPTY_USAGE, cost: {} } },
				},
			}),
			/assistant-message commit is malformed/,
		],
		[
			"assistant stop reason",
			() => ({
				type: "conversation_transcript_committed",
				entry: {
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-07-17T00:00:00.000Z",
					ordinal: 1,
					message: { ...assistant("valid"), stopReason: "bogus" },
				},
			}),
			/assistant-message commit is malformed/,
		],
		["workflow start schema", () => ({ type: "workflow_start", workflowId: "wf-1" }), /canonical workflow kind/],
		[
			"workflow update schema",
			() => ({ type: "workflow_update", workflowId: "wf-1", kind: "review", action: 7 }),
			/malformed optional fields/,
		],
		[
			"workflow end outbound metadata",
			() => ({ type: "workflow_end", workflowId: "wf-1", kind: "review", projection: {} }),
			/outbound-only/,
		],
		[
			"workflow tool start identity",
			() => ({
				type: "tool_execution_start",
				workflowId: "wf-1",
				workflowAction: "review-current",
				toolCallId: "tool-1",
				toolName: "read",
			}),
			/canonical identifiers/,
		],
		[
			"workflow tool start arguments",
			() => ({
				type: "tool_execution_start",
				workflowId: "wf-1",
				workflowKind: "review",
				workflowAction: "review-current",
				toolCallId: "tool-1",
				toolName: "read",
				args: [],
			}),
			/malformed arguments/,
		],
		[
			"workflow tool end outcome",
			() => ({
				type: "tool_execution_end",
				workflowId: "wf-1",
				workflowKind: "review",
				workflowAction: "review-current",
				toolCallId: "tool-1",
				toolName: "read",
			}),
			/error outcome/,
		],
		[
			"canonical JSON ownership",
			() => ({
				type: "conversation_transcript_committed",
				entry: {
					type: "custom",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-07-17T00:00:00.000Z",
					ordinal: 1,
					customType: "test",
					data: 1n,
				},
			}),
			/canonical limit/,
		],
	] as const)(
		"rejects malformed %s before subscriber projection or cursor allocation",
		async (_name, makeEvent, error) => {
			const source = new TestSource();
			const writes: object[] = [];
			const projectExternal = vi.fn((event: object) => event);
			const failed = vi.fn();
			const feed = new ConversationProjectionFeed(source, { createId: makeIds("external-schema") });
			const subscription = feed.attach({
				write: (value) => {
					writes.push(value);
				},
				buildSnapshot: snapshotBuilder(source),
				projectExternal,
				onError: failed,
			});
			await subscription.ready;

			expect(() => feed.publishExternal(makeEvent())).toThrow(error);
			expect(projectExternal).not.toHaveBeenCalled();
			expect(writes).toHaveLength(1);
			expect(failed).toHaveBeenCalledOnce();
			feed.dispose();
		},
	);

	it("owns queued JSON values before measurement so later producer mutation cannot alter the wire frame", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const prepare = vi.fn((value: object) => {
			const prepared = { ...value, prepared: true };
			return { value: prepared, bytes: Buffer.byteLength(JSON.stringify(prepared), "utf8") + 1 };
		});
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("owned-queue") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				return writes.length === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: snapshotBuilder(source),
			projectExternal: (event) => ({ type: "transcript_entry", entry: (event as { entry: object }).entry }),
			prepare,
		});
		const entry = {
			type: "custom",
			id: "owned-entry",
			parentId: null,
			timestamp: "2026-07-17T00:00:00.000Z",
			ordinal: 1,
			customType: "test",
			text: "before",
		};
		feed.publishExternal({ type: "conversation_transcript_committed", entry });
		entry.text = "after";
		blocked.resolve();
		await subscription.ready;
		await subscription.flush();

		expect(writes[1]).toMatchObject({
			type: "transcript_entry",
			entry: { id: "owned-entry", text: "before" },
			prepared: true,
			delivery: { cursor: 1 },
		});
		expect(prepare).toHaveBeenCalledTimes(2);
		feed.dispose();
	});

	it("materializes raw active workflows for bootstrap and recovery", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("workflow") });
		feed.publishExternal({
			type: "workflow_start",
			workflowId: "wf-1",
			kind: "review",
			status: "running",
		});
		feed.publishExternal({
			type: "tool_execution_start",
			workflowId: "wf-1",
			workflowKind: "review",
			workflowAction: "test",
			toolCallId: "tool-1",
			toolName: "read",
		});

		const writes: object[] = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: (context) => ({
				...snapshotBuilder(source)(context),
				activeWorkflows: context.activeWorkflows.map((workflow) => ({
					workflowId: workflow.workflowId,
					...(workflow.workflowEvent === undefined
						? {}
						: { workflowEvent: workflow.workflowEvent as RpcWorkflowEvent }),
					activeTools: workflow.activeTools.map((event) => event as RpcWorkflowToolEvent),
				})),
			}),
		});
		await subscription.ready;
		expect(feed.activeWorkflows).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			activeWorkflows: [
				{
					workflowEvent: { type: "workflow_start", workflowId: "wf-1" },
					activeTools: [{ type: "tool_execution_start", toolCallId: "tool-1" }],
				},
			],
		});

		feed.publishExternal({
			type: "tool_execution_end",
			workflowId: "wf-1",
			workflowKind: "review",
			workflowAction: "test",
			toolCallId: "tool-1",
			toolName: "read",
			isError: false,
		});
		feed.publishExternal({
			type: "workflow_end",
			workflowId: "wf-1",
			kind: "review",
			status: "completed",
		});
		subscription.requestCheckpoint(recoveryRequest("workflow-ended"));
		await subscription.flush();
		expect(feed.activeWorkflows).toEqual([]);
		expect(writes.at(-1)).toMatchObject({ reason: "resync", activeWorkflows: [] });
		feed.dispose();
	});

	it("bounds canonical workflow counts, event bytes, and aggregate retained bytes", () => {
		const workflowFeed = new ConversationProjectionFeed(new TestSource(), { createId: makeIds("workflow-cap") });
		for (let index = 0; index < DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS; index++) {
			workflowFeed.publishExternal({ type: "workflow_start", workflowId: `wf-${index}`, kind: "review" });
		}
		workflowFeed.publishExternal({ type: "workflow_end", workflowId: "wf-0", kind: "review" });
		workflowFeed.publishExternal({
			type: "workflow_start",
			workflowId: `wf-${DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS}`,
			kind: "review",
		});
		expect(workflowFeed.activeWorkflows).toHaveLength(DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS);
		expect(() =>
			workflowFeed.publishExternal({
				type: "workflow_start",
				workflowId: "wf-overflow",
				kind: "review",
			}),
		).toThrow(/workflow canonical-state limit/);
		expect(() => workflowFeed.attach({ write: () => {}, buildSnapshot: snapshotBuilder(new TestSource()) })).toThrow(
			/generation is poisoned/,
		);
		workflowFeed.dispose();

		const toolFeed = new ConversationProjectionFeed(new TestSource(), { createId: makeIds("tool-cap") });
		for (let index = 0; index < DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW; index++) {
			toolFeed.publishExternal({
				type: "tool_execution_start",
				workflowId: "wf-tools",
				workflowKind: "review",
				workflowAction: "test",
				toolCallId: `tool-${index}`,
				toolName: "read",
			});
		}
		toolFeed.publishExternal({
			type: "tool_execution_end",
			workflowId: "wf-tools",
			workflowKind: "review",
			workflowAction: "test",
			toolCallId: "tool-0",
			toolName: "read",
			isError: false,
		});
		toolFeed.publishExternal({
			type: "tool_execution_start",
			workflowId: "wf-tools",
			workflowKind: "review",
			workflowAction: "test",
			toolCallId: `tool-${DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW}`,
			toolName: "read",
		});
		expect(toolFeed.activeWorkflows[0]?.activeTools).toHaveLength(
			DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW,
		);
		expect(() =>
			toolFeed.publishExternal({
				type: "tool_execution_start",
				workflowId: "wf-tools",
				workflowKind: "review",
				workflowAction: "test",
				toolCallId: "tool-overflow",
				toolName: "read",
			}),
		).toThrow(/tool canonical-state limit/);
		toolFeed.dispose();

		const eventFeed = new ConversationProjectionFeed(new TestSource(), { createId: makeIds("event-cap") });
		expect(() =>
			eventFeed.publishExternal({
				type: "workflow_update",
				workflowId: "oversized-event",
				kind: "review",
				payload: "x".repeat(DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_EVENT_BYTES),
			}),
		).toThrow(/workflow event exceeded/);
		eventFeed.dispose();

		const byteFeed = new ConversationProjectionFeed(new TestSource(), { createId: makeIds("workflow-bytes") });
		const payload = "x".repeat(240 * 1024);
		for (let index = 0; index < 17; index++) {
			byteFeed.publishExternal({ type: "workflow_start", workflowId: `large-${index}`, kind: "review", payload });
		}
		expect(() =>
			byteFeed.publishExternal({ type: "workflow_start", workflowId: "large-overflow", kind: "review", payload }),
		).toThrow(`${DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_BYTES}-byte canonical workflow-state limit`);
		byteFeed.dispose();
	});

	it("deduplicates request ids and rejects stale subscriptions after rebind", async () => {
		const firstSource = new TestSource();
		const secondSource = new TestSource();
		const feed = new ConversationProjectionFeed(firstSource, { createId: makeIds("generation") });
		const writes: object[] = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: (context) => snapshotBuilder(context.source as TestSource)(context),
		});
		await subscription.ready;
		const oldSubscriptionId = subscription.subscriptionId;
		expect(() => subscription.requestCheckpoint(recoveryRequest("future-cut", 1))).toThrow(/exceeds issued cursor 0/);
		const admittedRequest: ConversationProjectionRecoveryRequest = {
			requestId: "same-request",
			lastAppliedCursor: 0,
			assistantPosition: { epoch: 7, seq: 12 },
			reason: "assistant_position_gap",
		};
		const first = subscription.requestCheckpoint(admittedRequest);
		const duplicate = subscription.requestCheckpoint(admittedRequest);
		expect(duplicate).toBe(first);
		expect(() =>
			subscription.requestCheckpoint({
				...admittedRequest,
				reason: "reducer_divergence",
			}),
		).toThrow(/changed after admission/);
		expect(() => subscription.requestCheckpoint(recoveryRequest(" padded "))).toThrow(/canonical non-empty string/);
		await subscription.flush();
		expect(writes.filter((value) => (value as { requestId?: string }).requestId === "same-request")).toHaveLength(1);

		feed.rebindSource(secondSource);
		await subscription.flush();
		expect(subscription.subscriptionId).not.toBe(oldSubscriptionId);
		expect(writes.at(-1)).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});
		expect(() => feed.requestCheckpoint({ subscriptionId: oldSubscriptionId, ...recoveryRequest("stale") })).toThrow(
			/Unknown or stale/,
		);

		const count = writes.length;
		firstSource.emit({ type: "agent_start" });
		await subscription.flush();
		expect(writes).toHaveLength(count);
		secondSource.emit({ type: "agent_start" });
		await subscription.flush();
		expect(delivery(writes.at(-1)!)).toEqual({ subscriptionId: subscription.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("suspends stale projection output until a fresh source generation is committed", async () => {
		const firstSource = new TestSource();
		const secondSource = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(firstSource, { createId: makeIds("authority-loss") });
		let writeCount = 0;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: (context) => snapshotBuilder(context.source as TestSource)(context),
		});
		const authorityChanged = vi.fn();
		subscription.subscribeAuthorityChanges(authorityChanged);
		firstSource.emit({ type: "agent_start" });
		firstSource.emit({ type: "mcp_servers_changed" });
		const staleProjectionControls = AUTHORITY_SCOPED_RESPONSE_COMMANDS.map((command) =>
			subscription.enqueueControl({
				type: "response",
				command,
				success: true,
				data: { stale: command },
			}),
		);
		const failedProjectionControl = subscription.enqueueControl({
			type: "response",
			command: "get_session_tree",
			success: false,
			error: "tree request failed before the authority cut",
		});
		const unrelatedControl = subscription.enqueueControl({
			type: "response",
			command: "list_sessions",
			success: true,
			data: { sessions: [] },
		});
		const authorityError = new Error("conversation authority requires reconciliation");

		firstSource.loseAuthority(authorityError);

		expect(authorityChanged).toHaveBeenCalledOnce();
		expect(firstSource.observationCount).toBe(0);
		expect(() => subscription.requestCheckpoint(recoveryRequest("suspended"))).toThrow(authorityError);
		expect(() => feed.attach({ write: () => {}, buildSnapshot: snapshotBuilder(firstSource) })).toThrow(
			authorityError,
		);
		firstSource.emit({ type: "agent_end", messages: [] });

		blocked.resolve();
		await Promise.all([subscription.ready, ...staleProjectionControls, failedProjectionControl, unrelatedControl]);
		await subscription.flush();
		expect(writes).toEqual([
			expect.objectContaining({ type: "conversation_bootstrap", reason: "bootstrap" }),
			{
				type: "response",
				command: "get_session_tree",
				success: false,
				error: "tree request failed before the authority cut",
			},
			{
				type: "response",
				command: "list_sessions",
				success: true,
				data: { sessions: [] },
			},
		]);

		feed.beginSourceRebind(secondSource);
		feed.commitSourceRebind();
		await subscription.flush();
		expect(authorityChanged).toHaveBeenCalledOnce();
		expect(writes.at(-1)).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			state: { revision: 0 },
		});
		expect(secondSource.observationCount).toBe(1);
		feed.dispose();
	});

	it("keeps a replacement generation unpublished until host ownership rekey commits", async () => {
		const firstSource = new TestSource();
		const secondSource = new TestSource();
		const feed = new ConversationProjectionFeed(firstSource, { createId: makeIds("transaction") });
		const writes: object[] = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: (context) => snapshotBuilder(context.source as TestSource)(context),
		});
		await subscription.ready;
		const originalSubscriptionId = subscription.subscriptionId;
		const originalBranchEpoch = subscription.branchEpoch;
		const authorityCuts: Array<{ subscriptionId: string; branchEpoch: string }> = [];
		subscription.subscribeAuthorityChanges(() => {
			authorityCuts.push({
				subscriptionId: subscription.subscriptionId,
				branchEpoch: subscription.branchEpoch,
			});
		});
		const countBeforeRekey = writes.length;

		feed.beginSourceRebind(secondSource);
		expect(authorityCuts).toEqual([{ subscriptionId: originalSubscriptionId, branchEpoch: originalBranchEpoch }]);
		secondSource.emit({ type: "agent_start" });
		expect(writes).toHaveLength(countBeforeRekey);
		expect(() =>
			feed.attach({
				write: () => {},
				buildSnapshot: snapshotBuilder(secondSource),
			}),
		).toThrow(/awaiting host ownership rekey/);

		feed.commitSourceRebind();
		await subscription.flush();
		expect(authorityCuts).toHaveLength(1);
		expect(subscription.subscriptionId).not.toBe(originalSubscriptionId);
		expect(writes.at(-1)).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
			state: { revision: 1 },
		});

		const countAfterCommit = writes.length;
		firstSource.emit({ type: "agent_start" });
		await subscription.flush();
		expect(writes).toHaveLength(countAfterCommit);
		secondSource.emit({ type: "agent_start" });
		await subscription.flush();
		expect(delivery(writes.at(-1)!)).toEqual({ subscriptionId: subscription.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("reduces active assistant state and buffers controls while a source rebind is unpublished", async () => {
		const firstSource = new TestSource();
		const secondSource = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(firstSource, { createId: makeIds("pending-rebind") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: (context) => snapshotBuilder(context.source as TestSource)(context),
		});
		await subscription.ready;

		feed.beginSourceRebind(secondSource);
		secondSource.emit({ type: "message_start", message: assistant("new generation") });
		secondSource.emit({ type: "mcp_auth_request", serverId: "server-1", auth: { flow: "device" } });
		expect(writes).toHaveLength(1);

		feed.commitSourceRebind();
		await subscription.flush();
		expect(writes[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			activeAssistant: { message: { content: [{ text: "new generation" }] } },
		});
		expect(writes[2]).toEqual({
			type: "mcp_auth_request",
			serverId: "server-1",
			auth: { flow: "device" },
		});
		expect(writes[2]).not.toHaveProperty("delivery");
		feed.dispose();
	});

	it("keeps retained old controls before a rebind bootstrap and new-generation controls after it", async () => {
		const firstSource = new TestSource();
		const secondSource = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(firstSource, {
			createId: makeIds("rebind-control-order"),
			maxQueuedEnvelopes: 2,
			maxQueuedBytes: 4_096,
		});
		let writeCount = 0;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: (context) => paddedSnapshotBuilder(context.source as TestSource, 2_500)(context),
			prepare: prepareJsonl,
		});
		const beforeCutWrite = subscription.enqueueControl({
			type: "control",
			marker: "before-rebind",
			padding: "c".repeat(3_000),
		});
		firstSource.emit({ type: "agent_start" });

		feed.beginSourceRebind(secondSource);
		secondSource.emit({ type: "mcp_servers_changed", marker: "after-rebind" });
		feed.commitSourceRebind();

		blocked.resolve();
		await Promise.all([subscription.ready, beforeCutWrite]);
		await subscription.flush();
		expect(writes).toHaveLength(4);
		expect(writes[0]).toMatchObject({ type: "conversation_bootstrap", reason: "bootstrap" });
		expect(writes[1]).toMatchObject({ type: "control", marker: "before-rebind" });
		expect(writes[2]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});
		expect(writes[3]).toEqual({ type: "mcp_servers_changed", marker: "after-rebind" });
		feed.dispose();
	});

	it("rotates branch epoch and subscription when the source branch rebases", async () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("branch") });
		const writes: object[] = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;
		const oldSubscriptionId = subscription.subscriptionId;
		const oldBranchEpoch = feed.branchEpoch;
		const authorityCuts: Array<{ subscriptionId: string; branchEpoch: string }> = [];
		subscription.subscribeAuthorityChanges(() => {
			authorityCuts.push({
				subscriptionId: subscription.subscriptionId,
				branchEpoch: subscription.branchEpoch,
			});
		});

		source.rebase();
		await subscription.flush();
		expect(feed.branchEpoch).not.toBe(oldBranchEpoch);
		expect(authorityCuts).toEqual([{ subscriptionId: oldSubscriptionId, branchEpoch: feed.branchEpoch }]);
		expect(subscription.subscriptionId).not.toBe(oldSubscriptionId);
		expect(writes.at(-1)).toMatchObject({
			reason: "branch_rebase",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
			state: { branchEpoch: feed.branchEpoch },
			transcript: { branchEpoch: feed.branchEpoch },
		});
		expect((writes.at(-1) as RpcConversationBootstrapEvent).conversation).toEqual(
			(writes[0] as RpcConversationBootstrapEvent).conversation,
		);
		feed.dispose();
	});

	it("accepts only bounded generation-issued transcript cursors", () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("pagination") });
		for (let index = 0; index <= DEFAULT_CONVERSATION_PROJECTION_MAX_TRANSCRIPT_CURSORS; index++) {
			feed.registerTranscriptCursor(`cursor-${index}`);
		}
		expect(feed.isTranscriptCursorValid("cursor-0")).toBe(false);
		expect(feed.isTranscriptCursorValid("cursor-1")).toBe(true);
		expect(feed.isTranscriptCursorValid(`cursor-${DEFAULT_CONVERSATION_PROJECTION_MAX_TRANSCRIPT_CURSORS}`)).toBe(
			true,
		);
		expect(feed.isTranscriptCursorValid("abandoned-branch-entry")).toBe(false);

		source.rebase();
		expect(feed.isTranscriptCursorValid("cursor-1")).toBe(false);
		feed.dispose();
	});

	it("drops held transcript controls captured before a branch rebase", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("stale-page") });
		let writeCount = 0;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: snapshotBuilder(source),
		});
		const oldBranchEpoch = feed.branchEpoch;
		const held = subscription.enqueueControl({
			type: "response",
			command: "get_transcript",
			success: true,
			data: { branchEpoch: oldBranchEpoch, items: [] },
		});

		source.rebase();
		await held;
		await subscription.enqueueControl({
			type: "response",
			command: "get_transcript",
			success: true,
			data: { branchEpoch: oldBranchEpoch, items: [] },
		});
		blocked.resolve();
		await subscription.ready;
		await subscription.flush();

		expect(writes).toHaveLength(2);
		expect(writes[1]).toMatchObject({ type: "conversation_bootstrap", reason: "branch_rebase" });
		expect(writes.some((value) => (value as { command?: string }).command === "get_transcript")).toBe(false);
		feed.dispose();
	});

	it("delivers MCP events as unsequenced ordered controls", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("mcp-control") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;

		source.emit({ type: "mcp_servers_changed", servers: [] });
		source.emit({ type: "agent_start" });
		await subscription.flush();

		expect(writes[1]).toEqual({ type: "mcp_servers_changed", servers: [] });
		expect(writes[1]).not.toHaveProperty("delivery");
		expect(delivery(writes[2]!)).toEqual({ subscriptionId: subscription.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("ignores internal delivery lifecycle events without consuming a cursor or poisoning the generation", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("delivery-lifecycle") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;

		source.emit({
			type: "delivery_start",
			deliveryId: "prompt-1",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		source.emit({
			type: "message_start",
			deliveryId: "prompt-1",
			message: { role: "user", content: "hello", timestamp: 1 },
		});
		await subscription.flush();

		expect(writes).toHaveLength(2);
		expect(writes[1]).toMatchObject({
			type: "message_start",
			deliveryId: "prompt-1",
			message: { role: "user", content: "hello" },
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 1 },
		});
		feed.dispose();
	});

	it("prunes unsent tail while keeping controls on their physical sides of a recovery cut", async () => {
		const source = new TestSource();
		const firstWrite = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("checkpoint"),
			maxQueuedEnvelopes: 2,
			maxQueuedBytes: 4_096,
		});
		let writeCount = 0;
		let enqueueDuringRecovery: (() => Promise<void>) | undefined;
		let afterCutWrite: Promise<void> | undefined;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? firstWrite.promise : Promise.resolve();
			},
			buildSnapshot: (context) => {
				if (context.reason === "resync") {
					afterCutWrite = enqueueDuringRecovery?.();
				}
				return paddedSnapshotBuilder(source, 2_500)(context);
			},
			prepare: prepareJsonl,
		});
		enqueueDuringRecovery = () => subscription.enqueueControl({ type: "control", marker: "after-cut" });

		const beforeCutWrite = subscription.enqueueControl({
			type: "control",
			marker: "before-cut",
			padding: "c".repeat(3_000),
		});
		feed.publishExternal({ type: "workflow_update", workflowId: "checkpoint-tail", kind: "review", message: "one" });
		const receipt = subscription.requestCheckpoint(recoveryRequest("cut-now"));
		expect(afterCutWrite).toBeDefined();
		expect(receipt.checkpointCursor).toBe(2);
		expect(writes).toHaveLength(1);

		firstWrite.resolve();
		await Promise.all([beforeCutWrite, afterCutWrite]);
		await subscription.flush();
		expect(writes).toHaveLength(4);
		expect(writes[0]).toMatchObject({ type: "conversation_bootstrap", reason: "bootstrap" });
		expect(writes[1]).toMatchObject({ type: "control", marker: "before-cut" });
		expect(writes[2]).toMatchObject({ reason: "resync", requestId: "cut-now", delivery: { cursor: 2 } });
		expect(writes[3]).toMatchObject({ type: "control", marker: "after-cut" });

		feed.publishExternal({ type: "workflow_update", workflowId: "checkpoint-tail", kind: "review", message: "two" });
		await subscription.flush();
		expect(delivery(writes.at(-1)!)).toEqual({ subscriptionId: subscription.subscriptionId, cursor: 3 });
		feed.dispose();
	});

	it("retains only the one in-flight ordinary frame before a recovery checkpoint", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("in-flight-cut") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				return delivery(value).cursor === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;

		feed.publishExternal({ type: "workflow_update", workflowId: "wf-1", kind: "review", message: "in-flight" });
		feed.publishExternal({ type: "workflow_update", workflowId: "wf-1", kind: "review", message: "prune-2" });
		feed.publishExternal({ type: "workflow_update", workflowId: "wf-1", kind: "review", message: "prune-3" });
		const receipt = subscription.requestCheckpoint(recoveryRequest("after-in-flight"));
		expect(receipt.checkpointCursor).toBe(4);
		expect(writes).toHaveLength(2);

		blocked.resolve();
		await subscription.flush();
		expect(writes).toHaveLength(3);
		expect(writes[1]).toMatchObject({ message: "in-flight", delivery: { cursor: 1 } });
		expect(writes[2]).toMatchObject({ reason: "resync", requestId: "after-in-flight", delivery: { cursor: 4 } });
		feed.dispose();
	});

	it("coalesces in-flight recovery and rate-bounds unique checkpoint rebuilds", async () => {
		const source = new TestSource();
		const firstCheckpointWrite = deferredVoid();
		const writes: object[] = [];
		let now = 0;
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("bounded-checkpoint"),
			maxCheckpointsPerWindow: 2,
			checkpointWindowMs: 1_000,
			now: () => now,
		});
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				if ((value as { requestId?: string }).requestId === "first") {
					return firstCheckpointWrite.promise;
				}
			},
			buildSnapshot: snapshotBuilder(source),
		});
		await subscription.ready;

		const first = subscription.requestCheckpoint(recoveryRequest("first"));
		expect(() => subscription.requestCheckpoint(recoveryRequest("while-first-pending"))).toThrow(/still pending/);
		firstCheckpointWrite.resolve();
		await subscription.flush();
		expect(subscription.requestCheckpoint(recoveryRequest("first"))).toBe(first);

		subscription.requestCheckpoint(recoveryRequest("second"));
		await subscription.flush();
		expect(() => subscription.requestCheckpoint(recoveryRequest("third"))).toThrow(/rate limit exceeded/);

		now = 1_001;
		subscription.requestCheckpoint(recoveryRequest("third"));
		await subscription.flush();
		expect(writes.filter((value) => (value as { reason?: string }).reason === "resync")).toHaveLength(3);
		feed.dispose();
	});

	it("fails a subscription closed when checkpoint materialization throws after pruning its tail", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const failed = vi.fn();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("broken-checkpoint") });
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
			measureBytes: (value) => {
				if ((value as { requestId?: string }).requestId === "cannot-measure") {
					throw new Error("checkpoint encoder failed");
				}
				return 1;
			},
			onError: failed,
		});
		await subscription.ready;

		expect(() => subscription.requestCheckpoint(recoveryRequest("cannot-measure"))).toThrow(
			"checkpoint encoder failed",
		);
		expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "checkpoint encoder failed" }));
		await expect(subscription.flush()).rejects.toThrow(/closed/);
		const writeCount = writes.length;
		source.emit({ type: "agent_start" });
		expect(writes).toHaveLength(writeCount);
		feed.dispose();
	});

	it("does not return a checkpoint receipt when snapshot preparation reentrantly fails the subscriber", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const failed = vi.fn();
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("reentrant-checkpoint-failure"),
			maxQueuedBytes: 4_096,
		});
		let failDuringSnapshot: (() => void) | undefined;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: (context) => {
				if (context.reason === "resync") failDuringSnapshot?.();
				return snapshotBuilder(source)(context);
			},
			prepare: prepareJsonl,
			onError: failed,
		});
		failDuringSnapshot = () => {
			void subscription.enqueueControl({ type: "control", payload: "x".repeat(5_000) });
		};
		await subscription.ready;

		expect(() => subscription.requestCheckpoint(recoveryRequest("reentrant-failure"))).toThrow(/generation changed/);
		expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("byte bounds") }));
		expect(writes).toHaveLength(1);
		await expect(subscription.flush()).rejects.toThrow(/closed/);
		feed.dispose();
	});

	it("does not return a checkpoint receipt when snapshot preparation reentrantly fences the subscriber", async () => {
		const source = new TestSource();
		const terminalBlocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("reentrant-checkpoint-fence") });
		let fenceDuringSnapshot: (() => void) | undefined;
		let terminalWrite: Promise<void> | undefined;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				return (value as { terminal?: boolean }).terminal === true ? terminalBlocked.promise : Promise.resolve();
			},
			buildSnapshot: (context) => {
				if (context.reason === "resync") fenceDuringSnapshot?.();
				return snapshotBuilder(source)(context);
			},
			prepare: prepareJsonl,
		});
		fenceDuringSnapshot = () => {
			terminalWrite = subscription.fenceAndEnqueueTerminal({ type: "terminal", terminal: true });
		};
		await subscription.ready;

		expect(() => subscription.requestCheckpoint(recoveryRequest("reentrant-fence"))).toThrow(/generation changed/);
		expect(terminalWrite).toBeDefined();
		expect(writes).toEqual([
			expect.objectContaining({ type: "conversation_bootstrap", reason: "bootstrap" }),
			{ type: "terminal", terminal: true },
		]);

		terminalBlocked.resolve();
		await terminalWrite;
		await expect(subscription.flush()).rejects.toThrow(/closed/);
		feed.dispose();
	});

	it("does not return a stale checkpoint receipt when preparation reentrantly rotates the generation", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("reentrant-checkpoint-rotate") });
		let rotated = false;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: snapshotBuilder(source),
			prepare: (value) => {
				const prepared = prepareJsonl(value);
				if ((value as { requestId?: string }).requestId === "rotate-during-prepare" && !rotated) {
					rotated = true;
					feed.rotateForBranchRebase();
				}
				return prepared;
			},
		});
		await subscription.ready;
		const originalSubscriptionId = subscription.subscriptionId;

		expect(() => subscription.requestCheckpoint(recoveryRequest("rotate-during-prepare"))).toThrow(
			/generation changed/,
		);
		expect(subscription.subscriptionId).not.toBe(originalSubscriptionId);
		await subscription.flush();
		expect(writes).toHaveLength(2);
		expect(writes[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "branch_rebase",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});

		source.emit({ type: "agent_start" });
		await subscription.flush();
		expect(delivery(writes.at(-1)!)).toEqual({ subscriptionId: subscription.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("includes the JSONL line feed in fallback queue byte accounting", async () => {
		const baselineSource = new TestSource();
		const baselineWrites: object[] = [];
		const baseline = new ConversationProjectionFeed(baselineSource, { createId: makeIds("jsonl-boundary") });
		const baselineSubscription = baseline.attach({
			write: (value) => {
				baselineWrites.push(value);
			},
			buildSnapshot: snapshotBuilder(baselineSource),
		});
		await baselineSubscription.ready;
		const jsonBytes = Buffer.byteLength(JSON.stringify(baselineWrites[0]), "utf8");
		baseline.dispose();

		const tooSmallSource = new TestSource();
		const tooSmall = new ConversationProjectionFeed(tooSmallSource, {
			createId: makeIds("jsonl-boundary"),
			maxQueuedBytes: jsonBytes,
		});
		expect(() => tooSmall.attach({ write: () => {}, buildSnapshot: snapshotBuilder(tooSmallSource) })).toThrow(
			/exceeds outbound queue byte bounds/,
		);
		tooSmall.dispose();

		const exactSource = new TestSource();
		const exact = new ConversationProjectionFeed(exactSource, {
			createId: makeIds("jsonl-boundary"),
			maxQueuedBytes: jsonBytes + 1,
		});
		const exactSubscription = exact.attach({ write: () => {}, buildSnapshot: snapshotBuilder(exactSource) });
		await exactSubscription.ready;
		exact.dispose();
	});

	it("rejects a prepared value whose declared bytes do not match its final JSONL representation", () => {
		const source = new TestSource();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("prepared-size") });
		expect(() =>
			feed.attach({
				write: () => {},
				buildSnapshot: snapshotBuilder(source),
				prepare: (value) => ({ value, bytes: 1 }),
			}),
		).toThrow(/prepared byte count does not match/);
		feed.dispose();
	});

	it("poisons an unsupported source generation until an authoritative rebase", async () => {
		const source = new TestSource();
		const failed = vi.fn();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("poison") });
		const subscription = feed.attach({
			write: () => {},
			buildSnapshot: snapshotBuilder(source),
			onError: failed,
		});
		await subscription.ready;

		source.emit({ type: "future_uncheckpointed_mutation" });
		expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Unsupported") }));
		expect(() => feed.attach({ write: () => {}, buildSnapshot: snapshotBuilder(source) })).toThrow(
			/generation is poisoned/,
		);

		source.rebase();
		const recovered = feed.attach({ write: () => {}, buildSnapshot: snapshotBuilder(source) });
		await recovered.ready;
		feed.dispose();
	});

	it("atomically fences queued output before one final terminal write", async () => {
		const source = new TestSource();
		const bootstrapWrite = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("terminal-fence") });
		let writeCount = 0;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? bootstrapWrite.promise : Promise.resolve();
			},
			buildSnapshot: snapshotBuilder(source),
		});

		feed.publishExternal({ type: "workflow_update", workflowId: "terminal-tail", kind: "review" });
		const supersededControl = subscription.enqueueControl({ type: "keep_awake_changed" });
		const terminalWrite = subscription.fenceAndEnqueueTerminal({
			type: "response",
			success: false,
			error: "RPC grant is stale; reconnect",
		});
		source.emit({ type: "turn_start" });
		await expect(supersededControl).rejects.toThrow(/terminal conversation fence/);
		await expect(subscription.enqueueControl({ type: "late" })).rejects.toThrow(/terminally fenced/);
		expect(writes).toHaveLength(1);

		bootstrapWrite.resolve();
		await terminalWrite;
		expect(writes).toEqual([
			expect.objectContaining({ type: "conversation_bootstrap" }),
			{ type: "response", success: false, error: "RPC grant is stale; reconnect" },
		]);
		await expect(subscription.flush()).rejects.toThrow(/closed/);
		feed.dispose();
	});

	it("isolates a slow or failed subscriber from a healthy subscriber", async () => {
		const source = new TestSource();
		const slowWrite = deferredVoid();
		const slowWrites: object[] = [];
		const healthyWrites: object[] = [];
		const failed = vi.fn();
		const feed = new ConversationProjectionFeed(source, { createId: makeIds("isolation") });
		let slowCount = 0;
		const slow = feed.attach({
			write: (value) => {
				slowWrites.push(value);
				slowCount++;
				return slowCount === 1 ? slowWrite.promise : Promise.reject(new Error("slow transport failed"));
			},
			buildSnapshot: snapshotBuilder(source, "slow"),
			onError: failed,
		});
		const healthy = feed.attach({
			write: (value) => {
				healthyWrites.push(value);
			},
			buildSnapshot: snapshotBuilder(source, "healthy"),
		});
		await healthy.ready;

		feed.publishExternal({ type: "workflow_update", workflowId: "isolation-tail", kind: "review" });
		await healthy.flush();
		expect(healthyWrites).toHaveLength(2);
		expect(slowWrites).toHaveLength(1);

		slowWrite.resolve();
		await vi.waitFor(() =>
			expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "slow transport failed" })),
		);
		expect(delivery(healthyWrites[1]!)).toEqual({ subscriptionId: healthy.subscriptionId, cursor: 1 });
		await expect(slow.flush()).rejects.toThrow(/closed/);
		feed.dispose();
	});

	it("rotates to a fresh cursor-zero overflow subscription and resumes at cursor one", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const prepare = vi.fn(prepareJsonl);
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("overflow"),
			maxQueuedEnvelopes: 2,
			maxQueuedBytes: 4 * 1024 * 1024,
		});
		let writeCount = 0;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: snapshotBuilder(source),
			prepare,
		});
		const initialSubscriptionId = subscription.subscriptionId;
		const authorityCuts: string[] = [];
		subscription.subscribeAuthorityChanges(() => {
			authorityCuts.push(subscription.subscriptionId);
		});

		source.emit({ type: "agent_start" });
		source.emit({ type: "turn_start" });
		expect(subscription.subscriptionId).toBe(initialSubscriptionId);
		source.emit({ type: "compaction_start" });
		expect(authorityCuts).toEqual([initialSubscriptionId]);
		expect(subscription.subscriptionId).not.toBe(initialSubscriptionId);
		expect(writes).toHaveLength(1);

		blocked.resolve();
		await subscription.flush();
		expect(writes).toHaveLength(2);
		expect(writes[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "overflow",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
			state: { revision: 3 },
		});
		expect(prepare).toHaveBeenCalled();

		source.emit({ type: "turn_end" });
		await subscription.flush();
		expect(delivery(writes.at(-1)!)).toEqual({ subscriptionId: subscription.subscriptionId, cursor: 1 });
		feed.dispose();
	});

	it("excludes the one in-flight record from byte overflow and reserves a bounded overflow authority slot", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("byte-overflow"),
			maxQueuedEnvelopes: 10,
			maxQueuedBytes: 4_096,
		});
		const prepared: Array<{ value: object; bytes: number }> = [];
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				return writes.length === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: paddedSnapshotBuilder(source, 2_500),
			prepare: (value) => {
				const record = prepareJsonl(value);
				prepared.push(record);
				return record;
			},
		});
		const initialSubscriptionId = subscription.subscriptionId;

		feed.publishExternal({
			type: "workflow_update",
			workflowId: "wf-byte-1",
			kind: "review",
			message: "a".repeat(2_200),
		});
		expect(subscription.subscriptionId).toBe(initialSubscriptionId);
		const initialBootstrap = prepared.find((record) => (record.value as { reason?: string }).reason === "bootstrap");
		const firstOrdinary = prepared.find(
			(record) => (record.value as { workflowId?: string }).workflowId === "wf-byte-1",
		);
		expect(initialBootstrap).toBeDefined();
		expect(firstOrdinary).toBeDefined();
		expect(initialBootstrap!.bytes).toBeLessThanOrEqual(4_096);
		expect(firstOrdinary!.bytes).toBeLessThanOrEqual(4_096);
		expect(initialBootstrap!.bytes + firstOrdinary!.bytes).toBeGreaterThan(4_096);
		feed.publishExternal({
			type: "workflow_update",
			workflowId: "wf-byte-2",
			kind: "review",
			message: "b".repeat(2_200),
		});
		expect(subscription.subscriptionId).not.toBe(initialSubscriptionId);
		expect(writes).toHaveLength(1);

		blocked.resolve();
		await subscription.ready;
		await subscription.flush();
		expect(writes).toHaveLength(2);
		expect(writes[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "overflow",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});
		expect(prepareJsonl(writes[0]!).bytes + prepareJsonl(writes[1]!).bytes).toBeGreaterThan(4_096);
		feed.dispose();
	});

	it("keeps one in-flight ordinary record, one full normal control lane, and one recovery authority record", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("three-part-recovery"),
			maxQueuedEnvelopes: 1,
			maxQueuedBytes: 4_096,
		});
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				return (value as { delivery?: { cursor?: number } }).delivery?.cursor === 1
					? blocked.promise
					: Promise.resolve();
			},
			buildSnapshot: paddedSnapshotBuilder(source, 2_500),
			prepare: prepareJsonl,
		});
		await subscription.ready;

		feed.publishExternal({ type: "workflow_update", workflowId: "wf-in-flight", kind: "review" });
		const controlWrite = subscription.enqueueControl({
			type: "control",
			marker: "full-normal-lane",
			padding: "c".repeat(3_000),
		});
		const receipt = subscription.requestCheckpoint(recoveryRequest("three-part-cut"));
		expect(receipt.checkpointCursor).toBe(2);
		expect(writes).toHaveLength(2);

		blocked.resolve();
		await controlWrite;
		await subscription.flush();
		expect(writes).toHaveLength(4);
		expect(writes[1]).toMatchObject({ workflowId: "wf-in-flight", delivery: { cursor: 1 } });
		expect(writes[2]).toMatchObject({ type: "control", marker: "full-normal-lane" });
		expect(writes[3]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "resync",
			requestId: "three-part-cut",
			delivery: { cursor: 2 },
		});
		expect(prepareJsonl(writes[2]!).bytes + prepareJsonl(writes[3]!).bytes).toBeGreaterThan(4_096);
		feed.dispose();
	});

	it("keeps controls on their physical sides of an overflow replacement bootstrap", async () => {
		const source = new TestSource();
		const blocked = deferredVoid();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source, {
			createId: makeIds("overflow-control-order"),
			maxQueuedEnvelopes: 2,
			maxQueuedBytes: 4_096,
		});
		let writeCount = 0;
		let enqueueDuringOverflow: (() => Promise<void>) | undefined;
		let afterCutWrite: Promise<void> | undefined;
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
				writeCount++;
				return writeCount === 1 ? blocked.promise : Promise.resolve();
			},
			buildSnapshot: (context) => {
				if (context.reason === "overflow") {
					afterCutWrite = enqueueDuringOverflow?.();
				}
				return paddedSnapshotBuilder(source, 2_500)(context);
			},
			prepare: prepareJsonl,
		});
		enqueueDuringOverflow = () => subscription.enqueueControl({ type: "control", marker: "after-overflow" });
		const originalSubscriptionId = subscription.subscriptionId;
		const beforeCutWrite = subscription.enqueueControl({
			type: "control",
			marker: "before-overflow",
			padding: "c".repeat(3_000),
		});
		source.emit({ type: "agent_start" });
		source.emit({ type: "turn_start" });
		expect(subscription.subscriptionId).not.toBe(originalSubscriptionId);
		expect(afterCutWrite).toBeDefined();

		blocked.resolve();
		await Promise.all([subscription.ready, beforeCutWrite, afterCutWrite]);
		await subscription.flush();
		expect(writes).toHaveLength(4);
		expect(writes[0]).toMatchObject({ type: "conversation_bootstrap", reason: "bootstrap" });
		expect(writes[1]).toMatchObject({ type: "control", marker: "before-overflow" });
		expect(writes[2]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "overflow",
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});
		expect(writes[3]).toEqual({ type: "control", marker: "after-overflow" });
		feed.dispose();
	});

	it.each(["stop", "aborted"] as const)(
		"terminal %s overflow rebuilds from persisted final truth without a later model event",
		async (stopReason) => {
			const source = new TestSource();
			const blocked = deferredVoid();
			const writes: object[] = [];
			let persistedItems: RpcConversationTranscriptItem[] = [];
			const feed = new ConversationProjectionFeed(source, {
				createId: makeIds(`terminal-overflow-${stopReason}`),
				maxQueuedEnvelopes: 1,
				maxQueuedBytes: 10_000,
			});
			source.emit({ type: "message_start", message: assistant("partial", "stop") });
			let writeCount = 0;
			const subscription = feed.attach({
				write: (value) => {
					writes.push(value);
					writeCount++;
					return writeCount === 1 ? blocked.promise : Promise.resolve();
				},
				buildSnapshot: (context) => {
					const snapshot = snapshotBuilder(source)(context);
					return { ...snapshot, transcript: { ...snapshot.transcript, items: persistedItems } };
				},
				measureBytes: () => 1,
			});
			source.subscribe((event) => {
				if ((event as { type?: string }).type !== "message_end") return;
				persistedItems = [
					{
						entryId: "assistant-final",
						ordinal: 2,
						createdAt: "2026-07-17T00:00:00.000Z",
						role: "assistant",
						text: "partial",
						truncated: false,
						stopReason,
					},
				];
			});

			feed.publishExternal({ type: "workflow_update", workflowId: "wf-1", kind: "review", message: "queued" });
			source.emit({ type: "message_end", message: assistant("partial", stopReason) });
			await Promise.resolve();
			expect(writes).toHaveLength(1);

			blocked.resolve();
			await subscription.ready;
			await subscription.flush();
			expect(writes).toHaveLength(2);
			expect(writes[1]).toMatchObject({
				type: "conversation_bootstrap",
				reason: "overflow",
				activeAssistant: null,
				transcript: {
					items: [{ entryId: "assistant-final", text: "partial", stopReason }],
				},
			});
			feed.dispose();
		},
	);
});
