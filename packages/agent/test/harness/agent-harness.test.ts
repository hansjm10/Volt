import {
	estimateToolDefinitionTokens,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	registerFauxProvider,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { estimateMessagesTokens } from "../../src/harness/compaction/compaction.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { PromptTemplate, Skill } from "../../src/harness/types.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import { getCurrentTimeTool } from "../utils/get-current-time.ts";

interface AppSkill extends Skill {
	source: "project" | "user";
}

interface AppPromptTemplate extends PromptTemplate {
	source: "project" | "user";
}

const registrations: Array<{ unregister(): void }> = [];

function textFromUserMessages(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
			return "text" in part && typeof part.text === "string" ? [part.text] : [];
		});
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function getReasoning(options: unknown): unknown {
	if (!options || typeof options !== "object" || !("reasoning" in options)) return undefined;
	return options["reasoning"];
}

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("AgentHarness", () => {
	it("constructs directly and exposes queue modes", () => {
		const session = new Session(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const initialModel = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness({
			env,
			session,
			model: initialModel,
			thinkingLevel: "high",
			systemPrompt: "You are helpful.",
			steeringMode: "all",
			followUpMode: "all",
		});
		expect(harness.env).toBe(env);
		expect(harness.getModel()).toBe(initialModel);
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.getSteeringMode()).toBe("all");
		expect(harness.getFollowUpMode()).toBe("all");
		harness.setSteeringMode("one-at-a-time");
		harness.setFollowUpMode("one-at-a-time");
		expect(harness.getSteeringMode()).toBe("one-at-a-time");
		expect(harness.getFollowUpMode()).toBe("one-at-a-time");
	});

	it("drains one queued steering message at a time and emits queue updates", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			steeringMode: "one-at-a-time",
		});
		const steerQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				steerQueueLengths.push(event.steer.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.steer("one");
				harness.steer("two");
			}
		});

		await harness.prompt("hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(steerQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("finalizes before leasing queued steering and processes it at the next boundary", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const requestSnapshots: Array<{ users: string[]; tools: string[] }> = [];
		registration.setResponses([
			(context) => {
				requestSnapshots.push({
					users: textFromUserMessages(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requestSnapshots.push({
					users: textFromUserMessages(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("finalized");
			},
			(context) => {
				requestSnapshots.push({
					users: textFromUserMessages(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("handled queued steering");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
		});
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				void harness.steer("queued steering");
			}
		});
		harness.on("tool_result", () => ({ disposition: "final_response" }));

		const response = await harness.prompt("complete and summarize");

		expect(response.content).toEqual([{ type: "text", text: "handled queued steering" }]);
		expect(requestSnapshots).toEqual([
			{ users: ["complete and summarize"], tools: ["calculate"] },
			{ users: ["complete and summarize"], tools: [] },
			{ users: ["complete and summarize", "queued steering"], tools: ["calculate"] },
		]);
	});

	it("abort after a steering delivery begins preserves the committed payload", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let providerCalls = 0;
		registration.setResponses([
			() => {
				providerCalls++;
				return fauxAssistantMessage("first");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		let turnStarts = 0;
		let queued = false;
		let abortResult: ReturnType<typeof harness.abort> | undefined;
		harness.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				await harness.steer("committed before abort");
			}
			if (event.type === "turn_start" && ++turnStarts === 2) {
				abortResult = harness.abort();
			}
		});

		await harness.prompt("hello");
		const persistedMessages = (await session.buildContext()).messages as AgentMessage[];

		expect(providerCalls).toBe(1);
		expect(abortResult).toMatchObject({ accepted: true });
		expect(textFromUserMessages(persistedMessages)).toEqual(["hello", "committed before abort"]);
	});

	it.each([
		["queue_update", "queue update exploded"],
		["delivery_start", "delivery start exploded"],
	] as const)(
		"keeps a begun delivery authoritative despite a rejecting %s observer",
		async (rejectedEvent, errorMessage) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("should not be used")]);
			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				model: registration.getModel(),
			});
			const lifecycleEvents: string[] = [];
			const steerQueueSnapshots: string[][] = [];
			let queued = false;
			let sawDeliveryStart = false;
			let terminalMessages: AgentMessage[] = [];
			const unsubscribe = harness.subscribe(async (event) => {
				if (
					event.type === "agent_start" ||
					event.type === "turn_start" ||
					event.type === "turn_end" ||
					event.type === "message_start" ||
					event.type === "message_end" ||
					event.type === "agent_end"
				) {
					lifecycleEvents.push(event.type);
				}
				if (event.type === "agent_start" && !queued) {
					queued = true;
					await harness.steer("committed delivery");
				}
				if (event.type === "queue_update") {
					steerQueueSnapshots.push(textFromUserMessages(event.steer));
					if (rejectedEvent === "queue_update" && queued && event.steer.length === 0) {
						throw new Error(errorMessage);
					}
				}
				if (event.type === "delivery_start" && event.deliveryId !== undefined) {
					sawDeliveryStart = true;
					if (rejectedEvent === "delivery_start") throw new Error(errorMessage);
				}
				if (event.type === "agent_end") terminalMessages = event.messages;
			});

			const response = await harness.prompt("initial prompt");
			const persistedMessages = (await session.buildContext()).messages as AgentMessage[];
			unsubscribe();
			const abortResult = harness.abort();

			expect(registration.state.callCount).toBe(1);
			expect(registration.getPendingResponseCount()).toBe(0);
			expect(response).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(textFromUserMessages(persistedMessages)).toEqual(["initial prompt", "committed delivery"]);
			expect(persistedMessages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
			expect(terminalMessages).toEqual(persistedMessages);
			expect(steerQueueSnapshots).toEqual([["committed delivery"], []]);
			expect(sawDeliveryStart).toBe(true);
			expect(abortResult).toMatchObject({ accepted: false });
			expect(lifecycleEvents.filter((event) => event === "turn_start" || event === "turn_end")).toEqual([
				"turn_start",
				"turn_end",
			]);
			expect(lifecycleEvents.at(-1)).toBe("agent_end");
		},
	);

	it("retains an initial prompt when agent_start observes abort intent", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const lifecycleEvents: string[] = [];
		let abortResult: ReturnType<typeof harness.abort> | undefined;
		harness.subscribe((event) => {
			lifecycleEvents.push(event.type);
			if (event.type === "agent_start") abortResult = harness.abort();
		});

		const result = await harness.runPrompt("preserve this prompt");

		expect(abortResult).toMatchObject({ accepted: true });
		expect(result).toEqual({ status: "completed", deliveries: [] });
		expect(registration.state.callCount).toBe(0);
		expect((await session.buildContext()).messages).toEqual([]);
		expect(harness.hasPendingPrompt()).toBe(true);
		expect(lifecycleEvents).toEqual(["agent_start", "agent_end", "settled"]);
	});

	it.each(["message_start", "message_end"] as const)(
		"isolates an initial delivery %s observer rejection without duplicating its message",
		async (rejectedEvent) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("should not be used")]);
			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				model: registration.getModel(),
			});
			const lifecycleEvents: string[] = [];
			let terminalMessages: AgentMessage[] = [];
			harness.subscribe((event) => {
				if (
					event.type === "agent_start" ||
					event.type === "turn_start" ||
					event.type === "turn_end" ||
					event.type === "message_start" ||
					event.type === "message_end" ||
					event.type === "agent_end"
				) {
					lifecycleEvents.push(event.type);
				}
				if (event.type === rejectedEvent && event.message.role === "user") {
					throw new Error("initial delivery exploded");
				}
				if (event.type === "agent_end") terminalMessages = event.messages;
			});

			const response = await harness.prompt("preserve this initial delivery");
			const persistedMessages = (await session.buildContext()).messages as AgentMessage[];

			expect(registration.state.callCount).toBe(1);
			expect(registration.getPendingResponseCount()).toBe(0);
			expect(response).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(textFromUserMessages(persistedMessages)).toEqual(["preserve this initial delivery"]);
			expect(persistedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(terminalMessages).toEqual(persistedMessages);
			expect(lifecycleEvents).toEqual([
				"agent_start",
				"message_start",
				"message_end",
				"turn_start",
				"message_start",
				"message_end",
				"turn_end",
				"agent_end",
			]);
		},
	);

	it("prepares a queued request from the post-delivery session snapshot", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const requestPrompts: string[] = [];
		registration.setResponses([
			(context) => {
				requestPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first");
			},
			(context) => {
				requestPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("second");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			systemPrompt: async ({ session: currentSession }) => {
				const current = await currentSession.buildContext();
				return `users:${textFromUserMessages(current.messages as AgentMessage[]).join("|")}`;
			},
		});
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				void harness.steer("steer");
			}
		});

		await harness.prompt("hello");

		expect(requestPrompts).toEqual(["users:hello", "users:hello|steer"]);
	});

	it("appends before_agent_start messages and persists them", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let requestText: string[] = [];
		registration.setResponses([
			(context) => {
				requestText = textFromUserMessages(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		harness.on("before_agent_start", () => ({
			messages: [{ role: "user", content: [{ type: "text", text: "hook" }], timestamp: Date.now() }],
		}));

		await harness.prompt("hello");

		const persistedText = (await session.getEntries()).flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const content = entry.message.content;
			if (typeof content === "string") return [content];
			return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		});
		expect(requestText).toEqual(["hello", "hook"]);
		expect(persistedText).toEqual(["hello", "hook"]);
	});

	it("abort retains steer and follow-up queues while explicit clear preserves next-turn messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let releaseFirstResponse: (() => void) | undefined;
		let abortedSignal: AbortSignal | undefined;
		const firstResponseReleased = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const secondRequestText: string[] = [];
		registration.setResponses([
			async (_context, options) => {
				abortedSignal = options?.signal;
				await firstResponseReleased;
				return fauxAssistantMessage("aborted-ish");
			},
			(context) => {
				secondRequestText.push(...textFromUserMessages(context.messages));
				return fauxAssistantMessage("second");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const queueUpdates: Array<{ steer: number; followUp: number; nextTurn: number }> = [];
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				queueUpdates.push({
					steer: event.steer.length,
					followUp: event.followUp.length,
					nextTurn: event.nextTurn.length,
				});
			}
		});

		const firstPrompt = harness.prompt("first");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const steerId = await harness.steer("steer");
		const followUpId = await harness.followUp("follow");
		await harness.nextTurn("next");
		const abortResult = harness.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(abortedSignal?.aborted).toBe(true);
		releaseFirstResponse?.();
		await firstPrompt;
		expect(harness.hasQueuedMessages()).toBe(true);
		expect(await harness.clearAllQueues()).toEqual([steerId, followUpId]);
		await harness.prompt("second");

		expect(abortResult).toMatchObject({ accepted: true });
		expect(queueUpdates).toContainEqual({ steer: 0, followUp: 0, nextTurn: 1 });
		expect(secondRequestText).toEqual(["first", "next", "second"]);
	});

	it("settles with an aborted assistant when context preflight is aborted", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const contextStarted = deferred();
		const releaseContext = deferred();
		const lifecycle: string[] = [];
		harness.on("context", async (event) => {
			contextStarted.resolve();
			await releaseContext.promise;
			return { messages: event.messages };
		});
		harness.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				lifecycle.push("message_start");
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				lifecycle.push(`message_end:${event.message.stopReason}`);
			} else if (event.type === "turn_end") {
				lifecycle.push("turn_end");
			} else if (event.type === "agent_end" || event.type === "settled") {
				lifecycle.push(event.type);
			}
		});

		const promptPromise = harness.prompt("hello");
		await contextStarted.promise;
		const abortPromise = harness.abort();
		releaseContext.resolve();
		const [response] = await Promise.all([promptPromise, abortPromise]);

		expect(response).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(lifecycle).toEqual(["message_start", "message_end:aborted", "turn_end", "agent_end", "settled"]);
		const persistedMessages = (await session.getEntries()).flatMap((entry) =>
			entry.type === "message" ? [entry.message] : [],
		);
		expect(persistedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(persistedMessages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("drains follow-up messages one at a time after the agent would otherwise stop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			followUpMode: "one-at-a-time",
		});
		const followUpQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				followUpQueueLengths.push(event.followUp.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.followUp("one");
				harness.followUp("two");
			}
		});

		await harness.prompt("hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(followUpQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("settles thrown hook failures with persisted assistant error messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: string[] = [];
		harness.subscribe((event) => {
			events.push(event.type);
		});
		harness.on("context", () => {
			throw new Error("context exploded");
		});

		const response = await harness.prompt("hello");
		await expect(harness.prompt("after failure")).resolves.toMatchObject({ role: "assistant" });

		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("context exploded");
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "context exploded" });
		expect(events).toContain("agent_end");
		expect(events).toContain("settled");
	});

	it("refreshes model, thinking level, resources, system prompt, and active tools at save points", async () => {
		const registration = registerFauxProvider({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		registrations.push(registration);
		const secondModel = registration.getModel("second");
		if (!secondModel) throw new Error("missing second faux model");
		const captured: Array<{ modelId: string; reasoning: unknown; systemPrompt: string; tools: string[] }> = [];
		registration.setResponses([
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("done");
			},
		]);
		const harness = new AgentHarness<Skill, PromptTemplate, AgentTool>({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "off",
			resources: {
				skills: [{ name: "prompt", description: "prompt", content: "first prompt", filePath: "/skills/prompt" }],
			},
			systemPrompt: ({ resources }) => resources.skills?.[0]?.content ?? "missing prompt",
			tools: [calculateTool],
		});
		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				void harness.setModel(secondModel);
				void harness.setThinkingLevel("high");
				void harness.setResources({
					skills: [
						{ name: "prompt", description: "prompt", content: "second prompt", filePath: "/skills/prompt" },
					],
				});
				void harness.setTools([calculateTool, getCurrentTimeTool], [getCurrentTimeTool.name]);
			}
		});

		await harness.prompt("hello");

		expect(captured).toEqual([
			{ modelId: "first", reasoning: undefined, systemPrompt: "first prompt", tools: ["calculate"] },
			{ modelId: "second", reasoning: "high", systemPrompt: "second prompt", tools: ["get_current_time"] },
		]);
	});

	it("orders pending listener session writes after agent-emitted messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		let wrotePendingMessage = false;
		harness.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && !wrotePendingMessage) {
				wrotePendingMessage = true;
				await harness.appendMessage({
					role: "custom",
					customType: "listener",
					content: "listener write",
					display: true,
					timestamp: Date.now(),
				} as AgentMessage);
			}
		});

		await harness.prompt("hello");

		const entries = await session.getEntries();
		const roles = entries.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
		expect(roles).toEqual(["user", "assistant", "custom"]);
	});

	it("waitForIdle waits for external run settlement and awaited listeners", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const barrier = deferred();
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		let listenerFinished = false;
		harness.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		const promptPromise = harness.prompt("hello");
		let idleResolved = false;
		const idlePromise = harness.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);
		expect(idleResolved).toBe(true);
		expect(listenerFinished).toBe(true);
	});

	it("runs tool_call and tool_result hooks through the direct loop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [calculateTool],
		});
		const seenToolCalls: Array<{ id: string; name: string; expression: unknown }> = [];
		harness.on("tool_call", (event) => {
			seenToolCalls.push({ id: event.toolCallId, name: event.toolName, expression: event.input["expression"] });
			return undefined;
		});
		harness.on("tool_result", (event) => {
			expect(event.toolCallId).toBe("call-1");
			expect(event.toolName).toBe("calculate");
			return {
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
				disposition: "stop",
			};
		});

		await harness.prompt("hello");

		const toolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(seenToolCalls).toEqual([{ id: "call-1", name: "calculate", expression: "2 + 2" }]);
		expect(toolResult).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
			},
		});
	});

	it("preserves app tool types for getters and update events", async () => {
		const session = new Session(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		type AppTool = AgentTool<typeof calculateTool.parameters> & { source: "builtin" | "extension" };
		const inspectTool: AppTool = { ...calculateTool, name: "inspect", source: "builtin" };
		const searchTool: AppTool = { ...calculateTool, name: "search", source: "extension" };
		const harness = new AgentHarness<AppSkill, AppPromptTemplate, AppTool>({
			env,
			session,
			model,
			tools: [inspectTool, searchTool],
			activeToolNames: ["inspect"],
		});
		const updates: Array<{
			toolNames: string[];
			previousToolNames: string[];
			activeToolNames: string[];
			previousActiveToolNames: string[];
			source: "set" | "restore";
		}> = [];
		harness.subscribe((event) => {
			if (event.type === "tools_update") {
				updates.push({
					toolNames: event.toolNames,
					previousToolNames: event.previousToolNames,
					activeToolNames: event.activeToolNames,
					previousActiveToolNames: event.previousActiveToolNames,
					source: event.source,
				});
				expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(event.activeToolNames);
			}
		});

		const tools = harness.getTools();
		const activeTools = harness.getActiveTools();
		tools.pop();
		activeTools.pop();
		expect(harness.getTools().map((tool) => tool.name)).toEqual(["inspect", "search"]);
		expect(harness.getActiveTools().map((tool) => tool.source)).toEqual(["builtin"]);

		await harness.setActiveTools(["search"]);
		await harness.setTools([searchTool], ["search"]);
		await expect(harness.setActiveTools(["missing"])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setActiveTools(["search", "search"])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setTools([inspectTool])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setTools([inspectTool, inspectTool], ["inspect"])).rejects.toMatchObject({
			code: "invalid_argument",
		});

		expect(updates).toEqual([
			{
				toolNames: ["inspect", "search"],
				previousToolNames: ["inspect", "search"],
				activeToolNames: ["search"],
				previousActiveToolNames: ["inspect"],
				source: "set",
			},
			{
				toolNames: ["search"],
				previousToolNames: ["inspect", "search"],
				activeToolNames: ["search"],
				previousActiveToolNames: ["search"],
				source: "set",
			},
		]);
		expect(harness.getTools().map((tool) => tool.source)).toEqual(["extension"]);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(["search"]);
		expect((await session.buildContext()).activeToolNames).toEqual(["search"]);
	});

	it("includes active definitions in manual compaction preparation and rebuilt estimates", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "compact", contextWindow: 6000, maxTokens: 1000 }],
		});
		registrations.push(registration);
		registration.setSimpleResponses([fauxAssistantMessage("summary")]);
		const session = new Session(new InMemorySessionStorage());
		for (let index = 0; index < 5; index++) {
			await session.appendMessage({
				role: "user",
				content: [{ type: "text", text: String(index).repeat(4000) }],
				timestamp: Date.now() + index,
			});
		}
		const largeTool: AgentTool = {
			...calculateTool,
			name: "large_tool",
			description: "x".repeat(16_000),
		};
		const messagesBefore = (await session.buildContext()).messages as AgentMessage[];
		let preparationTokens = 0;
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [largeTool],
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		harness.on("session_before_compact", (event) => {
			preparationTokens = event.preparation.tokensBefore;
			return undefined;
		});

		const result = await harness.compact();
		const rebuiltMessages = (await session.buildContext()).messages as AgentMessage[];

		expect(preparationTokens).toBe(
			estimateMessagesTokens(messagesBefore) + estimateToolDefinitionTokens([largeTool]),
		);
		expect(result.estimatedTokensAfter).toBe(
			estimateMessagesTokens(rebuiltMessages) + estimateToolDefinitionTokens([largeTool]),
		);
	});

	it("validates constructor tool names", () => {
		const session = new Session(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(
			() => new AgentHarness({ env, session, model, tools: [calculateTool], activeToolNames: ["missing"] }),
		).toThrow(/Unknown tool/);
		expect(
			() =>
				new AgentHarness({
					env,
					session,
					model,
					tools: [calculateTool, calculateTool],
					activeToolNames: [calculateTool.name],
				}),
		).toThrow(/Duplicate tool/);
		expect(
			() =>
				new AgentHarness({
					env,
					session,
					model,
					tools: [calculateTool],
					activeToolNames: [calculateTool.name, calculateTool.name],
				}),
		).toThrow(/Duplicate active tool/);
	});

	it("preserves app resource types for getters and update events", async () => {
		const session = new Session(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness<AppSkill, AppPromptTemplate, AgentTool>({ env, session, model });
		const skill: AppSkill = {
			name: "inspect",
			description: "Inspect things",
			content: "Use inspection tools.",
			filePath: "/skills/inspect/SKILL.md",
			source: "project",
		};
		const promptTemplate: AppPromptTemplate = { name: "review", content: "Review $1", source: "user" };
		const resources = { skills: [skill], promptTemplates: [promptTemplate] };
		const updates: Array<{ resourcesSource?: string; previousSource?: string }> = [];
		harness.subscribe((event) => {
			if (event.type === "resources_update") {
				const resourcesSource = event.resources.skills?.[0]?.source;
				const previousSource = event.previousResources.skills?.[0]?.source;
				updates.push({
					...(resourcesSource === undefined ? {} : { resourcesSource }),
					...(previousSource === undefined ? {} : { previousSource }),
				});
			}
		});

		await harness.setResources(resources);
		await harness.setResources(resources);
		const resolved = harness.getResources();

		expect(updates).toEqual([
			{ resourcesSource: "project", previousSource: undefined },
			{ resourcesSource: "project", previousSource: "project" },
		]);
		expect(resolved.skills?.[0]?.source).toBe("project");
		expect(resolved.promptTemplates?.[0]?.source).toBe("user");
		expect(resolved.skills).not.toBe(resources.skills);
		expect(resolved.promptTemplates).not.toBe(resources.promptTemplates);
	});
});
