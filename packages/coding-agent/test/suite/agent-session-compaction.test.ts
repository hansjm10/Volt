import type { AgentPreparedRequestDecision, AgentRunResult, PreparedProviderRequest } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	estimateToolDefinitionTokens,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateMessagesTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type ProactiveCompactionState =
	| { phase: "idle" }
	| { phase: "scheduled"; checkpointId: string }
	| { phase: "compacting"; checkpointId: string };

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_admitPreparedContinuation: (request: PreparedProviderRequest) => AgentPreparedRequestDecision;
	_handlePostAgentRun: (
		result: AgentRunResult,
		abortGeneration?: number,
		conversationGenerationRevision?: number,
	) => Promise<boolean>;
	_lastAssistantMessage: AssistantMessage | undefined;
	_proactiveCompactionState: ProactiveCompactionState;
	_conversationGenerationRevision: number;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function createPreparedRequest(
	harness: Harness,
	options: Partial<
		Pick<
			PreparedProviderRequest,
			| "checkpointId"
			| "requestId"
			| "attempt"
			| "model"
			| "providerContext"
			| "completedTurn"
			| "defaultAction"
			| "requestAuthority"
			| "reason"
			| "deliveries"
		>
	> = {},
): PreparedProviderRequest {
	return {
		checkpointId: options.checkpointId ?? "checkpoint-0",
		requestId: options.requestId ?? "request-0",
		attempt: options.attempt ?? 0,
		runId: "run-0",
		hostAuthority: harness.session.agent.getRequestAuthority?.(),
		providerContext: options.providerContext ?? { systemPrompt: "", messages: [], tools: [] },
		model: options.model ?? harness.getModel(),
		streamOptions: {},
		...(options.completedTurn === undefined ? {} : { completedTurn: options.completedTurn }),
		defaultAction: options.defaultAction ?? { type: "request", reason: "continuation" },
		requestAuthority: options.requestAuthority ?? "tool_continuation",
		reason: options.reason ?? "continuation",
		deliveries: options.deliveries ?? [],
	};
}

function createPausedRunResult(request: PreparedProviderRequest, estimatedTokens = 1): AgentRunResult {
	return {
		status: "paused",
		deliveries: [],
		pause: {
			type: "pause",
			reason: "compaction",
			estimatedTokens,
			attempt: request.attempt,
			checkpointId: request.checkpointId,
			requestId: request.requestId,
		},
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", seq: 1, reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function useSummaryResponses(
	harness: Harness,
	responses: AssistantMessage[],
	onOptions?: (options: { reasoning?: string } | undefined) => void,
): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model, _context, options) => {
		const response = responses[Math.min(callCount, responses.length - 1)];
		callCount += 1;
		onOptions?.(options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				seq: 1,
				reason: "stop",
				message: {
					...response,
					api: model.api,
					provider: model.provider,
					model: model.id,
				},
			});
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: now - 500,
		}),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 999,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from extension");
		expect(result.tokensBefore).toBe(999);
		expect(result.estimatedTokensAfter).toBe(
			estimateMessagesTokens(harness.session.messages) +
				estimateToolDefinitionTokens(harness.session.agent.state.tools),
		);
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("rejects invalid extension compaction details before appending", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "invalid extension summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { shared: new SharedArrayBuffer(1) } as never,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const leafId = harness.sessionManager.getLeafId();

		await expect(harness.session.compact()).rejects.toThrow("Extension session_before_compact output");
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toBe("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("appends the canonical active plan checkpoint after compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Finish after compaction" }] });
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Compacted plan",
			summary: "Keep canonical state across compaction.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "compaction-execution",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		useSummaryStreamFn(harness, "summary with active plan");

		await harness.session.compact();

		const checkpoints = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			content: expect.stringContaining(`Revision: ${active.revision}`),
			display: false,
		});
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
		});
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(getStreamCallCount()).toBe(1);
	});

	it("uses the model's lowest supported reasoning for compaction instead of the session level", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			models: [{ id: "reasoning-model", reasoning: true }],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.state.model = {
			...harness.session.agent.state.model,
			thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh", max: "max" },
		};
		harness.session.agent.state.thinkingLevel = "xhigh";
		const reasoningLevels: Array<string | undefined> = [];
		useSummaryResponses(harness, [fauxAssistantMessage("minimal summary")], (options) => {
			reasoningLevels.push(options?.reasoning);
		});

		await harness.session.compact();

		expect(reasoningLevels).toEqual(["low"]);
	});

	it("retries transient auto-compaction summarization failures", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getCallCount = useSummaryResponses(harness, [
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "service unavailable request-id=req_first",
			}),
			fauxAssistantMessage("summary after retry"),
		]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(getCallCount()).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("fails closed after transient auto-compaction retries are exhausted", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getCallCount = useSummaryResponses(harness, [
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "server is overloaded request-id=req_last",
			}),
		]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).rejects.toThrow(
			"Summarization failed after 3 attempts",
		);

		expect(getCallCount()).toBe(3);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("request-id=req_last"),
		});
	});

	it("does not resume a proactively interrupted run after compaction exhaustion", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryResponses(harness, [
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "service unavailable",
			}),
		]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const request = createPreparedRequest(harness, {
			providerContext: {
				systemPrompt: "",
				messages: [],
				tools: [],
			},
		});
		vi.spyOn(harness.session.agent, "getPreparedRequest").mockReturnValue(request);
		sessionInternals._proactiveCompactionState = {
			phase: "scheduled",
			checkpointId: request.checkpointId,
		};

		await expect(sessionInternals._handlePostAgentRun(createPausedRunResult(request))).rejects.toThrow(
			"Summarization failed after 2 attempts",
		);

		expect(sessionInternals._proactiveCompactionState).toEqual({ phase: "idle" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("admits the exact extension-transformed and converted provider context", async () => {
		const harness = await createHarness({
			prepareRequest: ({ context }) => ({
				context: { ...context, systemPrompt: "prepared system prompt" },
			}),
			extensionFactories: [
				(volt) => {
					volt.on("context", (event) => ({
						messages: [
							...event.messages,
							{
								role: "custom",
								customType: "admission-marker",
								content: "extension transformed marker",
								display: false,
								timestamp: 123,
							},
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		let admittedRequest: PreparedProviderRequest | undefined;
		let streamedContext: Context | undefined;
		const admitPreparedRequest = harness.session.agent.admitPreparedRequest;
		harness.session.agent.admitPreparedRequest = async (request, signal) => {
			admittedRequest = request;
			return admitPreparedRequest ? await admitPreparedRequest(request, signal) : undefined;
		};
		harness.setResponses([
			(context) => {
				streamedContext = structuredClone(context);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original prompt");

		expect(admittedRequest?.providerContext).toEqual(streamedContext);
		expect(admittedRequest?.providerContext.systemPrompt).toBe("prepared system prompt");
		expect(admittedRequest?.providerContext.messages).toContainEqual({
			role: "user",
			content: [{ type: "text", text: "extension transformed marker" }],
			timestamp: 123,
		});
	});

	it("rejects a paused checkpoint after the conversation generation changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.admitPreparedRequest = (request) => ({
			type: "pause",
			reason: "compaction",
			estimatedTokens: 1,
			attempt: request.attempt,
		});
		const paused = await harness.session.agent.prompt("pause before navigation");
		if (paused.status !== "paused") throw new Error("Expected a paused provider request");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		sessionInternals._conversationGenerationRevision++;

		await expect(
			harness.session.agent.replacePreparedRequestMessages(
				paused.pause.checkpointId,
				harness.session.agent.state.messages,
			),
		).rejects.toThrow("Prepared provider request host authority is stale");
		expect(harness.session.agent.getPreparedRequest()).toBeUndefined();
	});

	it("uses the captured prepared model and tool budget for proactive compaction", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			models: [
				{ id: "prepared-model", contextWindow: 40_000, reasoning: true },
				{ id: "live-model", contextWindow: 200_000, reasoning: false },
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const preparedModel = harness.getModel("prepared-model")!;
		const liveModel = harness.getModel("live-model")!;
		harness.session.agent.state.model = liveModel;
		let summarizationModelId: string | undefined;
		harness.session.agent.streamFn = (model) => {
			summarizationModelId = model.id;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					seq: 1,
					reason: "stop",
					message: {
						...fauxAssistantMessage("captured summary"),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			});
			return stream;
		};
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const capturedTools = [
			{
				name: "captured_tool",
				description: "x".repeat(20_000),
				parameters: { type: "object", properties: {} },
			},
		];
		const request = createPreparedRequest(harness, {
			model: preparedModel,
			providerContext: { systemPrompt: "", messages: [], tools: capturedTools },
		});
		const successor = createPreparedRequest(harness, {
			...request,
			checkpointId: "checkpoint-1",
			attempt: 1,
		});
		vi.spyOn(harness.session.agent, "getPreparedRequest").mockReturnValue(request);
		vi.spyOn(harness.session.agent, "replacePreparedRequestMessages").mockResolvedValue({
			type: "admit",
			checkpoint: successor,
		});
		sessionInternals._proactiveCompactionState = {
			phase: "compacting",
			checkpointId: request.checkpointId,
		};

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
		expect(summarizationModelId).toBe("prepared-model");
		expect(harness.sessionManager.getBranch().find((entry) => entry.type === "compaction")).toMatchObject({
			tokensBefore: estimateToolDefinitionTokens(capturedTools),
		});
	});

	it("does not resume a proactively interrupted run after compaction cancellation", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const request = createPreparedRequest(harness);
		sessionInternals._proactiveCompactionState = {
			phase: "scheduled",
			checkpointId: request.checkpointId,
		};
		vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await expect(sessionInternals._handlePostAgentRun(createPausedRunResult(request))).resolves.toBe(false);
	});

	it("clears a proactive ticket when auto-compaction aborts", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const request = createPreparedRequest(harness);
		vi.spyOn(harness.session.agent, "getPreparedRequest").mockReturnValue(request);
		sessionInternals._proactiveCompactionState = {
			phase: "compacting",
			checkpointId: request.checkpointId,
		};

		const compactPromise = sessionInternals._runAutoCompaction("threshold", false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).resolves.toBe(false);
		expect(sessionInternals._proactiveCompactionState).toEqual({ phase: "idle" });
	});

	it("does not reuse abandoned proactive accounting for a later compaction", async () => {
		const abandonedTokensBefore = 123_456;
		let extensionTokensBefore: number | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => {
						extensionTokensBefore = event.preparation.tokensBefore;
						return {
							compaction: {
								summary: "summary after abandoned proactive compaction",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		sessionInternals._proactiveCompactionState = {
			phase: "scheduled",
			checkpointId: "abandoned-checkpoint",
		};

		await expect(
			sessionInternals._handlePostAgentRun({ status: "completed", deliveries: [] }, undefined, -1),
		).resolves.toBe(false);
		expect(sessionInternals._proactiveCompactionState).toEqual({ phase: "idle" });

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		const compactionEntry = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(extensionTokensBefore).toBeDefined();
		expect(extensionTokensBefore).not.toBe(abandonedTokensBefore);
		expect(compactionEntry).toMatchObject({ type: "compaction", tokensBefore: extensionTokensBefore });
	});

	it("excludes a stripped trailing error message from estimatedTokensAfter when retrying", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.sessionManager.appendMessage({
			...createAssistant(harness, {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: Date.now(),
			}),
			content: [{ type: "text", text: "partial output ".repeat(50) }],
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		useSummaryStreamFn(harness, "overflow summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const estimates: (number | undefined)[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				estimates.push(event.result?.estimatedTokensAfter);
			}
		});

		await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(true);

		const retained = harness.session.agent.state.messages;
		expect(
			retained.some(
				(message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "error",
			),
		).toBe(false);
		expect(estimates.at(-1)).toBe(
			estimateMessagesTokens(retained) + estimateToolDefinitionTokens(harness.session.agent.state.tools),
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it.each(["plain response", "stopping tool batch"] as const)(
		"stops for proactive compaction after a %s when a message is queued",
		async (kind) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const model = harness.getModel();
			const toolCall = fauxToolCall("read", { path: "large.txt" });
			const message: AssistantMessage = {
				...createAssistant(harness, {
					stopReason: kind === "plain response" ? "stop" : "toolUse",
					totalTokens: model.contextWindow,
				}),
				content: kind === "plain response" ? [{ type: "text", text: "done" }] : [toolCall],
			};
			const toolResults =
				kind === "plain response"
					? []
					: [
							{
								role: "toolResult" as const,
								toolCallId: toolCall.id,
								toolName: toolCall.name,
								content: [{ type: "text" as const, text: "stopped" }],
								isError: false,
								timestamp: Date.now(),
							},
						];
			const deliveredMessage = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "queued follow-up" }],
				timestamp: Date.now(),
			};
			const delivery = { deliveryId: "follow-up-1", messages: [deliveredMessage] };

			const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
			const request = createPreparedRequest(harness, {
				completedTurn: {
					message,
					toolResults,
					disposition: kind === "stopping tool batch" ? "stop" : "continue",
				},
				requestAuthority: "provider",
				defaultAction: { type: "stop" },
				reason: "delivery",
				deliveries: [delivery],
				providerContext: {
					systemPrompt: "",
					messages: [message, ...toolResults, deliveredMessage],
					tools: [],
				},
				model,
			});
			expect(sessionInternals._admitPreparedContinuation(request)).toMatchObject({
				type: "pause",
				reason: "compaction",
				attempt: 0,
			});
		},
	);

	it("uses rebuilt context size when retained assistant usage predates proactive compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		const toolCall = fauxToolCall("read", { path: "large.txt" });
		const message: AssistantMessage = {
			...createAssistant(harness, { stopReason: "toolUse", totalTokens: model.contextWindow }),
			content: [toolCall],
		};
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "inspect the large file" }],
			timestamp: message.timestamp - 1,
		});
		harness.sessionManager.appendMessage(message);
		const firstKeptEntryId = harness.sessionManager.getLeafId()!;
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "retained result" }],
			isError: false,
			timestamp: message.timestamp + 1,
		});
		harness.sessionManager.appendCompaction("summary", firstKeptEntryId, model.contextWindow, undefined, false);
		const compactedMessages = harness.sessionManager.buildSessionContext().messages;
		const providerMessages = await harness.session.agent.convertToLlm(compactedMessages);
		harness.session.agent.state.messages = compactedMessages;
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		sessionInternals._proactiveCompactionState = {
			phase: "compacting",
			checkpointId: "checkpoint-before-compaction",
		};
		const request = createPreparedRequest(harness, {
			checkpointId: "checkpoint-after-compaction",
			attempt: 1,
			completedTurn: { message, toolResults: [], disposition: "continue" },
			providerContext: { systemPrompt: "", messages: providerMessages, tools: [] },
			model,
		});

		expect(sessionInternals._admitPreparedContinuation(request)).toEqual({ type: "admit" });
		expect(sessionInternals._proactiveCompactionState).toEqual({ phase: "idle" });
	});

	it("fails a still-oversized resumed request after one no-progress compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		const message = createAssistant(harness, { stopReason: "toolUse", totalTokens: model.contextWindow });
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const previous = createPreparedRequest(harness, {
			checkpointId: "checkpoint-before-compaction",
			completedTurn: { message, toolResults: [], disposition: "continue" },
			providerContext: { systemPrompt: "", messages: [message], tools: [] },
			model,
		});
		const successor = createPreparedRequest(harness, {
			checkpointId: "checkpoint-after-compaction",
			requestId: previous.requestId,
			attempt: 1,
			completedTurn: previous.completedTurn,
			providerContext: { systemPrompt: "", messages: [message], tools: [] },
			model,
		});
		vi.spyOn(harness.session.agent, "getPreparedRequest").mockReturnValue(previous);
		sessionInternals._proactiveCompactionState = {
			phase: "compacting",
			checkpointId: previous.checkpointId,
		};

		expect(() => sessionInternals._admitPreparedContinuation(successor)).toThrow(
			"Proactive compaction made no progress toward an admissible provider request",
		);
		expect(sessionInternals._proactiveCompactionState).toEqual({ phase: "idle" });
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, false, undefined);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
