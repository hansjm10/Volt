import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function createHarness(
	registration: ReturnType<typeof registerFauxProvider>,
	options: Omit<ConstructorParameters<typeof AgentHarness>[0], "env" | "session" | "model"> & {
		session?: Session;
	} = {},
): { harness: AgentHarness; session: Session } {
	const session = options.session ?? new Session(new InMemorySessionStorage());
	const { session: _session, ...harnessOptions } = options;
	return {
		harness: new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			...harnessOptions,
		}),
		session,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function reasoningOption(options: unknown): unknown {
	if (!options || typeof options !== "object" || !("reasoning" in options)) return undefined;
	return options.reasoning;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("AgentHarness continuation state", () => {
	it("uses the approved synchronous projector and projection token contract", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const anchorLeafId = await session.appendMessage({
			role: "user",
			content: "canonical",
			timestamp: Date.now(),
		});
		let providerTexts: string[] = [];
		let projectorInput: readonly AgentMessage[] = [];
		registration.setResponses([
			(context) => {
				providerTexts = (context.messages as AgentMessage[]).map(messageText);
				return fauxAssistantMessage("done");
			},
		]);
		const { harness } = createHarness(registration, { session });
		const token = await harness.rebaseContinuationContext({
			source: "retry",
			project: (messages) => {
				projectorInput = messages;
				return [{ role: "user", content: "projected", timestamp: Date.now() }];
			},
		});

		await expect(
			harness.rebaseContinuationContext({
				source: "compaction",
				project: () => {
					throw new Error("projection failed");
				},
			}),
		).rejects.toThrow("projection failed");
		await harness.continue();

		expect(projectorInput.map(messageText)).toEqual(["canonical"]);
		expect(Object.isFrozen(projectorInput)).toBe(true);
		expect(providerTexts).toEqual(["projected"]);
		expect(token).toMatchObject({
			projectionId: expect.any(String),
			source: "retry",
			anchorLeafId,
		});
		expect(Object.isFrozen(token)).toBe(true);
		expect(harness.clearContinuationContext({ ...token })).toBe(false);
		expect(harness.clearContinuationContext(token)).toBe(true);
		const invalidated = await harness.rebaseContinuationContext({ source: "explicit" });
		harness.invalidateContinuationContext();
		expect(harness.clearContinuationContext(invalidated)).toBe(false);
	});

	it("rejects non-cloneable canonical mutations before changing projection", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("must not run")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage({ role: "user", content: "canonical", timestamp: Date.now() });
		const { harness } = createHarness(registration, { session });
		await harness.rebaseContinuationContext({ source: "explicit" });

		await expect(
			harness.appendMessage({
				role: "custom",
				customType: "uncloneable",
				content: "persisted canonically",
				display: false,
				details: { callback: () => undefined } as never,
				timestamp: Date.now(),
			}),
		).rejects.toThrow("Failed to materialize canonical mutation batch");
		expect((await session.buildContext()).messages.map(messageText)).toEqual(["canonical"]);
		expect(registration.state.callCount).toBe(0);
	});

	it("lets canonical mode consume a branch rewrite between provider requests", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not run"),
		]);
		const storage = new InMemorySessionStorage();
		const session = new Session(storage);
		const { harness } = createHarness(registration, { session, tools: [calculateTool] });
		let movedBranch = false;
		harness.subscribe(async (event) => {
			if (event.type !== "tool_execution_end" || movedBranch) return;
			movedBranch = true;
			await session.moveTo(null);
		});

		const response = await harness.prompt("change branches between requests");

		expect(response).toMatchObject({ stopReason: "stop" });
		expect(registration.state.callCount).toBe(2);
	});

	it("reconciles metadata appended during a provider request before tool continuation", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const requestRoles: string[][] = [];
		registration.setResponses([
			async (context) => {
				requestRoles.push((context.messages as AgentMessage[]).map((message) => message.role));
				await session.appendSessionName("Generated while provider active");
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requestRoles.push((context.messages as AgentMessage[]).map((message) => message.role));
				return fauxAssistantMessage("done");
			},
		]);
		const { harness } = createHarness(registration, { session, tools: [calculateTool] });

		await expect(harness.runPrompt("continue after naming")).resolves.toMatchObject({ status: "completed" });

		expect(registration.state.callCount).toBe(2);
		expect(requestRoles).toEqual([["user"], ["user", "assistant", "toolResult"]]);
		expect((await session.getBranch()).map((entry) => entry.type)).toEqual([
			"message",
			"session_info",
			"message",
			"message",
			"message",
		]);
	});

	it("tails a legitimate canonical append before the next provider request", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		registration.setResponses([
			async () => {
				await session.appendMessage({ role: "user", content: "external write", timestamp: Date.now() });
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("must not run"),
		]);
		const { harness } = createHarness(registration, { session, tools: [calculateTool] });

		const response = await harness.prompt("reject external context");

		expect(response).toMatchObject({ stopReason: "stop" });
		expect(registration.state.callCount).toBe(2);
	});

	it("owns explicit continuation context before blocked canonical context resolution", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const contextStarted = deferred();
		const releaseContext = deferred();
		const getBranchSnapshot = session.getBranchSnapshot.bind(session);
		vi.spyOn(session, "getBranchSnapshot").mockImplementation(async (cursor) => {
			contextStarted.resolve();
			await releaseContext.promise;
			return await getBranchSnapshot(cursor);
		});
		let providerTexts: string[] = [];
		registration.setResponses([
			(context) => {
				providerTexts = (context.messages as AgentMessage[]).map(messageText);
				return fauxAssistantMessage("done");
			},
		]);
		const { harness } = createHarness(registration, { session });
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "owned continuation" }],
			timestamp: 1,
		};
		const context = [message];
		const options = { context, drainFollowUps: false };

		const continuation = harness.continue(options);
		await contextStarted.promise;
		if (message.role !== "user" || typeof message.content === "string") {
			throw new Error("Expected structured user context");
		}
		message.content[0] = { type: "text", text: "mutated continuation" };
		context.push({ role: "user", content: "late continuation", timestamp: 2 });
		options.context = [{ role: "user", content: "replacement continuation", timestamp: 3 }];
		options.drainFollowUps = true;
		releaseContext.resolve();

		await expect(continuation).resolves.toMatchObject({ status: "completed" });
		expect(providerTexts).toEqual(["owned continuation"]);
	});

	it("keeps an explicit continuation projection through tool requests", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const canonicalUser = { role: "user", content: "retry this", timestamp: Date.now() } as const;
		await session.appendMessage(canonicalUser);
		await session.appendMessage(
			fauxAssistantMessage("canonical error", { stopReason: "error", errorMessage: "provider failed" }),
		);
		const requestTexts: string[][] = [];
		registration.setResponses([
			(context) => {
				requestTexts.push((context.messages as AgentMessage[]).map(messageText));
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requestTexts.push((context.messages as AgentMessage[]).map(messageText));
				return fauxAssistantMessage("done");
			},
		]);
		const { harness } = createHarness(registration, { session, tools: [calculateTool] });

		await expect(harness.continue({ context: [canonicalUser] })).resolves.toMatchObject({ status: "completed" });

		expect(registration.state.callCount).toBe(2);
		expect(requestTexts[0]).toEqual(["retry this"]);
		expect(requestTexts[1]).toContain("2 + 2 = 4");
		expect(requestTexts.flat()).not.toContain("canonical error");
	});

	it("refreshes runtime configuration after delivery settlement before the first request", async () => {
		const registration = registerFauxProvider({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		registrations.push(registration);
		const secondModel = registration.getModel("second");
		if (!secondModel) throw new Error("missing second faux model");
		const captured: Array<{ modelId: string; reasoning: unknown; tools: string[] }> = [];
		registration.setResponses([
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: reasoningOption(options),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("done");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		let harness: AgentHarness;
		harness = createHarness(registration, {
			session,
			thinkingLevel: "off",
			deliveryOwner: {
				prepareLogical: (context) => ({ outcome: "prepared", messages: context.sourceMessages }),
				commitAttempt: async (context) => {
					await harness.setModel(secondModel, { persist: false });
					await harness.setThinkingLevel("high", { persist: false });
					await harness.setTools([calculateTool], [calculateTool.name]);
					const snapshot = await session.getBranchSnapshot();
					const result = await session.commitBatch({
						guard: { kind: "exact", cursor: snapshot.cursor },
						mutations: context.preparedMessages.map((message) => ({
							kind: "append" as const,
							entry: { type: "message" as const, message },
						})),
						deliveryAttribution: {
							deliveryId: context.deliveryId,
							epoch: context.epoch,
							attemptId: context.attemptId,
						},
					});
					if (result.outcome !== "committed") return { outcome: "terminally_failed", error: result.error };
					return { outcome: "committed", receipt: result.receipt };
				},
				finish: () => undefined,
			},
		}).harness;

		await harness.runPrompt("use current configuration");

		expect(captured).toEqual([{ modelId: "second", reasoning: "high", tools: ["calculate"] }]);
	});

	it("preserves final-response authority across pause and ignores weaker policy", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const requests: Array<{ tools: string[]; systemPrompt: string }> = [];
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "3 + 4" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			(context) => {
				requests.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("final answer");
			},
		]);
		const { harness } = createHarness(registration, { tools: [calculateTool] });
		harness.on("tool_result", () => ({ disposition: "final_response" }));
		let finalDecisions = 0;
		harness.on("next_action", (event) => {
			if (event.requestAuthority !== "final_response") return undefined;
			finalDecisions++;
			return finalDecisions === 1 ? { type: "pause" } : { type: "stop" };
		});

		await expect(harness.runPrompt("finish the work")).resolves.toMatchObject({ status: "completed" });
		expect(registration.state.callCount).toBe(1);
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });

		expect(finalDecisions).toBe(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.tools).toEqual([]);
		expect(requests[0]?.systemPrompt).toContain("VOLT FINAL RESPONSE");
	});

	it("preserves final-response authority when an explicit retry projector removes the error", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const finalRequests: Array<{ texts: string[]; tools: string[] }> = [];
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "5 + 5" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			(context) => {
				finalRequests.push({
					texts: (context.messages as AgentMessage[]).map(messageText),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("failed final", {
					stopReason: "error",
					errorMessage: "temporary provider failure",
				});
			},
			(context) => {
				finalRequests.push({
					texts: (context.messages as AgentMessage[]).map(messageText),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("recovered final");
			},
		]);
		const { harness } = createHarness(registration, { tools: [calculateTool] });
		harness.on("tool_result", () => ({ disposition: "final_response" }));

		await expect(harness.runPrompt("finish despite retry")).resolves.toMatchObject({ status: "completed" });
		await harness.rebaseContinuationContext({
			source: "retry",
			project: (messages) =>
				messages.filter((message) => message.role !== "assistant" || message.stopReason !== "error"),
		});
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });

		expect(registration.state.callCount).toBe(3);
		expect(finalRequests).toHaveLength(2);
		expect(finalRequests.map((request) => request.tools)).toEqual([[], []]);
		expect(finalRequests[1]?.texts).not.toContain("failed final");
	});

	it("completes assistant-tail no-ops without model-backed turn construction", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let systemPromptCalls = 0;
		for (const model of [undefined, registration.getModel()]) {
			const session = new Session(new InMemorySessionStorage());
			await session.appendMessage(fauxAssistantMessage("already complete"));
			const harness = new AgentHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				...(model === undefined ? {} : { model }),
				systemPrompt: () => {
					systemPromptCalls++;
					throw new Error("system prompt should not be evaluated");
				},
			});

			await expect(harness.continue()).resolves.toEqual({ status: "completed", deliveries: [] });
		}
		expect(systemPromptCalls).toBe(0);
		expect(registration.state.callCount).toBe(0);
	});
});
