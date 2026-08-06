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

interface RichDetails {
	map: Map<string, { count: number }>;
	set: Set<string>;
	date: Date;
	bytes: Uint8Array;
	cycle: CyclicDetails;
}

function getToolResultText(tool: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): string {
	const content = tool.result.content as Array<{ type: string; text?: string }>;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createCloneBoundaryTool(invalidPayload: "partial" | "final" | undefined): AgentTool {
	return {
		name: "clone-boundary",
		label: "Clone boundary",
		description: "Exercise structured-clone validation",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, onUpdate) => {
			if (invalidPayload === "partial") {
				onUpdate?.({
					content: [{ type: "text", text: "partial" }],
					details: { callback: () => undefined },
				});
				return { content: [{ type: "text", text: "complete" }], details: { valid: true } };
			}
			if (invalidPayload === "final") {
				return {
					content: [{ type: "text", text: "complete" }],
					details: { callback: () => undefined },
				};
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

	it("rejects known non-cloneable custom details in the public input type", () => {
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
		).rejects.toThrow("Custom message invalid-details must contain only structured-cloneable data");

		expect(customEvents).toEqual([]);
		expect(harness.session.messages).toHaveLength(messageCount);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
	});

	it("preserves rich cyclic data while isolating each observer snapshot", async () => {
		harness = await createHarness();
		const cycle: CyclicDetails = { label: "original" };
		cycle.self = cycle;
		const details: RichDetails = {
			map: new Map([["value", { count: 1 }]]),
			set: new Set(["kept"]),
			date: new Date("2026-01-02T03:04:05.000Z"),
			bytes: new Uint8Array([1, 2, 3]),
			cycle,
		};
		const laterSnapshots: RichDetails[] = [];

		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "custom") return;
			const snapshot = event.message.details as RichDetails;
			snapshot.map.get("value")!.count = 99;
			snapshot.set.add("mutated");
			snapshot.date.setUTCFullYear(2000);
			snapshot.bytes[0] = 9;
			snapshot.cycle.label = "mutated";
		});
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "custom") return;
			laterSnapshots.push(event.message.details as RichDetails);
		});

		await harness.session.sendCustomMessage({
			customType: "rich-details",
			content: "rich",
			display: true,
			details,
		});

		expect(laterSnapshots).toHaveLength(1);
		const later = laterSnapshots[0]!;
		expect(later.map.get("value")?.count).toBe(1);
		expect([...later.set]).toEqual(["kept"]);
		expect(later.date.toISOString()).toBe("2026-01-02T03:04:05.000Z");
		expect([...later.bytes]).toEqual([1, 2, 3]);
		expect(later.cycle.label).toBe("original");
		expect(later.cycle.self).toBe(later.cycle);
		expect(details.map.get("value")?.count).toBe(1);
	});

	it.each(["partial", "final"] as const)(
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
			expect(getToolResultText(toolEnd)).toContain(
				`Tool clone-boundary ${invalidPayload} result must contain only structured-cloneable data`,
			);
			if (invalidPayload === "partial") {
				expect(harness.eventsOfType("tool_execution_update")).toEqual([]);
			}
			expect(harness.eventsOfType("message_end").some((event) => event.message.role === "toolResult")).toBe(true);
		},
	);

	it("rejects clone-incompatible mutation by a tool_result extension", async () => {
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
		expect(getToolResultText(toolEnd)).toContain(
			"Extension tool_result output for clone-boundary must contain only structured-cloneable data",
		);
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
