import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
		) => Promise<void>;

		await bindCurrentSessionExtensions.call(fakeThis);
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
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
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
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
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
