import type { AgentMessage, AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { CustomMessageInput } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

function getUserText(messages: readonly AgentMessage[]): string | undefined {
	const user = messages.find((message) => message.role === "user");
	if (!user) return undefined;
	if (typeof user.content === "string") return user.content;
	return user.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function mutateUserText(messages: readonly AgentMessage[], text: string): void {
	const user = messages.find((message) => message.role === "user");
	if (!user) return;
	if (typeof user.content === "string") {
		user.content = text;
		return;
	}
	const content = user.content.find((part) => part.type === "text");
	if (content?.type === "text") content.text = text;
}

function isDeliveryOrTerminalEvent(
	event: AgentSessionEvent,
): event is Extract<AgentSessionEvent, { type: "delivery_start" | "agent_end" }> {
	return event.type === "delivery_start" || event.type === "agent_end";
}

async function flushUnhandledRejections(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

interface CyclicDetails {
	label: string;
	self?: CyclicDetails;
}

function getToolResultText(tool: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): string {
	const content = tool.result.content as Array<{ type: string; text?: string }>;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createCloneBoundaryTool(
	invalidPayload: "partial" | "final" | "explicit-undefined" | undefined,
	onInvalidPartial?: (signal: AbortSignal | undefined) => void | Promise<void>,
): AgentTool {
	return {
		name: "clone-boundary",
		label: "Clone boundary",
		description: "Exercise canonical JSON validation",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, onUpdate) => {
			if (invalidPayload === "partial") {
				onUpdate?.({
					content: [{ type: "text", text: "partial" }],
					details: { callback: () => undefined },
				});
				await onInvalidPartial?.(_signal);
				return { content: [{ type: "text", text: "complete" }], details: { valid: true } };
			}
			if (invalidPayload === "final") {
				return {
					content: [{ type: "text", text: "complete" }],
					details: { callback: () => undefined },
				};
			}
			if (invalidPayload === "explicit-undefined") {
				return { content: [{ type: "text", text: "complete" }], details: undefined };
			}
			return { content: [{ type: "text", text: "complete" }], details: { valid: true } };
		},
	};
}

describe("regression #213: AgentSession observer isolation", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps committed delivery and terminal projections authoritative across failing subscribers", async () => {
		let providerUserText: string | undefined;
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("context", (event) => {
						providerUserText = getUserText(event.messages);
						return { messages: event.messages };
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("observer failures stayed passive")]);
		const asyncSubscriberEvents: string[] = [];
		const syncSubscriberEvents: string[] = [];
		const laterSubscriberEvents: string[] = [];
		const laterSubscriberUserTexts: string[] = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown) => {
			unhandledRejections.push(error);
		};

		harness.session.subscribe(async (event) => {
			if (!isDeliveryOrTerminalEvent(event)) return;
			asyncSubscriberEvents.push(event.type);
			mutateUserText(event.messages, "mutated async snapshot");
			await Promise.resolve();
			throw new Error(`asynchronous ${event.type} observer failure`);
		});
		harness.session.subscribe((event) => {
			if (!isDeliveryOrTerminalEvent(event)) return;
			syncSubscriberEvents.push(event.type);
			mutateUserText(event.messages, "mutated sync snapshot");
			throw new Error(`synchronous ${event.type} observer failure`);
		});
		harness.session.subscribe((event) => {
			if (!isDeliveryOrTerminalEvent(event)) return;
			laterSubscriberEvents.push(event.type);
			laterSubscriberUserTexts.push(getUserText(event.messages) ?? "");
		});

		process.on("unhandledRejection", onUnhandledRejection);
		const result = await (async () => {
			try {
				const runResult = await harness!.session.agent.prompt({
					role: "user",
					content: [{ type: "text", text: "authoritative observer input" }],
					timestamp: 213,
				});
				await flushUnhandledRejections();
				return runResult;
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
			}
		})();

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(asyncSubscriberEvents).toEqual(["delivery_start", "agent_end"]);
		expect(syncSubscriberEvents).toEqual(["delivery_start", "agent_end"]);
		expect(laterSubscriberEvents).toEqual(["delivery_start", "agent_end"]);
		expect(laterSubscriberUserTexts).toEqual(["authoritative observer input", "authoritative observer input"]);
		expect(getUserText(harness.sessionManager.buildSessionContext().messages)).toBe("authoritative observer input");
		expect(getUserText(harness.session.agent.state.messages)).toBe("authoritative observer input");
		expect(providerUserText).toBe("authoritative observer input");
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(unhandledRejections).toEqual([]);
	});

	it("rejects known non-JSON custom details in the public input type", () => {
		type InvalidDetails = { callback: () => void };
		expectTypeOf<InvalidDetails>().not.toExtend<NonNullable<CustomMessageInput<InvalidDetails>["details"]>>();
	});

	it("rejects an invalid custom message before persistence or publication", async () => {
		harness = await createHarness();
		const customEvents: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "custom") {
				customEvents.push(event);
			}
		});
		const messageCount = harness.session.messages.length;
		const sendUnchecked = harness.session.sendCustomMessage.bind(harness.session) as (message: {
			customType: string;
			content: string;
			display: boolean;
			details: unknown;
		}) => Promise<void>;

		await expect(
			sendUnchecked({
				customType: "invalid-details",
				content: "invalid",
				display: true,
				details: { callback: () => undefined },
			}),
		).rejects.toThrow(
			"Custom message input must contain only JSON-compatible data; invalid value at $.details.callback: functions are not permitted",
		);

		expect(customEvents).toEqual([]);
		expect(harness.session.messages).toHaveLength(messageCount);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
	});

	it.each([
		[
			"cyclic data",
			() => {
				const cycle: CyclicDetails = { label: "cycle" };
				cycle.self = cycle;
				return cycle;
			},
		],
		["Map", () => new Map([["value", 1]])],
		["typed data", () => new Uint8Array([1, 2, 3])],
		["shared memory", () => new SharedArrayBuffer(1)],
	] as const)("rejects %s custom details before observer publication", async (_name, createDetails) => {
		harness = await createHarness();
		const events: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => events.push(event));
		const sendUnchecked = harness.session.sendCustomMessage.bind(harness.session) as (message: {
			customType: string;
			content: string;
			display: boolean;
			details: unknown;
		}) => Promise<void>;

		await expect(
			sendUnchecked({ customType: "invalid", content: "invalid", display: true, details: createDetails() }),
		).rejects.toThrow("must contain only JSON-compatible data");
		expect(events).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
	});

	it.each(["partial", "final", "explicit-undefined"] as const)(
		"turns an invalid %s tool result into an explicit tool failure",
		async (invalidPayload) => {
			harness = await createHarness({ tools: [createCloneBoundaryTool(invalidPayload)] });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("clone-boundary", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("run clone boundary tool");

			expect(harness.getPendingResponseCount()).toBe(0);
			const toolEnd = harness.eventsOfType("tool_execution_end")[0]!;
			expect(toolEnd.isError).toBe(true);
			const resultPhase = invalidPayload === "partial" ? "partial" : "final";
			expect(getToolResultText(toolEnd)).toContain(
				`Tool clone-boundary ${resultPhase} result must contain only JSON-compatible data`,
			);
			if (invalidPayload === "partial") {
				expect(harness.eventsOfType("tool_execution_update")).toEqual([]);
			}
			if (invalidPayload === "explicit-undefined") {
				expect(getToolResultText(toolEnd)).toContain("undefined is not permitted; omit optional properties");
			}
			expect(harness.eventsOfType("message_end").some((event) => event.message.role === "toolResult")).toBe(true);
		},
	);

	it("aborts an invalid streaming update but waits for tool settlement", async () => {
		let releaseTool!: () => void;
		let markToolWaiting!: () => void;
		const toolWaiting = new Promise<void>((resolve) => {
			markToolWaiting = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let linkedSignalAborted = false;
		let toolSettled = false;
		harness = await createHarness({
			tools: [
				createCloneBoundaryTool("partial", async (signal) => {
					linkedSignalAborted = signal?.aborted === true;
					markToolWaiting();
					await toolGate;
					toolSettled = true;
				}),
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("clone-boundary", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("run invalid streaming update");
		await toolWaiting;
		expect(linkedSignalAborted).toBe(true);
		expect(toolSettled).toBe(false);
		expect(harness.eventsOfType("tool_execution_end")).toEqual([]);
		releaseTool();
		await prompt;

		expect(toolSettled).toBe(true);
		expect(harness.eventsOfType("tool_execution_update")).toEqual([]);
		expect(harness.eventsOfType("tool_execution_end")[0]?.isError).toBe(true);
	});

	it("ignores tool update callbacks after execute settles", async () => {
		let lateUpdate: (() => void) | undefined;
		const tool: AgentTool = {
			name: "late-update",
			label: "Late update",
			description: "Calls its update callback after settling",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, onUpdate) => {
				lateUpdate = () =>
					onUpdate?.({
						content: [{ type: "text", text: "late" }],
						details: { callback: () => undefined },
					});
				return { content: [{ type: "text", text: "complete" }], details: { valid: true } };
			},
		};
		harness = await createHarness({ tools: [tool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("late-update", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run late update tool");
		const updateCount = harness.eventsOfType("tool_execution_update").length;
		expect(() => lateUpdate?.()).not.toThrow();
		await flushUnhandledRejections();
		expect(harness.eventsOfType("tool_execution_update")).toHaveLength(updateCount);
	});

	it("rejects non-JSON mutation by a tool_result extension", async () => {
		harness = await createHarness({
			tools: [createCloneBoundaryTool(undefined)],
			extensionFactories: [
				(volt) => {
					volt.on("tool_result", (event) => {
						if (event.toolName !== "clone-boundary") return;
						(event.details as { callback?: () => void }).callback = () => undefined;
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("clone-boundary", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run extension clone boundary");

		const toolEnd = harness.eventsOfType("tool_execution_end")[0]!;
		expect(toolEnd.isError).toBe(true);
		expect(getToolResultText(toolEnd)).toContain("Extension tool_result output from");
		expect(getToolResultText(toolEnd)).toContain("must contain only JSON-compatible data");
	});

	it("omits absent tool details before tool_result extension admission", async () => {
		const parameters = Type.Object({});
		const tool: AgentTool = {
			name: "no-details",
			label: "No details",
			description: "Returns content without optional details",
			parameters,
			execute: async () => ({ content: [{ type: "text", text: "complete" }] }),
		};
		let hookCalls = 0;
		harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(volt) => {
					volt.on("tool_result", (event) => {
						if (event.toolName !== "no-details") return;
						hookCalls++;
						expect(Object.hasOwn(event, "details")).toBe(false);
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("no-details", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run no-details tool");

		expect(hookCalls).toBe(1);
		const toolEnd = harness.eventsOfType("tool_execution_end")[0]!;
		expect(toolEnd.isError).toBe(false);
		expect(Object.hasOwn(toolEnd.result, "details")).toBe(false);
	});

	it("snapshots the listener list before publishing each event", async () => {
		harness = await createHarness();
		const originalListenerEvents: number[] = [];
		const addedListenerEvents: number[] = [];
		let queueEvent = 0;
		let changedListeners = false;
		const unsubscribeOriginal = harness.session.subscribe((event) => {
			if (event.type === "queue_update") originalListenerEvents.push(queueEvent);
		});
		harness.session.subscribe((event) => {
			if (event.type !== "queue_update" || changedListeners) return;
			changedListeners = true;
			unsubscribeOriginal();
			harness!.session.subscribe((laterEvent) => {
				if (laterEvent.type === "queue_update") addedListenerEvents.push(queueEvent);
			});
		});

		queueEvent = 1;
		await harness.session.steer("first");
		queueEvent = 2;
		await harness.session.steer("second");

		expect(originalListenerEvents).toEqual([1]);
		expect(addedListenerEvents).toEqual([2]);
	});

	it("skips an invalid optional before_agent_start message", async () => {
		let providerMessages: readonly AgentMessage[] = [];
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("before_agent_start", () => ({
						message: {
							customType: "invalid-prestart",
							content: "invalid",
							display: false,
							details: { callback: () => undefined },
						} as never,
					}));
					volt.on("context", (event) => {
						providerMessages = event.messages;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("continued")]);

		await harness.session.prompt("continue after invalid prestart");

		expect(providerMessages.some((message) => message.role === "custom")).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "invalid-prestart"),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("retains delivery when message_end returns an invalid replacement", async () => {
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "invalid", callback: () => undefined }],
							} as never,
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("must not run")]);

		const result = await harness.session.agent.prompt({
			role: "user",
			content: [{ type: "text", text: "original" }],
			timestamp: 213,
		});

		expect(result).toMatchObject({ status: "delivery_failed", failure: { outcome: "retained" } });
		expect(harness.session.agent.hasPendingPrompt()).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toEqual([]);
	});

	it("applies the same isolation policy to queue and planning projections", async () => {
		harness = await createHarness();
		const laterQueueTexts: string[] = [];
		const laterPlanningModes: string[] = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown) => {
			unhandledRejections.push(error);
		};

		harness.session.subscribe(async (event) => {
			if (event.type === "queue_update") {
				const first = event.steering[0];
				if (first) (first as { text: string }).text = "mutated queue snapshot";
			} else if (event.type === "planning_state_changed") {
				event.planning.mode = "build";
			} else {
				return;
			}
			await Promise.resolve();
			throw new Error(`asynchronous ${event.type} observer failure`);
		});
		harness.session.subscribe((event) => {
			if (event.type === "queue_update" || event.type === "planning_state_changed") {
				throw new Error(`synchronous ${event.type} observer failure`);
			}
		});
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") {
				laterQueueTexts.push(...event.steering.map((entry) => entry.text));
			} else if (event.type === "planning_state_changed") {
				laterPlanningModes.push(event.planning.mode);
			}
		});

		let planningFailure: unknown;
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			await harness.session.steer("authoritative queue projection");
			try {
				await harness.session.setAgentMode("plan");
			} catch (error) {
				planningFailure = error;
			}
			await flushUnhandledRejections();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(planningFailure).toBeUndefined();
		expect(laterQueueTexts).toEqual(["authoritative queue projection"]);
		expect(laterPlanningModes).toEqual(["plan"]);
		expect(harness.session.getSteeringMessages().map((entry) => entry.text)).toEqual([
			"authoritative queue projection",
		]);
		expect(harness.session.planningState.mode).toBe("plan");
		expect(unhandledRejections).toEqual([]);
	});
});
