import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { isStdoutTakenOver, restoreStdout } from "../src/core/output-guard.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

function createRuntimeHost(): { runtimeHost: AgentSessionRuntime; dispose: ReturnType<typeof vi.fn> } {
	const dispose = vi.fn(async () => {});
	const runtimeHost = {
		session: {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			agent: {
				subscribe: vi.fn(() => () => {}),
			},
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose,
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return { runtimeHost, dispose };
}

afterEach(() => {
	restoreStdout();
});

describe("RPC mode caller-provided transports", () => {
	test("rejects and closes when a command response write rejects", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "write-failure", type: "unknown_command" }));

		await expect(modePromise).rejects.toBe(writeError);
		expect(transport.write).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("close without exiting the embedding process", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { runtimeHost, dispose } = createRuntimeHost();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: string | number | null | undefined) => {
			throw new Error("process.exit called");
		}) as typeof process.exit);

		try {
			const modePromise = runRpcMode(runtimeHost, { transport });
			await vi.waitFor(() => expect(closeHandler).toBeDefined());

			closeHandler?.();

			await expect(modePromise).resolves.toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalled();
			expect(dispose).toHaveBeenCalledOnce();
			expect(detachInput).toHaveBeenCalledOnce();
			expect(detachClose).toHaveBeenCalledOnce();
			expect(transportClose).toHaveBeenCalledOnce();
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("closes the transport when shutdown flushing fails", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const flushError = new Error("flush failed");
		const transportClose = vi.fn(async () => {});
		const transportFlush = vi.fn(async () => {
			throw flushError;
		});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => () => {}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return () => {};
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: transportFlush,
			close: transportClose,
		};
		const { runtimeHost } = createRuntimeHost();

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(closeHandler).toBeDefined());

		closeHandler?.();

		await expect(modePromise).rejects.toThrow(flushError);
		expect(transportFlush).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});
});

describe("RPC mode stdio transport", () => {
	test("restores stdout when non-exiting stdio mode closes", async () => {
		const initialEndListenerCount = process.stdin.listenerCount("end");
		const { runtimeHost } = createRuntimeHost();

		const modePromise = runRpcMode(runtimeHost, { exitProcess: false });
		await vi.waitFor(() => {
			expect(process.stdin.listenerCount("end")).toBeGreaterThan(initialEndListenerCount);
		});
		expect(isStdoutTakenOver()).toBe(true);

		process.stdin.emit("end");

		await expect(modePromise).resolves.toBeUndefined();
		expect(isStdoutTakenOver()).toBe(false);
	});
});
