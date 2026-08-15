import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createUserMessage(text: string): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("regression #205: coding-agent delivery participant migration", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
	});

	it("publishes delivery projections only after canonical durability settles", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("committed")]);
		const clientMessageId = "participant-durability-publication";
		const durabilityStarted = deferred();
		const releaseDurability = deferred();
		const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
		let gated = false;
		vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
			const watermark = originalFlush();
			if (!gated && harness?.sessionManager.getClientInput(clientMessageId)?.state === "completed") {
				gated = true;
				durabilityStarted.resolve();
				return watermark.then(() => releaseDurability.promise);
			}
			return watermark;
		});
		const projections: string[] = [];
		const preflightResults: PromptPreflightResult[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "delivery_start") projections.push(event.type);
		});

		const prompt = harness.session.prompt("durability before publication", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflightResults.push(result),
		});
		await durabilityStarted.promise;

		expect(projections).toEqual([]);
		expect(preflightResults).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		releaseDurability.resolve();
		await prompt;

		expect(projections).toEqual(["delivery_start"]);
		expect(preflightResults).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("settles one failed direct RPC attempt and retries the same durable input explicitly", async () => {
		let retain = true;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () =>
						retain ? { outcome: "retained", error: new Error("retry direct input") } : { outcome: "committed" },
				},
			}),
		});
		harness.setResponses([fauxAssistantMessage("committed after retry")]);
		const clientMessageId = "participant-retained-direct-rpc";
		const firstPreflight: PromptPreflightResult[] = [];

		await expect(
			harness.session.prompt("retryable direct input", {
				clientMessageId,
				source: "rpc",
				preflightResult: (result) => firstPreflight.push(result),
			}),
		).rejects.toThrow("retry direct input");
		expect(firstPreflight).toEqual([{ success: false }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.getPendingResponseCount()).toBe(1);

		retain = false;
		const retryPreflight: PromptPreflightResult[] = [];
		await harness.session.prompt("retryable direct input", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => retryPreflight.push(result),
		});

		expect(retryPreflight).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(getUserTexts(harness)).toEqual(["retryable direct input"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rebases a retained direct prompt onto the branch selected by tree navigation", async () => {
		let retain = true;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () =>
						retain
							? { outcome: "retained", error: new Error("navigate before retry") }
							: { outcome: "committed" },
				},
			}),
		});
		const rootId = harness.sessionManager.appendMessage(createUserMessage("abandoned branch root"));
		harness.sessionManager.appendMessage(fauxAssistantMessage("abandoned branch assistant"));
		const providerTexts: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTexts.push((context.messages as AgentMessage[]).map(getMessageText));
				return fauxAssistantMessage("committed on selected branch");
			},
		]);
		const clientMessageId = "retained-navigation-rebase";

		await expect(
			harness.session.prompt("retained branch prompt", { clientMessageId, source: "rpc" }),
		).rejects.toThrow("navigate before retry");
		expect(harness.control.hasPendingPrompt()).toBe(true);

		await expect(harness.session.navigateTree(rootId)).resolves.toMatchObject({
			cancelled: false,
			editorText: "abandoned branch root",
		});
		expect(harness.sessionManager.getLeafId()).toBeNull();
		expect(harness.control.hasPendingPrompt()).toBe(true);

		retain = false;
		await harness.session.prompt("retained branch prompt", { clientMessageId, source: "rpc" });

		expect(providerTexts).toEqual([["retained branch prompt"]]);
		expect(getUserTexts(harness)).toEqual(["retained branch prompt"]);
		expect(harness.control.hasPendingPrompt()).toBe(false);
	});

	it("does not install prepared payload state after disposal interrupts upstream preparation", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		harness = await createHarness({
			prepareDelivery: async (delivery) => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return { messages: [...delivery.messages] };
			},
		});
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const prompting = harness.session.prompt("dispose during upstream preparation").catch(() => {});

		await preparationStarted.promise;
		const disposal = harness.session.dispose("disposal");
		releasePreparation.resolve();
		await Promise.all([prompting, disposal]);

		const preparationState = harness.session as unknown as {
			_preparedDeliveryExtensions: Map<string, unknown>;
			_preparingDeliveryExtensions: Map<string, unknown>;
		};
		expect(preparationState._preparedDeliveryExtensions.size).toBe(0);
		expect(preparationState._preparingDeliveryExtensions.size).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("settles a direct RPC attempt revoked through the public Agent during preparation", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_start", async (event) => {
						if (event.message.role !== "user") return;
						preparationStarted.resolve();
						await releasePreparation.promise;
					});
				},
			],
		});
		const clientMessageId = "participant-public-revocation";
		const preflight: PromptPreflightResult[] = [];
		const prompting = harness.session.prompt("revoke during preparation", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});

		await preparationStarted.promise;
		expect(await harness.control.discardPendingPrompt()).toHaveLength(1);
		releasePreparation.resolve();
		await expect(prompting).rejects.toThrow("Delivery was revoked before canonical commitment");

		expect(preflight).toEqual([{ success: false }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reconciles a prompt revoked reentrantly during AgentSession queue clearing", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_start", async (event) => {
						if (event.message.role !== "user") return;
						preparationStarted.resolve();
						await releasePreparation.promise;
					});
				},
			],
		});
		const clientMessageId = "participant-reentrant-prompt-revocation";
		const preflight: PromptPreflightResult[] = [];
		const prompting = harness.session.prompt("revoke prompt reentrantly", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});
		await preparationStarted.promise;
		await harness.session.steer("clear while preparing");
		const sessionRevocation = harness.control.getDeliveryRevoked();
		let discardedPrompt = false;
		harness.control.setDeliveryRevoked((delivery) => {
			if (delivery.kind === "steer" && !discardedPrompt) {
				discardedPrompt = true;
				void harness!.control.discardPendingPrompt();
			}
			sessionRevocation?.(delivery);
		});

		await harness.session.clearQueue();
		releasePreparation.resolve();
		await expect(prompting).rejects.toThrow("Delivery was revoked before canonical commitment");

		expect(preflight).toEqual([{ success: false }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rolls back a direct RPC attempt when canonical append rejects synchronously", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("committed after append retry")]);
		const clientMessageId = "participant-sync-append-failure";
		const appendMessage = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		const appendFailure = new Error("injected synchronous canonical append failure");
		const appendSpy = vi.spyOn(harness.sessionManager, "appendMessage").mockImplementationOnce(() => {
			throw appendFailure;
		});
		const firstPreflight: PromptPreflightResult[] = [];

		await expect(
			harness.session.prompt("append retry", {
				clientMessageId,
				source: "rpc",
				preflightResult: (result) => firstPreflight.push(result),
			}),
		).rejects.toThrow(appendFailure.message);
		expect(firstPreflight).toEqual([{ success: false }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.control.hasPendingPrompt()).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);

		appendSpy.mockImplementation(appendMessage);
		await harness.session.prompt("append retry", { clientMessageId, source: "rpc" });
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["append retry"]);
	});

	it("reuses one extension-transformed payload across a retained retry", async () => {
		let retain = true;
		let extensionRuns = 0;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () =>
						retain ? { outcome: "retained", error: new Error("retry explicitly") } : { outcome: "committed" },
				},
			}),
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						extensionRuns++;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: `transformed once (${extensionRuns})` }],
							},
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("committed")]);

		await expect(harness.control.run(createUserMessage("original"))).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained" },
		});
		retain = false;
		await harness.control.continue();

		expect(extensionRuns).toBe(1);
		expect(getUserTexts(harness)).toEqual(["transformed once (1)"]);
	});

	it("retains a completed extension transformation when abort wins before settlement", async () => {
		const extensionStarted = deferred();
		const releaseExtension = deferred();
		let extensionRuns = 0;
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role !== "user") return;
						extensionRuns++;
						extensionStarted.resolve();
						await releaseExtension.promise;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "cached after abort" }],
							},
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("committed after abort")]);

		const firstAttempt = harness.control.run(createUserMessage("original"));
		await extensionStarted.promise;
		const aborting = harness.session.abort("host_action");
		releaseExtension.resolve();
		await Promise.all([firstAttempt, aborting]);

		expect(extensionRuns).toBe(1);
		expect(harness.control.hasPendingPrompt()).toBe(true);
		await harness.control.continue();

		expect(extensionRuns).toBe(1);
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["cached after abort"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("fails closed when upstream preparation changes after an AgentSession retained attempt", async () => {
		let preparationCalls = 0;
		let extensionRuns = 0;
		let settlementCalls = 0;
		harness = await createHarness({
			prepareDelivery: (delivery) => {
				preparationCalls++;
				return {
					messages:
						preparationCalls === 1
							? delivery.messages.map((message) => structuredClone(message))
							: [createUserMessage("changed upstream preparation")],
					participant: {
						settle: () => {
							settlementCalls++;
							return { outcome: "retained", error: new Error("retain first upstream attempt") };
						},
					},
				};
			},
			extensionFactories: [
				(volt) => {
					volt.on("message_start", (event) => {
						if (event.message.role === "user") extensionRuns++;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await expect(harness.control.run(createUserMessage("stable upstream preparation"))).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});
		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: {
				outcome: "terminally_failed",
				phase: "preparation",
				error: {
					name: "AgentDeliveryPreparationReplayMismatchError",
					message: expect.stringContaining("changed the prepared messages"),
				},
			},
		});

		expect(preparationCalls).toBe(2);
		expect(extensionRuns).toBe(1);
		expect(settlementCalls).toBe(1);
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
		await expect(harness.control.continue()).resolves.toEqual({ status: "completed", deliveries: [] });
		expect(preparationCalls).toBe(2);
	});

	it("disposal revokes a retained prompt and clears all replay authority", async () => {
		const revokedDeliveryIds: string[] = [];
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => ({ outcome: "retained", error: new Error("retain until disposal") }),
				},
			}),
		});
		harness.control.setDeliveryRevoked((delivery) => revokedDeliveryIds.push(delivery.deliveryId));
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await expect(harness.control.run(createUserMessage("dispose retained prompt"))).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});
		expect(harness.control.hasPendingPrompt()).toBe(true);
		const internals = harness.session as unknown as {
			_harness: {
				deliveryPreparationStates: Map<string, unknown>;
				deliveryAttemptParticipants: Map<string, unknown>;
				continuationState: unknown;
				contextProjection: unknown;
			};
			_preparingDeliveryExtensions: Map<string, unknown>;
			_preparedDeliveryExtensions: Map<string, unknown>;
		};
		expect(internals._harness.deliveryPreparationStates.size).toBe(1);
		expect(internals._preparedDeliveryExtensions.size).toBe(1);

		await harness.session.dispose("disposal");

		expect(revokedDeliveryIds).toHaveLength(1);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(internals._harness.deliveryPreparationStates.size).toBe(0);
		expect(internals._harness.deliveryAttemptParticipants.size).toBe(0);
		expect(internals._harness.continuationState).toBeUndefined();
		expect(internals._harness.contextProjection).toBeUndefined();
		expect(internals._preparingDeliveryExtensions.size).toBe(0);
		expect(internals._preparedDeliveryExtensions.size).toBe(0);
		await expect(harness.control.continue()).rejects.toThrow("AgentHarness is disposed");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("terminally fences an uncertain durability failure after canonical append", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("must not run")]);
		vi.spyOn(harness.sessionManager, "flush").mockRejectedValueOnce(new Error("injected durability failure"));

		await expect(harness.control.run(createUserMessage("uncertain canonical append"))).resolves.toMatchObject({
			status: "delivery_failed",
			failure: {
				kind: "prompt",
				outcome: "terminally_failed",
				phase: "settlement",
				error: { message: "injected durability failure" },
			},
		});

		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
