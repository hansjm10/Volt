import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type {
	AgentDeliveryCommitContext,
	AgentDeliveryOwner,
	AgentDeliveryPreparationOutcome,
	AgentMessage,
} from "../../src/types.ts";

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

function getUserTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
	});
}

function createHarness(options: { session?: Session; deliveryOwner?: AgentDeliveryOwner } = {}) {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const session = options.session ?? new Session(new InMemorySessionStorage());
	return {
		harness: new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			...(options.deliveryOwner === undefined ? {} : { deliveryOwner: options.deliveryOwner }),
		}),
		registration,
		session,
	};
}

function createPersistingOwner(session: Session, overrides: Partial<AgentDeliveryOwner> = {}): AgentDeliveryOwner {
	return {
		prepareLogical: (context) => ({ outcome: "prepared", messages: structuredClone(context.sourceMessages) }),
		commitAttempt: async (context) => {
			return { outcome: "committed", receipt: await commitMessages(session, context) };
		},
		finish: () => undefined,
		...overrides,
	};
}

async function commitMessages(session: Session, context: AgentDeliveryCommitContext): Promise<unknown> {
	const snapshot = await session.getBranchSnapshot();
	const result = await session.commitBatch({
		guard: { kind: "exact", cursor: snapshot.cursor },
		mutations: context.preparedMessages.map((message) => ({
			kind: "append" as const,
			entry: { type: "message" as const, message: structuredClone(message) },
		})),
		deliveryAttribution: {
			deliveryId: context.deliveryId,
			epoch: context.epoch,
			attemptId: context.attemptId,
		},
	});
	if (result.outcome !== "committed") throw result.error;
	return result.receipt;
}

async function attestNoEffect(session: Session, context: AgentDeliveryCommitContext): Promise<unknown> {
	const snapshot = await session.getBranchSnapshot();
	const result = await session.commitBatch({
		guard: { kind: "exact", cursor: snapshot.cursor },
		mutations: [],
		deliveryAttribution: {
			deliveryId: context.deliveryId,
			epoch: context.epoch,
			attemptId: context.attemptId,
		},
	});
	if (result.outcome !== "committed") throw result.error;
	return result.receipt;
}

describe("AgentHarness delivery ownership", () => {
	it("exposes immutable preparation outcomes", () => {
		const assertReadonly = (preparation: AgentDeliveryPreparationOutcome): void => {
			if (preparation.outcome !== "prepared") return;
			// @ts-expect-error Prepared messages are readonly.
			preparation.messages = [];
			// @ts-expect-error Prepared message arrays are readonly.
			preparation.messages.push({ role: "user", content: "invalid", timestamp: 0 });
		};
		expectTypeOf(assertReadonly).toBeFunction();
	});

	it("awaits preparation and commit before publication or provider work", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		const session = new Session(new InMemorySessionStorage());
		let deliveryId = "";
		const owner = createPersistingOwner(session, {
			prepareLogical: async (context) => {
				deliveryId = context.deliveryId;
				preparationStarted.resolve();
				await releasePreparation.promise;
				return { outcome: "prepared", messages: context.sourceMessages };
			},
			commitAttempt: async (context) => {
				commitStarted.resolve();
				await releaseCommit.promise;
				return { outcome: "committed", receipt: await commitMessages(session, context) };
			},
		});
		const { harness, registration } = createHarness({ session, deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("done")]);

		const running = harness.runPrompt("transactional prompt");
		await preparationStarted.promise;
		expect(registration.state.callCount).toBe(0);
		expect((await session.buildContext()).messages).toEqual([]);
		releasePreparation.resolve();
		await commitStarted.promise;
		expect(await harness.discardPendingPrompt()).toEqual([]);
		expect(registration.state.callCount).toBe(0);
		releaseCommit.resolve();

		await expect(running).resolves.toEqual({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "committed" }],
		});
		expect(registration.state.callCount).toBe(1);
	});

	it("caches logical preparation once and creates a fresh retained attempt", async () => {
		const session = new Session(new InMemorySessionStorage());
		let prepareCalls = 0;
		let commitCalls = 0;
		const attempts: string[] = [];
		const owner = createPersistingOwner(session, {
			prepareLogical: (context) => {
				prepareCalls++;
				return { outcome: "prepared", messages: context.sourceMessages };
			},
			commitAttempt: async (context) => {
				attempts.push(context.attemptId);
				commitCalls++;
				if (commitCalls === 1) {
					return {
						outcome: "retained",
						error: new Error("safe retry"),
						noEffectReceipt: await attestNoEffect(session, context),
					};
				}
				return { outcome: "committed", receipt: await commitMessages(session, context) };
			},
		});
		const { harness, registration } = createHarness({ session, deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("retried")]);

		await expect(harness.runPrompt("retry me")).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained" },
		});
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });

		expect(prepareCalls).toBe(1);
		expect(commitCalls).toBe(2);
		expect(new Set(attempts)).toHaveLength(2);
		expect(registration.state.callCount).toBe(1);
	});

	it("keeps a retained rollback unavailable until owner finalization settles", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const finishStarted = deferred();
		const releaseFinish = deferred();
		const session = new Session(new InMemorySessionStorage());
		let prepareCalls = 0;
		const owner = createPersistingOwner(session, {
			prepareLogical: async (context) => {
				prepareCalls++;
				if (prepareCalls === 1) {
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return { outcome: "prepared", messages: context.sourceMessages };
			},
			finish: async (context) => {
				if (context.outcome !== "retained") return;
				finishStarted.resolve();
				await releaseFinish.promise;
			},
		});
		const { harness, registration } = createHarness({ session, deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("resumed")]);

		const running = harness.runPrompt("rollback me");
		await preparationStarted.promise;
		harness.abort("remote_request");
		releasePreparation.resolve();
		await finishStarted.promise;
		await expect(harness.continue()).rejects.toMatchObject({ code: "busy" });
		expect(registration.state.callCount).toBe(0);

		releaseFinish.resolve();
		await expect(running).resolves.toMatchObject({ deliveries: [{ outcome: "retained" }] });
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
		expect(prepareCalls).toBe(1);
		expect(registration.state.callCount).toBe(1);
	});

	it("serializes discard behind an in-flight retained rollback finalizer", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const retainedFinishStarted = deferred();
		const releaseRetainedFinish = deferred();
		const revokedFinishCompleted = deferred();
		const finishCalls: Array<{ attemptId: string | undefined; outcome: string }> = [];
		const session = new Session(new InMemorySessionStorage());
		const owner = createPersistingOwner(session, {
			prepareLogical: async (context) => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return { outcome: "prepared", messages: context.sourceMessages };
			},
			finish: async (context) => {
				finishCalls.push({ attemptId: context.attemptId, outcome: context.outcome });
				if (context.outcome === "retained") {
					retainedFinishStarted.resolve();
					await releaseRetainedFinish.promise;
				} else if (context.outcome === "revoked") {
					revokedFinishCompleted.resolve();
				}
			},
		});
		const { harness } = createHarness({ session, deliveryOwner: owner });

		const running = harness.runPrompt("discard rollback");
		await preparationStarted.promise;
		harness.abort("remote_request");
		releasePreparation.resolve();
		await retainedFinishStarted.promise;

		const discarding = harness.discardPendingPrompt();
		await Promise.resolve();
		expect(finishCalls).toEqual([{ attemptId: expect.any(String), outcome: "retained" }]);
		releaseRetainedFinish.resolve();
		await expect(discarding).resolves.toHaveLength(1);
		await revokedFinishCompleted.promise;
		await running;

		expect(finishCalls).toEqual([
			{ attemptId: expect.any(String), outcome: "retained" },
			{ attemptId: undefined, outcome: "revoked" },
		]);
		expect(harness.hasPendingPrompt()).toBe(false);
	});

	it("coerces retained preparation to terminal when owner finalization fails", async () => {
		const owner: AgentDeliveryOwner = {
			prepareLogical: () => ({ outcome: "retained", error: new Error("retry requested") }),
			commitAttempt: () => {
				throw new Error("commit must not run");
			},
			finish: () => {
				throw new Error("owner cleanup failed");
			},
		};
		const { harness, registration } = createHarness({ deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		await expect(harness.runPrompt("cannot retain")).resolves.toMatchObject({
			status: "delivery_failed",
			failure: {
				outcome: "terminally_failed",
				phase: "preparation",
				error: expect.objectContaining({ message: "Delivery preparation and owner finalization failed" }),
			},
		});
		await harness.waitForClosed();

		expect(harness.hasPendingPrompt()).toBe(false);
		expect(registration.state.callCount).toBe(0);
		await expect(harness.continue()).rejects.toThrow("AgentHarness is disposed");
	});

	it("classifies preparation rejection as terminal without provider work", async () => {
		let finishOutcome = "";
		const owner: AgentDeliveryOwner = {
			prepareLogical: () => Promise.reject(new Error("preparation crashed")),
			commitAttempt: () => {
				throw new Error("commit must not run");
			},
			finish: (context) => {
				finishOutcome = context.outcome;
			},
		};
		const { harness, registration } = createHarness({ deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		await expect(harness.runPrompt("unsafe")).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "preparation" },
		});
		expect(finishOutcome).toBe("terminally_failed");
		expect(registration.state.callCount).toBe(0);
		expect(harness.hasPendingPrompt()).toBe(false);
	});

	it("fences retired canonical authority without producing failure messages", async () => {
		const owner: AgentDeliveryOwner = {
			prepareLogical: (context) => ({ outcome: "prepared", messages: context.sourceMessages }),
			commitAttempt: () => ({
				outcome: "terminally_failed",
				error: new Error("commit authority is uncertain"),
				authority: "retired",
			}),
			finish: () => undefined,
		};
		const { harness, registration, session } = createHarness({ deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		await expect(harness.runPrompt("uncertain")).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});
		await harness.waitForClosed();

		expect(registration.state.callCount).toBe(0);
		expect((await session.buildContext()).messages).toEqual([]);
		await expect(harness.runPrompt("late")).rejects.toThrow("AgentHarness is disposed");
	});

	it("fault-closes after committed durability when owner finalization fails", async () => {
		const session = new Session(new InMemorySessionStorage());
		const owner = createPersistingOwner(session, {
			finish: (context) => {
				if (context.outcome === "committed") throw new Error("committed cleanup failed");
			},
		});
		const { harness, registration } = createHarness({ session, deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("must not run")]);

		await expect(harness.runPrompt("durable input")).resolves.toMatchObject({
			deliveries: [{ outcome: "committed" }],
		});
		await expect(harness.waitForClosed()).rejects.toThrow("AgentHarness close drains failed");

		expect(getUserTexts((await session.buildContext()).messages)).toEqual(["durable input"]);
		expect(registration.state.callCount).toBe(0);
		await expect(harness.continue()).rejects.toThrow("AgentHarness is disposed");
	});

	it("rejects an attributed retained receipt with a canonical label effect", async () => {
		const session = new Session(new InMemorySessionStorage());
		const targetId = await session.appendMessage({ role: "user", content: "basis", timestamp: 1 });
		const owner = createPersistingOwner(session, {
			commitAttempt: async (context) => {
				const snapshot = await session.getBranchSnapshot();
				const result = await session.commitBatch({
					guard: { kind: "exact", cursor: snapshot.cursor },
					mutations: [
						{
							kind: "append",
							entry: { type: "label", targetId, label: "not a no-effect" },
						},
					],
					deliveryAttribution: {
						deliveryId: context.deliveryId,
						epoch: context.epoch,
						attemptId: context.attemptId,
					},
				});
				if (result.outcome !== "committed") throw result.error;
				return {
					outcome: "retained",
					error: new Error("pretend retry"),
					noEffectReceipt: result.receipt,
				};
			},
		});
		const { harness, registration } = createHarness({ session, deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("must not run")]);

		await expect(harness.runPrompt("malicious receipt")).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});
		await harness.waitForClosed();
		expect(registration.state.callCount).toBe(0);
	});

	it("revokes pending preparation and ignores its late completion", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let commitCalls = 0;
		let finishOutcome = "";
		const owner: AgentDeliveryOwner = {
			prepareLogical: async (context) => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return { outcome: "prepared", messages: context.sourceMessages };
			},
			commitAttempt: () => {
				commitCalls++;
				return { outcome: "committed", receipt: {} };
			},
			finish: (context) => {
				finishOutcome = context.outcome;
			},
		};
		const { harness, registration } = createHarness({ deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		const running = harness.runPrompt("revoke me");
		await preparationStarted.promise;
		const discarding = harness.discardPendingPrompt();
		await Promise.resolve();
		expect(finishOutcome).toBe("");
		releasePreparation.resolve();
		await expect(discarding).resolves.toHaveLength(1);
		await expect(running).resolves.toMatchObject({ deliveries: [{ outcome: "revoked" }] });
		expect(finishOutcome).toBe("revoked");
		expect(commitCalls).toBe(0);
		expect(registration.state.callCount).toBe(0);
	});

	it("fault-closes when detached revocation finalization fails", async () => {
		const owner: AgentDeliveryOwner = {
			prepareLogical: (context) => ({ outcome: "prepared", messages: context.sourceMessages }),
			commitAttempt: () => {
				throw new Error("commit must not run");
			},
			finish: () => {
				throw new Error("revocation cleanup failed");
			},
		};
		const { harness } = createHarness();
		harness.queueSteer({ role: "user", content: "revoke", timestamp: 1 }, owner);

		await expect(harness.clearSteeringQueue()).rejects.toThrow("revocation cleanup failed");

		await expect(harness.waitForClosed()).rejects.toThrow("AgentHarness close drains failed");
		await expect(harness.runPrompt("late")).rejects.toThrow("AgentHarness is disposed");
	});

	it("preserves a committed FIFO prefix when the next delivery retains", async () => {
		const session = new Session(new InMemorySessionStorage());
		let retained = true;
		const owner = createPersistingOwner(session, {
			commitAttempt: async (context) => {
				const text = getUserTexts(context.preparedMessages)[0];
				if (text === "second" && retained) {
					return {
						outcome: "retained",
						error: new Error("retain second"),
						noEffectReceipt: await attestNoEffect(session, context),
					};
				}
				return { outcome: "committed", receipt: await commitMessages(session, context) };
			},
		});
		const { harness, registration } = createHarness({ session, deliveryOwner: owner });
		registration.setResponses([() => fauxAssistantMessage("done")]);
		harness.queueSteer({ role: "user", content: "first", timestamp: 1 }, owner);
		harness.queueSteer({ role: "user", content: "second", timestamp: 2 }, owner);

		await expect(harness.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			deliveries: [{ outcome: "committed" }, { outcome: "retained" }],
		});
		expect(getUserTexts((await session.buildContext()).messages)).toEqual(["first"]);
		retained = false;
		await expect(harness.continue()).resolves.toMatchObject({ status: "completed" });
		expect(getUserTexts((await session.buildContext()).messages)).toEqual(["first", "second"]);
	});
});
