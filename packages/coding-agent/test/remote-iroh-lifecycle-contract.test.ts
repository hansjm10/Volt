import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	getIrohRemoteRpcFilterResult,
	IROH_REMOTE_RPC_CANCELLATION_TYPES,
	IROH_REMOTE_RPC_PASSTHROUGH_TYPES,
} from "../src/core/remote/iroh/index.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "../src/core/rpc/index.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createIrohRemoteCloseDeferringRpcTransport } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

class ManualRpcTransport implements RpcTransport {
	readonly writes: object[] = [];
	readonly lineHandlers = new Set<RpcLineHandler>();
	readonly closeHandlers = new Set<RpcCloseHandler>();
	writeFailure: Error | undefined;

	write(value: object): void {
		if (this.writeFailure) {
			throw this.writeFailure;
		}
		this.writes.push(value);
	}

	onLine(handler: RpcLineHandler): () => void {
		this.lineHandlers.add(handler);
		return () => {
			this.lineHandlers.delete(handler);
		};
	}

	onClose(handler: RpcCloseHandler): () => void {
		this.closeHandlers.add(handler);
		return () => {
			this.closeHandlers.delete(handler);
		};
	}

	close(): void {}

	emitLine(line: string): void {
		for (const handler of this.lineHandlers) {
			handler(line);
		}
	}

	emitClose(error?: Error): void {
		for (const handler of this.closeHandlers) {
			handler(error);
		}
	}
}

function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
	let resolve = () => {};
	let reject = (_error: unknown) => {};
	const promise = new Promise<void>((innerResolve, innerReject) => {
		resolve = innerResolve;
		reject = innerReject;
	});
	return { promise, resolve, reject };
}

interface PromptRuntimeAbortControls {
	completePrompt(): void;
	promptCompleted: Promise<void>;
}

interface PromptRuntimeOptions {
	abort?: (controls: PromptRuntimeAbortControls) => Promise<void>;
	stopReason?: "stop" | "aborted";
}

function createPromptRuntime(
	sessionManager: SessionManager,
	completionText: string,
	options: PromptRuntimeOptions = {},
) {
	const promptRelease = createDeferred();
	const promptCompleted = createDeferred();
	const abort = vi.fn(async () => {
		await options.abort?.({
			completePrompt: promptRelease.resolve,
			promptCompleted: promptCompleted.promise,
		});
	});
	const dispose = vi.fn(async () => {
		await abort();
	});
	let sessionEventHandler: ((event: object) => void) | undefined;
	const detachSession = vi.fn();
	const detachBackpressure = vi.fn();
	const runtimeHost = {
		session: {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn((handler: (event: object) => void) => {
				sessionEventHandler = handler;
				return detachSession;
			}),
			agent: {
				subscribe: vi.fn(() => detachBackpressure),
			},
			sessionId: sessionManager.getSessionId(),
			sessionManager,
			prompt: vi.fn(
				async (
					_message: string,
					promptOptions?: { preflightResult?: (didSucceed: boolean) => void },
				): Promise<void> => {
					promptOptions?.preflightResult?.(true);
					await promptRelease.promise;
					sessionManager.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: completionText }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: options.stopReason ?? "stop",
						timestamp: Date.now(),
					});
					promptCompleted.resolve();
				},
			),
			abort,
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose,
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		abort,
		dispose,
		emitSessionEvent(event: object): void {
			if (!sessionEventHandler) {
				throw new Error("RPC mode did not subscribe to session events");
			}
			sessionEventHandler(event);
		},
		promptCompleted: promptCompleted.promise,
		promptRelease,
		runtimeHost,
	};
}

describe("Iroh remote lifecycle command contract", () => {
	test("allows abort as the only direct remote cancellation command", () => {
		expect(Array.from(IROH_REMOTE_RPC_CANCELLATION_TYPES)).toEqual(["abort"]);
		expect(IROH_REMOTE_RPC_PASSTHROUGH_TYPES.has("abort")).toBe(true);

		expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: "abort-1", type: "abort" }))).toEqual({
			allowed: true,
			command: { id: "abort-1", type: "abort" },
		});

		for (const command of ["cancel", "cancel_run", "detach", "disconnect", "stop"] as const) {
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${command}-1`, type: command }))).toEqual({
				allowed: false,
				response: {
					id: `${command}-1`,
					type: "response",
					command,
					success: false,
					error: `RPC command not allowed over remote host: ${command}`,
				},
			});
		}
	});

	test("clean transport close is not translated into an abort command", async () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => Promise.resolve(),
		});
		const forwardedLines: string[] = [];
		const closeErrors: Array<Error | undefined> = [];
		transport.onLine((line) => {
			forwardedLines.push(line);
		});
		const onClose = transport.onClose;
		if (!onClose) {
			throw new Error("Expected Iroh remote close-deferring transport to expose onClose");
		}
		const closeReceived = new Promise<void>((resolve) => {
			onClose((error) => {
				closeErrors.push(error);
				resolve();
			});
		});

		inner.emitClose();
		await closeReceived;

		expect(forwardedLines).toEqual([]);
		expect(inner.writes).toEqual([]);
		expect(closeErrors).toEqual([undefined]);
	});

	test("accepted prompts continue after clean transport close without disposing the runtime", async () => {
		const inner = new ManualRpcTransport();
		const sessionManager = SessionManager.inMemory("/workspace");
		const runtime = createPromptRuntime(sessionManager, "detached completion");
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => runtime.promptCompleted,
		});
		let resolveReady = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runRpcMode(runtime.runtimeHost, {
			disposeRuntimeOnClose: false,
			onReady: resolveReady,
			transport,
		});
		let modeSettled = false;
		void modePromise.then(
			() => {
				modeSettled = true;
			},
			() => {
				modeSettled = true;
			},
		);
		await ready;

		inner.emitLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "keep running" }));
		await vi.waitFor(() =>
			expect(inner.writes).toContainEqual({
				id: "prompt-1",
				type: "response",
				command: "prompt",
				success: true,
			}),
		);

		inner.emitClose();
		await Promise.resolve();
		await Promise.resolve();
		expect(modeSettled).toBe(false);

		runtime.promptRelease.resolve();
		await expect(modePromise).resolves.toBeUndefined();

		expect(runtime.dispose).not.toHaveBeenCalled();
		expect(runtime.abort).not.toHaveBeenCalled();
		expect(projectSessionTranscript(sessionManager, { limit: 10 }).items).toContainEqual(
			expect.objectContaining({ role: "assistant", text: "detached completion" }),
		);
	});

	test("write failure while an accepted prompt is active detaches without disposing the runtime", async () => {
		const inner = new ManualRpcTransport();
		const sessionManager = SessionManager.inMemory("/workspace");
		const runtime = createPromptRuntime(sessionManager, "write failure detached completion");
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => runtime.promptCompleted,
		});
		let resolveReady = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runRpcMode(runtime.runtimeHost, {
			disposeRuntimeOnClose: false,
			onReady: resolveReady,
			transport,
		});
		await ready;

		inner.emitLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "keep running" }));
		await vi.waitFor(() =>
			expect(inner.writes).toContainEqual({
				id: "prompt-1",
				type: "response",
				command: "prompt",
				success: true,
			}),
		);

		const writeError = new Error("remote write side closed");
		inner.writeFailure = writeError;
		runtime.emitSessionEvent({ type: "agent_event" });

		await expect(modePromise).rejects.toBe(writeError);
		expect(runtime.dispose).not.toHaveBeenCalled();
		expect(runtime.abort).not.toHaveBeenCalled();

		runtime.promptRelease.resolve();
		await runtime.promptCompleted;
		expect(projectSessionTranscript(sessionManager, { limit: 10 }).items).toContainEqual(
			expect.objectContaining({ role: "assistant", text: "write failure detached completion" }),
		);
	});

	test("explicit remote abort cancels an active prompt and waits for abort settlement", async () => {
		const inner = new ManualRpcTransport();
		const sessionManager = SessionManager.inMemory("/workspace");
		const abortCanFinish = createDeferred();
		const runtime = createPromptRuntime(sessionManager, "explicit abort completed", {
			stopReason: "aborted",
			async abort({ completePrompt, promptCompleted }) {
				completePrompt();
				await promptCompleted;
				await abortCanFinish.promise;
			},
		});
		const transport = createIrohRemoteFilteredRpcTransport({
			transport: createIrohRemoteCloseDeferringRpcTransport({
				transport: inner,
				waitForPromptCompletion: () => runtime.promptCompleted,
			}),
		});
		let resolveReady = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runRpcMode(runtime.runtimeHost, {
			disposeRuntimeOnClose: false,
			onReady: resolveReady,
			transport,
		});
		await ready;

		inner.emitLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "keep running" }));
		await vi.waitFor(() =>
			expect(inner.writes).toContainEqual({
				id: "prompt-1",
				type: "response",
				command: "prompt",
				success: true,
			}),
		);

		inner.emitLine(JSON.stringify({ id: "abort-1", type: "abort" }));
		await vi.waitFor(() => expect(runtime.abort).toHaveBeenCalledOnce());
		await Promise.resolve();
		expect(inner.writes).not.toContainEqual({
			id: "abort-1",
			type: "response",
			command: "abort",
			success: true,
		});

		abortCanFinish.resolve();
		await vi.waitFor(() =>
			expect(inner.writes).toContainEqual({
				id: "abort-1",
				type: "response",
				command: "abort",
				success: true,
			}),
		);
		expect(projectSessionTranscript(sessionManager, { limit: 10 }).items).toContainEqual(
			expect.objectContaining({ role: "assistant", text: "explicit abort completed" }),
		);

		inner.emitClose();
		await expect(modePromise).resolves.toBeUndefined();
		expect(runtime.dispose).not.toHaveBeenCalled();
	});
});
