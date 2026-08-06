import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
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
