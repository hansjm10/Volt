import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
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

describe("AgentHarness continuation state", () => {
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
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						await harness.setModel(secondModel, { persist: false });
						await harness.setThinkingLevel("high", { persist: false });
						await harness.setTools([calculateTool], [calculateTool.name]);
						for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
						return { outcome: "committed" };
					},
				},
			}),
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

	it("retries a failed final response from private continuation state", async () => {
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
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });

		expect(registration.state.callCount).toBe(3);
		expect(finalRequests).toHaveLength(2);
		expect(finalRequests.map((request) => request.tools)).toEqual([[], []]);
		expect(finalRequests[1]?.texts).not.toContain("failed final");
	});
});
