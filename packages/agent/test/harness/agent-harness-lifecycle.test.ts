import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
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

	it("cleans up lifecycle state after a retained preparation failure", async () => {
		const { harness, registration } = createHarness({
			prepareDelivery: () => {
				throw new Error("preparation failed");
			},
		});
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

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
	});
});
