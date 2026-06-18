import { describe, expect, test, vi } from "vitest";
import type { ExtensionBindings } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createLoopbackRpcTransportPair, type RpcExtensionUIRequest } from "../src/core/rpc/index.ts";
import { createInProcessRpcClient } from "../src/modes/rpc/in-process-rpc-client.ts";
import { createIrohRemoteCloseDeferringRpcTransport } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { RpcTransportClient } from "../src/modes/rpc/rpc-transport-client.ts";

describe("loopback RPC transport", () => {
	test("buffers writes until a peer line handler attaches and preserves JSON string separators", () => {
		const pair = createLoopbackRpcTransportPair();
		const receivedLines: string[] = [];

		pair.client.write({ text: "a\u2028b\u2029c" });
		pair.server.onLine((line) => {
			receivedLines.push(line);
		});

		expect(receivedLines).toEqual([JSON.stringify({ text: "a\u2028b\u2029c" })]);
	});

	test("closing one endpoint notifies the peer input", () => {
		const pair = createLoopbackRpcTransportPair();
		const closeHandler = vi.fn();
		pair.server.onClose?.(closeHandler);

		pair.client.close();

		expect(closeHandler).toHaveBeenCalledOnce();
	});
});

describe("RpcTransportClient", () => {
	test("sends typed commands and receives non-response events over a transport", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		const events: Array<{ type: string }> = [];
		client.onEvent((event) => {
			events.push(event);
		});
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: { commands: [] },
			});
			pair.server.write({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "hello" });
		});

		await client.start();

		await expect(client.getCommands()).resolves.toEqual([]);
		expect(events).toEqual([{ type: "extension_ui_request", id: "ui-1", method: "notify", message: "hello" }]);

		await client.stop();
	});

	test("rejects unsuccessful responses for void commands", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: "Session name cannot be empty",
			});
		});

		await client.start();
		try {
			await expect(client.setSessionName("")).rejects.toThrow("Session name cannot be empty");
		} finally {
			await client.stop();
		}
	});

	test("promptAndWait rejects unsuccessful prompt responses", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: "prompt preflight failed",
			});
		});

		await client.start();
		try {
			await expect(client.promptAndWait("hi", undefined, 50)).rejects.toThrow("prompt preflight failed");
		} finally {
			await client.stop();
		}
	});

	test("promptAndWait waits for prompt response before resolving on agent_end", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({ type: "agent_end" });
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: "prompt preflight failed",
			});
		});

		await client.start();
		try {
			await expect(client.promptAndWait("hi", undefined, 50)).rejects.toThrow("prompt preflight failed");
		} finally {
			await client.stop();
		}
	});

	test("promptAndWait resolves when a successful prompt response follows agent_end", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		let command: { id: string; type: string } | undefined;
		pair.server.onLine((line) => {
			command = parseCommandLine(line);
			pair.server.write({ type: "agent_end" });
		});

		await client.start();
		try {
			let resolved = false;
			const eventsPromise = client.promptAndWait("/extension-command", undefined, 100).then((events) => {
				resolved = true;
				return events;
			});

			await Promise.resolve();
			expect(resolved).toBe(false);

			const acceptedCommand = command;
			if (!acceptedCommand) {
				throw new Error("prompt command was not sent");
			}
			pair.server.write({
				id: acceptedCommand.id,
				type: "response",
				command: acceptedCommand.type,
				success: true,
			});
			await expect(eventsPromise).resolves.toEqual([{ type: "agent_end" }]);
		} finally {
			await client.stop();
		}
	});

	test("rejects in-flight requests when the transport closes", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		await client.start();

		const statePromise = client.getState();
		pair.server.close();

		await expect(statePromise).rejects.toThrow("RPC transport closed");
	});
});

describe("runRpcMode", () => {
	test("aborts startup extension UI waits when the transport closes", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const startupRequest = new Promise<Extract<RpcExtensionUIRequest, { method: "confirm" }>>((resolve) => {
			pair.client.onLine((line) => {
				const event = JSON.parse(line) as RpcExtensionUIRequest;
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					resolve(event);
				}
			});
		});
		const runtimeHost = createRuntimeHost(dispose, async (bindings) => {
			const uiContext = bindings.uiContext;
			if (!uiContext) {
				throw new Error("UI context was not bound");
			}
			await uiContext.confirm("Startup", "Continue?");
		});
		const modePromise = runRpcMode(runtimeHost, { transport: pair.server, exitProcess: false });
		void modePromise.catch(() => {});

		await startupRequest;
		pair.client.close();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("does not defer startup closes behind queued Iroh commands", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const startupRequest = new Promise<Extract<RpcExtensionUIRequest, { method: "confirm" }>>((resolve) => {
			pair.client.onLine((line) => {
				const event = JSON.parse(line) as RpcExtensionUIRequest;
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					resolve(event);
				}
			});
		});
		const runtimeHost = createRuntimeHost(dispose, async (bindings) => {
			const uiContext = bindings.uiContext;
			if (!uiContext) {
				throw new Error("UI context was not bound");
			}
			await uiContext.confirm("Startup", "Continue?");
		});
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: pair.server,
			waitForPromptCompletion: () => Promise.resolve(),
		});
		const modePromise = runRpcMode(runtimeHost, { transport, exitProcess: false });
		void modePromise.catch(() => {});

		await startupRequest;
		pair.client.write({ id: "queued-state", type: "get_state" });
		pair.client.close();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(dispose).toHaveBeenCalledOnce();
	});
});

describe("createInProcessRpcClient", () => {
	test("runs RPC mode against a runtime in the same process", async () => {
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose);
		const client = await createInProcessRpcClient(runtimeHost);

		await expect(client.getState()).resolves.toMatchObject({
			thinkingLevel: "off",
			isStreaming: false,
			sessionId: "in-process-session",
			messageCount: 0,
		});

		await client.stop();
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("sends extension UI responses from in-process clients", async () => {
		let uiContext: ExtensionBindings["uiContext"];
		const runtimeHost = createRuntimeHost(
			vi.fn(async () => {}),
			async (bindings) => {
				uiContext = bindings.uiContext;
			},
		);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const boundUiContext = uiContext;
			if (!boundUiContext) {
				throw new Error("UI context was not bound");
			}

			let unsubscribe = () => {};
			const requestPromise = new Promise<Extract<RpcExtensionUIRequest, { method: "confirm" }>>((resolve) => {
				unsubscribe = client.onEvent((event) => {
					if (event.type === "extension_ui_request" && event.method === "confirm") {
						unsubscribe();
						resolve(event);
					}
				});
			});
			const confirmPromise = boundUiContext.confirm("Approve", "Continue?");
			const request = await requestPromise;

			await client.sendExtensionUIResponse({
				type: "extension_ui_response",
				id: request.id,
				confirmed: true,
			});

			await expect(confirmPromise).resolves.toBe(true);
		} finally {
			await client.stop();
		}
	});

	test("handles extension UI requests emitted while binding startup extensions", async () => {
		const responsePromises: Promise<void>[] = [];
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async (bindings) => {
			const uiContext = bindings.uiContext;
			if (!uiContext) {
				throw new Error("UI context was not bound");
			}
			const confirmed = await uiContext.confirm("Startup", "Continue?", { timeout: 250 });
			if (!confirmed) {
				throw new Error("startup UI was not confirmed");
			}
		});

		const client = await createInProcessRpcClient(runtimeHost, {
			onEvent(event, pendingClient) {
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					const responsePromise = pendingClient.sendExtensionUIResponse({
						type: "extension_ui_response",
						id: event.id,
						confirmed: true,
					});
					responsePromises.push(responsePromise);
					void responsePromise.catch(() => {});
				}
			},
		});

		try {
			await expect(Promise.all(responsePromises)).resolves.toEqual([undefined]);
			await expect(client.getState()).resolves.toMatchObject({ sessionId: "in-process-session" });
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("rejects with the startup error when RPC mode cannot bind extensions", async () => {
		const bindError = new Error("bind failed");
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {
			throw bindError;
		});

		await expect(createInProcessRpcClient(runtimeHost)).rejects.toBe(bindError);
		expect(dispose).toHaveBeenCalledOnce();
	});
});

function parseCommandLine(line: string): { id: string; type: string } {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("command must be an object");
	}
	const command = parsed as Record<string, unknown>;
	if (typeof command.id !== "string" || typeof command.type !== "string") {
		throw new Error("command must include id and type");
	}
	return { id: command.id, type: command.type };
}

function createRuntimeHost(
	dispose: () => Promise<void>,
	bindExtensions: (bindings: ExtensionBindings) => Promise<void> = async () => {},
): AgentSessionRuntime {
	return {
		session: {
			bindExtensions: vi.fn(bindExtensions),
			subscribe: vi.fn(() => () => {}),
			agent: {
				subscribe: vi.fn(() => () => {}),
			},
			model: undefined,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionFile: undefined,
			sessionId: "in-process-session",
			sessionName: undefined,
			autoCompactionEnabled: true,
			messages: [],
			pendingMessageCount: 0,
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose,
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}
