import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	createTestModel,
	createTestSession,
	parseWrittenObjects,
	startIrohRpcMode,
	withCurrentConversationAuthority,
} from "./iroh-stream-doubles.ts";

function createStableSessionRunner<TSession>(getSession: () => TSession) {
	return {
		async runWithStableSession<TResult>(
			operation: (session: TSession) => Promise<TResult> | TResult,
		): Promise<TResult> {
			const session = getSession();
			return operation(session);
		},
	};
}

describe("Iroh remote model RPC", () => {
	test("starts recovered dispatch only after extension session_start and resource discovery binding", async () => {
		const bindingOrder: string[] = [];
		let sessionStartInitialized = false;
		let resourcesInitialized = false;
		const session = {
			...createTestSession("session-recovery-order", null),
			bindExtensions: vi.fn(async () => {
				sessionStartInitialized = true;
				bindingOrder.push("session_start");
				await Promise.resolve();
				resourcesInitialized = true;
				bindingOrder.push("resources");
			}),
		};
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const recoveredDispatch = vi.fn(() => {
			expect(sessionStartInitialized).toBe(true);
			expect(resourcesInitialized).toBe(true);
			bindingOrder.push("recovered_dispatch");
		});

		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			onReady: recoveredDispatch,
		});
		await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledOnce());
		expect(bindingOrder).toEqual(["session_start", "resources", "recovered_dispatch"]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("forwards model catalog, set_model, and set_thinking_level while rejecting cycle commands", async () => {
		const modelOne = createTestModel("model-one");
		const modelTwo = createTestModel("model-two", { input: ["text", "image"] });
		const fastModel = createTestModel("gpt-5.6-sol", {
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		});
		let currentModel = modelOne;
		let thinkingLevel: ThinkingLevel = "medium";
		const setModel = vi.fn(async (model: Model<Api>) => {
			currentModel = model;
		});
		const setThinkingLevel = vi.fn((level: ThinkingLevel) => {
			thinkingLevel = level;
		});
		const session = {
			...createTestSession("session-one", null),
			get model() {
				return currentModel;
			},
			get thinkingLevel() {
				return thinkingLevel;
			},
			modelRegistry: {
				authStorage: {},
				getAvailable: vi.fn(() => [modelOne, modelTwo, fastModel]),
				refreshFromDisk: vi.fn(),
			},
			getAvailableThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
			setModel,
			setThinkingLevel,
			activeToolExecutions: new Map(),
			subscribeRuntimeEvents: vi.fn(() => () => {}),
		};
		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		recv.pushLine(JSON.stringify({ id: "models-1", type: "get_available_models" }));
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "set-1",
					type: "set_model",
					provider: "anthropic",
					modelId: "model-two",
				}),
			),
		);
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "set-2",
					type: "set_model",
					provider: "anthropic",
					modelId: "missing",
				}),
			),
		);
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "think-1",
					type: "set_thinking_level",
					level: "low",
				}),
			),
		);
		recv.pushLine(JSON.stringify({ id: "state-1", type: "get_state" }));
		// Sent after state-1 so the persistDefault-forwarding checks don't disturb the state assertions above.
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "set-3",
					type: "set_model",
					provider: "anthropic",
					modelId: "model-one",
					persistDefault: false,
				}),
			),
		);
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "think-2",
					type: "set_thinking_level",
					level: "high",
					persistDefault: false,
				}),
			),
		);
		recv.pushLine(JSON.stringify({ id: "cycle-1", type: "cycle_model" }));
		recv.pushLine(JSON.stringify({ id: "cycle-2", type: "cycle_thinking_level" }));

		await vi.waitFor(() => {
			const responses = parseWrittenObjects(send).filter((record) => record.type === "response");
			expect(responses.map((record) => record.id)).toEqual(
				expect.arrayContaining([
					"models-1",
					"set-1",
					"set-2",
					"set-3",
					"think-1",
					"think-2",
					"state-1",
					"cycle-1",
					"cycle-2",
				]),
			);
		});

		const responses = parseWrittenObjects(send).filter((record) => record.type === "response");
		const byId = new Map(responses.map((record) => [record.id, record]));

		const catalogLevels = ["off", "minimal", "low", "medium", "high"];
		expect(byId.get("models-1")).toMatchObject({
			command: "get_available_models",
			success: true,
			data: {
				models: [
					expect.objectContaining({
						id: "model-one",
						availableThinkingLevels: catalogLevels,
						supportsFastMode: false,
						input: ["text"],
					}),
					expect.objectContaining({
						id: "model-two",
						availableThinkingLevels: catalogLevels,
						supportsFastMode: false,
						input: ["text", "image"],
					}),
					expect.objectContaining({
						id: "gpt-5.6-sol",
						supportsFastMode: true,
					}),
				],
			},
		});
		expect(session.modelRegistry.refreshFromDisk).toHaveBeenCalled();
		expect(byId.get("set-1")).toMatchObject({
			command: "set_model",
			success: true,
			data: expect.objectContaining({
				provider: "anthropic",
				id: "model-two",
				availableThinkingLevels: catalogLevels,
				supportsFastMode: false,
				input: ["text", "image"],
			}),
		});
		expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "model-two" }), {
			persistDefault: undefined,
		});
		expect(byId.get("set-3")).toMatchObject({ command: "set_model", success: true });
		expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "model-one" }), {
			persistDefault: false,
		});
		expect(byId.get("set-2")).toMatchObject({
			command: "set_model",
			success: false,
			error: "Model not found: anthropic/missing",
		});
		expect(byId.get("think-1")).toMatchObject({
			command: "set_thinking_level",
			success: true,
			data: { level: "low" },
		});
		expect(setThinkingLevel).toHaveBeenCalledWith("low", { persistDefault: undefined });
		expect(byId.get("think-2")).toMatchObject({ command: "set_thinking_level", success: true });
		expect(setThinkingLevel).toHaveBeenCalledWith("high", { persistDefault: false });
		expect(byId.get("state-1")).toMatchObject({
			command: "get_state",
			success: true,
			data: expect.objectContaining({
				model: expect.objectContaining({ id: "model-two", input: ["text", "image"] }),
				thinkingLevel: "low",
				availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
			}),
		});
		expect(byId.get("cycle-1")).toMatchObject({
			success: false,
			error: "RPC command not allowed over remote host: cycle_model",
		});
		expect(byId.get("cycle-2")).toMatchObject({
			success: false,
			error: "RPC command not allowed over remote host: cycle_thinking_level",
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});
});
