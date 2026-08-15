import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createTestAgentSessionRuntimeConfig, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	outputObserver: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	restoreStdout: vi.fn(),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.outputObserver?.(line);
	},
}));

vi.mock("../src/core/theme/runtime.js", () => ({
	theme: {},
	Theme: class {},
	getAvailableThemesWithPaths: () => [],
	getThemeByName: () => undefined,
	setRegisteredThemes: () => {},
	setTheme: () => ({ success: true }),
	setThemeInstance: () => {},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
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

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	configureSession?: (session: AgentSession) => void;
	sessionManager?: SessionManager;
}): {
	runtimeHost: AgentSessionRuntime;
	sessionManager: SessionManager;
	getStreamCallCount: () => number;
	cleanup: () => Promise<void>;
} {
	const tempDir = join(tmpdir(), `volt-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	let streamCallCount = 0;
	const runtimeConfig = createTestAgentSessionRuntimeConfig({
		model,
		streamFn: (_model, _context, _options) => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", seq: 0, snapshot: createAssistantMessage(""), toolState: [] });
				setTimeout(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	const session = new AgentSession({
		...runtimeConfig,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	options.configureSession?.(session);

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		async runWithStableSession<T>(operation: (stableSession: AgentSession) => Promise<T> | T): Promise<T> {
			return operation(session);
		},
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		sessionManager,
		getStreamCallCount: () => streamCallCount,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			await session.waitForClosed();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	configureSession?: (session: AgentSession) => void;
	sessionManager?: SessionManager;
}): Promise<{
	lineHandler: (line: string) => void;
	sessionManager: SessionManager;
	getStreamCallCount: () => number;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	rpcIo.outputObserver = undefined;

	const { runtimeHost, sessionManager, getStreamCallCount, cleanup } = createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, sessionManager, getStreamCallCount, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.outputObserver = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", clientMessageId: "client-b1", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const sessionDir = join(tmpdir(), `volt-rpc-durable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(sessionDir, { recursive: true });
		const manager = SessionManager.create(sessionDir, sessionDir);
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			sessionManager: manager,
		});
		let successObservedCanonicalCommit = false;
		rpcIo.outputObserver = (line) => {
			const response = parseOutputLines([line]).find(
				(record) => record.id === "b2" && record.type === "response" && record.success === true,
			);
			if (!response) return;
			const persistedEntries = readFileSync(manager.getSessionFile()!, "utf8")
				.trim()
				.split("\n")
				.map((entry) => JSON.parse(entry) as Record<string, unknown>);
			successObservedCanonicalCommit =
				manager.getClientInput("client-b2")?.state === "completed" &&
				persistedEntries.some(
					(entry) =>
						entry.type === "message" &&
						(entry.message as Record<string, unknown> | undefined)?.role === "user" &&
						(entry.message as Record<string, unknown> | undefined)?.clientMessageId === "client-b2",
				);
		};

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", clientMessageId: "client-b2", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
					data: {
						clientMessageId: "client-b2",
						outcome: "admitted",
						canonicalEntryId: expect.any(String),
					},
				});
			});
			expect(successObservedCanonicalCommit).toBe(true);
			await vi.waitFor(() => {
				const userEnd = parseOutputLines(rpcIo.outputLines).find(
					(record) =>
						record.type === "message_end" &&
						(record.message as Record<string, unknown> | undefined)?.role === "user",
				);
				expect(userEnd).toMatchObject({
					message: { role: "user", clientMessageId: "client-b2" },
				});
			});
		} finally {
			await cleanup();
			if (existsSync(sessionDir)) {
				rmSync(sessionDir, { recursive: true, force: true });
			}
		}
	});

	it("replays success after immediate teardown without dispatching the same durable input again", async () => {
		const sessionDir = join(tmpdir(), `volt-rpc-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(sessionDir, { recursive: true });
		const manager = SessionManager.create(sessionDir, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		const command = {
			type: "prompt",
			clientMessageId: "client-success-crash",
			message: "Commit before acknowledging",
		};
		const first = await startRpcMode({
			withAuth: true,
			responseDelayMs: 250,
			sessionManager: manager,
		});
		let second: Awaited<ReturnType<typeof startRpcMode>> | undefined;

		try {
			first.lineHandler(JSON.stringify({ ...command, id: "before-crash" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "before-crash")).toMatchObject([
					{
						id: "before-crash",
						success: true,
						data: {
							clientMessageId: command.clientMessageId,
							outcome: "admitted",
							canonicalEntryId: expect.any(String),
						},
					},
				]);
			});
			expect(manager.getClientInput(command.clientMessageId)?.state).toBe("completed");
			expect(first.getStreamCallCount()).toBe(1);
			await first.cleanup();

			const reopened = SessionManager.open(sessionFile, sessionDir);
			second = await startRpcMode({ withAuth: true, responseDelayMs: 0, sessionManager: reopened });
			second.lineHandler(JSON.stringify({ ...command, id: "after-crash" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "after-crash")).toMatchObject([
					{
						id: "after-crash",
						success: true,
						data: {
							clientMessageId: command.clientMessageId,
							outcome: "completed",
							canonicalEntryId: expect.any(String),
						},
					},
				]);
			});
			expect(second.getStreamCallCount()).toBe(0);
			expect(
				reopened
					.buildSessionContext()
					.messages.filter(
						(message) => message.role === "user" && message.clientMessageId === command.clientMessageId,
					),
			).toHaveLength(1);
		} finally {
			await first.cleanup();
			await second?.cleanup();
			if (existsSync(sessionDir)) {
				rmSync(sessionDir, { recursive: true, force: true });
			}
		}
	});

	it("reports busy preflight separately from provider streaming", async () => {
		let releaseInput: () => void = () => undefined;
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let notifyInputStarted: () => void = () => undefined;
		const inputStarted = new Promise<void>((resolve) => {
			notifyInputStarted = resolve;
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			configureSession: (session) => {
				const runner = session.extensionRunner;
				const hasHandlers = runner.hasHandlers.bind(runner);
				runner.hasHandlers = (eventType) => eventType === "input" || hasHandlers(eventType);
				runner.emitInput = async () => {
					notifyInputStarted();
					await inputRelease;
					return { action: "handled" };
				};
			},
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "busy-prompt",
					type: "prompt",
					clientMessageId: "client-busy",
					message: "Wait in preflight",
				}),
			);
			await inputStarted;
			lineHandler(JSON.stringify({ id: "busy-state", type: "get_state" }));

			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((record) => record.id === "busy-state");
				expect(response).toMatchObject({
					type: "response",
					command: "get_state",
					success: true,
					data: { isStreaming: false, isBusy: true },
				});
			});
		} finally {
			releaseInput();
			await cleanup();
		}
	});

	it("reports handled identified prompts as completed without waiting for a canonical row", async () => {
		const { lineHandler, sessionManager, getStreamCallCount, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			configureSession: (session) => {
				const runner = session.extensionRunner;
				const hasHandlers = runner.hasHandlers.bind(runner);
				runner.hasHandlers = (eventType) => eventType === "input" || hasHandlers(eventType);
				runner.emitInput = async () => ({ action: "handled" });
			},
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "handled-prompt",
					type: "prompt",
					clientMessageId: "client-handled",
					message: "Handled without a model turn",
				}),
			);

			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "handled-prompt")).toMatchObject([
					{
						id: "handled-prompt",
						success: true,
						data: {
							clientMessageId: "client-handled",
							outcome: "completed",
						},
					},
				]);
			});
			expect(sessionManager.getClientInput("client-handled")).toMatchObject({ state: "completed" });
			expect(sessionManager.getClientInput("client-handled")?.canonicalEntryId).toBeUndefined();
			expect(getStreamCallCount()).toBe(0);
			expect(
				parseOutputLines(rpcIo.outputLines).filter(
					(record) =>
						record.type === "message_end" &&
						(record.message as Record<string, unknown> | undefined)?.role === "user",
				),
			).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("joins concurrent retries while preserving each request RPC id", async () => {
		let releaseInput!: () => void;
		let markInputStarted!: () => void;
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			configureSession: (session) => {
				const runner = session.extensionRunner;
				const hasHandlers = runner.hasHandlers.bind(runner);
				runner.hasHandlers = (eventType) => eventType === "input" || hasHandlers(eventType);
				runner.emitInput = async (text, images) => {
					markInputStarted();
					await inputRelease;
					return { action: "transform", text, images };
				};
			},
		});

		try {
			const command = {
				type: "prompt",
				clientMessageId: "client-concurrent-retry",
				message: "One dispatch",
			};
			lineHandler(JSON.stringify({ ...command, id: "concurrent-original" }));
			await inputStarted;
			lineHandler(JSON.stringify({ ...command, id: "concurrent-retry" }));
			releaseInput();

			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "concurrent-original")).toMatchObject([
					{ id: "concurrent-original", success: true },
				]);
				expect(getPromptResponses(rpcIo.outputLines, "concurrent-retry")).toMatchObject([
					{ id: "concurrent-retry", success: true },
				]);
			});
			await vi.waitFor(() => {
				const messageEnds = parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "message_end");
				expect(
					messageEnds.filter((record) => (record.message as Record<string, unknown> | undefined)?.role === "user"),
				).toHaveLength(1);
				expect(
					messageEnds.filter(
						(record) => (record.message as Record<string, unknown> | undefined)?.role === "assistant",
					),
				).toHaveLength(1);
			});
		} finally {
			releaseInput();
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(
				JSON.stringify({ id: "b3-start", type: "prompt", clientMessageId: "client-b3-start", message: "Start" }),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					clientMessageId: "client-b3",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("answers completed retries under each RPC id without replaying the turn", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(
				JSON.stringify({
					id: "retry-original",
					type: "prompt",
					clientMessageId: "client-retry-complete",
					message: "Only once",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "retry-original")).toMatchObject([
					{
						data: {
							clientMessageId: "client-retry-complete",
							outcome: "admitted",
							canonicalEntryId: expect.any(String),
						},
					},
				]);
				const assistantEnds = parseOutputLines(rpcIo.outputLines).filter(
					(record) =>
						record.type === "message_end" &&
						(record.message as Record<string, unknown> | undefined)?.role === "assistant",
				);
				expect(assistantEnds).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "retry-replay",
					type: "prompt",
					clientMessageId: "client-retry-complete",
					message: "Only once",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "retry-replay")).toMatchObject([
					{
						id: "retry-replay",
						type: "response",
						command: "prompt",
						success: true,
						data: {
							clientMessageId: "client-retry-complete",
							outcome: "completed",
							canonicalEntryId: expect.any(String),
						},
					},
				]);
			});

			lineHandler(
				JSON.stringify({
					id: "retry-conflict",
					type: "prompt",
					clientMessageId: "client-retry-complete",
					message: "Different input",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "retry-conflict")).toMatchObject([
					{
						id: "retry-conflict",
						type: "response",
						command: "prompt",
						success: false,
						error: expect.stringContaining("client_input_conflict"),
						errorCode: "client_input_conflict",
					},
				]);
			});

			const transcriptEnds = parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "message_end");
			expect(
				transcriptEnds.filter((record) => (record.message as Record<string, unknown> | undefined)?.role === "user"),
			).toHaveLength(1);
			expect(
				transcriptEnds.filter(
					(record) => (record.message as Record<string, unknown> | undefined)?.role === "assistant",
				),
			).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("replays a durable prompt failure under a new RPC id", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "failed-replay-model",
				name: "Failed Replay Model",
				api: "openai-completions",
				provider: "failed-replay-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			const command = {
				type: "prompt",
				clientMessageId: "client-retry-failed",
				message: "Cannot dispatch",
			};
			lineHandler(JSON.stringify({ ...command, id: "failed-original" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "failed-original")).toMatchObject([
					{ id: "failed-original", success: false, error: expect.stringContaining("No API key found") },
				]);
			});

			lineHandler(JSON.stringify({ ...command, id: "failed-replay" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "failed-replay")).toMatchObject([
					{ id: "failed-replay", success: false, error: expect.stringContaining("No API key found") },
				]);
			});

			const userEnds = parseOutputLines(rpcIo.outputLines).filter(
				(record) =>
					record.type === "message_end" &&
					(record.message as Record<string, unknown> | undefined)?.role === "user",
			);
			expect(userEnds).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});
});
