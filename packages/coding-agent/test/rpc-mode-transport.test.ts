import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
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

describe("RPC mode caller-provided transports", () => {
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
});
