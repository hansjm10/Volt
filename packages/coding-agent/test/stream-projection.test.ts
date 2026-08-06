import {
	type ActiveToolCallState,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantStreamFragment,
	AssistantStreamNormalizer,
	type JsonObject,
	parseStreamingJson,
	type ToolCall,
	type Usage,
} from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createIrohRemoteProjectionSanitizer,
	sanitizeIrohRemoteOutbound,
} from "../src/core/remote/iroh/outbound-filter.ts";
import {
	createProjectionState,
	type ProjectedMessageUpdateFrame,
	type ProjectionInput,
	type ProjectionPhase,
	type ProjectionResult,
	type ProjectionSanitizer,
	type ProjectionState,
	project,
	StreamProjectionDecoder,
	StreamProjector,
	type WireFrame,
} from "../src/core/rpc/stream-projection.ts";

const SECRET_ROOT = "/private/secret-project";
const SANITIZED_ROOT = "/workspace";
const SANITIZER_OPTIONS = {
	workspacePath: SECRET_ROOT,
	remoteWorkspacePath: SANITIZED_ROOT,
} as const;

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const testSanitizer: ProjectionSanitizer = createIrohRemoteProjectionSanitizer(SANITIZER_OPTIONS);

function assistant(
	content: AssistantMessage["content"] = [],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function textStartEvent(
	seq: number,
	snapshot: AssistantMessage,
	contentIndex = 0,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "text_start" }> {
	return { type: "text_start", seq, contentIndex, snapshot, toolState };
}

function textDeltaEvent(
	seq: number,
	snapshot: AssistantMessage,
	delta: string,
	contentIndex = 0,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "text_delta" }> {
	return { type: "text_delta", seq, contentIndex, delta, snapshot, toolState };
}

function textEndEvent(
	seq: number,
	snapshot: AssistantMessage,
	content: string,
	contentIndex = 0,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "text_end" }> {
	return { type: "text_end", seq, contentIndex, content, snapshot, toolState };
}

function thinkingStartEvent(
	seq: number,
	snapshot: AssistantMessage,
	contentIndex = 0,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "thinking_start" }> {
	return { type: "thinking_start", seq, contentIndex, snapshot, toolState };
}

function thinkingDeltaEvent(
	seq: number,
	snapshot: AssistantMessage,
	delta: string,
	contentIndex = 0,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "thinking_delta" }> {
	return { type: "thinking_delta", seq, contentIndex, delta, snapshot, toolState };
}

function thinkingEndEvent(
	seq: number,
	snapshot: AssistantMessage,
	content: string,
	contentIndex = 0,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "thinking_end" }> {
	return { type: "thinking_end", seq, contentIndex, content, snapshot, toolState };
}

function toolStartEvent(
	seq: number,
	snapshot: AssistantMessage,
	contentIndex: number,
	id: string,
	name: string,
	toolState: readonly ActiveToolCallState[],
): Extract<AssistantMessageEvent, { type: "toolcall_start" }> {
	return { type: "toolcall_start", seq, contentIndex, id, name, snapshot, toolState };
}

function toolDeltaEvent(
	seq: number,
	snapshot: AssistantMessage,
	contentIndex: number,
	argsTextDelta: string,
	toolState: readonly ActiveToolCallState[],
	identity: { id?: string; name?: string } = {},
): Extract<AssistantMessageEvent, { type: "toolcall_delta" }> {
	return { type: "toolcall_delta", seq, contentIndex, argsTextDelta, snapshot, toolState, ...identity };
}

function toolEndEvent(
	seq: number,
	snapshot: AssistantMessage,
	contentIndex: number,
	toolCall: ToolCall,
	toolState: readonly ActiveToolCallState[] = [],
): Extract<AssistantMessageEvent, { type: "toolcall_end" }> {
	return { type: "toolcall_end", seq, contentIndex, toolCall, snapshot, toolState };
}

function toolCall(id: string, name: string, args: JsonObject): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function stateForPhase(phase: ProjectionPhase): ProjectionState {
	return Object.freeze({
		phase,
		epoch: 7,
		lastSeq: phase === "synchronized" || phase === "desynchronized" ? 0 : -1,
		emitted: new Map(phase === "synchronized" || phase === "desynchronized" ? [[0, ""]] : []),
		replaceOnly: new Set(phase === "desynchronized" ? [0] : []),
	});
}

function tableToolEvent(): Extract<AssistantMessageEvent, { type: "toolcall_delta" }> {
	const argsText = JSON.stringify({ path: `${SECRET_ROOT}/notes.md` });
	const block = toolCall("tc-1", "read", parseStreamingJson<JsonObject>(argsText));
	return toolDeltaEvent(1, assistant([block]), 0, argsText, [{ contentIndex: 0, argsText }]);
}

function inputForKind(kind: ProjectionInput["kind"]): ProjectionInput {
	switch (kind) {
		case "message_start":
			return { kind, message: assistant() };
		case "event":
			return { kind, event: tableToolEvent() };
		case "message_end":
			return { kind, message: assistant([{ type: "text", text: "done" }]) };
		case "discontinuity":
		case "run_end":
		case "stream_end":
			return { kind };
	}
}

function expectedNextPhase(phase: ProjectionPhase, kind: ProjectionInput["kind"]): ProjectionPhase {
	if (phase === "terminal") return "terminal";
	switch (kind) {
		case "message_start":
			return "synchronized";
		case "event":
			return "desynchronized";
		case "message_end":
		case "run_end":
			return "idle";
		case "discontinuity":
			return phase === "idle" ? "idle" : "needs_snapshot";
		case "stream_end":
			return "terminal";
	}
}

function expectedFrameCount(phase: ProjectionPhase, kind: ProjectionInput["kind"]): number {
	if (phase === "terminal") return 0;
	return kind === "message_start" || kind === "event" || kind === "message_end" ? 1 : 0;
}

function onlyFrame(result: ProjectionResult): WireFrame {
	expect(result.frames).toHaveLength(1);
	const frame = result.frames[0];
	if (!frame) throw new Error("Expected one projected frame");
	return frame;
}

function onlyObjectFrame(frames: readonly object[]): Record<string, unknown> {
	expect(frames).toHaveLength(1);
	return getRecord(frames[0]);
}

function getRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Expected a record");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMessage(value: unknown): AssistantMessage {
	if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) {
		throw new Error("Expected an assistant message");
	}
	return value as unknown as AssistantMessage;
}

function getDecodedMessage(value: unknown): AssistantMessage {
	return getMessage(getRecord(value).message);
}

function getDecodedEvent(value: unknown): Record<string, unknown> {
	return getRecord(getRecord(value).assistantMessageEvent);
}

function cloneWire<T>(value: T): T {
	return structuredClone(value);
}

function decodeRequired(decoder: StreamProjectionDecoder, frame: unknown): Record<string, unknown> {
	const decoded = decoder.decode(cloneWire(frame));
	if (!isRecord(decoded)) throw new Error("Expected a decoded frame");
	return decoded;
}

function projectUpdate(projector: StreamProjector, event: AssistantMessageEvent): Record<string, unknown> {
	if (!("snapshot" in event)) throw new Error("Expected a snapshot-bearing update event");
	return onlyObjectFrame(
		projector.push({ type: "message_update", message: event.snapshot, assistantMessageEvent: event }).frames,
	);
}

async function normalize(fragments: readonly AssistantStreamFragment[]): Promise<AssistantMessageEvent[]> {
	const normalizer = new AssistantStreamNormalizer();
	for (const fragment of fragments) normalizer.push(fragment);
	normalizer.end();
	const events: AssistantMessageEvent[] = [];
	for await (const event of normalizer.stream) events.push(event);
	return events;
}

function startFragment(): Extract<AssistantStreamFragment, { type: "start" }> {
	return {
		type: "start",
		init: { api: "faux", provider: "faux", model: "faux-1", timestamp: 1 },
	};
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

function withoutOpaqueContent(message: AssistantMessage): unknown {
	return message.content.map((block) => {
		if (block.type === "text") {
			const { textSignature: _textSignature, ...rest } = block;
			return rest;
		}
		if (block.type === "thinking") {
			const { thinkingSignature: _thinkingSignature, ...rest } = block;
			return rest;
		}
		const { thoughtSignature: _thoughtSignature, ...rest } = block;
		return rest;
	});
}

describe("project producer transition table", () => {
	const phases: ProjectionPhase[] = ["idle", "needs_snapshot", "synchronized", "desynchronized", "terminal"];
	const inputKinds: ProjectionInput["kind"][] = [
		"message_start",
		"event",
		"message_end",
		"discontinuity",
		"run_end",
		"stream_end",
	];

	for (const phase of phases) {
		for (const kind of inputKinds) {
			it(`${phase} × ${kind} has the documented cardinality and next phase`, () => {
				const state = stateForPhase(phase);
				const result = project(state, inputForKind(kind), { sanitizer: testSanitizer });
				expect(result.frames).toHaveLength(expectedFrameCount(phase, kind));
				expect(result.state.phase).toBe(expectedNextPhase(phase, kind));
				expect(result.frames.length).toBeLessThanOrEqual(1);

				const expectedDiagnostics =
					phase === "terminal" ||
					(kind === "message_start" && (phase === "synchronized" || phase === "desynchronized"))
						? 1
						: 0;
				expect(result.diagnostics).toHaveLength(expectedDiagnostics);

				if (result.frames.length === 1) {
					const frame = result.frames[0];
					expect(Object.isFrozen(frame)).toBe(true);
					if (kind === "message_start") expect(frame.type).toBe("message_start");
					if (kind === "event") expect(frame.type).toBe("message_update");
					if (kind === "message_end") expect(frame.type).toBe("message_end");
				}
			});
		}
	}

	it("starts at needs_snapshot by default and can start explicitly idle", () => {
		expect(createProjectionState().phase).toBe("needs_snapshot");
		expect(createProjectionState("idle").phase).toBe("idle");
	});

	it("emits consistent updates as slim deltas with contiguous positions", () => {
		let state = createProjectionState("idle");
		const base = project(state, { kind: "message_start", message: assistant() });
		state = base.state;
		expect(onlyFrame(base)).toMatchObject({ type: "message_start", stream: { epoch: 1, seq: 0 } });

		const started = project(state, {
			kind: "event",
			event: textStartEvent(1, assistant([{ type: "text", text: "" }])),
		});
		state = started.state;
		const startedFrame = onlyFrame(started);
		expect(startedFrame).toMatchObject({ type: "message_update", stream: { epoch: 1, seq: 1 } });

		const delta = project(state, {
			kind: "event",
			event: textDeltaEvent(2, assistant([{ type: "text", text: "hello" }]), "hello"),
		});
		const deltaFrame = onlyFrame(delta);
		expect(deltaFrame).toMatchObject({
			type: "message_update",
			stream: { epoch: 1, seq: 2 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		});
		expect("message" in deltaFrame).toBe(false);
		const slim = (deltaFrame as ProjectedMessageUpdateFrame).assistantMessageEvent;
		expect("seq" in slim).toBe(false);
		expect("snapshot" in slim).toBe(false);
		expect("toolState" in slim).toBe(false);
	});

	it("recovers sequence gaps and non-append authoritative ends with snapshots", () => {
		let state = project(createProjectionState("idle"), {
			kind: "message_start",
			message: assistant([{ type: "text", text: "" }]),
		}).state;
		state = project(state, {
			kind: "event",
			event: textDeltaEvent(1, assistant([{ type: "text", text: "a" }]), "a"),
		}).state;

		const gap = project(state, {
			kind: "event",
			event: textDeltaEvent(3, assistant([{ type: "text", text: "abc" }]), "bc"),
		});
		expect(onlyFrame(gap)).toHaveProperty("message");
		expect(gap.state.epoch).toBe(2);
		expect(gap.diagnostics.map((entry) => entry.code)).toEqual(["sequence_gap"]);

		const replacement = project(gap.state, {
			kind: "event",
			event: textEndEvent(4, assistant([{ type: "text", text: "replacement" }]), "replacement"),
		});
		expect(onlyFrame(replacement)).toHaveProperty("message");
		expect(replacement.state.epoch).toBe(3);
	});

	it("treats update start/done/error events as malformed without throwing", () => {
		const state = createProjectionState("idle");
		const message = assistant();
		const events: AssistantMessageEvent[] = [
			{ type: "start", seq: 0, snapshot: message, toolState: [] },
			{ type: "done", seq: 1, reason: "stop", message },
			{ type: "error", seq: 1, reason: "error", error: { ...message, stopReason: "error", errorMessage: "x" } },
		];
		for (const event of events) {
			const result = project(state, { kind: "event", event });
			expect(result.frames).toHaveLength(0);
			expect(result.diagnostics.map((entry) => entry.code)).toEqual(["non_update_event"]);
		}
	});

	it("does not mutate the prior state's maps while projecting", () => {
		const state = stateForPhase("synchronized");
		const emittedBefore = [...state.emitted];
		const replaceOnlyBefore = [...state.replaceOnly];
		const result = project(state, {
			kind: "event",
			event: textDeltaEvent(1, assistant([{ type: "text", text: "x" }]), "x"),
		});
		expect([...state.emitted]).toEqual(emittedBefore);
		expect([...state.replaceOnly]).toEqual(replaceOnlyBefore);
		expect(result.state.emitted).not.toBe(state.emitted);
		expect(result.state.replaceOnly).not.toBe(state.replaceOnly);
	});
});

describe("tool-state snapshots and authoritative replacement", () => {
	it("resumes arguments after a mid-toolcall attachment", () => {
		const projector = new StreamProjector();
		const decoder = new StreamProjectionDecoder();
		const firstArgs = '{"path":"no';
		const firstBlock = toolCall("tc-1", "read", parseStreamingJson<JsonObject>(firstArgs));
		const firstEvent = toolDeltaEvent(3, assistant([firstBlock]), 0, "no", [
			{ contentIndex: 0, argsText: firstArgs },
		]);
		const firstFrame = projectUpdate(projector, firstEvent);
		expect(firstFrame).toHaveProperty("message");
		expect(firstFrame.toolState).toEqual([{ contentIndex: 0, argsText: firstArgs }]);
		const adopted = decodeRequired(decoder, firstFrame);
		expect(getDecodedEvent(adopted).snapshot).toBe(getDecodedMessage(adopted));

		const suffix = 'tes.md"}';
		const fullArgs = firstArgs + suffix;
		const nextBlock = toolCall("tc-1", "read", parseStreamingJson<JsonObject>(fullArgs));
		const nextEvent = toolDeltaEvent(4, assistant([nextBlock]), 0, suffix, [{ contentIndex: 0, argsText: fullArgs }]);
		const nextFrame = projectUpdate(projector, nextEvent);
		expect(nextFrame).not.toHaveProperty("message");
		const decoded = decodeRequired(decoder, nextFrame);
		expect(getMessage(decoded.message).content[0]).toMatchObject({ arguments: { path: "notes.md" } });
		expect(getDecodedEvent(decoded).toolState).toEqual([{ contentIndex: 0, argsText: fullArgs }]);
	});

	it("keeps concurrent replace-only calls desynchronized until the set drains", () => {
		const argsA = JSON.stringify({ path: `${SECRET_ROOT}/a` });
		const argsB = JSON.stringify({ path: `${SECRET_ROOT}/b` });
		const openA = toolCall("tc-a", "read", { path: `${SECRET_ROOT}/a` });
		const openB = toolCall("tc-b", "read", { path: `${SECRET_ROOT}/b` });
		const startEvent = toolDeltaEvent(5, assistant([openA, openB]), 0, argsA, [
			{ contentIndex: 0, argsText: argsA },
			{ contentIndex: 1, argsText: argsB },
		]);
		let result = project(createProjectionState(), { kind: "event", event: startEvent }, { sanitizer: testSanitizer });
		expect(result.state.phase).toBe("desynchronized");
		expect([...result.state.replaceOnly]).toEqual([0, 1]);
		expect(onlyFrame(result)).toHaveProperty("message");

		result = project(
			result.state,
			{
				kind: "event",
				event: toolEndEvent(6, assistant([openA, openB]), 0, openA, [{ contentIndex: 1, argsText: argsB }]),
			},
			{ sanitizer: testSanitizer },
		);
		expect(result.frames).toHaveLength(1);
		expect(result.state.phase).toBe("desynchronized");
		expect([...result.state.replaceOnly]).toEqual([1]);

		result = project(
			result.state,
			{ kind: "event", event: toolEndEvent(7, assistant([openA, openB]), 1, openB) },
			{ sanitizer: testSanitizer },
		);
		expect(result.frames).toHaveLength(1);
		expect(result.state.phase).toBe("synchronized");
		expect([...result.state.replaceOnly]).toEqual([]);
	});

	it("ships authoritative text, thinking, and tool ends as replacements", () => {
		const projector = new StreamProjector({}, "idle");
		const decoder = new StreamProjectionDecoder();
		decodeRequired(decoder, onlyObjectFrame(projector.push({ type: "message_start", message: assistant() }).frames));

		const textStart = textStartEvent(1, assistant([{ type: "text", text: "" }]));
		decodeRequired(decoder, projectUpdate(projector, textStart));
		decodeRequired(
			decoder,
			projectUpdate(projector, textDeltaEvent(2, assistant([{ type: "text", text: "old" }]), "old")),
		);
		const textEnd = textEndEvent(3, assistant([{ type: "text", text: "new" }]), "new");
		const textEndFrame = projectUpdate(projector, textEnd);
		expect(getRecord(textEndFrame.assistantMessageEvent)).not.toHaveProperty("message");
		const decodedText = decodeRequired(decoder, textEndFrame);
		expect(getDecodedMessage(decodedText).content[0]).toEqual({ type: "text", text: "new" });

		const thinkingStart = thinkingStartEvent(
			4,
			assistant([
				{ type: "text", text: "new" },
				{ type: "thinking", thinking: "" },
			]),
			1,
		);
		decodeRequired(decoder, projectUpdate(projector, thinkingStart));
		decodeRequired(
			decoder,
			projectUpdate(
				projector,
				thinkingDeltaEvent(
					5,
					assistant([
						{ type: "text", text: "new" },
						{ type: "thinking", thinking: "old" },
					]),
					"old",
					1,
				),
			),
		);
		const thinkingEnd = thinkingEndEvent(
			6,
			assistant([
				{ type: "text", text: "new" },
				{ type: "thinking", thinking: "replacement" },
			]),
			"replacement",
			1,
		);
		const decodedThinking = decodeRequired(decoder, projectUpdate(projector, thinkingEnd));
		expect(getDecodedMessage(decodedThinking).content[1]).toEqual({ type: "thinking", thinking: "replacement" });

		const initialTool = toolCall("tc", "old-name", {});
		const startedToolMessage = assistant([
			{ type: "text", text: "new" },
			{ type: "thinking", thinking: "replacement" },
			initialTool,
		]);
		decodeRequired(
			decoder,
			projectUpdate(
				projector,
				toolStartEvent(7, startedToolMessage, 2, "tc", "old-name", [{ contentIndex: 2, argsText: "" }]),
			),
		);
		const authoritative = toolCall("tc-final", "write", { path: "final.md" });
		const endedToolMessage = assistant([
			{ type: "text", text: "new" },
			{ type: "thinking", thinking: "replacement" },
			authoritative,
		]);
		const decodedTool = decodeRequired(
			decoder,
			projectUpdate(projector, toolEndEvent(8, endedToolMessage, 2, authoritative)),
		);
		expect(getDecodedMessage(decodedTool).content[2]).toEqual(authoritative);
	});
});

type DecoderPhaseForTest = "idle" | "synchronized" | "desynchronized";
type DecoderFrameKind = "base" | "snapshot" | "delta" | "final";

function prepareDecoder(phase: DecoderPhaseForTest): {
	decoder: StreamProjectionDecoder;
	diagnostics: string[];
} {
	const diagnostics: string[] = [];
	const decoder = new StreamProjectionDecoder({ onDiagnostic: (entry) => diagnostics.push(entry.code) });
	if (phase !== "idle") {
		decoder.decode({ type: "message_start", stream: { epoch: 4, seq: 0 }, message: assistant() });
	}
	if (phase === "desynchronized") {
		decoder.decode({
			type: "message_update",
			stream: { epoch: 4, seq: 2 },
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		diagnostics.length = 0;
	}
	return { decoder, diagnostics };
}

function decoderFrame(kind: DecoderFrameKind, phase: DecoderPhaseForTest): Record<string, unknown> {
	const epoch = phase === "idle" ? 1 : 4;
	switch (kind) {
		case "base":
			return { type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() };
		case "snapshot": {
			const message = assistant([{ type: "text", text: "seed" }]);
			return {
				type: "message_update",
				stream: { epoch: 1, seq: 8 },
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "seed" },
			};
		}
		case "delta":
			return {
				type: "message_update",
				stream: { epoch, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			};
		case "final":
			return {
				type: "message_end",
				stream: { epoch: 1, seq: 9 },
				message: assistant([{ type: "text", text: "final" }]),
			};
	}
}

describe("StreamProjectionDecoder mirrored transition table", () => {
	const phases: DecoderPhaseForTest[] = ["idle", "synchronized", "desynchronized"];
	const frameKinds: DecoderFrameKind[] = ["base", "snapshot", "delta", "final"];

	for (const phase of phases) {
		for (const kind of frameKinds) {
			it(`${phase} × ${kind} adopts or drops exactly as documented`, () => {
				const { decoder, diagnostics } = prepareDecoder(phase);
				const decoded = decoder.decode(decoderFrame(kind, phase));
				const shouldDrop = kind === "delta" && phase !== "synchronized";
				if (shouldDrop) {
					expect(decoded).toBeUndefined();
					expect(diagnostics).toContain("delta_position_gap");
					return;
				}

				expect(decoded).toBeDefined();
				if (kind === "snapshot") {
					const record = getRecord(decoded);
					expect(getDecodedEvent(record).snapshot).toBe(getDecodedMessage(record));
					expect(getDecodedEvent(record).seq).toBe(8);
				}
				if (kind === "delta") {
					expect(getDecodedMessage(decoded).content).toEqual([{ type: "text", text: "" }]);
				}
			});
		}
	}

	it("adopts lower-epoch base, snapshot, and final frames unconditionally", () => {
		const decoder = new StreamProjectionDecoder();
		decoder.decode({ type: "message_start", stream: { epoch: 20, seq: 0 }, message: assistant() });
		decoder.decode({
			type: "message_update",
			stream: { epoch: 20, seq: 1 },
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});

		const lowerBase = decodeRequired(decoder, {
			type: "message_start",
			stream: { epoch: 1, seq: 0 },
			message: assistant(),
		});
		expect(getMessage(lowerBase.message).content).toEqual([]);
		const afterBase = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		expect(getDecodedMessage(afterBase).content).toEqual([{ type: "text", text: "" }]);

		const snapshotMessage = assistant([{ type: "text", text: "rebound" }]);
		const lowerSnapshot = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 0, seq: 7 },
			message: snapshotMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "rebound" },
		});
		expect(getDecodedMessage(lowerSnapshot).content).toEqual(snapshotMessage.content);

		const finalMessage = assistant([{ type: "text", text: "final rebound" }]);
		const lowerFinal = decodeRequired(decoder, {
			type: "message_end",
			stream: { epoch: 0, seq: 1 },
			message: finalMessage,
		});
		expect(getDecodedMessage(lowerFinal).content).toEqual(finalMessage.content);
	});

	it("drops stale deltas until an adoptable snapshot recovers the stream", () => {
		const diagnostics: string[] = [];
		const decoder = new StreamProjectionDecoder({ onDiagnostic: (entry) => diagnostics.push(entry.code) });
		decoder.decode({ type: "message_start", stream: { epoch: 3, seq: 0 }, message: assistant() });
		expect(
			decoder.decode({
				type: "message_update",
				stream: { epoch: 2, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			}),
		).toBeUndefined();
		expect(
			decoder.decode({
				type: "message_update",
				stream: { epoch: 3, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			}),
		).toBeUndefined();

		const recoveredMessage = assistant([{ type: "text", text: "recovered" }]);
		const recovered = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 4, seq: 4 },
			message: recoveredMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" },
		});
		expect(getDecodedMessage(recovered).content).toEqual(recoveredMessage.content);
		expect(diagnostics.filter((code) => code === "delta_position_gap")).toHaveLength(2);
	});

	it("preserves copy-on-write history and freezes newly decoded graphs", () => {
		const decoder = new StreamProjectionDecoder();
		const base = decodeRequired(decoder, {
			type: "message_start",
			stream: { epoch: 1, seq: 0 },
			message: assistant([{ type: "text", text: "stable" }]),
		});
		const baseMessage = getDecodedMessage(base);
		const started = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
		});
		const startedMessage = getDecodedMessage(started);
		const delta = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 1, seq: 2 },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "new" },
		});
		const deltaMessage = getDecodedMessage(delta);

		expect(baseMessage.content).toEqual([{ type: "text", text: "stable" }]);
		expect(startedMessage.content[1]).toEqual({ type: "thinking", thinking: "" });
		expect(deltaMessage.content[1]).toEqual({ type: "thinking", thinking: "new" });
		expect(deltaMessage).not.toBe(startedMessage);
		expect(deltaMessage.content).not.toBe(startedMessage.content);
		expect(deltaMessage.content[0]).toBe(startedMessage.content[0]);
		expect(Object.isFrozen(baseMessage)).toBe(true);
		expect(Object.isFrozen(deltaMessage)).toBe(true);
		expect(Object.isFrozen(deltaMessage.content)).toBe(true);
		expect(Object.isFrozen(deltaMessage.content[1])).toBe(true);
	});

	it("drops huge, negative, fractional, and wrong-kind content indexes without allocation", () => {
		const invalidIndexes: unknown[] = [50_000_000, -1, 0.5, Number.POSITIVE_INFINITY, "0"];
		for (const contentIndex of invalidIndexes) {
			const diagnostics: string[] = [];
			const decoder = new StreamProjectionDecoder({ onDiagnostic: (entry) => diagnostics.push(entry.code) });
			decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
			const decoded = decoder.decode({
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex },
			});
			expect(decoded).toBeUndefined();
			expect(diagnostics).toContain("invalid_delta_payload");
		}
	});

	it("drops malformed positions and payloads and recovers via snapshot", () => {
		const invalidPositions: unknown[] = [
			{},
			{ epoch: -1, seq: 1 },
			{ epoch: 1.5, seq: 1 },
			{ epoch: 1, seq: Number.NaN },
			{ epoch: "1", seq: 1 },
		];
		const unrecognized = {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		};
		const passthroughDecoder = new StreamProjectionDecoder();
		expect(passthroughDecoder.decode(unrecognized)).toBe(unrecognized);
		for (const stream of invalidPositions) {
			const decoder = new StreamProjectionDecoder();
			decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
			expect(
				decoder.decode({
					type: "message_update",
					stream,
					assistantMessageEvent: { type: "text_start", contentIndex: 0 },
				}),
			).toBeUndefined();
		}

		const decoder = new StreamProjectionDecoder();
		decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
		expect(
			decoder.decode({
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: 42 },
			}),
		).toBeUndefined();
		const recovered = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 2, seq: 2 },
			message: assistant([{ type: "text", text: "ok" }]),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
		});
		expect(getDecodedMessage(recovered).content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("rejects an authoritative tool end when no tool block exists", () => {
		const decoder = new StreamProjectionDecoder();
		decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
		const decoded = decoder.decode({
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: toolCall("tc", "read", {}),
			},
		});
		expect(decoded).toBeUndefined();
	});
});

describe("stateful adapters and keyed stream lifecycles", () => {
	it("passes non-assistant messages through untouched with no stream marker or state change", () => {
		const projector = new StreamProjector({}, "idle");
		const frames = [
			{ type: "message_start", message: { role: "user", content: "hello", timestamp: 1 } },
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "tc",
					toolName: "read",
					content: [{ type: "text", text: `${SECRET_ROOT}/result` }],
					isError: false,
					timestamp: 1,
				},
			},
			{ type: "message_start", message: { role: "custom", content: "custom", timestamp: 1 } },
		];
		for (const frame of frames) {
			const result = projector.push(frame);
			expect(result.frames).toEqual([frame]);
			expect(result.frames[0]).toBe(frame);
			expect(result.frames[0]).not.toHaveProperty("stream");
			expect(projector.state.phase).toBe("idle");
		}
	});

	it("recovers the next event with a snapshot after discontinuity", () => {
		const projector = new StreamProjector({}, "idle");
		const decoder = new StreamProjectionDecoder();
		decodeRequired(decoder, onlyObjectFrame(projector.push({ type: "message_start", message: assistant() }).frames));
		decodeRequired(decoder, projectUpdate(projector, textStartEvent(1, assistant([{ type: "text", text: "" }]))));
		expect(projector.discontinuity().frames).toHaveLength(0);
		expect(projector.state.phase).toBe("needs_snapshot");

		const recoveredFrame = projectUpdate(
			projector,
			textDeltaEvent(2, assistant([{ type: "text", text: "recovered" }]), "recovered"),
		);
		expect(recoveredFrame).toHaveProperty("message");
		const recovered = decodeRequired(decoder, recoveredFrame);
		expect(getDecodedMessage(recovered).content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("retains epoch across run resets and only stream teardown is terminal", () => {
		const projector = new StreamProjector({}, "idle");
		const first = onlyObjectFrame(projector.push({ type: "message_start", message: assistant() }).frames);
		expect(getRecord(first.stream).epoch).toBe(1);
		const resetFrame = { type: "agent_end", messages: [] };
		expect(projector.push(resetFrame).frames).toEqual([resetFrame]);
		expect(projector.state.phase).toBe("idle");
		const second = onlyObjectFrame(projector.push({ type: "message_start", message: assistant() }).frames);
		expect(getRecord(second.stream).epoch).toBe(2);

		projector.endStream();
		expect(projector.state.phase).toBe("terminal");
		const after = projector.push({ type: "message_start", message: assistant() });
		expect(after.frames).toHaveLength(0);
		expect(after.diagnostics.map((entry) => entry.code)).toEqual(["input_after_stream_end"]);
	});

	it("keys main and subagent streams independently and resets/deletes only the targeted key", () => {
		const decoder = new StreamProjectionDecoder();
		decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
		decoder.decode({
			type: "subagent_event",
			subagentId: "sa-a",
			event: { type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() },
		});
		decoder.decode({
			type: "subagent_event",
			subagentId: "sa-b",
			event: { type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() },
		});

		const main = decodeRequired(decoder, {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		expect(getDecodedMessage(main).content).toEqual([{ type: "text", text: "" }]);

		const subA = decodeRequired(decoder, {
			type: "subagent_event",
			subagentId: "sa-a",
			event: {
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
			},
		});
		expect(getDecodedMessage(getRecord(subA.event)).content).toEqual([{ type: "thinking", thinking: "" }]);

		decoder.decode({
			type: "subagent_event",
			subagentId: "sa-a",
			event: { type: "agent_end", messages: [] },
		});
		expect(
			decoder.decode({
				type: "subagent_event",
				subagentId: "sa-a",
				event: {
					type: "message_update",
					stream: { epoch: 1, seq: 2 },
					assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "lost" },
				},
			}),
		).toBeUndefined();

		const subB = decodeRequired(decoder, {
			type: "subagent_event",
			subagentId: "sa-b",
			event: {
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			},
		});
		expect(getDecodedMessage(getRecord(subB.event)).content).toEqual([{ type: "text", text: "" }]);

		decoder.decode({ type: "subagent_disposed", subagentId: "sa-b" });
		const reseeded = decodeRequired(decoder, {
			type: "subagent_event",
			subagentId: "sa-b",
			event: { type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() },
		});
		expect(getMessage(getRecord(reseeded.event).message).content).toEqual([]);
	});

	it.each(["agent_start", "agent_end", "agent_settled"])("%s resets the decoder run state", (type) => {
		const decoder = new StreamProjectionDecoder();
		decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
		decoder.decode({ type });
		expect(
			decoder.decode({
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			}),
		).toBeUndefined();
	});
});

describe("sanitizer-mode projection", () => {
	it("sanitizes snapshots, deltas, authoritative ends, diagnostics, and argument keys", async () => {
		const path = `${SECRET_ROOT}/notes.md`;
		const args = { [path]: path };
		const argsText = JSON.stringify(args);
		const splitAt = argsText.indexOf("secret-project") + 3;
		const events = await normalize([
			{
				...startFragment(),
				init: {
					...startFragment().init,
					diagnostics: [
						{
							type: "test",
							timestamp: 1,
							error: { message: path, stack: `at ${path}` },
							details: { path },
						},
					],
				},
			},
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: `See ${path.slice(0, 12)}` },
			{ type: "text_delta", contentIndex: 0, delta: `${path.slice(12)} now` },
			{ type: "text_end", contentIndex: 0, content: `See ${path} now` },
			{ type: "toolcall_start", contentIndex: 1, id: "opaque-id", name: `read ${path}` },
			{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: argsText.slice(0, splitAt) },
			{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: argsText.slice(splitAt) },
			{ type: "toolcall_end", contentIndex: 1, toolCall: toolCall("opaque-id", "read", args) },
			{ type: "error", reason: "error", errorMessage: `failed at ${path}` },
		]);

		const projector = new StreamProjector({ sanitizer: testSanitizer }, "idle");
		const decoder = new StreamProjectionDecoder();
		let finalFrame: Record<string, unknown> | undefined;
		for (const event of events) {
			const batch = pushNormalizedEvent(projector, event);
			for (const frame of batch.frames) {
				expect(JSON.stringify(frame)).not.toContain(SECRET_ROOT);
				const decoded = decoder.decode(cloneWire(frame));
				expect(decoded).toBeDefined();
				if (event.type === "done" || event.type === "error") finalFrame = getRecord(frame);
			}
		}

		const finalMessage = events.map(terminalMessage).find((value) => value !== undefined);
		if (!finalMessage || !finalFrame) throw new Error("Expected a projected terminal frame");
		const expected = testSanitizer.sanitizeValue(finalMessage) as AssistantMessage;
		expect(getMessage(finalFrame.message)).toEqual(expected);
	});

	it("preserves opaque identity/signature/image fields byte-for-byte", () => {
		const opaque = `opaque:${SECRET_ROOT}:bytes`;
		const message = assistant([
			{ type: "text", text: `${SECRET_ROOT}/visible`, textSignature: opaque },
			{ type: "thinking", thinking: `${SECRET_ROOT}/thought`, thinkingSignature: opaque },
			{ ...toolCall(opaque, `${SECRET_ROOT}/tool`, { path: `${SECRET_ROOT}/arg` }), thoughtSignature: opaque },
		]);
		const result = project(
			createProjectionState("idle"),
			{ kind: "message_start", message },
			{
				sanitizer: testSanitizer,
			},
		);
		const sanitized = getMessage(onlyFrame(result).message);
		expect(sanitized.content[0]).toMatchObject({ text: `${SANITIZED_ROOT}/visible`, textSignature: opaque });
		expect(sanitized.content[1]).toMatchObject({
			thinking: `${SANITIZED_ROOT}/thought`,
			thinkingSignature: opaque,
		});
		expect(sanitized.content[2]).toMatchObject({
			id: opaque,
			name: `${SANITIZED_ROOT}/tool`,
			thoughtSignature: opaque,
			arguments: { path: `${SANITIZED_ROOT}/arg` },
		});
	});
});

interface GeneratedTurn {
	textChunks: string[];
	thinkingChunks: string[];
	argKey: string;
	argValue: string;
	argNumber: number;
	argChunkWidths: number[];
	rewriteText: boolean;
	rewriteThinking: boolean;
	rewriteTool: boolean;
	redactedThinking: boolean;
	terminal: "done" | "error";
}

const nonEmptyShortString = fc.string({ minLength: 1, maxLength: 12 });
const generatedTurnArbitrary: fc.Arbitrary<GeneratedTurn> = fc.record({
	textChunks: fc.array(nonEmptyShortString, { maxLength: 5 }),
	thinkingChunks: fc.array(nonEmptyShortString, { maxLength: 4 }),
	argKey: fc.string({ maxLength: 10 }),
	argValue: fc.string({ maxLength: 16 }),
	argNumber: fc.integer({ min: -1_000, max: 1_000 }),
	argChunkWidths: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 6 }),
	rewriteText: fc.boolean(),
	rewriteThinking: fc.boolean(),
	rewriteTool: fc.boolean(),
	redactedThinking: fc.boolean(),
	terminal: fc.constantFrom("done", "error"),
});

function splitByWidths(value: string, widths: readonly number[]): string[] {
	if (value.length === 0) return [""];
	const chunks: string[] = [];
	let offset = 0;
	let widthIndex = 0;
	while (offset < value.length) {
		const width = widths[widthIndex % widths.length] ?? 1;
		chunks.push(value.slice(offset, offset + width));
		offset += width;
		widthIndex += 1;
	}
	return chunks;
}

function generatedTurnFragments(value: GeneratedTurn): AssistantStreamFragment[] {
	const accumulatedText = value.textChunks.join("");
	const finalText = value.rewriteText ? `authoritative:${accumulatedText}` : accumulatedText;
	const accumulatedThinking = value.thinkingChunks.join("");
	const finalThinking = value.rewriteThinking ? `authoritative:${accumulatedThinking}` : accumulatedThinking;
	const rawArguments = {
		[`key:${value.argKey}`]: value.argValue,
		count: value.argNumber,
	};
	const argsText = JSON.stringify(rawArguments);
	const finalArguments = value.rewriteTool ? { ...rawArguments, authoritative: true } : rawArguments;
	const fragments: AssistantStreamFragment[] = [
		{
			...startFragment(),
			init: {
				...startFragment().init,
				responseId: "opaque-response-id",
			},
		},
		{
			type: "meta",
			patch: {
				responseModel: "resolved-model",
				usage: { input: 7, output: 3, totalTokens: 10 },
			},
		},
		{ type: "text_start", contentIndex: 0 },
		...value.textChunks.map((delta): AssistantStreamFragment => ({ type: "text_delta", contentIndex: 0, delta })),
		{
			type: "text_end",
			contentIndex: 0,
			content: finalText,
			textSignature: "opaque-text-signature",
		},
		{ type: "thinking_start", contentIndex: 1 },
		...value.thinkingChunks.map(
			(delta): AssistantStreamFragment => ({
				type: "thinking_delta",
				contentIndex: 1,
				delta,
				signatureDelta: `sig:${delta.length}`,
			}),
		),
		{
			type: "thinking_end",
			contentIndex: 1,
			content: finalThinking,
			thinkingSignature: "opaque-thinking-signature",
			redacted: value.redactedThinking,
		},
		{ type: "toolcall_start", contentIndex: 2, id: "opaque-tool-id", name: "generated_tool" },
		...splitByWidths(argsText, value.argChunkWidths).map(
			(argsTextDelta): AssistantStreamFragment => ({
				type: "toolcall_delta",
				contentIndex: 2,
				argsTextDelta,
			}),
		),
		{
			type: "toolcall_end",
			contentIndex: 2,
			toolCall: {
				...toolCall("opaque-tool-id", "generated_tool", finalArguments),
				thoughtSignature: "opaque-tool-signature",
			},
		},
	];
	fragments.push(
		value.terminal === "done"
			? { type: "done", reason: "toolUse" }
			: {
					type: "error",
					reason: "aborted",
					errorMessage: "generated abort",
				},
	);
	return fragments;
}

function pushNormalizedEvent(projector: StreamProjector, event: AssistantMessageEvent) {
	if (event.type === "start") {
		return projector.push({ type: "message_start", message: event.snapshot });
	}
	if (event.type === "done") {
		return projector.push({ type: "message_end", message: event.message });
	}
	if (event.type === "error") {
		return projector.push({ type: "message_end", message: event.error });
	}
	return projector.push({ type: "message_update", message: event.snapshot, assistantMessageEvent: event });
}

function messageForNormalizedEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.snapshot;
}

function sanitizeExpectedMessage(
	message: AssistantMessage,
	sanitizer: ProjectionSanitizer | undefined,
): AssistantMessage {
	return sanitizer ? (sanitizer.sanitizeValue(message) as AssistantMessage) : message;
}

function expectDecodedEventMatches(
	decoded: Record<string, unknown>,
	frame: Record<string, unknown>,
	event: AssistantMessageEvent,
	sanitizer?: ProjectionSanitizer,
): void {
	const expected = sanitizeExpectedMessage(messageForNormalizedEvent(event), sanitizer);
	const decodedMessage = getDecodedMessage(decoded);
	const isAdoption = isRecord(frame.message);
	if (isAdoption) {
		expect(decodedMessage).toEqual(expected);
	} else {
		expect(withoutOpaqueContent(decodedMessage)).toEqual(withoutOpaqueContent(expected));
	}
	if (event.type !== "start" && event.type !== "done" && event.type !== "error") {
		const rebuilt = getDecodedEvent(decoded);
		expect(rebuilt.seq).toBe(event.seq);
		expect(rebuilt.snapshot).toBe(decodedMessage);
	}
}

async function normalizedRoundTrip(
	fragments: readonly AssistantStreamFragment[],
	options: { sanitizer?: ProjectionSanitizer } = {},
): Promise<{
	events: AssistantMessageEvent[];
	frames: Record<string, unknown>[];
	finalMessage: AssistantMessage;
}> {
	const events = await normalize(fragments);
	const projector = new StreamProjector(options.sanitizer ? { sanitizer: options.sanitizer } : {}, "idle");
	const decoder = new StreamProjectionDecoder();
	const frames: Record<string, unknown>[] = [];
	let finalMessage: AssistantMessage | undefined;
	for (const event of events) {
		const batch = pushNormalizedEvent(projector, event);
		expect(batch.frames).toHaveLength(1);
		const frame = onlyObjectFrame(batch.frames);
		frames.push(frame);
		const decoded = decodeRequired(decoder, frame);
		expectDecodedEventMatches(decoded, frame, event, options.sanitizer);
		if (event.type === "done" || event.type === "error") {
			finalMessage = getDecodedMessage(decoded);
		}
	}
	if (!finalMessage) throw new Error("Expected a terminal normalized event");
	return { events, frames, finalMessage };
}

describe("stateful projection properties", () => {
	it("round-trips randomized normalizer snapshots at every sequence and adopts exact boundaries", async () => {
		await fc.assert(
			fc.asyncProperty(generatedTurnArbitrary, async (value) => {
				const fragments = generatedTurnFragments(value);
				const events = await normalize(fragments);
				const expectedFinal = messageForNormalizedEvent(events.at(-1) as AssistantMessageEvent);
				const result = await normalizedRoundTrip(fragments);
				expect(result.finalMessage).toEqual(expectedFinal);
			}),
			{ numRuns: 75 },
		);
	});

	it("never leaks planted host paths and rebuilds the sanitized accumulation at every sequence", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					prefix: fc.string({ maxLength: 12 }),
					suffix: fc.string({ minLength: 1, maxLength: 12 }),
					rootSplit: fc.integer({ min: 1, max: SECRET_ROOT.length - 1 }),
				}),
				async ({ prefix, suffix, rootSplit }) => {
					const path = `${SECRET_ROOT}/${suffix}`;
					const textPrefix = `${prefix} `;
					const text = `${textPrefix}${path}`;
					const textSplit = textPrefix.length + rootSplit;
					const args = { [path]: path, nested: { path } };
					const argsText = JSON.stringify(args);
					const argsSplit = argsText.indexOf(SECRET_ROOT) + rootSplit;
					const fragments: AssistantStreamFragment[] = [
						{
							...startFragment(),
							init: {
								...startFragment().init,
								diagnostics: [
									{
										type: "generated",
										timestamp: 1,
										error: { message: path, stack: `at ${path}` },
										details: { [path]: path },
									},
								],
							},
						},
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: text.slice(0, textSplit) },
						{ type: "text_delta", contentIndex: 0, delta: text.slice(textSplit) },
						{
							type: "text_end",
							contentIndex: 0,
							content: text,
							textSignature: "opaque-text-signature",
						},
						{ type: "toolcall_start", contentIndex: 1, id: "opaque-id", name: `read ${path}` },
						{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: argsText.slice(0, argsSplit) },
						{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: argsText.slice(argsSplit) },
						{
							type: "toolcall_end",
							contentIndex: 1,
							toolCall: {
								...toolCall("opaque-id", "read", args),
								thoughtSignature: "opaque-tool-signature",
							},
						},
						{
							type: "error",
							reason: "error",
							errorMessage: `failed at ${path}`,
							diagnostics: [
								{
									type: "generated_terminal",
									timestamp: 2,
									error: { message: path, stack: `terminal ${path}` },
									details: { path },
								},
							],
						},
					];
					const result = await normalizedRoundTrip(fragments, { sanitizer: testSanitizer });
					for (const frame of result.frames) {
						expect(JSON.stringify(frame)).not.toContain(SECRET_ROOT);
					}

					const imageData = `opaque:${SECRET_ROOT}:image`;
					const nonAssistantFrames = [
						{ type: "message_start", message: { role: "user", content: `open ${path}`, timestamp: 1 } },
						{
							type: "message_end",
							message: {
								role: "toolResult",
								toolCallId: "tc",
								toolName: "read",
								content: [
									{ type: "text", text: path },
									{ type: "image", data: imageData, mimeType: "image/png" },
								],
								isError: false,
								timestamp: 1,
							},
						},
						{ type: "custom", path, payload: `visible ${path}` },
					];
					const filtered = nonAssistantFrames.map((frame) => sanitizeIrohRemoteOutbound(frame, SANITIZER_OPTIONS));
					expect(JSON.stringify(filtered[0])).not.toContain(SECRET_ROOT);
					expect(JSON.stringify(filtered[2])).not.toContain(SECRET_ROOT);
					const filteredImage = getRecord(getRecord(filtered[1]).message).content as unknown[];
					expect(getRecord(filteredImage[1]).data).toBe(imageData);
					expect(getRecord(filteredImage[0]).text).toBe(testSanitizer.sanitizeText(path));
				},
			),
			{ numRuns: 50 },
		);
	});

	it("converges when attachment begins at any randomized event index", async () => {
		await fc.assert(
			fc.asyncProperty(generatedTurnArbitrary, fc.nat(), async (value, indexSeed) => {
				const events = await normalize(generatedTurnFragments(value));
				const attachIndex = indexSeed % events.length;
				const projector = new StreamProjector();
				const decoder = new StreamProjectionDecoder();
				let final: AssistantMessage | undefined;
				for (const event of events.slice(attachIndex)) {
					const frame = onlyObjectFrame(pushNormalizedEvent(projector, event).frames);
					const decoded = decodeRequired(decoder, frame);
					if (event.type === "done" || event.type === "error") final = getDecodedMessage(decoded);
				}
				const expected = messageForNormalizedEvent(events.at(-1) as AssistantMessageEvent);
				expect(final).toEqual(expected);
			}),
			{ numRuns: 50 },
		);
	});

	it("recovers from randomized discontinuities and projector recreation", async () => {
		await fc.assert(
			fc.asyncProperty(generatedTurnArbitrary, fc.nat(), fc.boolean(), async (value, indexSeed, recreate) => {
				const events = await normalize(generatedTurnFragments(value));
				const updateIndexes = events
					.map((event, index) => ({ event, index }))
					.filter(({ event }) => event.type !== "start" && event.type !== "done" && event.type !== "error")
					.map(({ index }) => index);
				const recoveryIndex = updateIndexes[indexSeed % updateIndexes.length] as number;
				let projector = new StreamProjector({}, "idle");
				const decoder = new StreamProjectionDecoder();
				let recovered = false;
				let final: AssistantMessage | undefined;
				for (const [index, event] of events.entries()) {
					if (index === recoveryIndex) {
						if (recreate) projector = new StreamProjector();
						else projector.discontinuity();
					}
					const frame = onlyObjectFrame(pushNormalizedEvent(projector, event).frames);
					const decoded = decodeRequired(decoder, frame);
					if (index === recoveryIndex) {
						expect(frame).toHaveProperty("message");
						recovered = true;
					}
					if (event.type === "done" || event.type === "error") final = getDecodedMessage(decoded);
				}
				expect(recovered).toBe(true);
				expect(final).toEqual(messageForNormalizedEvent(events.at(-1) as AssistantMessageEvent));
			}),
			{ numRuns: 50 },
		);
	});

	it("keeps one subscription live across randomized retries, aborts, and later prompts", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.string({ maxLength: 20 }), { minLength: 2, maxLength: 5 }),
				fc.array(fc.nat({ max: 2 }), { minLength: 2, maxLength: 5 }),
				async (texts, extraResets) => {
					const projector = new StreamProjector({}, "idle");
					const decoder = new StreamProjectionDecoder();
					const startEpochs: number[] = [];
					for (const [runIndex, text] of texts.entries()) {
						const events = await normalize([
							startFragment(),
							{ type: "text_start", contentIndex: 0 },
							{ type: "text_delta", contentIndex: 0, delta: text },
							{ type: "text_end", contentIndex: 0, content: text },
							runIndex % 2 === 0
								? { type: "error", reason: "aborted", errorMessage: "abort then continue" }
								: { type: "done", reason: "stop" },
						]);
						let terminal: AssistantMessage | undefined;
						for (const event of events) {
							const frame = onlyObjectFrame(pushNormalizedEvent(projector, event).frames);
							if (event.type === "start") startEpochs.push(getRecord(frame.stream).epoch as number);
							const decoded = decodeRequired(decoder, frame);
							if (event.type === "done" || event.type === "error") terminal = getDecodedMessage(decoded);
						}
						expect(terminal).toEqual(messageForNormalizedEvent(events.at(-1) as AssistantMessageEvent));
						const resetCount = 1 + (extraResets[runIndex % extraResets.length] ?? 0);
						for (let resetIndex = 0; resetIndex < resetCount; resetIndex += 1) {
							const reset = { type: "agent_end", messages: [], willRetry: runIndex < texts.length - 1 };
							expect(projector.push(reset).frames).toEqual([reset]);
							expect(decoder.decode(reset)).toBe(reset);
						}
					}
					expect(startEpochs).toEqual(startEpochs.map((_, index) => index + 1));
				},
			),
			{ numRuns: 35 },
		);
	});

	it("is total over arbitrary malformed values and rejects every generated oversized index", () => {
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 75 }), (values) => {
				const decoder = new StreamProjectionDecoder();
				for (const value of values) expect(() => decoder.decode(value)).not.toThrow();
			}),
			{ numRuns: 100 },
		);

		fc.assert(
			fc.property(
				fc.integer({ min: 100_001, max: 50_000_000 }),
				fc.constantFrom("text_start", "thinking_start", "toolcall_start"),
				(contentIndex, type) => {
					const decoder = new StreamProjectionDecoder();
					decoder.decode({ type: "message_start", stream: { epoch: 1, seq: 0 }, message: assistant() });
					const decoded = decoder.decode({
						type: "message_update",
						stream: { epoch: 1, seq: 1 },
						assistantMessageEvent: { type, contentIndex },
					});
					expect(decoded).toBeUndefined();
				},
			),
			{ numRuns: 100 },
		);
	});
});
