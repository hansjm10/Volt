import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getIrohRemoteRpcFilterResult } from "../src/core/remote/iroh/index.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import type { RpcSessionState, RpcTranscriptResponse } from "../src/core/rpc/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { SubagentDefinition, SubagentEvent, SubagentHandle, SubagentResult } from "../src/core/subagents/index.ts";
import type { SubagentToolManager } from "../src/core/tools/index.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

interface RpcHarness {
	close(): void;
	modePromise: Promise<void>;
	send(message: object): void;
	writes: object[];
}

interface ControlledSubagent {
	handle: SubagentHandle;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	emit(event: SubagentEvent): void;
	complete(result?: SubagentResult): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function createDefinition(name: string, filePath: string): SubagentDefinition {
	return {
		name,
		description: `${name} description`,
		tools: ["read", "grep"],
		model: "faux/model",
		thinking: "off",
		systemPrompt: `${name} secret system prompt`,
		source: "project",
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "local",
			scope: "project",
			baseDir: join(filePath, ".."),
		}),
		filePath,
	};
}

function createState(sessionId: string): RpcSessionState {
	return {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionId,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
}

function createTranscript(sessionId: string): RpcTranscriptResponse {
	return {
		sessionId,
		items: [
			{
				id: `${sessionId}-user`,
				role: "user",
				text: `prompt for ${sessionId}`,
				timestamp: new Date(0).toISOString(),
			},
		],
		hasMore: false,
		nextBeforeEntryId: null,
	};
}

function createResult(subagentId: string, sessionId: string): SubagentResult {
	return {
		id: subagentId,
		sessionId,
		event: { type: "agent_end", messages: [], willRetry: false },
	};
}

function createControlledSubagent(subagentId: string, sessionId: string): ControlledSubagent {
	const listeners = new Set<(event: SubagentEvent) => void>();
	const completion = createDeferred<SubagentResult>();
	const prompt = vi.fn(async () => undefined);
	const abort = vi.fn(async () => undefined);
	const dispose = vi.fn(async () => undefined);
	return {
		handle: {
			id: subagentId,
			sessionId,
			prompt,
			abort,
			getState: async () => createState(sessionId),
			getTranscript: async () => createTranscript(sessionId),
			getSessionStats: async () => {
				throw new Error("not used");
			},
			waitForEnd: async () => completion.promise,
			dispose,
			onEvent: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		abort,
		dispose,
		prompt,
		emit(event) {
			for (const listener of listeners) {
				listener(event);
			}
		},
		complete(result = createResult(subagentId, sessionId)) {
			completion.resolve(result);
		},
	};
}

function createSession(options: {
	definitions: SubagentDefinition[];
	manager: SubagentToolManager;
	sessionId?: string;
}) {
	return {
		bindExtensions: vi.fn(async () => undefined),
		subscribe: vi.fn(() => () => undefined),
		agent: {
			state: { pendingToolExecutions: new Map() },
			subscribe: vi.fn(() => () => undefined),
		},
		resourceLoader: {
			getSubagents: () => ({ definitions: options.definitions, diagnostics: [] }),
		},
		getSubagentToolManager: () => options.manager,
		getActiveToolNames: () => ["read"],
		sessionId: options.sessionId ?? "parent-session",
		sessionFile: undefined,
	};
}

function createRuntimeHost(options: {
	definitions: SubagentDefinition[];
	manager: SubagentToolManager;
	onNewSession?: () => void;
}): AgentSessionRuntime {
	let session = createSession({ definitions: options.definitions, manager: options.manager });
	return {
		get session() {
			return session;
		},
		newSession: vi.fn(async () => {
			options.onNewSession?.();
			session = createSession({
				definitions: options.definitions,
				manager: options.manager,
				sessionId: "new-parent-session",
			});
			return { cancelled: false };
		}),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		switchSessionById: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => undefined),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

async function startHarness(runtimeHost: AgentSessionRuntime): Promise<RpcHarness> {
	let lineHandler: ((line: string) => void) | undefined;
	let closeHandler: RpcCloseHandler | undefined;
	const writes: object[] = [];
	const transport: RpcTransport = {
		write: vi.fn((value) => {
			writes.push(value);
		}),
		onLine: vi.fn((handler) => {
			lineHandler = handler;
			return vi.fn();
		}),
		onClose: vi.fn((handler) => {
			closeHandler = handler;
			return vi.fn();
		}),
		waitForBackpressure: vi.fn(async () => undefined),
		flush: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
	let resolveReady: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const modePromise = runRpcMode(runtimeHost, { transport, onReady: resolveReady });
	await ready;
	await vi.waitFor(() => expect(lineHandler).toBeDefined());
	return {
		close() {
			closeHandler?.();
		},
		modePromise,
		send(message: object) {
			if (!lineHandler) {
				throw new Error("RPC line handler was not registered");
			}
			lineHandler(JSON.stringify(message));
		},
		writes,
	};
}

describe("local RPC subagent lifecycle commands", () => {
	test("list_subagents returns safe discovered definition summaries", async () => {
		const filePath = join(tmpdir(), "unsafe-project", ".volt", "agents", "scout.md");
		const manager = {
			getDefinition: () => createDefinition("scout", filePath),
			startByName: async () => createControlledSubagent("sa_unused", "child-unused").handle,
		} satisfies SubagentToolManager;
		const rpc = await startHarness(
			createRuntimeHost({ definitions: [createDefinition("scout", filePath)], manager }),
		);
		try {
			rpc.send({ id: "list-1", type: "list_subagents" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "list-1",
					type: "response",
					command: "list_subagents",
					success: true,
					data: {
						subagents: [
							{
								name: "scout",
								description: "scout description",
								source: "project",
								sourceInfo: { source: "local", scope: "project", origin: "top-level" },
								tools: ["read", "grep"],
								model: "faux/model",
								thinking: "off",
							},
						],
					},
				}),
			);
			const serialized = JSON.stringify(rpc.writes.find((write) => (write as { id?: string }).id === "list-1"));
			expect(serialized).not.toContain(filePath);
			expect(serialized).not.toContain("secret system prompt");
			expect(serialized).not.toContain("baseDir");
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => undefined);
		}
	});

	test("subagent_start returns ids and streams wrapped child events and terminal completion", async () => {
		const child = createControlledSubagent("sa_child", "child-session");
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => child.handle),
		} satisfies SubagentToolManager;
		const rpc = await startHarness(createRuntimeHost({ definitions: [], manager }));
		try {
			rpc.send({ id: "start-1", type: "subagent_start", agent: "scout", prompt: "inspect auth" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "start-1",
					type: "response",
					command: "subagent_start",
					success: true,
					data: { subagentId: "sa_child", sessionId: "child-session" },
				}),
			);
			expect(manager.startByName).toHaveBeenCalledWith("scout", { allowedTools: ["read"] });
			expect(child.prompt).toHaveBeenCalledWith("inspect auth");

			child.emit({ type: "agent_start" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					type: "subagent_event",
					subagentId: "sa_child",
					event: { type: "agent_start" },
				}),
			);

			const result = createResult("sa_child", "child-session");
			child.complete(result);
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					type: "subagent_end",
					subagentId: "sa_child",
					result,
				}),
			);
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => undefined);
		}
	});

	test("subagent_abort calls through, disposes, and removes the child", async () => {
		const child = createControlledSubagent("sa_abort", "child-abort-session");
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => child.handle),
		} satisfies SubagentToolManager;
		const rpc = await startHarness(createRuntimeHost({ definitions: [], manager }));
		try {
			rpc.send({ id: "start-1", type: "subagent_start", agent: "scout", prompt: "slow" });
			await vi.waitFor(() => expect(child.prompt).toHaveBeenCalledWith("slow"));
			rpc.send({ id: "abort-1", type: "subagent_abort", subagentId: "sa_abort" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "abort-1",
					type: "response",
					command: "subagent_abort",
					success: true,
				}),
			);
			expect(child.abort).toHaveBeenCalledOnce();
			expect(child.dispose).toHaveBeenCalledOnce();

			rpc.send({ id: "state-after-abort", type: "subagent_get_state", subagentId: "sa_abort" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "state-after-abort",
					type: "response",
					command: "subagent_get_state",
					success: false,
					error: "Subagent sa_abort is not active",
				}),
			);
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => undefined);
		}
	});

	test("subagent state and transcript commands route to the selected child", async () => {
		const first = createControlledSubagent("sa_first", "first-session");
		const second = createControlledSubagent("sa_second", "second-session");
		const manager = {
			getDefinition: (agent: string) => createDefinition(agent, `/tmp/${agent}.md`),
			startByName: vi.fn(async (agent: string) => (agent === "first" ? first.handle : second.handle)),
		} satisfies SubagentToolManager;
		const rpc = await startHarness(createRuntimeHost({ definitions: [], manager }));
		try {
			rpc.send({ id: "start-first", type: "subagent_start", agent: "first", prompt: "one" });
			rpc.send({ id: "start-second", type: "subagent_start", agent: "second", prompt: "two" });
			await vi.waitFor(() => expect(second.prompt).toHaveBeenCalledWith("two"));

			rpc.send({ id: "state-second", type: "subagent_get_state", subagentId: "sa_second" });
			rpc.send({
				id: "transcript-second",
				type: "subagent_get_transcript",
				subagentId: "sa_second",
				limit: 5,
				beforeEntryId: "before-entry",
			});

			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "state-second",
					type: "response",
					command: "subagent_get_state",
					success: true,
					data: createState("second-session"),
				}),
			);
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "transcript-second",
					type: "response",
					command: "subagent_get_transcript",
					success: true,
					data: createTranscript("second-session"),
				}),
			);
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => undefined);
		}
	});

	test("subagent_dispose removes the child and later commands fail clearly", async () => {
		const child = createControlledSubagent("sa_dispose", "child-dispose-session");
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => child.handle),
		} satisfies SubagentToolManager;
		const rpc = await startHarness(createRuntimeHost({ definitions: [], manager }));
		try {
			rpc.send({ id: "start-1", type: "subagent_start", agent: "scout", prompt: "work" });
			await vi.waitFor(() => expect(child.prompt).toHaveBeenCalledWith("work"));
			rpc.send({ id: "dispose-1", type: "subagent_dispose", subagentId: "sa_dispose" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "dispose-1",
					type: "response",
					command: "subagent_dispose",
					success: true,
				}),
			);
			expect(child.dispose).toHaveBeenCalledOnce();

			rpc.send({ id: "state-after-dispose", type: "subagent_get_state", subagentId: "sa_dispose" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual({
					id: "state-after-dispose",
					type: "response",
					command: "subagent_get_state",
					success: false,
					error: "Subagent sa_dispose is not active",
				}),
			);
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => undefined);
		}
	});

	test("RPC shutdown and session replacement dispose active RPC-started children", async () => {
		const first = createControlledSubagent("sa_shutdown", "child-shutdown-session");
		const second = createControlledSubagent("sa_replaced", "child-replaced-session");
		let nextHandle = first.handle;
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => nextHandle),
		} satisfies SubagentToolManager;
		const rpc = await startHarness(createRuntimeHost({ definitions: [], manager }));
		try {
			rpc.send({ id: "start-shutdown", type: "subagent_start", agent: "scout", prompt: "keep alive" });
			await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledWith("keep alive"));
			rpc.close();
			await expect(rpc.modePromise).resolves.toBeUndefined();
			expect(first.dispose).toHaveBeenCalledOnce();
		} finally {
			await rpc.modePromise.catch(() => undefined);
		}

		nextHandle = second.handle;
		const replacementRpc = await startHarness(createRuntimeHost({ definitions: [], manager }));
		try {
			replacementRpc.send({ id: "start-replace", type: "subagent_start", agent: "scout", prompt: "replace me" });
			await vi.waitFor(() => expect(second.prompt).toHaveBeenCalledWith("replace me"));
			replacementRpc.send({ id: "new-session", type: "new_session" });
			await vi.waitFor(() =>
				expect(replacementRpc.writes).toContainEqual({
					id: "new-session",
					type: "response",
					command: "new_session",
					success: true,
					data: { cancelled: false },
				}),
			);
			expect(second.dispose).toHaveBeenCalledOnce();
		} finally {
			replacementRpc.close();
			await replacementRpc.modePromise.catch(() => undefined);
		}
	});

	test("Iroh remote filtering rejects subagent lifecycle commands", () => {
		for (const command of [
			"list_subagents",
			"subagent_start",
			"subagent_abort",
			"subagent_get_state",
			"subagent_get_transcript",
			"subagent_dispose",
		] as const) {
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
});
