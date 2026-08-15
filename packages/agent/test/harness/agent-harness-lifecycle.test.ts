import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createHarness(
	options: Omit<ConstructorParameters<typeof AgentHarness>[0], "env" | "session" | "model"> & {
		session?: Session;
	} = {},
): { harness: AgentHarness; registration: ReturnType<typeof registerFauxProvider>; session: Session } {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const session = options.session ?? new Session(new InMemorySessionStorage());
	const { session: _session, ...harnessOptions } = options;
	return {
		harness: new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			...harnessOptions,
		}),
		registration,
		session,
	};
}

function getUserTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
	});
}

function runtimeAbortSources(messages: readonly AgentMessage[]): unknown[] {
	return messages.flatMap((message) =>
		message.role === "assistant"
			? (message.diagnostics ?? []).flatMap((diagnostic) =>
					diagnostic.type === "runtime_abort" &&
					diagnostic.details &&
					typeof diagnostic.details === "object" &&
					"source" in diagnostic.details
						? [diagnostic.details["source"]]
						: [],
				)
			: [],
	);
}

describe("AgentHarness lifecycle and abort", () => {
	it("makes disposal terminal and idempotent without admitting later work", async () => {
		const { harness } = createHarness();
		const disposal = harness.dispose();
		expect(harness.dispose()).toBe(disposal);
		await disposal;

		const message: AgentMessage = { role: "user", content: "late", timestamp: Date.now() };
		expect(() => harness.queueSteer(message)).toThrow("AgentHarness is disposed");
		await expect(harness.nextTurn("late")).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.clearAllQueues()).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.run(message)).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.runPrompt("late")).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.prompt("late")).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.continue()).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.appendMessage(message)).rejects.toThrow("AgentHarness is disposed");
		await expect(harness.compact()).rejects.toThrow("AgentHarness is disposed");
	});

	it("keeps synchronous queue admission separate from passive publication completion", async () => {
		const publicationGate = deferred();
		let publicationCalls = 0;
		const { harness } = createHarness();
		harness.subscribe(async (event) => {
			if (event.type !== "queue_update") return;
			publicationCalls++;
			await publicationGate.promise;
		});

		const steerId = harness.queueSteer({ role: "user", content: "steer", timestamp: 1 });
		const followUpId = harness.queueFollowUp({ role: "user", content: "follow", timestamp: 2 });
		expect(steerId).toEqual(expect.any(String));
		expect(followUpId).toEqual(expect.any(String));
		expect(publicationCalls).toBe(2);
		publicationGate.resolve();
		await harness.clearAllQueues();
	});

	it.each(["steer", "followUp"] as const)("awaits %s queue publication before resolving", async (operation) => {
		const requestStarted = deferred();
		const releaseRequest = deferred();
		const publicationStarted = deferred();
		const releasePublication = deferred();
		const { harness, registration } = createHarness();
		registration.setResponses([
			async () => {
				requestStarted.resolve();
				await releaseRequest.promise;
				return fauxAssistantMessage("late");
			},
			() => fauxAssistantMessage("done"),
		]);
		harness.subscribe(async (event) => {
			if (event.type !== "queue_update") return;
			publicationStarted.resolve();
			await releasePublication.promise;
		});

		const running = harness.runPrompt("start");
		await requestStarted.promise;
		let settled = false;
		const queued = harness[operation]("queued").then((deliveryId) => {
			settled = true;
			return deliveryId;
		});
		await publicationStarted.promise;
		await Promise.resolve();
		expect(settled).toBe(false);

		releasePublication.resolve();
		await expect(queued).resolves.toEqual(expect.any(String));
		expect(settled).toBe(true);
		harness.abort("host_action");
		releaseRequest.resolve();
		await running;
		await harness.clearAllQueues();
	});

	it("accepts abort synchronously, preserves the first source, and exposes immutable run state", async () => {
		const requestStarted = deferred();
		const releaseRequest = deferred();
		const { harness, registration, session } = createHarness();
		registration.setResponses([
			async () => {
				requestStarted.resolve();
				await releaseRequest.promise;
				return fauxAssistantMessage("late response");
			},
		]);

		const running = harness.runPrompt("abort me");
		await requestStarted.promise;
		const beforeAbort = harness.activeRunSnapshot;
		expect(beforeAbort).toMatchObject({ requestAccepted: true, phase: "open" });
		expect(Object.isFrozen(beforeAbort)).toBe(true);
		expect(harness.signal?.aborted).toBe(false);

		const first = harness.abort("host_action");
		const second = harness.abort("disposal");
		expect(first).toMatchObject({ accepted: true, source: "host_action" });
		expect(second).toEqual(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(harness.signal?.aborted).toBe(true);
		expect(harness.activeRunSnapshot).toMatchObject({
			runId: first.runId,
			source: "host_action",
			diagnosticTimestamp: expect.any(Number),
		});

		releaseRequest.resolve();
		await running;
		const messages = (await session.buildContext()).messages as AgentMessage[];
		expect(runtimeAbortSources(messages)).toEqual(["host_action"]);
		expect(harness.signal).toBeUndefined();
		expect(harness.activeRunSnapshot).toBeUndefined();
		expect(harness.abort("remote_request")).toEqual({ accepted: false, runId: undefined, source: undefined });
	});

	it("owns caller input and explicit context before blocked preflight and across a retained retry", async () => {
		const callbackStarted = deferred();
		const releaseCallback = deferred();
		let settlementCalls = 0;
		let providerMessages: AgentMessage[] = [];
		let providerSystemPrompt = "";
		const { harness, registration, session } = createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						settlementCalls++;
						return settlementCalls === 1
							? { outcome: "retained", error: new Error("retry owned input") }
							: { outcome: "committed" };
					},
				},
			}),
		});
		const buildContext = session.buildContext.bind(session);
		vi.spyOn(session, "buildContext").mockImplementation(async () => {
			callbackStarted.resolve();
			await releaseCallback.promise;
			return await buildContext();
		});
		registration.setResponses([
			(context) => {
				providerMessages = context.messages as AgentMessage[];
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("owned");
			},
		]);
		const inputMessage: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "owned input" },
				{ type: "image", mimeType: "image/png", data: "owned-image" },
			],
			timestamp: 1,
		};
		const contextMessage: AgentMessage = { role: "user", content: "owned context", timestamp: 2 };
		const input = [inputMessage];
		const context = [contextMessage];
		const options = { systemPrompt: "owned system", context };

		const running = harness.run(input, options);
		await callbackStarted.promise;
		if (inputMessage.role !== "user" || typeof inputMessage.content === "string") {
			throw new Error("Expected structured user input");
		}
		inputMessage.content[0] = { type: "text", text: "mutated input" };
		inputMessage.content[1] = { type: "image", mimeType: "image/png", data: "mutated-image" };
		input.push({ role: "user", content: "late input", timestamp: 3 });
		contextMessage.content = "mutated context";
		context.push({ role: "user", content: "late context", timestamp: 4 });
		options.systemPrompt = "mutated system";
		options.context = [{ role: "user", content: "replacement context", timestamp: 5 }];
		releaseCallback.resolve();

		await expect(running).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained" },
		});
		inputMessage.content[0] = { type: "text", text: "mutated again" };
		contextMessage.content = "mutated again";
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });

		expect(getUserTexts(providerMessages)).toEqual(["owned context", "owned input"]);
		expect(providerSystemPrompt).toBe("owned system");
		const providerInput = providerMessages.find(
			(message) => message.role === "user" && getUserTexts([message]).includes("owned input"),
		);
		expect(
			providerInput?.role === "user" && typeof providerInput.content !== "string" ? providerInput.content[1] : null,
		).toEqual({
			type: "image",
			mimeType: "image/png",
			data: "owned-image",
		});
	});

	it.each(["runPrompt", "prompt"] as const)(
		"owns %s images and structured options before its first await",
		async (operation) => {
			const callbackStarted = deferred();
			const releaseCallback = deferred();
			let providerMessages: AgentMessage[] = [];
			let providerSystemPrompt = "";
			const { harness, registration, session } = createHarness();
			const buildContext = session.buildContext.bind(session);
			vi.spyOn(session, "buildContext").mockImplementation(async () => {
				callbackStarted.resolve();
				await releaseCallback.promise;
				return await buildContext();
			});
			registration.setResponses([
				(context) => {
					providerMessages = context.messages as AgentMessage[];
					providerSystemPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage("owned");
				},
			]);
			const image = { type: "image" as const, mimeType: "image/png", data: "owned-image" };
			const explicitContext: AgentMessage[] = [{ role: "user", content: "owned context", timestamp: 1 }];
			const options = { images: [image], context: explicitContext, systemPrompt: "owned system" };

			const running = harness[operation]("owned prompt", options);
			await callbackStarted.promise;
			image.data = "mutated-image";
			options.images.push({ type: "image", mimeType: "image/png", data: "late-image" });
			explicitContext[0] = { role: "user", content: "mutated context", timestamp: 2 };
			options.context = [{ role: "user", content: "replacement context", timestamp: 3 }];
			options.systemPrompt = "mutated system";
			releaseCallback.resolve();
			await running;

			expect(getUserTexts(providerMessages)).toEqual(["owned context", "owned prompt"]);
			expect(providerSystemPrompt).toBe("owned system");
			const promptMessage = providerMessages.find(
				(message) => message.role === "user" && getUserTexts([message]).includes("owned prompt"),
			);
			expect(
				promptMessage?.role === "user" && typeof promptMessage.content !== "string"
					? promptMessage.content.filter((part) => part.type === "image")
					: [],
			).toEqual([{ type: "image", mimeType: "image/png", data: "owned-image" }]);
		},
	);

	it("owns async system-prompt preflight and retains canceled input for explicit continuation", async () => {
		const callbackStarted = deferred();
		const releaseCallback = deferred();
		let callbackSignal: AbortSignal | undefined;
		let systemPromptCalls = 0;
		let providerSystemPrompt = "";
		const { harness, registration } = createHarness({
			systemPrompt: async ({ signal }) => {
				systemPromptCalls++;
				if (systemPromptCalls === 1) {
					callbackSignal = signal;
					callbackStarted.resolve();
					await releaseCallback.promise;
					return "retained system prompt";
				}
				return "fresh default prompt";
			},
		});
		registration.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("resumed");
			},
		]);

		const running = harness.runPrompt("cancel system preflight");
		await callbackStarted.promise;
		expect(callbackSignal).toBe(harness.signal);
		expect(harness.getPhase()).toBe("turn");
		expect(harness.activeRunSnapshot).toMatchObject({ requestAccepted: false, phase: "open" });
		let idleSettled = false;
		const waiting = harness.waitForIdle().then(() => {
			idleSettled = true;
		});
		const first = harness.abort("host_action");
		expect(first).toMatchObject({ accepted: true, source: "host_action", runId: expect.any(String) });
		expect(harness.abort("disposal")).toEqual(first);
		expect(callbackSignal?.aborted).toBe(true);
		expect(harness.activeRunSnapshot).toMatchObject({ runId: first.runId, source: "host_action" });
		await Promise.resolve();
		expect(idleSettled).toBe(false);

		releaseCallback.resolve();
		await Promise.all([running, waiting]);
		expect(registration.state.callCount).toBe(0);
		expect(harness.hasPendingPrompt()).toBe(true);
		expect(harness.activeRunSnapshot).toBeUndefined();

		await harness.continue();
		expect(registration.state.callCount).toBe(1);
		expect(systemPromptCalls).toBe(1);
		expect(providerSystemPrompt).toBe("retained system prompt");
		expect(harness.hasPendingPrompt()).toBe(false);
	});

	it("passes the active signal through before_agent_start and retains its completed payload on cancel", async () => {
		const hookStarted = deferred();
		const releaseHook = deferred();
		let hookSignal: AbortSignal | undefined;
		let hookCalls = 0;
		let providerTexts: string[] = [];
		let providerSystemPrompt = "";
		const { harness, registration } = createHarness();
		harness.on("before_agent_start", async (event) => {
			hookCalls++;
			hookSignal = event.signal;
			hookStarted.resolve();
			await releaseHook.promise;
			return {
				messages: [{ role: "user", content: "hook payload", timestamp: Date.now() }],
				systemPrompt: "hook system prompt",
			};
		});
		registration.setResponses([
			(context) => {
				providerTexts = getUserTexts(context.messages as AgentMessage[]);
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("resumed");
			},
		]);

		const running = harness.runPrompt("cancel hook preflight");
		await hookStarted.promise;
		expect(hookSignal).toBe(harness.signal);
		expect(harness.activeRunSnapshot).toMatchObject({ requestAccepted: false, phase: "open" });
		let idleSettled = false;
		const waiting = harness.waitForIdle().then(() => {
			idleSettled = true;
		});
		const first = harness.abort("remote_request");
		expect(first).toMatchObject({ accepted: true, source: "remote_request", runId: expect.any(String) });
		expect(harness.abort("disposal")).toEqual(first);
		expect(hookSignal?.aborted).toBe(true);
		await Promise.resolve();
		expect(idleSettled).toBe(false);

		releaseHook.resolve();
		await Promise.all([running, waiting]);
		expect(registration.state.callCount).toBe(0);
		expect(harness.hasPendingPrompt()).toBe(true);

		await harness.continue();
		expect(registration.state.callCount).toBe(1);
		expect(hookCalls).toBe(1);
		expect(providerTexts).toEqual(["cancel hook preflight", "hook payload"]);
		expect(providerSystemPrompt).toBe("hook system prompt");
		expect(harness.hasPendingPrompt()).toBe(false);
	});

	it("retains one prompt identity when before_agent_start rejects after system-prompt preparation", async () => {
		let systemPromptCalls = 0;
		let beforeStartCalls = 0;
		let settlementCalls = 0;
		const deliveryIds: string[] = [];
		const { harness, registration } = createHarness({
			systemPrompt: async () => {
				systemPromptCalls++;
				return "cached system prompt";
			},
			prepareDelivery: (delivery) => {
				deliveryIds.push(delivery.deliveryId);
				return {
					messages: [...delivery.messages],
					participant: {
						settle: () => {
							settlementCalls++;
							return settlementCalls === 1
								? { outcome: "retained", error: new Error("retry settlement") }
								: { outcome: "committed" };
						},
					},
				};
			},
		});
		harness.on("before_agent_start", () => {
			beforeStartCalls++;
			if (beforeStartCalls === 1) throw new Error("preflight rejected");
			return {
				messages: [{ role: "user", content: "prepared after rejection", timestamp: Date.now() }],
			};
		});
		registration.setResponses([() => fauxAssistantMessage("resumed")]);

		await expect(harness.runPrompt("retained before preflight")).rejects.toThrow("preflight rejected");
		expect(harness.hasPendingPrompt()).toBe(true);
		await expect(harness.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained" },
		});
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });

		expect(systemPromptCalls).toBe(1);
		expect(beforeStartCalls).toBe(2);
		expect(new Set(deliveryIds)).toHaveLength(1);
		expect(settlementCalls).toBe(2);
		expect(registration.state.callCount).toBe(1);
	});

	it("re-canonicalizes the first abort source across awaited message replacements", async () => {
		const terminalHookStarted = deferred();
		const releaseTerminalHook = deferred();
		const { harness, registration, session } = createHarness();
		registration.setResponses([() => fauxAssistantMessage("provider response")]);
		let laterHookSources: unknown[] = [];
		harness.on("message_end", async (event) => {
			if (event.message.role !== "assistant") return undefined;
			terminalHookStarted.resolve();
			await releaseTerminalHook.promise;
			return {
				message: {
					...event.message,
					content: [{ type: "text", text: "replacement" }],
					diagnostics: [{ type: "runtime_abort", timestamp: 1, details: { source: "disposal" } }],
				},
			};
		});
		harness.on("message_end", (event) => {
			if (event.message.role !== "assistant") return undefined;
			laterHookSources = runtimeAbortSources([event.message]);
			return undefined;
		});

		const running = harness.prompt("race replacement");
		await terminalHookStarted.promise;
		expect(harness.abort("host_action")).toMatchObject({ accepted: true, source: "host_action" });
		expect(harness.abort("disposal")).toMatchObject({ accepted: true, source: "host_action" });
		releaseTerminalHook.resolve();
		const response = await running;
		const persisted = (await session.buildContext()).messages;

		expect(laterHookSources).toEqual(["host_action"]);
		expect(runtimeAbortSources([response])).toEqual(["host_action"]);
		expect(runtimeAbortSources(persisted as AgentMessage[])).toEqual(["host_action"]);
	});

	it("retains revocable queues on abort until an explicit clear", async () => {
		const requestStarted = deferred();
		const releaseRequest = deferred();
		const { harness, registration } = createHarness();
		registration.setResponses([
			async () => {
				requestStarted.resolve();
				await releaseRequest.promise;
				return fauxAssistantMessage("late response");
			},
		]);

		const running = harness.runPrompt("initial");
		await requestStarted.promise;
		const steerId = await harness.steer("steer after abort");
		const followUpId = await harness.followUp("follow after abort");
		harness.abort("remote_request");
		expect(harness.hasQueuedMessages()).toBe(true);
		releaseRequest.resolve();
		await running;
		expect(harness.hasQueuedMessages()).toBe(true);

		expect(await harness.clearAllQueues()).toEqual([steerId, followUpId]);
		expect(harness.hasQueuedMessages()).toBe(false);
	});

	it("retains a prompt when abort wins during preparation and resumes it explicitly", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let preparationCalls = 0;
		const { harness, registration } = createHarness({
			prepareDelivery: async (delivery) => {
				preparationCalls++;
				if (preparationCalls === 1) {
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return { messages: [...delivery.messages] };
			},
		});
		registration.setResponses([() => fauxAssistantMessage("resumed")]);

		const running = harness.runPrompt("retain before begin");
		await preparationStarted.promise;
		expect(harness.abort("remote_request")).toMatchObject({ accepted: true, source: "remote_request" });
		releasePreparation.resolve();
		expect(await running).toMatchObject({ status: "completed", deliveries: [{ outcome: "retained" }] });
		expect(registration.state.callCount).toBe(0);
		expect(harness.hasPendingPrompt()).toBe(true);

		await harness.continue();
		expect(registration.state.callCount).toBe(1);
		expect(harness.hasPendingPrompt()).toBe(false);
	});

	it("exposes participant settlement and permits reentrant abort without deadlock", async () => {
		const session = new Session(new InMemorySessionStorage());
		let settlementSnapshot: Promise<void> | undefined;
		const acceptances: unknown[] = [];
		const { harness, registration } = createHarness({
			session,
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async (context) => {
						settlementSnapshot = harness.activeDeliverySettlement;
						acceptances.push(context.requestAbort("disposal"));
						for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
						return { outcome: "committed" };
					},
				},
			}),
		});
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		await harness.runPrompt("commit reentrantly");

		expect(settlementSnapshot).toBeInstanceOf(Promise);
		await expect(settlementSnapshot).resolves.toBeUndefined();
		expect(acceptances).toEqual([
			expect.objectContaining({ accepted: true, source: "disposal", runId: expect.any(String) }),
		]);
		expect(registration.state.callCount).toBe(0);
	});

	it("keeps terminal listeners inside waitForIdle while rejecting late abort intent", async () => {
		const terminalStarted = deferred();
		const releaseTerminal = deferred();
		let laterTerminalCount = 0;
		const { harness, registration } = createHarness();
		registration.setResponses([() => fauxAssistantMessage("done")]);
		harness.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			terminalStarted.resolve();
			await releaseTerminal.promise;
			throw new Error("terminal observer failure");
		});
		harness.subscribe((event) => {
			if (event.type === "agent_end") laterTerminalCount++;
		});

		const running = harness.runPrompt("settle listeners");
		await terminalStarted.promise;
		expect(harness.getPhase()).toBe("turn");
		expect(harness.activeRunSnapshot).toMatchObject({ phase: "settled" });
		expect(harness.abort("remote_request")).toMatchObject({ accepted: false });
		await expect(harness.runPrompt("overlap terminal settlement")).rejects.toMatchObject({ code: "busy" });
		let idle = false;
		const waiting = harness.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);

		releaseTerminal.resolve();
		await Promise.all([running, waiting]);
		expect(idle).toBe(true);
		expect(harness.getPhase()).toBe("idle");
		expect(laterTerminalCount).toBe(1);
	});

	it("does not issue another provider request after a tool aborts between turns", async () => {
		let harness!: AgentHarness;
		const tool: AgentTool<ReturnType<typeof Type.Object>> = {
			name: "stop_tool",
			label: "Stop Tool",
			description: "Queues work and aborts",
			parameters: Type.Object({}),
			async execute() {
				await harness.steer("queued steering");
				harness.abort("host_action");
				return { content: [{ type: "text", text: "stopped" }] };
			},
		};
		const created = createHarness({ tools: [tool] });
		harness = created.harness;
		created.registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("stop_tool", {}, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("resumed"),
		]);

		await harness.runPrompt("run tool");
		expect(created.registration.state.callCount).toBe(1);
		expect(harness.hasQueuedMessages()).toBe(true);

		await harness.continue();
		expect(created.registration.state.callCount).toBe(2);
		expect(harness.hasQueuedMessages()).toBe(false);
	});

	it("retains an ordinary preparation rejection for explicit retry", async () => {
		let preparationCalls = 0;
		const { harness, registration } = createHarness({
			prepareDelivery: (delivery) => {
				preparationCalls++;
				if (preparationCalls === 1) throw new Error("preparation failed");
				return { messages: [...delivery.messages] };
			},
		});
		registration.setResponses([() => fauxAssistantMessage("retried")]);

		await expect(harness.runPrompt("fail preparation")).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "preparation" },
		});
		expect(harness.getPhase()).toBe("idle");
		expect(harness.signal).toBeUndefined();
		expect(harness.activeRunSnapshot).toBeUndefined();
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		expect(harness.hasPendingPrompt()).toBe(true);
		expect(registration.state.callCount).toBe(0);

		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
		expect(preparationCalls).toBe(2);
		expect(harness.hasPendingPrompt()).toBe(false);
		expect(registration.state.callCount).toBe(1);
	});
});
