import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	streamSimple,
} from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAgentSessionTestControl } from "./agent-session-test-control.ts";
import { createTestResourceLoader } from "./utilities.ts";

const compactionMockState = vi.hoisted(() => ({ firstKeptEntryId: undefined as string | undefined }));

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({
		summary: "compacted",
		firstKeptEntryId: compactionMockState.firstKeptEntryId ?? "missing-first-kept-entry",
		tokensBefore: 100,
		details: {},
	}),
	estimateTokens: (message: { content?: unknown }) => Math.ceil(JSON.stringify(message.content ?? "").length / 4),
	estimateMessagesTokens: (messages: Array<{ content?: unknown }>) =>
		messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message.content ?? "").length / 4), 0),
	estimateContextTokens: (
		messages: Array<{
			role: string;
			content?: Array<{ type: string; text?: string; thinking?: string }>;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			stopReason?: string;
		}>,
	) => {
		const estimateMessageTokens = (message: (typeof messages)[number]) =>
			Math.ceil(
				(message.content ?? []).reduce(
					(chars, part) => chars + (part.text?.length ?? 0) + (part.thinking?.length ?? 0),
					0,
				) / 4,
			);
		// Walk backwards to find last non-error, non-aborted assistant with usage,
		// then include tool results and other messages appended after that request.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
				const usageTokens =
					msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				const trailingTokens = messages
					.slice(i + 1)
					.reduce((total, message) => total + estimateMessageTokens(message), 0);
				return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i };
			}
		}
		const tokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
		return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
	},
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: (branchEntries: Array<{ id: string }>) => {
		compactionMockState.firstKeptEntryId = branchEntries.at(-1)?.id;
		return { dummy: true };
	},
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
	) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));

vi.mock("../src/core/compaction/context-compaction.ts", () => ({
	compactContext: async () => ({
		summary: "compacted",
		firstKeptEntryId: compactionMockState.firstKeptEntryId ?? "missing-first-kept-entry",
		tokensBefore: 100,
		details: {},
	}),
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let control: ReturnType<typeof createAgentSessionTestControl>;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			sessionManager,
			model,
			thinkingLevel: "off",
			streamFn: (requestModel, context, options) =>
				streamSimple(requestModel, context, { ...options, apiKey: "test-key" }),
			convertToLlm,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		control = createAgentSessionTestControl(session);
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("should resume after threshold compaction when only agent-level queued messages exist", async () => {
		sessionManager.appendMessage({ role: "user", content: "compaction seed", timestamp: Date.now() });
		control.queueFollowUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.pendingMessageCount).toBe(0);
		expect(control.hasQueuedMessages()).toBe(true);

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await expect(runAutoCompaction("threshold", false)).resolves.toBe(true);

		expect(control.hasQueuedMessages()).toBe(true);
	});

	it("should continue after threshold compaction when a length stop has no visible response", async () => {
		const model = session.model!;
		let streamCallCount = 0;

		control.setStreamFn(() => {
			const callNumber = ++streamCallCount;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callNumber === 1) {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "thinking", thinking: "still reasoning" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: model.contextWindow - 20_000,
							output: 10_000,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: model.contextWindow - 10_000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "length",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
					stream.push({ type: "done", seq: 1, reason: "length", message });
					return;
				}

				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "continued" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		});

		await session.prompt("trigger length continuation");

		expect(streamCallCount).toBe(2);
	});

	it("should compact mid-run when a turn with tool calls crosses the threshold", async () => {
		const model = session.model!;
		let streamCallCount = 0;
		let streamCallsAtCompactionStart = -1;
		const agentEnds: string[] = [];
		const compactionContinuations: boolean[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") {
				streamCallsAtCompactionStart = streamCallCount;
			}
			if (event.type === "compaction_end") {
				compactionContinuations.push(event.willRetry);
			}
			if (event.type === "agent_end") {
				agentEnds.push(event.type);
			}
		});

		control.setStreamFn(() => {
			const callNumber = ++streamCallCount;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callNumber === 1) {
					// Tool-call turn whose usage already exceeds the compaction threshold.
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "missing-file.txt" } }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: model.contextWindow - 20_000,
							output: 10_000,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: model.contextWindow - 10_000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
					return;
				}

				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "finished after compaction" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		});

		await session.prompt("trigger proactive mid-run compaction");

		// Compaction ran between the tool-call turn and the continuation, not
		// after the full agent/tool loop finished.
		expect(streamCallsAtCompactionStart).toBe(1);
		expect(streamCallCount).toBe(2);
		expect(agentEnds).toHaveLength(2);
		expect(compactionContinuations).toEqual([true]);
		expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("should include newly appended tool results in proactive threshold checks", async () => {
		const model = session.model!;
		writeFileSync(join(tempDir, "large-result.txt"), "x".repeat(40_000));
		let streamCallCount = 0;
		let streamCallsAtCompactionStart = -1;
		session.subscribe((event) => {
			if (event.type === "compaction_start") {
				streamCallsAtCompactionStart = streamCallCount;
			}
		});

		control.setStreamFn(() => {
			const callNumber = ++streamCallCount;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content:
						callNumber === 1
							? [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large-result.txt" } }]
							: [{ type: "text", text: "finished after tool-result compaction" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: callNumber === 1 ? model.contextWindow - 20_000 : 100,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: callNumber === 1 ? model.contextWindow - 20_000 : 100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: callNumber === 1 ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({
					type: "done",
					seq: 1,
					reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
					message,
				});
			});
			return stream;
		});

		await session.prompt("trigger compaction from a large tool result");

		expect(streamCallsAtCompactionStart).toBe(1);
		expect(streamCallCount).toBe(2);
	});

	it("should compact a terminating tool batch using its live tool-result context without resuming", async () => {
		const model = session.model!;
		writeFileSync(join(tempDir, "large-terminating-result.txt"), "x".repeat(40_000));
		let streamCallCount = 0;
		control.onToolResult(async () => ({ disposition: "stop" }));
		control.setStreamFn(() => {
			streamCallCount += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "large-terminating-result.txt" },
						},
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: model.contextWindow - 20_000,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: model.contextWindow - 20_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "toolUse", message });
			});
			return stream;
		});

		await session.prompt("run terminating tool");

		expect(streamCallCount).toBe(1);
		expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("keeps session busy and waitForIdle pending during manual compaction", async () => {
		const model = session.model!;
		control.setStreamFn(() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ready" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 10,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 11,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		});
		await session.prompt("seed compaction history");

		const beforeCompactStarted = createDeferred();
		const finishBeforeCompact = createDeferred();
		vi.spyOn(session.extensionRunner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact",
		);
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") {
				beforeCompactStarted.resolve();
				await finishBeforeCompact.promise;
			}
			return undefined;
		});

		const compaction = session.compact();
		await beforeCompactStarted.promise;
		expect(session.isBusy).toBe(true);
		let idleResolved = false;
		const idle = session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);

		finishBeforeCompact.resolve();
		await compaction;
		await idle;
		expect(idleResolved).toBe(true);
		expect(session.isBusy).toBe(false);
	});

	it("reports no continuation when session abort cancels proactive compaction", async () => {
		const compactionStarted = createDeferred();
		const finishCompaction = createDeferred();
		vi.spyOn(session.extensionRunner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact",
		);
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") {
				compactionStarted.resolve();
				await finishCompaction.promise;
			}
			return undefined;
		});
		const compactionEnds: Array<{ aborted: boolean; willRetry: boolean }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				compactionEnds.push({ aborted: event.aborted, willRetry: event.willRetry });
			}
		});
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction(
					reason: "threshold",
					willRetry: boolean,
					continueAfterCompaction: boolean,
				): Promise<boolean>;
			}
		)._runAutoCompaction("threshold", false, true);
		await compactionStarted.promise;

		const abort = session.abort();
		finishCompaction.resolve();
		await abort;
		await runAutoCompaction;

		expect(compactionEnds).toEqual([{ aborted: true, willRetry: false }]);
	});

	it("does not authorize queued continuation when abort lands during post-run compaction", async () => {
		const model = session.model!;
		const compactionStarted = createDeferred();
		const finishCompaction = createDeferred();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const internals = session as unknown as {
			_abortGeneration: number;
			_conversationGenerationRevision: number;
			_lastAssistantMessage: AssistantMessage | undefined;
			_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
			_handlePostAgentRun: (abortGeneration: number, conversationGenerationRevision: number) => Promise<boolean>;
		};
		internals._lastAssistantMessage = assistantMessage;
		vi.spyOn(internals, "_checkCompaction").mockImplementation(async () => {
			compactionStarted.resolve();
			await finishCompaction.promise;
			return false;
		});

		const continuation = internals._handlePostAgentRun(
			internals._abortGeneration,
			internals._conversationGenerationRevision,
		);
		await compactionStarted.promise;
		control.queueSteer({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "retained" }],
			display: false,
			timestamp: Date.now(),
		});
		await session.abort();
		finishCompaction.resolve();

		await expect(continuation).resolves.toBe(false);
		expect(control.hasQueuedMessages()).toBe(true);
	});

	it("should not continue after disposal during proactive compaction", async () => {
		const model = session.model!;
		const compactionStarted = createDeferred();
		const finishCompaction = createDeferred();
		let streamCallCount = 0;
		vi.spyOn(
			session as unknown as {
				_runAutoCompaction: (
					reason: "overflow" | "threshold",
					willRetry: boolean,
					continueAfterCompaction?: boolean,
				) => Promise<boolean>;
			},
			"_runAutoCompaction",
		).mockImplementation(async () => {
			compactionStarted.resolve();
			await finishCompaction.promise;
			return false;
		});

		control.setStreamFn(() => {
			streamCallCount += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "missing.txt" } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: model.contextWindow - 20_000,
						output: 10_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: model.contextWindow - 10_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "toolUse", message });
			});
			return stream;
		});

		const promptPromise = session.prompt("trigger proactive compaction");
		await compactionStarted.promise;
		session.dispose();
		finishCompaction.resolve();
		await promptPromise;

		expect(streamCallCount).toBe(1);
	});

	it("should stop proactively only once until a compaction succeeds", async () => {
		const model = session.model!;
		const message = {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "x" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: model.contextWindow - 10_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: model.contextWindow - 10_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: Date.now(),
		};
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [],
			isError: true,
			timestamp: Date.now(),
		};
		const context = {
			completedTurn: { message, toolResults: [toolResult], disposition: "continue" },
			requestAuthority: "tool_continuation",
			context: { systemPrompt: "", messages: [message, toolResult], tools: [] },
			newMessages: [],
			defaultAction: { type: "request", reason: "continuation" },
		};

		const hook = (
			session as unknown as {
				_shouldStopForProactiveCompaction: (context: unknown) => boolean;
			}
		)._shouldStopForProactiveCompaction.bind(session);

		expect(hook(context)).toBe(true);
		// A second threshold crossing before any successful compaction must not
		// interrupt the run again (prevents stop/fail/continue churn every turn).
		expect(hook(context)).toBe(false);
	});

	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		const model = session.model!;
		const overflowMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		};

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const events: Array<{ type: string; reason: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason, errorMessage: event.errorMessage });
			}
		});

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(overflowMessage);
		await checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("should ignore stale pre-compaction assistant usage on pre-prompt compaction checks", async () => {
		const model = session.model!;
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 600_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 610_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: staleAssistantTimestamp,
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		sessionManager.appendMessage(staleAssistant);

		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, staleAssistant.usage.totalTokens, undefined, false);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session recovery payload" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should trigger threshold compaction for error messages using last successful usage", async () => {
		const model = session.model!;

		// A successful assistant message with high token usage (near context limit)
		const successfulAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large successful response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: model.contextWindow - 20_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: model.contextWindow - 10_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// An error message (e.g. 529 overloaded) with no useful usage data
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		};

		// Persist both messages so canonical context estimation can find the successful one.
		for (const message of [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "another prompt" }],
				timestamp: Date.now() + 500,
			},
			errorAssistant,
		]) {
			sessionManager.appendMessage(message);
		}

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, false, undefined);
	});

	it("should not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const model = session.model!;

		// An error message with no prior successful assistant in context
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		});
		sessionManager.appendMessage(errorAssistant);

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should not trigger threshold compaction for error messages when only kept pre-compaction usage exists", async () => {
		const model = session.model!;
		const preCompactionTimestamp = Date.now() - 10_000;

		// A "kept" assistant message from before compaction with high usage
		const keptAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "kept response from before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: model.contextWindow - 20_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: model.contextWindow - 10_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: preCompactionTimestamp,
		};

		// Record the kept assistant in the session and create a compaction after it
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined, false);

		// Post-compaction error message
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		// Canonical context has only new post-compaction work after the summary.
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "new prompt" }],
			timestamp: Date.now() - 500,
		});
		sessionManager.appendMessage(errorAssistant);

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		// Should NOT compact because the only usage data is from a kept pre-compaction message
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
});
