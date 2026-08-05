import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => {};
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

function persistedAssistantMessages(harness: Harness): AssistantMessage[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
}

function runtimeAbortSources(harness: Harness): string[] {
	return persistedAssistantMessages(harness).flatMap((message) =>
		(message.diagnostics ?? []).flatMap((diagnostic) =>
			diagnostic.type === "runtime_abort" &&
			diagnostic.details &&
			typeof diagnostic.details === "object" &&
			"source" in diagnostic.details &&
			typeof diagnostic.details.source === "string"
				? [diagnostic.details.source]
				: [],
		),
	);
}

describe("regression #199: abort provenance persistence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists a remote-request source for a joined local abort", async () => {
		const responseStarted = deferred();
		const finishResponse = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await finishResponse.promise;
				return fauxAssistantMessage("late response");
			},
		]);

		const prompt = harness.session.prompt("wait for cancellation");
		await responseStarted.promise;
		const abort = harness.session.abort("remote_request");
		finishResponse.resolve();
		await Promise.all([prompt, abort]);

		expect(persistedAssistantMessages(harness)).toHaveLength(1);
		expect(persistedAssistantMessages(harness)[0]).toMatchObject({ stopReason: "aborted" });
		expect(runtimeAbortSources(harness)).toEqual(["remote_request"]);
	});

	it("persists cancellation accepted while an extension listener settles", async () => {
		const terminalHandlerStarted = deferred();
		const finishTerminalHandler = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role !== "assistant") return;
						terminalHandlerStarted.resolve();
						await finishTerminalHandler.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("provider completed")]);

		const prompt = harness.session.prompt("race cancellation with terminal persistence");
		await terminalHandlerStarted.promise;
		const abort = harness.session.abort("remote_request");
		finishTerminalHandler.resolve();
		await Promise.all([prompt, abort]);

		expect(persistedAssistantMessages(harness)).toHaveLength(1);
		expect(persistedAssistantMessages(harness)[0]).toMatchObject({ stopReason: "stop" });
		expect(runtimeAbortSources(harness)).toEqual(["remote_request"]);
	});

	it("persists the canonical runtime diagnostic after an extension replacement", async () => {
		const responseStarted = deferred();
		const finishResponse = deferred();
		let canonicalTimestamp: number | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "assistant" || event.message.stopReason !== "aborted") return;
						canonicalTimestamp = event.message.diagnostics?.find(
							(diagnostic) => diagnostic.type === "runtime_abort",
						)?.timestamp;
						return {
							message: {
								...event.message,
								diagnostics: [
									{ type: "extension_before", timestamp: 1, details: { retained: true } },
									{ type: "runtime_abort", timestamp: 2, details: { source: "disposal" } },
									{ type: "extension_after", timestamp: 3, details: { retained: true } },
									{ type: "runtime_abort", timestamp: 4, details: { source: "keyboard_interrupt" } },
								],
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await finishResponse.promise;
				return fauxAssistantMessage("late response");
			},
		]);

		const prompt = harness.session.prompt("replace the aborted message");
		await responseStarted.promise;
		const abort = harness.session.abort("remote_request");
		finishResponse.resolve();
		await Promise.all([prompt, abort]);

		const persisted = persistedAssistantMessages(harness);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"extension_before",
			"extension_after",
			"runtime_abort",
		]);
		expect(persisted[0]?.diagnostics?.at(-1)).toMatchObject({
			timestamp: canonicalTimestamp,
			details: { source: "remote_request" },
		});
		expect(runtimeAbortSources(harness)).toEqual(["remote_request"]);
	});

	it("keeps delivery-start observer failures from interrupting committed delivery publication", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first delivery completed"),
			fauxAssistantMessage("second delivery completed"),
		]);
		let failFirstDeliveryPublication = true;
		harness.session.subscribe((event) => {
			if (event.type === "delivery_start" && failFirstDeliveryPublication) {
				failFirstDeliveryPublication = false;
				throw new Error("delivery observer failed");
			}
		});

		await harness.session.prompt("first committed delivery");
		await harness.session.prompt("second committed delivery");

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(
			messages.flatMap((message) =>
				message.role === "user" && Array.isArray(message.content)
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [],
			),
		).toEqual(["first committed delivery", "second committed delivery"]);
		expect(
			messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [],
			),
		).toEqual(["first delivery completed", "second delivery completed"]);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("persists one replacement marker when disposal interrupts an accepted request", async () => {
		const responseStarted = deferred();
		const finishResponse = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await finishResponse.promise;
				return fauxAssistantMessage("late response");
			},
		]);

		const prompt = harness.session.prompt("replace this session");
		await responseStarted.promise;
		await harness.session.dispose("session_replacement");
		finishResponse.resolve();
		await prompt;

		expect(persistedAssistantMessages(harness)).toHaveLength(1);
		expect(persistedAssistantMessages(harness)[0]).toMatchObject({ stopReason: "aborted" });
		expect(runtimeAbortSources(harness)).toEqual(["session_replacement"]);
	});

	it("does not append an abort marker when disposal wins before request admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let disposal: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") disposal = harness.session.dispose("disposal");
		});

		await harness.session.prompt("never admitted");
		await disposal;

		expect(persistedAssistantMessages(harness)).toEqual([]);
	});

	it("persists an admitted delivery before its disposal marker", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("never requested")]);
		let disposal: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "delivery_start") disposal = harness.session.dispose("disposal");
		});

		await harness.session.prompt("persist this admitted prompt", {
			clientMessageId: "dispose-admitted-delivery",
		});
		await disposal;

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({
			role: "user",
			clientMessageId: "dispose-admitted-delivery",
			content: [{ type: "text", text: "persist this admitted prompt" }],
		});
		expect(harness.sessionManager.getClientInput("dispose-admitted-delivery")?.state).toBe("completed");
		expect(messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "disposal" } })],
		});
	});

	it("persists a delivery when disposal runs inside its commit callback", async () => {
		let harness: Harness;
		let disposal: Promise<void> | undefined;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				commit: () => {
					disposal = harness.session.dispose("disposal");
				},
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("never requested")]);

		await harness.session.prompt("commit before disposal", {
			clientMessageId: "dispose-during-delivery-commit",
		});
		await disposal;

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({
			role: "user",
			clientMessageId: "dispose-during-delivery-commit",
			content: [{ type: "text", text: "commit before disposal" }],
		});
		expect(messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "disposal" } })],
		});
	});

	it("persists each composed delivery message once when disposal runs during commit", async () => {
		let harness: Harness;
		let disposal: Promise<void> | undefined;
		harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [createUserMessage("prepared predecessor"), ...delivery.messages];
				return {
					messages,
					commit: () => {
						messages.push(createUserMessage("message composed during commit"));
						disposal = harness.session.dispose("disposal");
					},
				};
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("never requested")]);

		await harness.session.prompt("original admitted prompt");
		await disposal;

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(
			messages.flatMap((message) => {
				if (message.role !== "user") return [];
				if (typeof message.content === "string") return [message.content];
				return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
			}),
		).toEqual(["prepared predecessor", "original admitted prompt", "message composed during commit"]);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(runtimeAbortSources(harness)).toEqual(["disposal"]);
	});

	it("persists ready-plan checkpoint composition when disposal starts at the user boundary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Revise the approved work" }] });
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Approved work",
			summary: "Revise the approved work.",
		});
		await harness.session.setAgentMode("build");
		harness.setResponses([fauxAssistantMessage("never requested")]);
		let disposal: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "user" || disposal) return;
			if (
				!Array.isArray(event.message.content) ||
				!event.message.content.some(
					(part) => part.type === "text" && part.text === "Revise after ready-plan approval",
				)
			) {
				return;
			}
			disposal = harness.session.dispose("disposal");
		});

		await harness.session.prompt("Revise after ready-plan approval");
		if (!disposal) throw new Error("Expected disposal at the canonical user boundary");
		await disposal;

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["custom", "user", "assistant"]);
		expect(messages[0]).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
			content: expect.stringContaining("Phase: draft"),
		});
		expect(messages[1]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Revise after ready-plan approval" }],
		});
		expect(messages[2]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "disposal" } })],
		});
		expect(harness.session.planningState).toMatchObject({
			mode: "plan",
			plan: { id: ready.id, revision: ready.revision + 1, phase: "draft" },
		});
	});

	it("does not persist committed feedback when disposal cannot persist its planning transition", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [...delivery.messages];
				return {
					messages,
					commit: () => {
						predecessorCommits++;
						messages.unshift(
							{
								role: "custom",
								customType: "committed-before-disposal",
								content: "External preparation committed",
								display: false,
								timestamp: Date.now(),
							},
							createUserMessage("committed predecessor output"),
						);
					},
				};
			},
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Preserve committed preparation" }] });
		harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Preserve preparation",
			summary: "Keep external preparation through disposal.",
		});
		harness.session.agent.state.messages = [fauxAssistantMessage("Plan tail")];
		harness.session.agent.steer(createUserMessage("feedback before disposal"));
		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		harness.sessionManager.appendPlanningState = (planning) => {
			if (planning.plan?.phase === "draft") {
				throw new Error("planning persistence remains unavailable");
			}
			return appendPlanningState(planning);
		};

		await harness.session.agent.continue();
		expect(harness.session.agent.state.errorMessage).toBe("planning persistence remains unavailable");
		expect(predecessorCommits).toBe(1);

		await harness.session.dispose("disposal");

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages).not.toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "committed-before-disposal",
				content: "External preparation committed",
			}),
		);
		expect(
			messages.flatMap((message) =>
				message.role === "user" && Array.isArray(message.content)
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [],
			),
		).toEqual([]);
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(predecessorCommits).toBe(1);
	});

	it("does not retain delivery admission when a disposing commit fails", async () => {
		let harness: Harness;
		let disposal: Promise<void> | undefined;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				commit: () => {
					disposal = harness.session.dispose("disposal");
					throw new Error("delivery commit failed");
				},
			}),
		});
		harnesses.push(harness);

		await harness.session.prompt("do not admit this delivery");
		await disposal;

		expect(harness.sessionManager.buildSessionContext().messages).toEqual([]);
	});

	it("attributes manual compaction cancellation to the local host action", async () => {
		const responseStarted = deferred();
		const finishResponse = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await finishResponse.promise;
				return fauxAssistantMessage("late response");
			},
		]);
		const abortSpy = vi.spyOn(harness.session.agent, "abort");

		const prompt = harness.session.prompt("compact this active run");
		await responseStarted.promise;
		const compaction = harness.session.compact();
		finishResponse.resolve();
		await prompt;
		await compaction.catch(() => undefined);

		expect(abortSpy).toHaveBeenCalledWith("host_action");
	});

	it("attributes RPC compaction cancellation to a remote request", async () => {
		const responseStarted = deferred();
		const finishResponse = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await finishResponse.promise;
				return fauxAssistantMessage("late response");
			},
		]);
		const abortSpy = vi.spyOn(harness.session.agent, "abort");

		const prompt = harness.session.prompt("compact this RPC run");
		await responseStarted.promise;
		const compaction = harness.session.compact();
		finishResponse.resolve();
		await prompt;
		await compaction.catch(() => undefined);

		expect(abortSpy).toHaveBeenCalledWith("remote_request");
	});

	it("deduplicates disposal against a terminal message_end still settling", async () => {
		const terminalHandlerStarted = deferred();
		const finishTerminalHandler = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role !== "assistant") return;
						terminalHandlerStarted.resolve();
						await finishTerminalHandler.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("provider completed")]);

		const prompt = harness.session.prompt("race terminal persistence");
		await terminalHandlerStarted.promise;
		await harness.session.dispose("disposal");
		finishTerminalHandler.resolve();
		await prompt;

		expect(persistedAssistantMessages(harness)).toHaveLength(1);
		expect(persistedAssistantMessages(harness)[0]).toMatchObject({ stopReason: "aborted" });
		expect(runtimeAbortSources(harness)).toEqual(["disposal"]);
	});

	it("keeps a normally persisted provider stop distinct from later disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("normal completion")]);

		await harness.session.prompt("complete normally");
		await harness.session.dispose("disposal");

		expect(persistedAssistantMessages(harness)).toHaveLength(1);
		expect(persistedAssistantMessages(harness)[0]).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "normal completion" }],
		});
		expect(runtimeAbortSources(harness)).toEqual([]);
	});
});
