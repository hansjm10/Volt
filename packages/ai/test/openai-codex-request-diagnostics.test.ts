import { createHash, webcrypto } from "node:crypto";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	type OpenAICodexResponsesOptions,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import type { AssistantMessageDiagnostic } from "../src/utils/diagnostics.ts";

const accountId = "private-diagnostics-account";
const token = `fake.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
).toString("base64")}.fake-signature`;
const sessionId = "private-diagnostics-session";
const endpoint = "https://codex-diagnostics.invalid/backend-api/codex/responses";
const model: Model<"openai-codex-responses"> = {
	id: "gpt-6-astra",
	name: "Codex diagnostics fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://codex-diagnostics.invalid/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
	promptCache: { modes: ["implicit"], retention: { short: {} } },
};
const options: OpenAICodexResponsesOptions = {
	apiKey: token,
	sessionId,
	transport: "auto",
	cacheRetention: "short",
	env: { VOLT_CODEX_REQUEST_DIAGNOSTICS: "1" },
};

interface SentBody extends Record<string, unknown> {
	input: unknown[];
	previous_response_id?: string;
}

type RequestHashes = {
	cacheKey: string;
	instructions: string;
	tools: string;
	configuration: string;
	inputItems: string[];
	wireInput: string;
	previousResponseId: string;
};

type RequestDetails = {
	transport: "websocket" | "sse";
	configuredTransport: string;
	requestMode: "full" | "delta";
	continuationReason: string;
	attempt: number;
	connectionReused?: boolean;
	fullInputItems: number;
	wireInputItems: number;
	inputItemsTruncated: boolean;
	hashesAvailable: boolean;
	hashes?: RequestHashes;
};

type RequestDiagnostic = AssistantMessageDiagnostic & { details: RequestDetails };

beforeEach(() => {
	vi.stubEnv("VOLT_CODEX_REQUEST_DIAGNOSTICS", undefined);
	vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function context(): Context {
	return {
		systemPrompt: "private-system-instructions",
		messages: [{ role: "user", content: "private-first-prompt", timestamp: 1 }],
		tools: [
			{
				name: "private_tool_name",
				description: "private-tool-description",
				parameters: Type.Object({ text: Type.String({ description: "private-schema-description" }) }),
			},
		],
	};
}

function appendReply(previous: Context, reply: AssistantMessage): Context {
	return {
		...previous,
		messages: [...previous.messages, reply, { role: "user", content: "private-next-prompt", timestamp: 2 }],
	};
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestDiagnostics(message: AssistantMessage): RequestDiagnostic[] {
	return (message.diagnostics ?? []).filter(
		(diagnostic) => diagnostic.type === "codex_request",
	) as RequestDiagnostic[];
}

function onlyRequestDiagnostic(message: AssistantMessage): RequestDiagnostic {
	const records = requestDiagnostics(message);
	expect(records).toHaveLength(1);
	expect(records[0].timestamp).toEqual(expect.any(Number));
	expect(records[0].timestamp).toBeGreaterThan(0);
	expect(records[0].error).toBeUndefined();
	return records[0];
}

function expectHashes(details: RequestDetails, fullInput: unknown[], wireBody: SentBody): void {
	expect(details).toMatchObject({
		hashesAvailable: true,
		fullInputItems: fullInput.length,
		wireInputItems: wireBody.input.length,
		inputItemsTruncated: fullInput.length > 2048,
	});
	expect(details.hashes).toEqual({
		cacheKey: hash(wireBody.prompt_cache_key ?? null),
		instructions: hash(wireBody.instructions ?? null),
		tools: hash(wireBody.tools ?? null),
		configuration: expect.stringMatching(/^[a-f0-9]{64}$/),
		inputItems: fullInput.slice(0, 2048).map(hash),
		wireInput: hash(wireBody.input),
		previousResponseId: hash(wireBody.previous_response_id ?? null),
	});
}

function responseEvents(requestNumber: number): Record<string, unknown>[] {
	const responseId = `private_response_${requestNumber}`;
	const messageId = `msg_private_${requestNumber}`;
	const text = `private-reply-${requestNumber}`;
	return [
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function mockTransports(settings: { failWebSocketSend?: boolean; retrySse?: boolean } = {}) {
	const websocketBodies: SentBody[] = [];
	const sseBodies: SentBody[] = [];
	const sseBodyJson: string[] = [];
	const websocketConnections: { url: string; headers?: Record<string, string> }[] = [];
	const sseRequests: { url: string; headers: Headers; method?: string }[] = [];

	class MockWebSocket {
		readyState = 1;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor(url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
			const headers =
				protocols && typeof protocols === "object" && !Array.isArray(protocols) ? protocols.headers : undefined;
			websocketConnections.push({ url, headers });
			queueMicrotask(() => this.dispatch("open", {}));
		}

		addEventListener(type: string, listener: (event: unknown) => void): void {
			let listeners = this.listeners.get(type);
			if (!listeners) {
				listeners = new Set();
				this.listeners.set(type, listeners);
			}
			listeners.add(listener);
		}

		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(data: string): void {
			websocketBodies.push(JSON.parse(data) as SentBody);
			if (settings.failWebSocketSend) throw new Error("fixture websocket dispatch failed");
			const events = responseEvents(websocketBodies.length);
			queueMicrotask(() => {
				for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
			});
		}

		close(): void {
			this.readyState = 3;
			this.listeners.clear();
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = input.toString();
		if (url !== endpoint) throw new Error(`Unexpected mocked endpoint: ${url}`);
		if (typeof init?.body !== "string") throw new Error("Expected serialized SSE request body");
		sseRequests.push({ url, headers: new Headers(init.headers), method: init.method });
		sseBodies.push(JSON.parse(init.body) as SentBody);
		sseBodyJson.push(init.body);
		if (settings.retrySse && sseBodies.length === 1) {
			return new Response("service unavailable", { status: 503, headers: { "retry-after-ms": "1" } });
		}
		const sse = `${responseEvents(sseBodies.length)
			.map((event) => `data: ${JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal("fetch", fetchMock);
	return { websocketBodies, sseBodies, sseBodyJson, websocketConnections, sseRequests, fetchMock };
}

describe("Codex redacted request diagnostics", () => {
	it.each(["auto", "websocket-cached"] as const)(
		"records full, append-only delta, and shorter-prefix requests with %s transport",
		async (transport) => {
			const mock = mockTransports();
			const firstContext = context();
			const requestOptions = { ...options, transport };
			const first = await streamOpenAICodexResponses(model, firstContext, requestOptions).result();
			const second = await streamOpenAICodexResponses(
				model,
				appendReply(firstContext, first),
				requestOptions,
			).result();
			const compactedContext = context();
			compactedContext.messages = [
				...firstContext.messages,
				{ role: "user", content: "private-checkpoint-instruction", timestamp: 3 },
			];
			const compacted = await streamOpenAICodexResponses(model, compactedContext, requestOptions).result();

			expect([first.stopReason, second.stopReason, compacted.stopReason]).toEqual(["stop", "stop", "stop"]);
			expect(mock.fetchMock).not.toHaveBeenCalled();
			expect(mock.websocketConnections).toHaveLength(1);
			expect(mock.websocketConnections[0].url).toBe(endpoint.replace("https:", "wss:"));
			expect(mock.websocketBodies).toHaveLength(3);
			const [firstBody, deltaBody, compactedBody] = mock.websocketBodies;
			expect(firstBody).toMatchObject({ type: "response.create", model: model.id, store: false });
			expect(firstBody.previous_response_id).toBeUndefined();
			expect(deltaBody.previous_response_id).toBe(first.responseId);
			expect(deltaBody.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "private-next-prompt" }] },
			]);
			expect(compactedBody.previous_response_id).toBeUndefined();
			expect(compactedBody.input).toHaveLength(2);
			expect(compactedBody.input.slice(0, firstBody.input.length)).toEqual(firstBody.input);

			const firstDetails = onlyRequestDiagnostic(first).details;
			const deltaDetails = onlyRequestDiagnostic(second).details;
			const compactedDetails = onlyRequestDiagnostic(compacted).details;
			expect(firstDetails).toMatchObject({
				transport: "websocket",
				configuredTransport: transport,
				attempt: 1,
				requestMode: "full",
				continuationReason: "no_previous_response",
				connectionReused: false,
			});
			expect(deltaDetails).toMatchObject({
				transport: "websocket",
				configuredTransport: transport,
				attempt: 1,
				requestMode: "delta",
				continuationReason: "eligible",
				connectionReused: true,
			});
			expect(compactedDetails).toMatchObject({
				transport: "websocket",
				configuredTransport: transport,
				attempt: 1,
				requestMode: "full",
				continuationReason: "input_shorter",
				connectionReused: true,
			});
			const fullSecondInput = [
				...firstBody.input,
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "private-reply-1", annotations: [] }],
					status: "completed",
					id: "msg_private_1",
				},
				...deltaBody.input,
			];
			expectHashes(firstDetails, firstBody.input, firstBody);
			expectHashes(deltaDetails, fullSecondInput, deltaBody);
			expectHashes(compactedDetails, compactedBody.input, compactedBody);
			for (const key of ["cacheKey", "instructions", "tools", "configuration"] as const) {
				expect(deltaDetails.hashes?.[key]).toBe(firstDetails.hashes?.[key]);
				expect(compactedDetails.hashes?.[key]).toBe(firstDetails.hashes?.[key]);
			}
			expect(deltaDetails.hashes?.inputItems[0]).toBe(firstDetails.hashes?.inputItems[0]);
		},
	);

	it.each(["auto", "websocket-cached"] as const)(
		"continues full-warm-context native compaction with only the checkpoint instruction over %s",
		async (transport) => {
			const mock = mockTransports();
			const firstContext = context();
			firstContext.messages.unshift({ role: "user", content: "private-earlier-history", timestamp: 0 });
			const requestOptions: OpenAICodexResponsesOptions = {
				...options,
				transport,
				reasoningEffort: "high",
				temperature: 0.2,
				serviceTier: "priority",
				textVerbosity: "high",
			};
			const first = await streamOpenAICodexResponses(model, firstContext, requestOptions).result();
			const checkpointInstruction = "private-checkpoint-instruction";
			const compactionContext: Context = {
				...firstContext,
				messages: [...firstContext.messages, first, { role: "user", content: checkpointInstruction, timestamp: 2 }],
			};
			const compaction = await streamOpenAICodexResponses(model, compactionContext, requestOptions).result();

			expect([first.stopReason, compaction.stopReason]).toEqual(["stop", "stop"]);
			expect(first.responseId).toBe("private_response_1");
			expect(compaction.content).toEqual([expect.objectContaining({ type: "text", text: "private-reply-2" })]);
			expect(mock.fetchMock).not.toHaveBeenCalled();
			expect(mock.websocketConnections).toHaveLength(1);
			expect(mock.websocketBodies).toHaveLength(2);
			const [firstBody, compactionBody] = mock.websocketBodies;
			expect(firstBody.previous_response_id).toBeUndefined();
			expect(firstBody.input).toHaveLength(2);
			const checkpointInput = [{ role: "user", content: [{ type: "input_text", text: checkpointInstruction }] }];
			expect(compactionBody).toEqual({
				...firstBody,
				previous_response_id: first.responseId,
				input: checkpointInput,
			});

			const firstDetails = onlyRequestDiagnostic(first).details;
			const compactionDetails = onlyRequestDiagnostic(compaction).details;
			expect(firstDetails).toMatchObject({
				transport: "websocket",
				configuredTransport: transport,
				attempt: 1,
				requestMode: "full",
				continuationReason: "no_previous_response",
				connectionReused: false,
			});
			expect(compactionDetails).toMatchObject({
				transport: "websocket",
				configuredTransport: transport,
				attempt: 1,
				requestMode: "delta",
				continuationReason: "eligible",
				connectionReused: true,
				fullInputItems: 4,
				wireInputItems: 1,
			});
			const preCheckpointInput = [
				...firstBody.input,
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "private-reply-1", annotations: [] }],
					status: "completed",
					id: "msg_private_1",
				},
			];
			expectHashes(firstDetails, firstBody.input, firstBody);
			expectHashes(compactionDetails, [...preCheckpointInput, ...checkpointInput], compactionBody);
			expect(compactionDetails.hashes?.inputItems.slice(0, preCheckpointInput.length)).toEqual(
				preCheckpointInput.map(hash),
			);
			for (const key of ["cacheKey", "instructions", "tools", "configuration"] as const) {
				expect(compactionDetails.hashes?.[key]).toBe(firstDetails.hashes?.[key]);
			}
		},
	);

	it("identifies the first changed history item without exposing its content", async () => {
		const mock = mockTransports();
		const firstContext = context();
		firstContext.messages.push({ role: "user", content: "private-original-history", timestamp: 2 });
		const first = await streamOpenAICodexResponses(model, firstContext, options).result();
		const changedContext = appendReply(firstContext, first);
		changedContext.messages[1] = { role: "user", content: "private-replaced-history", timestamp: 2 };
		const changed = await streamOpenAICodexResponses(model, changedContext, options).result();
		expect(changed.stopReason).toBe("stop");
		expect(mock.websocketBodies[1].input).toHaveLength(4);
		expect(mock.websocketBodies[1].previous_response_id).toBeUndefined();
		const originalDetails = onlyRequestDiagnostic(first).details;
		const changedDetails = onlyRequestDiagnostic(changed).details;
		expect(changedDetails).toMatchObject({
			requestMode: "full",
			continuationReason: "input_prefix_changed",
			connectionReused: true,
		});
		expectHashes(changedDetails, mock.websocketBodies[1].input, mock.websocketBodies[1]);
		const originalHashes = originalDetails.hashes!.inputItems;
		const changedHashes = changedDetails.hashes!.inputItems;
		expect(originalHashes.findIndex((value, index) => value !== changedHashes[index])).toBe(1);
		expect(changedDetails.hashes?.configuration).toBe(originalDetails.hashes?.configuration);
		expect(JSON.stringify(requestDiagnostics(changed))).not.toContain("private-replaced-history");
	});

	it.each([
		["reasoning", { reasoningEffort: "high" }],
		["temperature", { temperature: 0.7 }],
		["service tier", { serviceTier: "priority" }],
		["verbosity", { textVerbosity: "high" }],
	] satisfies [string, Partial<OpenAICodexResponsesOptions>][])(
		"records non-input rejection when %s changes",
		async (_name, changedOptions) => {
			const mock = mockTransports();
			const firstContext = context();
			const first = await streamOpenAICodexResponses(model, firstContext, options).result();
			const second = await streamOpenAICodexResponses(model, appendReply(firstContext, first), {
				...options,
				...changedOptions,
			}).result();
			expect(second.stopReason).toBe("stop");
			expect(mock.websocketBodies[1].input).toHaveLength(3);
			expect(mock.websocketBodies[1].previous_response_id).toBeUndefined();
			const firstDetails = onlyRequestDiagnostic(first).details;
			const secondDetails = onlyRequestDiagnostic(second).details;
			expect(secondDetails).toMatchObject({
				requestMode: "full",
				continuationReason: "non_input_changed",
				connectionReused: true,
			});
			expectHashes(secondDetails, mock.websocketBodies[1].input, mock.websocketBodies[1]);
			expect(secondDetails.hashes?.configuration).not.toBe(firstDetails.hashes?.configuration);
			for (const key of ["cacheKey", "instructions", "tools"] as const) {
				expect(secondDetails.hashes?.[key]).toBe(firstDetails.hashes?.[key]);
			}
		},
	);

	it("hashes the replacement hook payload and retains immutable, detached, redacted terminal records", async () => {
		const mock = mockTransports();
		const replacement = {
			model: model.id,
			store: false,
			stream: true,
			instructions: "private-hook-instructions",
			prompt_cache_key: "private-hook-cache-key",
			input: [{ content: [{ text: "private-hook-input", type: "input_text" }], role: "user" }],
			tools: [
				{
					type: "function",
					name: "private_hook_tool",
					description: "private-hook-tool-description",
					parameters: { type: "object" },
				},
			],
			untrusted_hook_field: { secret: "private-arbitrary-hook-value" },
		};
		const stream = streamOpenAICodexResponses(model, context(), {
			...options,
			headers: { "x-private-auth": "private-header-secret" },
			onPayload: () => replacement,
		});
		let terminal: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "done") terminal = event.message;
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(mock.websocketBodies[0]).toEqual({ type: "response.create", ...replacement });
		expect(mock.websocketConnections[0].headers).toMatchObject({
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			"session-id": sessionId,
			"x-private-auth": "private-header-secret",
		});
		expect(terminal).toBeDefined();
		expect(requestDiagnostics(terminal!)).toEqual(requestDiagnostics(result));
		const record = onlyRequestDiagnostic(result);
		expectHashes(record.details, mock.websocketBodies[0].input, mock.websocketBodies[0]);
		const serialized = JSON.stringify(record);
		for (const secret of [
			token,
			accountId,
			sessionId,
			result.responseId!,
			"private-first-prompt",
			"private-system-instructions",
			"private-hook-instructions",
			"private-hook-cache-key",
			"private-hook-input",
			"private_hook_tool",
			"private-hook-tool-description",
			"private-header-secret",
			"private-arbitrary-hook-value",
			"untrusted_hook_field",
		])
			expect(serialized).not.toContain(secret);
		expect(Object.keys(record).sort()).toEqual(["details", "timestamp", "type"]);
		expect(Object.keys(record.details).sort()).toEqual([
			"attempt",
			"configuredTransport",
			"connectionReused",
			"continuationReason",
			"fullInputItems",
			"hashes",
			"hashesAvailable",
			"inputItemsTruncated",
			"requestMode",
			"transport",
			"wireInputItems",
		]);
		expect(Object.isFrozen(result.diagnostics)).toBe(true);
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.details)).toBe(true);
		expect(Object.isFrozen(record.details.hashes)).toBe(true);
		expect(Object.isFrozen(record.details.hashes?.inputItems)).toBe(true);
		expect(() => record.details.hashes!.inputItems.push("mutated")).toThrow(TypeError);
		replacement.instructions = "mutated-instructions";
		replacement.input[0].content[0].text = "mutated-input";
		replacement.tools[0].description = "mutated-tool";
		replacement.untrusted_hook_field.secret = "mutated-hook";
		expect(JSON.stringify(record)).toBe(serialized);
		expect(JSON.stringify(onlyRequestDiagnostic(terminal!))).toBe(serialized);
	});

	it.each(["getter", "toJSON"] as const)(
		"does not re-evaluate a hook-owned %s while fingerprinting the actual full request",
		async (kind) => {
			const outcomes: { evaluations: number; body: SentBody }[] = [];
			for (const enabled of [false, true]) {
				closeOpenAICodexWebSocketSessions();
				const mock = mockTransports();
				let evaluations = 0;
				const item = () => ({ role: "user", content: `private-hook-evaluation-${++evaluations}` });
				const result = await streamOpenAICodexResponses(model, context(), {
					...options,
					env: { VOLT_CODEX_REQUEST_DIAGNOSTICS: enabled ? "1" : "0" },
					onPayload: (payload) => {
						const body = payload as SentBody;
						if (kind === "getter") {
							Object.defineProperty(body, "input", { enumerable: true, get: () => [item()] });
						} else {
							body.input = [{ toJSON: item }];
						}
						return body;
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(mock.websocketBodies).toHaveLength(1);
				const body = mock.websocketBodies[0];
				if (enabled) expectHashes(onlyRequestDiagnostic(result).details, body.input, body);
				else expect(requestDiagnostics(result)).toEqual([]);
				outcomes.push({ evaluations, body });
			}
			expect(outcomes[1]).toEqual(outcomes[0]);
		},
	);

	it("uses exact serialized property ordering rather than sorted semantic fingerprints", async () => {
		const mock = mockTransports();
		const firstInput = [{ role: "user", content: [{ type: "input_text", text: "same text" }] }];
		const reorderedInput = [{ content: [{ text: "same text", type: "input_text" }], role: "user" }];
		const firstTools = [{ type: "function", name: "same_tool", parameters: { type: "object" } }];
		const reorderedTools = [{ parameters: { type: "object" }, name: "same_tool", type: "function" }];
		const first = await streamOpenAICodexResponses(model, context(), {
			...options,
			transport: "sse",
			onPayload: (payload) => ({
				...(payload as SentBody),
				input: firstInput,
				tools: firstTools,
				extra: { z: 1, a: 2 },
			}),
		}).result();
		const reordered = await streamOpenAICodexResponses(model, context(), {
			...options,
			transport: "sse",
			onPayload: (payload) => ({
				...(payload as SentBody),
				input: reorderedInput,
				tools: reorderedTools,
				extra: { a: 2, z: 1 },
			}),
		}).result();
		expect([first.stopReason, reordered.stopReason]).toEqual(["stop", "stop"]);
		expect(mock.sseBodies[0].input).toEqual(mock.sseBodies[1].input);
		expect(JSON.stringify(mock.sseBodies[0].input)).not.toBe(JSON.stringify(mock.sseBodies[1].input));
		const firstDetails = onlyRequestDiagnostic(first).details;
		const reorderedDetails = onlyRequestDiagnostic(reordered).details;
		expectHashes(firstDetails, mock.sseBodies[0].input, mock.sseBodies[0]);
		expectHashes(reorderedDetails, mock.sseBodies[1].input, mock.sseBodies[1]);
		for (const key of ["inputItems", "wireInput", "tools", "configuration"] as const) {
			expect(reorderedDetails.hashes?.[key]).not.toEqual(firstDetails.hashes?.[key]);
		}
	});

	it("records explicit SSE dispatches without websocket-only metadata or routing changes", async () => {
		const mock = mockTransports();
		const result = await streamOpenAICodexResponses(model, context(), { ...options, transport: "sse" }).result();
		expect(result.stopReason).toBe("stop");
		expect(mock.websocketConnections).toHaveLength(0);
		expect(mock.sseBodies).toHaveLength(1);
		expect(mock.sseRequests[0]).toMatchObject({ url: endpoint, method: "POST" });
		expect(mock.sseRequests[0].headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(mock.sseRequests[0].headers.get("session-id")).toBe(sessionId);
		expect(mock.sseBodies[0]).toMatchObject({ model: model.id, store: false, prompt_cache_key: sessionId });
		expect(mock.sseBodies[0].previous_response_id).toBeUndefined();
		const record = onlyRequestDiagnostic(result);
		expect(record.details).toMatchObject({
			transport: "sse",
			configuredTransport: "sse",
			requestMode: "full",
			continuationReason: "sse_requested",
			attempt: 1,
		});
		expect(record.details).not.toHaveProperty("connectionReused");
		expectHashes(record.details, mock.sseBodies[0].input, mock.sseBodies[0]);
	});

	it("assigns distinct dispatch attempts across websocket failure, SSE fallback, and SSE retry", async () => {
		const mock = mockTransports({ failWebSocketSend: true, retrySse: true });
		const result = await streamOpenAICodexResponses(model, context(), { ...options, maxRetries: 1 }).result();
		expect(result.stopReason).toBe("stop");
		expect(mock.websocketBodies).toHaveLength(1);
		expect(mock.sseBodies).toHaveLength(2);
		expect(mock.sseBodyJson[0]).toBe(mock.sseBodyJson[1]);
		const records = requestDiagnostics(result);
		expect(
			records.map((record) => ({ transport: record.details.transport, attempt: record.details.attempt })),
		).toEqual([
			{ transport: "websocket", attempt: 1 },
			{ transport: "sse", attempt: 2 },
			{ transport: "sse", attempt: 3 },
		]);
		expect(records[0].details).toMatchObject({
			requestMode: "full",
			continuationReason: "no_previous_response",
			connectionReused: false,
		});
		for (const [index, record] of records.entries()) {
			expect(record.timestamp).toBeGreaterThan(0);
			expect(record.details.configuredTransport).toBe("auto");
			const body = index === 0 ? mock.websocketBodies[0] : mock.sseBodies[index - 1];
			expectHashes(record.details, body.input, body);
			if (index > 0) {
				expect(record.details).toMatchObject({ requestMode: "full", continuationReason: "websocket_fallback" });
				expect(record.details).not.toHaveProperty("connectionReused");
				expect(record).not.toBe(records[index - 1]);
				expect(record.details.hashes).toEqual(records[0].details.hashes);
			}
		}
		const saved = JSON.stringify(records);
		const next = await streamOpenAICodexResponses(model, context(), options).result();
		expect(next.stopReason).toBe("stop");
		expect(mock.websocketConnections).toHaveLength(1);
		expect(onlyRequestDiagnostic(next).details).toMatchObject({
			transport: "sse",
			continuationReason: "websocket_fallback",
			attempt: 1,
		});
		expect(JSON.stringify(records)).toBe(saved);
	});

	it.each([
		["cache disabled", { cacheRetention: "none" }, "cache_disabled", false],
		["uncached transport", { transport: "websocket" }, "transport_not_cached", true],
	] satisfies [string, Partial<OpenAICodexResponsesOptions>, string, boolean][])(
		"reports %s while keeping requests full",
		async (_name, overrides, continuationReason, connectionReused) => {
			const mock = mockTransports();
			const firstContext = context();
			const requestOptions = { ...options, ...overrides };
			const first = await streamOpenAICodexResponses(model, firstContext, requestOptions).result();
			const second = await streamOpenAICodexResponses(
				model,
				appendReply(firstContext, first),
				requestOptions,
			).result();
			expect(second.stopReason).toBe("stop");
			expect(mock.websocketBodies[1].previous_response_id).toBeUndefined();
			expect(mock.websocketBodies[1].input).toHaveLength(3);
			const details = onlyRequestDiagnostic(second).details;
			expect(details).toMatchObject({
				transport: "websocket",
				requestMode: "full",
				continuationReason,
				connectionReused,
			});
			expectHashes(details, mock.websocketBodies[1].input, mock.websocketBodies[1]);
		},
	);

	it.each([
		[undefined, undefined, false],
		["0", undefined, false],
		["true", undefined, false],
		["1", "0", false],
		["1", "", false],
		["0", "1", true],
		["1", undefined, true],
	] as const)(
		"respects process flag %s and provider override %s without changing the body",
		async (processFlag, providerFlag, enabled) => {
			const mock = mockTransports();
			const baseline = await streamOpenAICodexResponses(model, context(), {
				...options,
				transport: "sse",
				env: { VOLT_CODEX_REQUEST_DIAGNOSTICS: "0" },
			}).result();
			vi.stubEnv("VOLT_CODEX_REQUEST_DIAGNOSTICS", processFlag);
			const result = await streamOpenAICodexResponses(model, context(), {
				...options,
				transport: "sse",
				env: providerFlag === undefined ? undefined : { VOLT_CODEX_REQUEST_DIAGNOSTICS: providerFlag },
			}).result();
			expect([baseline.stopReason, result.stopReason]).toEqual(["stop", "stop"]);
			expect(mock.sseBodyJson).toHaveLength(2);
			expect(mock.sseBodyJson[1]).toBe(mock.sseBodyJson[0]);
			expect(requestDiagnostics(baseline)).toEqual([]);
			expect(requestDiagnostics(result)).toHaveLength(enabled ? 1 : 0);
		},
	);

	it.each(["auto", "websocket-cached", "sse"] as const)(
		"leaves the complete request sequence unchanged with diagnostics enabled over %s",
		async (transport) => {
			const sequences: SentBody[][] = [];
			for (const flag of ["0", "1"]) {
				closeOpenAICodexWebSocketSessions();
				resetOpenAICodexWebSocketDebugStats();
				const mock = mockTransports();
				const settings = { ...options, transport, env: { VOLT_CODEX_REQUEST_DIAGNOSTICS: flag } };
				const firstContext = context();
				const first = await streamOpenAICodexResponses(model, firstContext, settings).result();
				const second = await streamOpenAICodexResponses(model, appendReply(firstContext, first), settings).result();
				const compaction = await streamOpenAICodexResponses(
					model,
					{
						...firstContext,
						messages: [
							...firstContext.messages,
							{ role: "user", content: "Summarize earlier history", timestamp: 3 },
						],
					},
					settings,
				).result();
				for (const message of [first, second, compaction]) {
					expect(message.stopReason).toBe("stop");
					expect(requestDiagnostics(message)).toHaveLength(flag === "1" ? 1 : 0);
				}
				sequences.push(transport === "sse" ? mock.sseBodies : mock.websocketBodies);
			}
			expect(JSON.stringify(sequences[1])).toBe(JSON.stringify(sequences[0]));
		},
	);

	it("does not wait indefinitely for diagnostic hashing", async () => {
		vi.useFakeTimers();
		const mock = mockTransports();
		vi.spyOn(webcrypto.subtle, "digest").mockImplementation(() => new Promise<ArrayBuffer>(() => {}));
		const response = streamOpenAICodexResponses(model, context(), options).result();
		await vi.advanceTimersByTimeAsync(250);
		const result = await response;
		expect(result.stopReason).toBe("stop");
		expect(mock.websocketBodies).toHaveLength(1);
		expect(onlyRequestDiagnostic(result).details.hashesAvailable).toBe(false);
	});

	it("bounds per-item hashes without truncating the request or complete wire-input hash", async () => {
		const mock = mockTransports();
		const input = Array.from({ length: 2050 }, (_, index) => ({
			role: "user",
			content: `private-large-history-${index}`,
		}));
		const result = await streamOpenAICodexResponses(model, context(), {
			...options,
			transport: "sse",
			onPayload: (payload) => ({ ...(payload as SentBody), input }),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(mock.sseBodies[0].input).toEqual(input);
		const details = onlyRequestDiagnostic(result).details;
		expectHashes(details, input, mock.sseBodies[0]);
		expect(details.hashes?.inputItems).toHaveLength(2048);
		expect(details.inputItemsTruncated).toBe(true);
		expect(details.hashes?.wireInput).not.toBe(hash(input.slice(0, 2048)));
	});

	it.each(["missing crypto", "digest rejection"] as const)(
		"continues streaming with transport metadata after %s",
		async (failure) => {
			const mock = mockTransports();
			if (failure === "missing crypto") {
				vi.stubGlobal("crypto", undefined);
			} else {
				vi.spyOn(webcrypto.subtle, "digest").mockRejectedValue(new Error("private-crypto-failure-secret"));
			}
			const result = await streamOpenAICodexResponses(model, context(), options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "private-reply-1" })]);
			expect(mock.websocketBodies).toHaveLength(1);
			expect(mock.fetchMock).not.toHaveBeenCalled();
			const record = onlyRequestDiagnostic(result);
			expect(record.details).toMatchObject({
				transport: "websocket",
				configuredTransport: "auto",
				attempt: 1,
				requestMode: "full",
				continuationReason: "no_previous_response",
				connectionReused: false,
				fullInputItems: 1,
				wireInputItems: 1,
				hashesAvailable: false,
			});
			expect(JSON.stringify(record)).not.toContain("private-crypto-failure-secret");
			expect(JSON.stringify(record)).not.toContain("private-first-prompt");
		},
	);
});
