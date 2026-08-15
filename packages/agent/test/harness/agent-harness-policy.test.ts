import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function textOfContent(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

function textOf(message: AgentMessage): string {
	return "content" in message ? textOfContent(message.content) : "";
}

function createHarness(options: ConstructorParameters<typeof AgentHarness>[0]): AgentHarness {
	return new AgentHarness(options);
}

describe("AgentHarness host policy", () => {
	it("allows model-less construction and rejects only model-backed preflight", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
		});

		expect(harness.getModel()).toBeUndefined();
		await expect(harness.runPrompt("not yet")).rejects.toMatchObject({
			code: "invalid_state",
			message: "No model set for AgentHarness run",
		});
		expect(harness.getPhase()).toBe("idle");
		expect((await session.buildContext()).messages).toEqual([]);

		await harness.setModel(registration.getModel());
		await expect(harness.runPrompt("ready")).resolves.toMatchObject({ status: "completed" });
		expect(registration.state.callCount).toBe(1);
	});

	it("applies structured per-run system prompts and ordered context reducers", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let providerSystemPrompt = "";
		let providerMessages: unknown;
		registration.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				providerMessages = context.messages;
				return fauxAssistantMessage("ok");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			systemPrompt: "configured",
		});
		const order: string[] = [];
		harness.on("context", (event) => {
			order.push("first");
			return {
				messages: event.messages.map((message) =>
					message.role === "user" ? { ...message, content: "first replacement" } : message,
				),
			};
		});
		harness.on("context", (event) => {
			order.push(textOf(event.messages[0]!));
			return {
				messages: event.messages.map((message) =>
					message.role === "user" ? { ...message, content: "second replacement" } : message,
				),
			};
		});

		const message = { role: "user", content: "structured", timestamp: Date.now() } as const;
		await harness.run(message, { systemPrompt: "per-run" });

		expect(order).toEqual(["first", "first replacement"]);
		expect(providerSystemPrompt).toBe("per-run");
		expect(JSON.stringify(providerMessages)).toContain("second replacement");
	});

	it("finalizes ordered message replacements before persistence and passive cloned subscribers", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("provider")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const reducerInputs: string[] = [];
		harness.on("message_end", (event) => {
			if (event.message.role !== "assistant") return undefined;
			reducerInputs.push(textOf(event.message));
			return { message: { ...event.message, content: [{ type: "text", text: "first" }] } };
		});
		harness.on("message_end", (event) => {
			if (event.message.role !== "assistant") return undefined;
			reducerInputs.push(textOf(event.message));
			return { message: { ...event.message, content: [{ type: "text", text: "final" }] } };
		});
		const observed: string[] = [];
		harness.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			observed.push(textOf(event.message));
			const content = event.message.content;
			if (typeof content !== "string" && content[0]?.type === "text") content[0].text = "subscriber mutation";
			throw new Error("passive subscriber failure");
		});

		const response = await harness.prompt("hello");
		const persisted = (await session.buildContext()).messages.at(-1);

		expect(reducerInputs).toEqual(["provider", "first"]);
		expect(observed).toEqual(["final"]);
		expect(textOf(response)).toBe("final");
		expect(persisted && textOf(persisted)).toBe("final");
	});

	it("reduces tool policy in registration order before the continuation request", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let continuationMessages: unknown;
		const providerSystemPrompts: Array<string | undefined> = [];
		registration.setResponses([
			(context) => {
				providerSystemPrompts.push(context.systemPrompt);
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt);
				continuationMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
		});
		const order: string[] = [];
		harness.on("tool_call", () => {
			order.push("tool-call-first");
			return { block: true, reason: "first" };
		});
		harness.on("tool_call", (event) => {
			expect(event).toMatchObject({ block: true, reason: "first" });
			order.push("tool-call-second");
			return { block: false, reason: "second" };
		});
		harness.on("tool_result", () => {
			order.push("tool-result-first");
			return { content: [{ type: "text", text: "first result" }], isError: false };
		});
		harness.on("tool_result", (event) => {
			order.push(textOfContent(event.content));
			return { content: [{ type: "text", text: "final result" }] };
		});

		await harness.prompt("calculate", { systemPrompt: "per-run" });

		expect(order).toEqual(["tool-call-first", "tool-call-second", "tool-result-first", "first result"]);
		expect(providerSystemPrompts).toEqual(["per-run", "per-run"]);
		expect(JSON.stringify(continuationMessages)).toContain("final result");
	});

	it("keeps successful non-cloneable tool details inert when no tool-result handlers exist", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("non_cloneable_details", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("must not continue"),
		]);
		const detailCallback = () => "still callable";
		const tool: AgentTool = {
			name: "non_cloneable_details",
			label: "Non-cloneable details",
			description: "Returns successful details containing a function",
			parameters: calculateTool.parameters,
			execute: async () => ({
				content: [{ type: "text", text: "successful result" }],
				details: { callback: detailCallback },
				disposition: "stop",
			}),
		};
		const session = new Session(new InMemorySessionStorage());
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [tool],
		});

		const response = await harness.prompt("run the tool");
		const persistedToolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);

		expect(registration.state.callCount).toBe(1);
		expect(response.stopReason).toBe("toolUse");
		expect(persistedToolResult?.type === "message" ? persistedToolResult.message : undefined).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: "successful result" }],
		});
		expect(
			persistedToolResult?.type === "message" && persistedToolResult.message.role === "toolResult"
				? (persistedToolResult.message.details as { callback?: unknown } | undefined)?.callback
				: undefined,
		).toBe(detailCallback);
	});

	it("allows scoped policy to deliver work from an assistant-tail continuation", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let continuationMessages: AgentMessage[] = [];
		registration.setResponses([
			() => fauxAssistantMessage("one"),
			(context) => {
				continuationMessages = context.messages as AgentMessage[];
				return fauxAssistantMessage("two");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		await harness.prompt("first");

		const decisions: string[] = [];
		let delivered = false;
		const policyMessage: AgentMessage = {
			role: "user",
			content: "policy delivery",
			timestamp: Date.now(),
		};
		const unregister = harness.registerNextActionPolicy((context) => {
			decisions.push(context.defaultAction.type);
			if (delivered) return undefined;
			delivered = true;
			return { type: "request", reason: "delivery", deliveries: [{ messages: [policyMessage] }] };
		});

		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
		unregister();

		expect(decisions).toEqual(["stop", "stop"]);
		expect(continuationMessages.map(textOf)).toEqual(["first", "one", "policy delivery"]);
		expect(registration.state.callCount).toBe(2);
		await expect(harness.continue()).resolves.toEqual({ status: "completed", deliveries: [] });
		expect(registration.state.callCount).toBe(2);
	});

	it("isolates every next-action handler and policy projection and owns returned actions", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let continuationMessages: AgentMessage[] = [];
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "isolated-call" }), {
					stopReason: "toolUse",
				}),
			(context) => {
				continuationMessages = context.messages as AgentMessage[];
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
		});
		let mutatingHandlerCalls = 0;
		let observingHandlerCalls = 0;
		let observingPolicyCalls = 0;

		harness.on("next_action", (event) => {
			if (!event.completedTurn || event.completedTurn.toolResults.length === 0) return undefined;
			mutatingHandlerCalls++;
			event.context.messages[0] = { role: "user", content: "mutated context", timestamp: 10 };
			event.context.tools?.splice(0, event.context.tools.length);
			event.newMessages[0] = { role: "user", content: "mutated new messages", timestamp: 11 };
			event.completedTurn.message.content = [{ type: "text", text: "mutated completed message" }];
			event.completedTurn.toolResults[0]!.content = [{ type: "text", text: "mutated tool result" }];
			if (event.defaultAction.type === "request") event.defaultAction.reason = "final_response";
			return undefined;
		});
		harness.on("next_action", (event) => {
			if (!event.completedTurn || event.completedTurn.toolResults.length === 0) return undefined;
			observingHandlerCalls++;
			expect(event.context.tools).toEqual([calculateTool]);
			expect(event.context.messages.map(textOf)).not.toContain("mutated context");
			expect(event.newMessages.map(textOf)).not.toContain("mutated new messages");
			expect(JSON.stringify(event.completedTurn)).not.toContain("mutated");
			expect(event.defaultAction).toMatchObject({ type: "request", reason: "continuation" });
			const returnedMessage: AgentMessage = { role: "user", content: "owned reducer delivery", timestamp: 12 };
			const returnedAction = {
				type: "request" as const,
				reason: "delivery" as const,
				deliveries: [{ messages: [returnedMessage] }],
			};
			queueMicrotask(() => {
				returnedMessage.content = "late returned-action mutation";
				returnedAction.deliveries[0]!.messages.push({
					role: "user",
					content: "late returned delivery",
					timestamp: 13,
				});
			});
			return returnedAction;
		});
		harness.on("next_action", (event) => {
			if (
				event.defaultAction.type !== "request" ||
				event.defaultAction.reason !== "delivery" ||
				event.defaultAction.deliveries === undefined
			)
				return undefined;
			expect(event.defaultAction.deliveries.flatMap((delivery) => delivery.messages).map(textOf)).toEqual([
				"owned reducer delivery",
			]);
			const firstDelivery = event.defaultAction.deliveries?.[0];
			if (firstDelivery) {
				firstDelivery.messages[0] = { role: "user", content: "mutated handler delivery", timestamp: 14 };
				firstDelivery.messages.push({ role: "user", content: "extra handler delivery", timestamp: 15 });
			}
			return undefined;
		});
		harness.registerNextActionPolicy((context) => {
			if (
				context.defaultAction.type !== "request" ||
				context.defaultAction.reason !== "delivery" ||
				context.defaultAction.deliveries === undefined
			)
				return undefined;
			observingPolicyCalls++;
			expect(context.context.tools).toEqual([calculateTool]);
			expect(context.defaultAction.deliveries?.flatMap((delivery) => delivery.messages).map(textOf)).toEqual([
				"owned reducer delivery",
			]);
			return undefined;
		});

		await harness.prompt("calculate");

		expect(mutatingHandlerCalls).toBe(1);
		expect(observingHandlerCalls).toBe(1);
		expect(observingPolicyCalls).toBe(1);
		expect(continuationMessages.map(textOf)).toContain("owned reducer delivery");
		expect(continuationMessages.map(textOf)).not.toContain("mutated handler delivery");
		expect(continuationMessages.map(textOf)).not.toContain("late returned-action mutation");
	});

	it("orders event and scoped next-action policy and unregisters scoped policy", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);
		const harness = createHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const order: string[] = [];
		harness.on("next_action", (event) => {
			order.push(`event:${event.defaultAction.type}`);
			return undefined;
		});
		const unregister = harness.registerNextActionPolicy((context, signal) => {
			expect(signal.aborted).toBe(false);
			order.push(`scoped:${context.defaultAction.type}`);
			return undefined;
		});

		await harness.prompt("first");
		unregister();
		await harness.prompt("second");

		expect(order.slice(0, 4)).toEqual(["event:request", "scoped:request", "event:stop", "scoped:stop"]);
		expect(order.slice(4)).toEqual(["event:request", "event:stop"]);
	});
});
