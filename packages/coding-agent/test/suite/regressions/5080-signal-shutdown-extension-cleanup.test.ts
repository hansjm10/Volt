import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import type { SessionManager, SessionReference } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/earendil-works/pi/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (runtimeHost.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

type ShutdownThis = {
	isShuttingDown: boolean;
	flushStdout: () => Promise<void>;
	unregisterSignalHandlers: () => void;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	stop: () => void;
	settingsManager: { rememberActiveProfile: () => void; flush: () => Promise<void> };
	sessionManager: SessionManager;
	releaseDaemonLeaseOnQuit: () => Promise<void>;
	closeLspTrace: () => Promise<void>;
	cleanupAllScratchDirectories: () => void;
};

type InteractiveModePrototypeWithShutdown = {
	flushStdout(this: ShutdownThis): Promise<void>;
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {}

const TEST_SESSION_REF: SessionReference = {
	sessionDirectory: "/tmp/volt-sessions",
	storeId: "test-store",
	sessionGeneration: "generation-test",
	sessionId: "test-session",
};

function createSessionManager(options: { sessionRef?: SessionReference } = {}): SessionManager {
	return {
		isPersisted: () => options.sessionRef !== undefined,
		getSessionRef: () => options.sessionRef,
		getSessionId: () => options.sessionRef?.sessionId ?? "test-session",
		getSessionDir: () => options.sessionRef?.sessionDirectory ?? "/tmp/volt-sessions",
		usesDefaultSessionDir: () => true,
	} as unknown as SessionManager;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionManager = createSessionManager()): ShutdownThis {
	return {
		isShuttingDown: false,
		flushStdout: (interactiveModePrototype as InteractiveModePrototypeWithShutdown).flushStdout,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		stop: vi.fn(() => {
			order.push("stop");
		}),
		settingsManager: {
			rememberActiveProfile: vi.fn(),
			flush: vi.fn(async () => {}),
		},
		sessionManager,
		releaseDaemonLeaseOnQuit: vi.fn(async () => {}),
		closeLspTrace: vi.fn(async () => {}),
		cleanupAllScratchDirectories: vi.fn(),
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

function getStdoutWriteCallback(args: readonly unknown[]): ((error?: Error | null) => void) | undefined {
	for (let index = args.length - 1; index >= 0; index--) {
		const value = args[index];
		if (typeof value === "function") return value as (error?: Error | null) => void;
	}
	return undefined;
}

function completeStdoutWrite(...args: unknown[]): boolean {
	getStdoutWriteCallback(args)?.();
	return true;
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
	});

	test("signal-triggered shutdown waits for stdout to flush before force-exiting", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const initialErrorListenerCount = process.stdout.listenerCount("error");
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
			const callback = getStdoutWriteCallback(args);
			if (args[0] === "") {
				completeFlush = () => callback?.();
				return false;
			}
			callback?.();
			return true;
		}) as typeof process.stdout.write);
		const context = createContext([]);

		const shutdown = callShutdown(context, { fromSignal: true });
		await vi.waitFor(() => expect(completeFlush).toBeTypeOf("function"));
		expect(exit).not.toHaveBeenCalled();

		completeFlush?.();
		await shutdown;
		expect(exit).toHaveBeenCalledWith(0);
		expect(process.stdout.listenerCount("error")).toBe(initialErrorListenerCount);
	});

	test("signal-triggered shutdown bounds a stalled stdout flush", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const initialErrorListenerCount = process.stdout.listenerCount("error");
		const initialTimerCount = vi.getTimerCount();
		let flushStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			flushStarted = resolve;
		});
		vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
			if (args[0] === "") {
				flushStarted?.();
				return false;
			}
			getStdoutWriteCallback(args)?.();
			return true;
		}) as typeof process.stdout.write);
		const context = createContext([]);

		const shutdown = callShutdown(context, { fromSignal: true });
		await started;
		expect(exit).not.toHaveBeenCalled();
		expect(process.stdout.listenerCount("error")).toBe(initialErrorListenerCount + 1);

		await vi.advanceTimersByTimeAsync(999);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await shutdown;

		expect(exit).toHaveBeenCalledWith(0);
		expect(process.stdout.listenerCount("error")).toBe(initialErrorListenerCount);
		expect(vi.getTimerCount()).toBe(initialTimerCount);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(completeStdoutWrite as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionRef: TEST_SESSION_REF }));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(stdoutWrite).toHaveBeenCalledWith(
			`${chalk.dim("To resume this session:")} ${APP_NAME} --session test-session\n`,
		);
	});

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(completeStdoutWrite as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionRef: TEST_SESSION_REF }));

		await callShutdown(context, { fromSignal: true });

		for (const call of stdoutWrite.mock.calls) {
			expect(call[0]).not.toContain("To resume this session:");
		}
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});
});
