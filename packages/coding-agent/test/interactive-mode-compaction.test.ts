import { Container } from "@hansjm10/volt-tui";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;

function createCompactionEventContext() {
	initTheme("dark");
	const chatContainer = new Container();
	vi.spyOn(chatContainer, "clear");
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		autoCompactionEscapeHandler: undefined as (() => void) | undefined,
		autoCompactionLoader: undefined,
		defaultEditor: {},
		statusContainer: { clear: vi.fn() },
		chatContainer,
		rebuildChatFromMessages: vi.fn(),
		addMessageToChat: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	};
}

const handleCompactionEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: ReturnType<typeof createCompactionEventContext>,
	event: CompactionEndEvent,
) => Promise<void>;

describe("InteractiveMode extension settlement", () => {
	test("binds extension waitForIdle to the session settlement boundary", async () => {
		const sessionWaitForIdle = vi.fn(async () => undefined);
		const session = {
			isBusy: true,
			bindExtensions: vi.fn(
				async (_options: { commandContextActions: { waitForIdle(): Promise<void> } }) => undefined,
			),
			extensionRunner: {},
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			waitForIdle: sessionWaitForIdle,
		};
		const fakeThis = {
			createExtensionUIContext: vi.fn(() => ({})),
			session,
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			showLoadedResources: vi.fn(),
			showStartupNoticesIfNeeded: vi.fn(),
			shutdownRequested: false,
			shutdown: vi.fn(async () => undefined),
		};
		const bindCurrentSessionExtensions = Reflect.get(InteractiveMode.prototype, "bindCurrentSessionExtensions") as (
			this: typeof fakeThis,
			currentSession: typeof session,
		) => Promise<void>;

		await bindCurrentSessionExtensions.call(fakeThis, session);
		const options = session.bindExtensions.mock.calls[0]?.[0] as {
			commandContextActions: { waitForIdle(): Promise<void> };
			shutdownHandler(): void;
		};
		await options.commandContextActions.waitForIdle();

		expect(sessionWaitForIdle).toHaveBeenCalledOnce();

		options.shutdownHandler();
		expect(fakeThis.shutdownRequested).toBe(true);
		expect(fakeThis.shutdown).not.toHaveBeenCalled();
		session.isBusy = false;
		options.shutdownHandler();
		expect(fakeThis.shutdown).toHaveBeenCalledOnce();
	});
});

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = createCompactionEventContext();

		await handleCompactionEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				firstKeptEntryId: "kept",
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.chatContainer.render(120).lines).toEqual([]);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test.each(["manual", "threshold", "overflow"] as const)(
		"displays every request at %s compaction completion without changing the summary",
		async (reason) => {
			const fakeThis = createCompactionEventContext();
			const request = { provider: "test-provider", model: "test-model" };
			await handleCompactionEvent.call(fakeThis, {
				type: "compaction_end",
				reason,
				result: {
					firstKeptEntryId: "kept",
					tokensBefore: 123,
					summary: "summary",
					details: {
						requests: [
							{ ...request, strategy: "native", attempt: 1 },
							{
								...request,
								strategy: "native",
								attempt: 2,
								stopReason: "error",
								usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 },
							},
							{
								...request,
								strategy: "chunked",
								attempt: 3,
								stopReason: "stop",
								usage: { input: 100, cacheRead: 800, cacheWrite: 100, output: 100, totalTokens: 1100 },
							},
							{
								...request,
								strategy: "chunked",
								attempt: 4,
								stopReason: "stop",
								usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 200 },
							},
						],
					},
				},
				aborted: false,
				willRetry: reason !== "manual",
			});

			const lines = fakeThis.chatContainer.render(160).lines.map((line) => stripAnsi(line).trim());
			expect(lines).toEqual([
				"Native compaction request 1 (no terminal response): cache usage unavailable",
				"Native compaction request 2 (error): cache usage unavailable",
				`Chunked compaction request 3 (stop): 800 cached / ${(1000).toLocaleString()} prompt tokens — 80.0% hit`,
				"Chunked compaction request 4 (stop): 0 cached / 100 prompt tokens — 0.0% hit",
			]);
			expect(fakeThis.addMessageToChat).toHaveBeenCalledExactlyOnceWith({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
				timestamp: expect.any(Number),
			});
			expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: reason !== "manual" });
		},
	);

	test("shows unavailable cache data and ignores malformed records without losing later requests", async () => {
		const fakeThis = createCompactionEventContext();
		const request = { strategy: "native", provider: "test-provider", model: "test-model", stopReason: "stop" };
		await handleCompactionEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				firstKeptEntryId: "kept",
				tokensBefore: 123,
				summary: "summary",
				details: {
					requests: [
						null,
						{ strategy: "unsupported", attempt: 1 },
						{ ...request, attempt: 2 },
						{ ...request, attempt: 3, usage: { input: "100", cacheRead: 100, cacheWrite: 0 } },
						{
							...request,
							attempt: 4,
							usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 100 },
						},
					],
				},
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.render(120).lines.map((line) => stripAnsi(line).trim())).toEqual([
			"Native compaction request 2 (stop): cache usage unavailable",
			"Native compaction request 3 (stop): cache usage unavailable",
			"Native compaction request 4 (stop): cache usage unavailable",
		]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("waits for the compaction transaction to settle before flushing a new prompt", async () => {
		let releaseIdle: () => void = () => undefined;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const session = {
			waitForIdle: vi.fn(() => idle),
			prompt: vi.fn(async () => undefined),
			followUp: vi.fn(async () => undefined),
			steer: vi.fn(async () => undefined),
			clearQueue: vi.fn(),
		};
		const fakeThis = {
			compactionQueuedMessages: [{ text: "queued after compaction", mode: "steer" as const }],
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			session,
			isExtensionCommand: vi.fn(() => false),
			collectPromptImages: vi.fn(async () => undefined),
		};
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		const flushing = flushCompactionQueue.call(fakeThis, { willRetry: false });
		await Promise.resolve();
		expect(session.waitForIdle).toHaveBeenCalledOnce();
		expect(session.prompt).not.toHaveBeenCalled();

		releaseIdle();
		await flushing;
		expect(session.prompt).toHaveBeenCalledWith("queued after compaction", undefined);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
	});

	test("defers requested shutdown from agent_end until the session settles", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			loadingAnimation: undefined,
			statusContainer: { clear: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			chatContainer: { removeChild: vi.fn() },
			disposePendingTools: vi.fn(),
			stopWorkingElapsedTicker: vi.fn(),
			scheduleTurnDoneAlert: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			checkShutdownRequested: vi.fn(async () => undefined),
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "agent_end"; messages: []; willRetry: false } | { type: "agent_settled" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_end", messages: [], willRetry: false });
		expect(fakeThis.checkShutdownRequested).not.toHaveBeenCalled();

		await handleEvent.call(fakeThis, { type: "agent_settled" });
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledOnce();
	});
});
