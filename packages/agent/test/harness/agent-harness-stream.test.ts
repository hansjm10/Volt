import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type SimpleStreamOptions as StreamOptions,
	streamSimple,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { convertToLlm } from "../../src/harness/messages.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { GenerateBranchSummaryOptions } from "../../src/index.ts";
import type { StreamFn } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createHarness(options: ConstructorParameters<typeof AgentHarness>[0]): AgentHarness {
	return new AgentHarness(options);
}

function captureOptions(options: StreamOptions | undefined): StreamOptions {
	return {
		...options,
		...(options?.headers ? { headers: { ...options.headers } } : {}),
		...(options?.metadata ? { metadata: { ...options.metadata } } : {}),
		...(options?.env ? { env: { ...options.env } } : {}),
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("AgentHarness stream configuration", () => {
	it("exports branch-summary options with streamFn and optional apiKey", () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const options = {
			model: registration.getModel(),
			signal: new AbortController().signal,
			streamFn: streamSimple,
		} satisfies GenerateBranchSummaryOptions;

		expect(options.streamFn).toBe(streamSimple);
		expect(options).not.toHaveProperty("apiKey");
	});

	it("uses configurable base stream and message converter functions", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		let streamCalls = 0;
		let converterCalls = 0;
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamFn: async (model, context, options) => {
				streamCalls++;
				return streamSimple(model, context, options);
			},
			convertToLlm: async (messages) => {
				converterCalls++;
				return convertToLlm(messages);
			},
		});

		await harness.prompt("hello");

		expect(streamCalls).toBe(1);
		expect(converterCalls).toBe(1);
	});

	it("snapshots stream options and merges auth headers before provider request hooks", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const session = new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				websocketConnectTimeoutMs: 1500,
				maxRetries: 2,
				maxRetryDelayMs: 3000,
				headers: { "x-base": "base" },
				metadata: { base: true },
				env: { BASE_ENV: "base", SHARED_ENV: "base" },
				inferenceSpeed: "fast",
				thinkingBudgets: { low: 128 },
				transport: "websocket",
				cacheRetention: "none",
			},
			getApiKeyAndHeaders: async () => ({
				apiKey: "secret",
				headers: { "x-auth": "auth" },
				env: { AUTH_ENV: "auth", SHARED_ENV: "auth" },
			}),
		});

		let responseHookCalls = 0;
		harness.on("before_provider_request", (event) => {
			expect(event.sessionId).toBe("session-1");
			expect(event.streamOptions.headers).toEqual({ "x-base": "base", "x-auth": "auth" });
			return {
				streamOptions: {
					headers: { "x-hook": "hook" },
					metadata: { hook: true },
				},
			};
		});
		harness.on("after_provider_response", (event) => {
			responseHookCalls++;
			expect(event.status).toBe(200);
			return undefined;
		});

		await harness.prompt("hello");

		expect(responseHookCalls).toBe(1);
		expect(capturedOptions).toMatchObject({
			apiKey: "secret",
			timeoutMs: 1000,
			websocketConnectTimeoutMs: 1500,
			maxRetries: 2,
			maxRetryDelayMs: 3000,
			sessionId: "session-1",
			inferenceSpeed: "fast",
			thinkingBudgets: { low: 128 },
			transport: "websocket",
			cacheRetention: "none",
		});
		expect(capturedOptions?.headers).toEqual({ "x-base": "base", "x-auth": "auth", "x-hook": "hook" });
		expect(capturedOptions?.metadata).toEqual({ base: true, hook: true });
		expect(capturedOptions?.env).toEqual({ BASE_ENV: "base", AUTH_ENV: "auth", SHARED_ENV: "auth" });
	});

	it("rebuilds canonical context and atomic runtime configuration after provider request hooks", async () => {
		const registration = registerFauxProvider({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		registrations.push(registration);
		const secondModel = registration.getModel("second");
		if (!secondModel) throw new Error("missing second faux model");
		let captured:
			| { hookModel: string | undefined; modelId: string; reasoning: unknown; userTexts: string[] }
			| undefined;
		const hookModels: string[] = [];
		const conversionStarted = deferred();
		const releaseConversion = deferred();
		let blockedConversion = false;
		registration.setResponses([
			(context, options, _state, model) => {
				captured = {
					hookModel: options?.headers?.["x-hook-model"],
					modelId: model.id,
					reasoning: options && "reasoning" in options ? options.reasoning : undefined,
					userTexts: context.messages.flatMap((message) =>
						message.role === "user"
							? [
									typeof message.content === "string"
										? message.content
										: message.content
												.filter((content) => content.type === "text")
												.map((content) => content.text)
												.join(""),
								]
							: [],
					),
				};
				return fauxAssistantMessage("ok");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "off",
			convertToLlm: async (messages) => {
				if (!blockedConversion && JSON.stringify(messages).includes("hook append")) {
					blockedConversion = true;
					conversionStarted.resolve();
					await releaseConversion.promise;
				}
				return convertToLlm(messages);
			},
		});
		harness.on("before_provider_request", async (event) => {
			hookModels.push(event.model.id);
			await harness.appendMessage({ role: "user", content: "hook append", timestamp: 2 });
			await harness.setModelAndThinkingLevel(secondModel, "high");
			return { streamOptions: { headers: { "x-hook-model": event.model.id } } };
		});

		const running = harness.prompt("initial");
		await conversionStarted.promise;
		await harness.setThinkingLevel("medium");
		releaseConversion.resolve();
		await running;

		expect(captured).toEqual({
			hookModel: "second",
			modelId: "second",
			reasoning: "high",
			userTexts: ["initial", "hook append"],
		});
		expect(hookModels).toEqual(["first", "second", "second", "second"]);
	});

	it("stops before provider hooks when aborted during credential resolution", async () => {
		const credentialsStarted = deferred();
		const releaseCredentials = deferred();
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		let providerHookCalls = 0;
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => {
				credentialsStarted.resolve();
				await releaseCredentials.promise;
				return { apiKey: "secret" };
			},
		});
		harness.on("before_provider_request", () => {
			providerHookCalls++;
			return undefined;
		});

		const promptPromise = harness.prompt("hello");
		await credentialsStarted.promise;
		const abortPromise = harness.abort();
		releaseCredentials.resolve();
		const response = await promptPromise;
		await abortPromise;
		const persistedMessages = await session.buildContext();

		expect(providerHookCalls).toBe(0);
		expect(registration.state.callCount).toBe(0);
		expect(registration.getPendingResponseCount()).toBe(1);
		expect(response).toMatchObject({ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" });
		expect(persistedMessages.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("stops later request hooks and provider startup when aborted in a request hook", async () => {
		const requestHookStarted = deferred();
		const releaseRequestHook = deferred();
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		let laterHookCalls = 0;
		harness.on("before_provider_request", async () => {
			requestHookStarted.resolve();
			await releaseRequestHook.promise;
			return undefined;
		});
		harness.on("before_provider_request", () => {
			laterHookCalls++;
			return undefined;
		});

		const promptPromise = harness.prompt("hello");
		await requestHookStarted.promise;
		const abortPromise = harness.abort();
		releaseRequestHook.resolve();
		const response = await promptPromise;
		await abortPromise;
		const persistedMessages = await session.buildContext();

		expect(laterHookCalls).toBe(0);
		expect(registration.state.callCount).toBe(0);
		expect(registration.getPendingResponseCount()).toBe(1);
		expect(response).toMatchObject({ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" });
		expect(persistedMessages.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("chains provider request patches and supports deletion semantics", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				maxRetries: 2,
				headers: { keep: "base", remove: "base" },
				metadata: { keep: "base", remove: "base" },
			},
		});

		harness.on("before_provider_request", (event) => {
			expect(event.streamOptions.headers).toEqual({ keep: "base", remove: "base" });
			return {
				streamOptions: {
					headers: { first: "1", remove: undefined },
					metadata: { first: 1, remove: undefined },
				},
			};
		});
		harness.on("before_provider_request", (event) => {
			expect(event.streamOptions.headers).toEqual({ keep: "base", first: "1" });
			expect(event.streamOptions.metadata).toEqual({ keep: "base", first: 1 });
			return {
				streamOptions: {
					timeoutMs: undefined,
					headers: { second: "2" },
					metadata: undefined,
				},
			};
		});

		await harness.prompt("hello");

		expect(capturedOptions?.timeoutMs).toBeUndefined();
		expect(capturedOptions?.maxRetries).toBe(2);
		expect(capturedOptions?.headers).toEqual({ keep: "base", first: "1", second: "2" });
		expect(capturedOptions?.metadata).toBeUndefined();
	});

	it("uses updated stream options for save-point snapshots without mutating the active request", async () => {
		const capturedOptions: StreamOptions[] = [];
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage("done");
			},
		]);

		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
			streamOptions: { timeoutMs: 1000, headers: { turn: "first" } },
		});

		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				harness.setStreamOptions({ timeoutMs: 2000, headers: { turn: "second" } });
			}
		});

		await harness.prompt("hello");

		expect(capturedOptions).toHaveLength(2);
		expect(capturedOptions[0]?.timeoutMs).toBe(1000);
		expect(capturedOptions[0]?.headers).toEqual({ turn: "first" });
		expect(capturedOptions[1]?.timeoutMs).toBe(2000);
		expect(capturedOptions[1]?.headers).toEqual({ turn: "second" });
	});

	it("chains provider payload hooks", async () => {
		const seenPayloads: unknown[] = [];
		let finalPayload: unknown;
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			async (_context, options, _state, model) => {
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});

		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first"] } };
		});
		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first", "second"] } };
		});

		await harness.prompt("hello");

		expect(seenPayloads).toEqual([{ steps: ["provider"] }, { steps: ["provider", "first"] }]);
		expect(finalPayload).toEqual({ steps: ["provider", "first", "second"] });
	});

	it("routes compaction through a custom stream without requiring separate auth", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "compact", contextWindow: 6000, maxTokens: 1000 }],
		});
		registrations.push(registration);
		registration.setSimpleResponses([fauxAssistantMessage("summary")]);
		const session = new Session(new InMemorySessionStorage());
		for (let index = 0; index < 5; index++) {
			await session.appendMessage({
				role: "user",
				content: [{ type: "text", text: String(index).repeat(4000) }],
				timestamp: Date.now() + index,
			});
		}
		let streamCalls = 0;
		const streamFn: StreamFn = async (model, context, options) => {
			streamCalls++;
			expect(options?.apiKey).toBeUndefined();
			return streamSimple(model, context, options);
		};
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			streamFn,
		});

		const result = await harness.compact();

		expect(result.summary).toBe("summary");
		expect(streamCalls).toBeGreaterThan(0);
	});

	it("routes tree summaries through snapshotted provider policy and lifecycle hooks", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "branch-summary", contextWindow: 6000, maxTokens: 1000 }],
		});
		registrations.push(registration);
		registration.setSimpleResponses([fauxAssistantMessage("branch summary")]);
		const session = new Session(new InMemorySessionStorage({ metadata: { id: "branch-session", createdAt: "now" } }));
		const targetId = await session.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("first response"));
		await session.appendMessage({ role: "user", content: "second", timestamp: Date.now() + 1 });
		await session.appendMessage(fauxAssistantMessage("second response"));
		let capturedOptions: StreamOptions | undefined;
		let payloadHookCalls = 0;
		let responseHookCalls = 0;
		const streamFn: StreamFn = async (model, context, options) => {
			capturedOptions = captureOptions(options);
			await options?.onPayload?.({ structural: true }, model);
			return streamSimple(model, context, options);
		};
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			streamFn,
			streamOptions: {
				env: { BASE_ENV: "base" },
				headers: { "x-base": "base" },
				metadata: { base: true },
			},
			getApiKeyAndHeaders: async () => ({
				apiKey: "secret",
				env: { AUTH_ENV: "auth" },
				headers: { "x-auth": "auth" },
			}),
		});
		harness.on("before_provider_request", (event) => {
			expect(event.sessionId).toBe("branch-session");
			return {
				streamOptions: {
					env: { HOOK_ENV: "hook" },
					headers: { "x-hook": "hook" },
					metadata: { hook: true },
				},
			};
		});
		harness.on("before_provider_payload", () => {
			payloadHookCalls++;
			return undefined;
		});
		harness.on("after_provider_response", () => {
			responseHookCalls++;
			return undefined;
		});

		const result = await harness.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry).toBeDefined();
		expect(capturedOptions).toMatchObject({
			apiKey: "secret",
			maxTokens: 2048,
			sessionId: "branch-session",
		});
		expect(capturedOptions?.env).toEqual({ BASE_ENV: "base", AUTH_ENV: "auth", HOOK_ENV: "hook" });
		expect(capturedOptions?.headers).toEqual({ "x-base": "base", "x-auth": "auth", "x-hook": "hook" });
		expect(capturedOptions?.metadata).toEqual({ base: true, hook: true });
		expect(payloadHookCalls).toBe(1);
		expect(responseHookCalls).toBe(1);
	});

	it("preserves operation-requested reasoning for structural provider work", async () => {
		const registration = registerFauxProvider({ models: [{ id: "reasoning", reasoning: true }] });
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("summary")]);
		let capturedReasoning: unknown;
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "xhigh",
			streamFn: (model, context, options) => {
				capturedReasoning = options?.reasoning;
				return streamSimple(model, context, options);
			},
		});

		await harness.runTreeOperation(async (operation) => {
			const stream = await operation.streamFn(
				registration.getModel(),
				{ messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
				{ reasoning: "low" },
			);
			for await (const _event of stream) {
				// Drain the policy-wrapped stream.
			}
		});

		expect(capturedReasoning).toBe("low");
	});
});
