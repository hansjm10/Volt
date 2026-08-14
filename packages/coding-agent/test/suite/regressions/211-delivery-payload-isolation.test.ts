import type { AgentMessage, AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createNestedUserMessage(
	text: string,
	imageData: string,
	timestamp: number,
): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", mimeType: "image/png", data: imageData },
		],
		timestamp,
	};
}

function mutateRetainedMessages(messages: AgentMessage[]): void {
	messages.reverse();
	for (const message of messages) {
		if (message.role !== "user") continue;
		message.timestamp = 1;
		if (typeof message.content === "string") {
			message.content = "mutated during settlement";
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") part.text = "mutated during settlement";
			if (part.type === "image") part.data = "bXV0YXRlZA==";
		}
	}
}

function findUser(messages: readonly AgentMessage[]): Extract<AgentMessage, { role: "user" }> | undefined {
	return messages.find((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user");
}

describe("regression #211: delivery payload isolation", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps canonical, finalized-event, delivery-event, and provider payloads identical when an upstream participant mutates", async () => {
		let providerUser: Extract<AgentMessage, { role: "user" }> | undefined;
		let deliveryUser: Extract<AgentMessage, { role: "user" }> | undefined;
		harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [...delivery.messages];
				return {
					messages,
					participant: {
						settle: () => {
							mutateRetainedMessages(messages);
							return { outcome: "committed" };
						},
					},
				};
			},
			extensionFactories: [
				(volt) => {
					volt.on("context", (event) => {
						const user = findUser(event.messages);
						if (user) providerUser = structuredClone(user);
						return { messages: event.messages };
					});
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type !== "delivery_start") return;
			const user = findUser(event.messages);
			if (user) deliveryUser = structuredClone(user);
		});
		harness.setResponses([fauxAssistantMessage("committed")]);
		const expected = createNestedUserMessage("immutable original", "b3JpZ2luYWw=", 123);

		await harness.control.run(expected);

		const canonicalUser = findUser(harness.sessionManager.buildSessionContext().messages);
		const agentUser = findUser(harness.session.state.messages);
		expect(canonicalUser).toEqual(expected);
		expect(agentUser).toEqual(expected);
		expect(deliveryUser).toEqual(expected);
		expect(providerUser).toEqual(expected);
	});

	it("reuses the isolated extension-transformed snapshot after a retained attempt mutates every exposed reference", async () => {
		let retain = true;
		let extensionRuns = 0;
		let extensionReference: Extract<AgentMessage, { role: "user" }> | undefined;
		let providerUser: Extract<AgentMessage, { role: "user" }> | undefined;
		let deliveryUser: Extract<AgentMessage, { role: "user" }> | undefined;
		harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [...delivery.messages];
				return {
					messages,
					participant: {
						settle: () => {
							mutateRetainedMessages(messages);
							if (extensionReference) mutateRetainedMessages([extensionReference]);
							return retain
								? { outcome: "retained", error: new Error("retry isolated payload") }
								: { outcome: "committed" };
						},
					},
				};
			},
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						extensionRuns++;
						extensionReference = {
							...event.message,
							content: [
								{ type: "text", text: "transformed once" },
								{ type: "image", mimeType: "image/png", data: "dHJhbnNmb3JtZWQ=" },
							],
						};
						return { message: extensionReference };
					});
					volt.on("context", (event) => {
						const user = findUser(event.messages);
						if (user) providerUser = structuredClone(user);
						return { messages: event.messages };
					});
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type !== "delivery_start") return;
			const user = findUser(event.messages);
			if (user) deliveryUser = structuredClone(user);
		});
		harness.setResponses([fauxAssistantMessage("committed after retry")]);
		const original = createNestedUserMessage("original", "b3JpZ2luYWw=", 456);
		const expected = createNestedUserMessage("transformed once", "dHJhbnNmb3JtZWQ=", 456);

		await expect(harness.control.run(original)).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained" },
		});
		retain = false;
		await harness.control.continue();

		const canonicalUser = findUser(harness.sessionManager.buildSessionContext().messages);
		const agentUser = findUser(harness.session.state.messages);
		expect(extensionRuns).toBe(1);
		expect(canonicalUser).toEqual(expected);
		expect(agentUser).toEqual(expected);
		expect(deliveryUser).toEqual(expected);
		expect(providerUser).toEqual(expected);
	});

	it("does not start extension preparation after revocation wins during upstream preparation", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let extensionRuns = 0;
		harness = await createHarness({
			prepareDelivery: async (delivery) => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return { messages: [...delivery.messages] };
			},
			extensionFactories: [
				(volt) => {
					volt.on("message_start", () => {
						extensionRuns++;
					});
				},
			],
		});
		const clientMessageId = "revoked-before-extension-preparation";
		const prompting = harness.session.prompt("revoke before extensions", { clientMessageId, source: "rpc" });

		await preparationStarted.promise;
		expect(await harness.control.discardPendingPrompt()).toHaveLength(1);
		releasePreparation.resolve();
		await expect(prompting).rejects.toThrow("Delivery was revoked before canonical commitment");

		expect(extensionRuns).toBe(0);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");
		expect(harness.control.hasQueuedMessages()).toBe(false);
	});

	it("reuses queue ownership with the cached payload when retained upstream messages lose their runtime identity", async () => {
		let releaseTool = (): void => undefined;
		let markToolStarted = (): void => undefined;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait-for-retained-queue",
			label: "Wait",
			description: "Wait for retained queue delivery",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		let retainedMessages: AgentMessage[] | undefined;
		let retain = true;
		harness = await createHarness({
			tools: [waitTool],
			prepareDelivery: (delivery) => {
				if (delivery.kind !== "steer") return { messages: [...delivery.messages] };
				retainedMessages ??= [...delivery.messages];
				return {
					messages: retainedMessages,
					participant: {
						settle: () => {
							if (retain) {
								mutateRetainedMessages(retainedMessages!);
								const user = findUser(retainedMessages!);
								if (user) user.clientMessageId = "substituted-runtime-identity";
								retain = false;
								return { outcome: "retained", error: new Error("retry retained queue") };
							}
							return { outcome: "committed" };
						},
					},
				};
			},
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait-for-retained-queue", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("queued turn complete"),
		]);
		const activeRun = harness.session.prompt("start retained queue");
		await toolStarted;
		const clientMessageId = "retained-queue-client";
		await harness.session.steer("queued immutable payload", undefined, clientMessageId);

		releaseTool();
		await activeRun;
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.session.getSteeringMessages()).toHaveLength(1);

		await harness.control.continue();

		const canonicalUser = harness.sessionManager
			.buildSessionContext()
			.messages.find(
				(message): message is Extract<AgentMessage, { role: "user" }> =>
					message.role === "user" && message.clientMessageId === clientMessageId,
			);
		expect(canonicalUser?.content).toEqual([{ type: "text", text: "queued immutable payload" }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
