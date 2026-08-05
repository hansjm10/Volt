import { describe, expect, test, vi } from "vitest";
import { QueueClearPersistenceError } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CompactionQueuedMessage = { text: string; mode: "steer" | "followUp" };

const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
	this: unknown,
	options?: { abortSource?: "keyboard_interrupt" | "host_action"; currentText?: string },
) => Promise<number>;
const runKeyAction = Reflect.get(InteractiveMode.prototype, "runKeyAction") as (
	this: unknown,
	action: () => Promise<void>,
) => void;

/**
 * Builds a receiver carrying the real collaborating prototype methods, so the
 * restore path is exercised end to end rather than through stubs.
 */
function createRestoreReceiver(options: {
	clearQueue: () => Promise<{ steering: string[]; followUp: string[] }>;
	compactionQueuedMessages?: CompactionQueuedMessage[];
	editorText?: string;
}) {
	return {
		clearAllQueues: Reflect.get(InteractiveMode.prototype, "clearAllQueues"),
		drainCompactionQueue: Reflect.get(InteractiveMode.prototype, "drainCompactionQueue"),
		putQueuedTextInEditor: Reflect.get(InteractiveMode.prototype, "putQueuedTextInEditor"),
		session: { clearQueue: vi.fn(options.clearQueue) },
		compactionQueuedMessages: options.compactionQueuedMessages ?? [],
		agent: { abort: vi.fn() },
		editor: { getText: vi.fn(() => options.editorText ?? ""), setText: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
	};
}

describe("InteractiveMode queued message restoration", () => {
	test("restores queued text to the editor when cancellation persistence fails", async () => {
		const receiver = createRestoreReceiver({
			clearQueue: () =>
				Promise.reject(
					new QueueClearPersistenceError(new Error("ENOSPC: no space left on device"), {
						steering: ["steered draft"],
						followUp: ["follow-up draft"],
					}),
				),
			compactionQueuedMessages: [{ text: "queued for after compaction", mode: "steer" }],
			editorText: "in-progress draft",
		});

		await expect(
			restoreQueuedMessagesToEditor.call(receiver, { abortSource: "keyboard_interrupt" }),
		).rejects.toBeInstanceOf(QueueClearPersistenceError);

		// Every queued message survives, including the compaction queue that is
		// drained alongside the revoked session queue.
		expect(receiver.editor.setText).toHaveBeenCalledWith(
			"steered draft\n\nqueued for after compaction\n\nfollow-up draft\n\nin-progress draft",
		);
		expect(receiver.compactionQueuedMessages).toEqual([]);
		expect(receiver.agent.abort).toHaveBeenCalledWith("keyboard_interrupt");
	});

	test("leaves the compaction queue intact when clearing fails before the queues are revoked", async () => {
		const compactionQueuedMessages: CompactionQueuedMessage[] = [
			{ text: "queued for after compaction", mode: "steer" },
		];
		const receiver = createRestoreReceiver({
			clearQueue: () => Promise.reject(new Error("session persistence is closed")),
			compactionQueuedMessages,
		});

		await expect(restoreQueuedMessagesToEditor.call(receiver, { abortSource: "host_action" })).rejects.toThrow(
			"session persistence is closed",
		);

		// Nothing was revoked, so nothing needs recovering and the queue stays put.
		expect(receiver.editor.setText).not.toHaveBeenCalled();
		expect(receiver.compactionQueuedMessages).toEqual(compactionQueuedMessages);
		expect(receiver.agent.abort).toHaveBeenCalledWith("host_action");
	});

	test("restores both queues to the editor on the success path", async () => {
		const receiver = createRestoreReceiver({
			clearQueue: async () => ({ steering: ["steered draft"], followUp: ["follow-up draft"] }),
			compactionQueuedMessages: [{ text: "queued for after compaction", mode: "followUp" }],
			editorText: "in-progress draft",
		});

		await expect(restoreQueuedMessagesToEditor.call(receiver)).resolves.toBe(3);

		expect(receiver.editor.setText).toHaveBeenCalledWith(
			"steered draft\n\nfollow-up draft\n\nqueued for after compaction\n\nin-progress draft",
		);
		expect(receiver.compactionQueuedMessages).toEqual([]);
		expect(receiver.agent.abort).not.toHaveBeenCalled();
	});

	test("reports the cancellation failure from the dequeue key after restoring the text", async () => {
		const receiver = {
			restoreQueuedMessagesToEditor: vi.fn(() =>
				Promise.reject(
					new QueueClearPersistenceError(new Error("ENOSPC: no space left on device"), {
						steering: ["steered draft"],
						followUp: [],
					}),
				),
			),
			showError: vi.fn(),
			showStatus: vi.fn(),
		};
		const handleDequeue = Reflect.get(InteractiveMode.prototype, "handleDequeue") as (
			this: typeof receiver,
		) => Promise<void>;

		await expect(handleDequeue.call(receiver)).resolves.toBeUndefined();

		expect(receiver.showError).toHaveBeenCalledWith(
			"Failed to persist queued-message cancellation: ENOSPC: no space left on device",
		);
		expect(receiver.showStatus).not.toHaveBeenCalled();
	});

	test("reports a rejected keybinding action instead of leaking an unhandled rejection", async () => {
		const receiver = { showError: vi.fn() };
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			runKeyAction.call(receiver, async () => {
				throw new Error("Session persistence is fail-stopped after an uncertain write");
			});
			// Two macrotask turns: Node reports an unhandled rejection only after the
			// microtask queue drains without a handler being attached.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			process.off("unhandledRejection", unhandled);
		}

		expect(unhandled).not.toHaveBeenCalled();
		expect(receiver.showError).toHaveBeenCalledWith("Session persistence is fail-stopped after an uncertain write");
	});
});
