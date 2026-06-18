import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
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

	test("rejects and closes when a fire-and-forget prompt response write rejects", async () => {
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
		Object.assign(runtimeHost.session, {
			prompt: vi.fn((_message: string, options: { preflightResult?: (didSucceed: boolean) => void }) => {
				options.preflightResult?.(true);
				return Promise.resolve();
			}),
		});

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "prompt-write-failure", type: "prompt", message: "hello" }));

		await expect(modePromise).rejects.toBe(writeError);
		expect(transport.write).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("agent backpressure subscriber handles write failures by shutting down", async () => {
		let sessionEventHandler: ((event: object) => void) | undefined;
		let backpressureHandler: (() => Promise<void> | void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async () => {}),
				subscribe: vi.fn((handler: (event: object) => void) => {
					sessionEventHandler = handler;
					return detachSession;
				}),
				agent: {
					subscribe: vi.fn((handler: () => Promise<void> | void) => {
						backpressureHandler = handler;
						return detachBackpressure;
					}),
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(sessionEventHandler).toBeDefined());
		await vi.waitFor(() => expect(backpressureHandler).toBeDefined());

		sessionEventHandler?.({ type: "agent_event" });

		await expect(Promise.resolve(backpressureHandler?.())).resolves.toBeUndefined();
		await expect(modePromise).rejects.toBe(writeError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(detachSession).toHaveBeenCalledOnce();
		expect(detachBackpressure).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("does not subscribe after startup close interrupts extension binding", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		let resolveBindExtensions: (() => void) | undefined;
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
		const subscribe = vi.fn(() => () => {});
		const agentSubscribe = vi.fn(() => () => {});
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							resolveBindExtensions = resolve;
						}),
				),
				subscribe,
				agent: {
					subscribe: agentSubscribe,
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => {
			expect(closeHandler).toBeDefined();
			expect(runtimeHost.session.bindExtensions).toHaveBeenCalledOnce();
		});

		closeHandler?.();
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
		expect(resolveBindExtensions).toBeDefined();
		resolveBindExtensions?.();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(subscribe).not.toHaveBeenCalled();
		expect(agentSubscribe).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("startup cleanup treats extension shutdown UI requests as cancelled", async () => {
		let uiContext: ExtensionUIContext | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const startupError = new Error("bind failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {
			if (!uiContext) {
				throw new Error("missing extension UI context");
			}
			const confirmed = await uiContext.confirm("Shutdown", "Continue?");
			expect(confirmed).toBe(false);
		});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async (options: { uiContext: ExtensionUIContext }) => {
					uiContext = options.uiContext;
					throw startupError;
				}),
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

		await expect(runRpcMode(runtimeHost, { transport })).rejects.toBe(startupError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(transport.write).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("cleans up when onReady throws", async () => {
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const readyError = new Error("ready failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: {
				bindExtensions: vi.fn(async () => {}),
				subscribe: vi.fn(() => detachSession),
				agent: {
					subscribe: vi.fn(() => detachBackpressure),
				},
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const modePromise = runRpcMode(runtimeHost, {
			transport,
			onReady: () => {
				throw readyError;
			},
		});

		await expect(modePromise).rejects.toBe(readyError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(detachSession).toHaveBeenCalledOnce();
		expect(detachBackpressure).toHaveBeenCalledOnce();
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
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(runtimeHost, {
				transport,
				onReady: () => {
					resolveReady();
				},
			});
			await ready;
			expect(closeHandler).toBeDefined();

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

	test("rejects and closes when the input transport closes with an error", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const inputError = new Error("input failed");
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

		const modePromise = runRpcMode(runtimeHost, { transport });
		await vi.waitFor(() => expect(closeHandler).toBeDefined());

		closeHandler?.(inputError);

		await expect(modePromise).rejects.toBe(inputError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
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
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			transport,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(closeHandler).toBeDefined();

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
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(runtimeHost, {
			exitProcess: false,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(process.stdin.listenerCount("end")).toBeGreaterThan(initialEndListenerCount);
		expect(isStdoutTakenOver()).toBe(true);

		process.stdin.emit("end");

		await expect(modePromise).resolves.toBeUndefined();
		expect(isStdoutTakenOver()).toBe(false);
	});
});
