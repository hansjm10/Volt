import type { ActiveToolCallState, AssistantMessage, AssistantMessageEvent, ToolCall, Usage } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import type { JsonObject } from "../utils/json-value.ts";
import type { AssistantMessageInit, AssistantMessageMetaPatch, AssistantStreamFragment } from "./fragments.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type StreamBlockKind = "text" | "thinking" | "toolCall";

interface StreamBlockState {
	kind: StreamBlockKind;
	open: boolean;
}

type SnapshotEvent = Extract<AssistantMessageEvent, { snapshot: AssistantMessage }>;
type SnapshotEventInput = SnapshotEvent extends infer Event
	? Event extends SnapshotEvent
		? Omit<Event, "snapshot" | "toolState">
		: never
	: never;

/**
 * Converts provider fragments into immutable, internally consistent public
 * events. This is the only accumulator in the provider streaming pipeline.
 */
export class AssistantStreamNormalizer {
	readonly stream = new AssistantMessageEventStream();

	private message: AssistantMessage | undefined;
	private seq = -1;
	private terminal = false;
	private readonly blocks = new Map<number, StreamBlockState>();
	private readonly toolArgsText = new Map<number, string>();

	push(fragment: AssistantStreamFragment): void {
		if (this.terminal) {
			return;
		}

		switch (fragment.type) {
			case "start":
				this.handleStart(fragment.init);
				break;
			case "meta":
				this.ensureStarted();
				this.applyMeta(fragment.patch);
				break;
			case "text_start":
				this.startText(fragment.contentIndex);
				break;
			case "text_delta":
				this.appendText(fragment.contentIndex, fragment.delta);
				break;
			case "text_end":
				this.endText(fragment.contentIndex, fragment.content, fragment.textSignature);
				break;
			case "thinking_start":
				this.startThinking(fragment.contentIndex, fragment.content, fragment.thinkingSignature, fragment.redacted);
				break;
			case "thinking_delta":
				this.appendThinking(fragment.contentIndex, fragment.delta, fragment.signatureDelta);
				break;
			case "thinking_end":
				this.endThinking(fragment.contentIndex, fragment.content, fragment.thinkingSignature, fragment.redacted);
				break;
			case "toolcall_start":
				this.startToolCall(fragment.contentIndex, fragment.id, fragment.name);
				break;
			case "toolcall_delta":
				this.appendToolCall(fragment.contentIndex, fragment.argsTextDelta, fragment.id, fragment.name);
				break;
			case "toolcall_end":
				this.endToolCall(fragment.contentIndex, fragment.toolCall, fragment.thoughtSignature);
				break;
			case "done":
				this.finishSuccess(fragment.reason, fragment.usage);
				break;
			case "error":
				this.finishError(fragment.reason, fragment.errorMessage, fragment.diagnostics, fragment.usage);
				break;
		}
	}

	/** Finish a fragment source, synthesizing an error if it omitted a terminal fragment. */
	end(): void {
		if (this.terminal) {
			return;
		}
		this.finishError("error", "Assistant stream ended without a terminal fragment");
	}

	private handleStart(init: AssistantMessageInit): void {
		if (this.message) {
			this.recordViolation("duplicate_start");
			return;
		}

		const content: AssistantMessage["content"] = [];
		Object.freeze(content);
		const usage = cloneAndFreeze(init.usage ?? EMPTY_USAGE);
		const diagnostics = init.diagnostics ? freezeDiagnostics(init.diagnostics) : undefined;
		this.message = Object.freeze({
			role: "assistant",
			content,
			api: init.api,
			provider: init.provider,
			model: init.model,
			...(init.responseModel === undefined ? {} : { responseModel: init.responseModel }),
			...(init.responseId === undefined ? {} : { responseId: init.responseId }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			usage,
			stopReason: "stop",
			timestamp: init.timestamp,
		});
		this.emitSnapshot({ type: "start", seq: this.nextSeq() });
	}

	private ensureStarted(): void {
		if (this.message) {
			return;
		}
		this.handleStart({ api: "unknown", provider: "unknown", model: "unknown", timestamp: Date.now() });
		this.recordViolation("missing_start");
	}

	private applyMeta(patch: AssistantMessageMetaPatch): void {
		const message = this.requireMessage();
		let usage = message.usage;
		if (patch.usage) {
			usage = cloneAndFreeze({
				...message.usage,
				...patch.usage,
				cost: {
					...message.usage.cost,
					...patch.usage.cost,
				},
			});
		}

		let diagnostics = message.diagnostics;
		if (patch.diagnostics && patch.diagnostics.length > 0) {
			diagnostics = Object.freeze([
				...(message.diagnostics ?? []),
				...patch.diagnostics.map((diagnostic) => cloneAndFreeze(diagnostic)),
			]) as AssistantMessageDiagnostic[];
		}

		this.message = Object.freeze({
			...message,
			...(patch.responseId === undefined ? {} : { responseId: patch.responseId }),
			...(patch.responseModel === undefined ? {} : { responseModel: patch.responseModel }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			usage,
		});
	}

	private startText(contentIndex: number): void {
		this.ensureStarted();
		if (!this.canStartBlock(contentIndex, "text")) {
			return;
		}
		this.replaceBlock(contentIndex, Object.freeze({ type: "text", text: "" }));
		this.blocks.set(contentIndex, { kind: "text", open: true });
		this.emitSnapshot({ type: "text_start", seq: this.nextSeq(), contentIndex });
	}

	private appendText(contentIndex: number, delta: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "text")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "text") {
			this.recordViolation("block_type_mismatch", contentIndex, "text");
			return;
		}
		this.replaceBlock(contentIndex, Object.freeze({ ...block, text: block.text + delta }));
		this.emitSnapshot({ type: "text_delta", seq: this.nextSeq(), contentIndex, delta });
	}

	private endText(contentIndex: number, content?: string, textSignature?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "text")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "text") {
			this.recordViolation("block_type_mismatch", contentIndex, "text");
			return;
		}
		const finalContent = content ?? block.text;
		this.replaceBlock(
			contentIndex,
			Object.freeze({
				...block,
				text: finalContent,
				...(textSignature === undefined ? {} : { textSignature }),
			}),
		);
		this.closeBlock(contentIndex);
		this.emitSnapshot({ type: "text_end", seq: this.nextSeq(), contentIndex, content: finalContent });
	}

	private startThinking(contentIndex: number, content?: string, thinkingSignature?: string, redacted?: boolean): void {
		this.ensureStarted();
		if (!this.canStartBlock(contentIndex, "thinking")) {
			return;
		}
		const block = Object.freeze({
			type: "thinking",
			thinking: content ?? "",
			...(thinkingSignature === undefined ? {} : { thinkingSignature }),
			...(redacted === undefined ? {} : { redacted }),
		});
		this.replaceBlock(contentIndex, block);
		this.blocks.set(contentIndex, { kind: "thinking", open: true });
		this.emitSnapshot({
			type: "thinking_start",
			seq: this.nextSeq(),
			contentIndex,
			...(block.redacted === undefined ? {} : { redacted: block.redacted }),
		});
	}

	private appendThinking(contentIndex: number, delta: string, signatureDelta?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "thinking")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "thinking") {
			this.recordViolation("block_type_mismatch", contentIndex, "thinking");
			return;
		}
		this.replaceBlock(
			contentIndex,
			Object.freeze({
				...block,
				thinking: block.thinking + delta,
				...(signatureDelta === undefined
					? {}
					: { thinkingSignature: (block.thinkingSignature ?? "") + signatureDelta }),
			}),
		);
		this.emitSnapshot({ type: "thinking_delta", seq: this.nextSeq(), contentIndex, delta });
	}

	private endThinking(contentIndex: number, content?: string, thinkingSignature?: string, redacted?: boolean): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "thinking")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "thinking") {
			this.recordViolation("block_type_mismatch", contentIndex, "thinking");
			return;
		}
		const finalContent = content ?? block.thinking;
		const finalBlock = Object.freeze({
			...block,
			thinking: finalContent,
			...(thinkingSignature === undefined ? {} : { thinkingSignature }),
			...(redacted === undefined ? {} : { redacted }),
		});
		this.replaceBlock(contentIndex, finalBlock);
		this.closeBlock(contentIndex);
		this.emitSnapshot({
			type: "thinking_end",
			seq: this.nextSeq(),
			contentIndex,
			content: finalContent,
			...(finalBlock.redacted === undefined ? {} : { redacted: finalBlock.redacted }),
		});
	}

	private startToolCall(contentIndex: number, id?: string, name?: string): void {
		this.ensureStarted();
		if (!this.canStartBlock(contentIndex, "toolCall")) {
			return;
		}
		const argumentsValue = Object.freeze({});
		const block = Object.freeze({ type: "toolCall", id: id ?? "", name: name ?? "", arguments: argumentsValue });
		this.replaceBlock(contentIndex, block);
		this.blocks.set(contentIndex, { kind: "toolCall", open: true });
		this.toolArgsText.set(contentIndex, "");
		this.emitSnapshot({
			type: "toolcall_start",
			seq: this.nextSeq(),
			contentIndex,
			id: block.id,
			name: block.name,
		});
	}

	private appendToolCall(contentIndex: number, argsTextDelta: string, id?: string, name?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "toolCall")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "toolCall") {
			this.recordViolation("block_type_mismatch", contentIndex, "toolCall");
			return;
		}
		const argsText = (this.toolArgsText.get(contentIndex) ?? "") + argsTextDelta;
		this.toolArgsText.set(contentIndex, argsText);
		const argumentsValue = cloneAndFreeze(parseStreamingJson<JsonObject>(argsText));
		this.replaceBlock(
			contentIndex,
			Object.freeze({
				...block,
				...(id === undefined ? {} : { id }),
				...(name === undefined ? {} : { name }),
				arguments: argumentsValue,
			}),
		);
		this.emitSnapshot({
			type: "toolcall_delta",
			seq: this.nextSeq(),
			contentIndex,
			argsTextDelta,
			...(id === undefined ? {} : { id }),
			...(name === undefined ? {} : { name }),
		});
	}

	private endToolCall(contentIndex: number, toolCall?: ToolCall, thoughtSignature?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "toolCall")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "toolCall") {
			this.recordViolation("block_type_mismatch", contentIndex, "toolCall");
			return;
		}
		const finalToolCall = toolCall
			? cloneToolCall(toolCall)
			: thoughtSignature === undefined
				? block
				: Object.freeze({ ...block, thoughtSignature });
		this.replaceBlock(contentIndex, finalToolCall);
		this.toolArgsText.delete(contentIndex);
		this.closeBlock(contentIndex);
		this.emitSnapshot({
			type: "toolcall_end",
			seq: this.nextSeq(),
			contentIndex,
			toolCall: finalToolCall,
		});
	}

	private finishSuccess(reason: "stop" | "length" | "toolUse", usage?: Usage): void {
		this.ensureStarted();
		this.closeOpenBlocks();
		if (usage) {
			this.applyMeta({ usage });
		}
		const message = this.requireMessage();
		this.message = Object.freeze({ ...message, stopReason: reason });
		this.terminal = true;
		this.stream.push(
			Object.freeze({
				type: "done",
				seq: this.nextSeq(),
				reason,
				message: this.message,
			}) satisfies AssistantMessageEvent,
		);
	}

	private finishError(
		reason: "aborted" | "error",
		errorMessage: string,
		diagnostics?: AssistantMessageDiagnostic[],
		usage?: Usage,
	): void {
		this.ensureStarted();
		this.closeOpenBlocks();
		if (usage || diagnostics) {
			this.applyMeta({ ...(usage === undefined ? {} : { usage }), diagnostics });
		}
		const message = this.requireMessage();
		this.message = Object.freeze({ ...message, stopReason: reason, errorMessage });
		this.terminal = true;
		this.stream.push(
			Object.freeze({
				type: "error",
				seq: this.nextSeq(),
				reason,
				error: this.message,
			}) satisfies AssistantMessageEvent,
		);
	}

	private closeOpenBlocks(): void {
		const openBlocks = [...this.blocks.entries()]
			.filter(([, state]) => state.open)
			.sort(([left], [right]) => left - right);
		for (const [contentIndex, state] of openBlocks) {
			switch (state.kind) {
				case "text":
					this.endText(contentIndex);
					break;
				case "thinking":
					this.endThinking(contentIndex);
					break;
				case "toolCall":
					this.endToolCall(contentIndex);
					break;
			}
		}
	}

	private ensureOpenBlock(contentIndex: number, kind: StreamBlockKind): boolean {
		if (!this.isValidContentIndex(contentIndex)) {
			this.recordViolation("invalid_content_index", contentIndex, kind);
			return false;
		}

		const state = this.blocks.get(contentIndex);
		if (!state) {
			if (contentIndex !== this.requireMessage().content.length) {
				this.recordViolation("unopened_non_dense_block", contentIndex, kind);
				return false;
			}
			switch (kind) {
				case "text":
					this.startText(contentIndex);
					break;
				case "thinking":
					this.startThinking(contentIndex);
					break;
				case "toolCall":
					this.startToolCall(contentIndex);
					break;
			}
			return true;
		}

		if (!state.open) {
			this.recordViolation("fragment_after_block_end", contentIndex, kind);
			return false;
		}
		if (state.kind !== kind) {
			this.recordViolation("block_type_mismatch", contentIndex, kind);
			return false;
		}
		return true;
	}

	private canStartBlock(contentIndex: number, kind: StreamBlockKind): boolean {
		if (!this.isValidContentIndex(contentIndex) || contentIndex !== this.requireMessage().content.length) {
			this.recordViolation("non_dense_block_start", contentIndex, kind);
			return false;
		}
		if (this.blocks.has(contentIndex)) {
			this.recordViolation("duplicate_block_start", contentIndex, kind);
			return false;
		}
		return true;
	}

	private isValidContentIndex(contentIndex: number): boolean {
		return Number.isSafeInteger(contentIndex) && contentIndex >= 0;
	}

	private closeBlock(contentIndex: number): void {
		const state = this.blocks.get(contentIndex);
		if (state) {
			this.blocks.set(contentIndex, { ...state, open: false });
		}
	}

	private replaceBlock(contentIndex: number, block: AssistantMessage["content"][number]): void {
		const message = this.requireMessage();
		const content = [...message.content];
		content[contentIndex] = block;
		this.message = Object.freeze({
			...message,
			content: Object.freeze(content) as AssistantMessage["content"],
		});
	}

	private recordViolation(code: string, contentIndex?: number, blockKind?: StreamBlockKind): void {
		if (!this.message) {
			return;
		}
		const diagnostic = {
			type: "assistant_stream_contract_violation",
			timestamp: Date.now(),
			details: {
				code,
				...(contentIndex === undefined ? {} : { contentIndex }),
				...(blockKind === undefined ? {} : { blockKind }),
			},
		} satisfies AssistantMessageDiagnostic;
		this.applyMeta({ diagnostics: [diagnostic] });
	}

	private emitSnapshot(event: SnapshotEventInput): void {
		this.stream.push(
			Object.freeze({
				...event,
				snapshot: this.requireMessage(),
				toolState: this.createToolState(),
			}) as SnapshotEvent,
		);
	}

	private createToolState(): readonly ActiveToolCallState[] {
		return Object.freeze(
			[...this.toolArgsText.entries()]
				.sort(([left], [right]) => left - right)
				.map(([contentIndex, argsText]) => Object.freeze({ contentIndex, argsText })),
		);
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	private requireMessage(): AssistantMessage {
		if (!this.message) {
			throw new Error("Assistant stream normalizer has no message");
		}
		return this.message;
	}
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return Object.freeze({
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: cloneAndFreeze(toolCall.arguments),
		...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: toolCall.thoughtSignature }),
	});
}

function freezeDiagnostics(diagnostics: AssistantMessageDiagnostic[]): AssistantMessageDiagnostic[] {
	return Object.freeze(diagnostics.map((diagnostic) => cloneAndFreeze(diagnostic))) as AssistantMessageDiagnostic[];
}

function cloneAndFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const clone: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		clone[key] = cloneAndFreeze(entry);
	}
	return Object.freeze(clone) as T;
}
