import type { AgentMessage, AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = () => {};
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

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = harness.session.updatePlan({
		title: "Queued feedback",
		summary: "Exercise transactional feedback admission.",
		steps: [{ text: "Apply feedback" }],
	});
	harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

function createBuildMarkerTool(): AgentTool {
	return {
		name: "build_marker",
		label: "Build marker",
		description: "Observable Build-only test tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "built" }], details: {} }),
	};
}

describe("regression #199: approved plan finalization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("leaves a revoked first preparation without planning state or checkpoint side effects", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let preparationCount = 0;
		const harness = await createHarness({
			prepareDelivery: async (delivery) => {
				preparationCount++;
				if (preparationCount === 1) {
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return { messages: [...delivery.messages] };
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.agent.state.messages = [createUserMessage("existing context")];
		harness.setResponses([
			fauxAssistantMessage("revoked delivery omitted"),
			fauxAssistantMessage("feedback admitted"),
		]);
		const planningEntryCount = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "planning_state_change").length;
		const planningEventCount = harness.eventsOfType("planning_state_changed").length;
		const checkpointEventCount = harness
			.eventsOfType("message_end")
			.filter(
				(event) => event.message.role === "custom" && event.message.customType === "volt-plan-checkpoint",
			).length;
		harness.session.agent.steer(createUserMessage("revoked feedback"));

		const firstRun = harness.session.agent.continue();
		await preparationStarted.promise;
		expect(harness.session.agent.clearSteeringQueue()).toHaveLength(1);
		releasePreparation.resolve();
		await firstRun;

		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount);
		expect(
			harness
				.eventsOfType("message_end")
				.filter((event) => event.message.role === "custom" && event.message.customType === "volt-plan-checkpoint"),
		).toHaveLength(checkpointEventCount);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change")).toHaveLength(
			planningEntryCount,
		);

		harness.session.agent.steer(createUserMessage("admitted feedback"));
		await harness.session.agent.continue();
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount + 1);
		expect(
			harness
				.eventsOfType("message_end")
				.filter((event) => event.message.role === "custom" && event.message.customType === "volt-plan-checkpoint"),
		).toHaveLength(checkpointEventCount + 1);
	});

	it("keeps uncommitted preparation side-effect free and composes predecessor messages and commit", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [createUserMessage("predecessor"), ...delivery.messages];
				return {
					messages,
					commit: () => {
						predecessorCommits++;
						messages.push(createUserMessage("predecessor committed"));
					},
				};
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		const planningEntryCount = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "planning_state_change").length;
		const planningEventCount = harness.eventsOfType("planning_state_changed").length;

		const revoked = await harness.session.agent.prepareDelivery?.({
			deliveryId: "revoked",
			kind: "steer",
			messages: [createUserMessage("revoked feedback")],
		});
		expect(revoked).toBeDefined();
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(predecessorCommits).toBe(0);
		expect(revoked?.messages.some((message) => message.role === "custom")).toBe(false);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change")).toHaveLength(
			planningEntryCount,
		);

		const admitted = await harness.session.agent.prepareDelivery?.({
			deliveryId: "admitted",
			kind: "steer",
			messages: [createUserMessage("admitted feedback")],
		});
		admitted?.commit?.();

		expect(predecessorCommits).toBe(1);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(
			admitted?.messages.map((message) => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["volt-plan-checkpoint", "user", "user", "user"]);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount + 1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change")).toHaveLength(
			planningEntryCount + 1,
		);
	});

	it("does not replay a predecessor commit after a concurrent planning transition rejects ready feedback", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				commit: () => {
					predecessorCommits++;
				},
			}),
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.agent.state.messages = [fauxAssistantMessage("Plan tail")];
		harness.session.agent.steer(createUserMessage("feedback during transition"));
		harness.setResponses([fauxAssistantMessage("feedback admitted once")]);

		const transitionStarted = deferred();
		const releaseTransition = deferred();
		const internals = harness.session as unknown as { _prepareUnrestrictedMcpForBuild(): Promise<void> };
		const prepareUnrestrictedMcpForBuild = internals._prepareUnrestrictedMcpForBuild.bind(harness.session);
		internals._prepareUnrestrictedMcpForBuild = async () => {
			transitionStarted.resolve();
			await releaseTransition.promise;
			await prepareUnrestrictedMcpForBuild();
		};
		const transition = harness.session.setAgentMode("build");
		await transitionStarted.promise;

		await harness.session.agent.continue();
		expect(harness.session.agent.state.errorMessage).toContain("planning transition is in progress");
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(predecessorCommits).toBe(1);

		releaseTransition.resolve();
		await transition;
		await harness.session.agent.continue();

		expect(predecessorCommits).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.planningState).toMatchObject({ mode: "plan", plan: { phase: "draft" } });
	});

	it("does not replay a predecessor commit after ready-feedback planning persistence fails", async () => {
		let predecessorPreparations = 0;
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				predecessorPreparations++;
				const messages = [...delivery.messages];
				return {
					messages,
					commit: () => {
						predecessorCommits++;
						messages.unshift(createUserMessage("committed predecessor output"));
					},
				};
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.agent.state.messages = [fauxAssistantMessage("Plan tail")];
		harness.session.agent.steer(createUserMessage("feedback across persistence retry"));
		harness.setResponses([fauxAssistantMessage("feedback admitted once")]);

		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		let failDraftPersistence = true;
		harness.sessionManager.appendPlanningState = (planning) => {
			if (planning.plan?.phase === "draft" && failDraftPersistence) {
				failDraftPersistence = false;
				throw new Error("planning persistence failed");
			}
			return appendPlanningState(planning);
		};

		await harness.session.agent.continue();
		expect(harness.session.agent.state.errorMessage).toBe("planning persistence failed");
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(predecessorPreparations).toBe(1);
		expect(predecessorCommits).toBe(1);

		await harness.session.agent.continue();

		expect(predecessorPreparations).toBe(1);
		expect(predecessorCommits).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(
			harness.session.messages.filter(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "text" && part.text === "committed predecessor output"),
			),
		).toHaveLength(1);
	});

	it("promotes committed preparation instead of revoking it when queue clearing follows a planning failure", async () => {
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
								customType: "committed-preparation",
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
		await createReadyPlan(harness);
		harness.session.agent.state.messages = [fauxAssistantMessage("Plan tail")];
		await harness.session.steer("feedback cleared after partial commit", undefined, "committed-preparation-clear");

		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		let failDraftPersistence = true;
		harness.sessionManager.appendPlanningState = (planning) => {
			if (planning.plan?.phase === "draft" && failDraftPersistence) {
				failDraftPersistence = false;
				throw new Error("planning persistence failed before queue clear");
			}
			return appendPlanningState(planning);
		};

		await harness.session.agent.continue();
		expect(harness.session.agent.state.errorMessage).toBe("planning persistence failed before queue clear");
		expect(predecessorCommits).toBe(1);

		await expect(harness.session.clearQueue()).resolves.toEqual({ steering: [], followUp: [] });

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "committed-preparation",
				content: "External preparation committed",
			}),
		);
		expect(
			messages.flatMap((message) =>
				message.role === "user" && Array.isArray(message.content)
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [],
			),
		).toEqual(["committed predecessor output", "feedback cleared after partial commit"]);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(harness.sessionManager.getClientInput("committed-preparation-clear")?.state).toBe("completed");
		expect(predecessorCommits).toBe(1);
	});

	it("does not replay a predecessor commit after a ready-feedback planning observer fails", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				commit: () => {
					predecessorCommits++;
				},
			}),
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.agent.state.messages = [fauxAssistantMessage("Plan tail")];
		harness.session.agent.steer(createUserMessage("feedback across observer retry"));
		harness.setResponses([fauxAssistantMessage("feedback admitted once")]);

		let failDraftObserver = true;
		harness.session.subscribe((event) => {
			if (event.type === "planning_state_changed" && event.planning.plan?.phase === "draft" && failDraftObserver) {
				failDraftObserver = false;
				throw new Error("planning observer failed");
			}
		});

		await harness.session.agent.continue();

		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(predecessorCommits).toBe(1);
		const feedbackIndex = harness.session.messages.findIndex(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "text" && part.text === "feedback across observer retry"),
		);
		expect(harness.session.messages[feedbackIndex - 1]).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
		});
	});

	it("admits all-mode feedback with one ready-to-draft transition and checkpoint", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.agent.steeringMode = "all";
		const planningEntryCount = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "planning_state_change").length;
		const planningEventCount = harness.eventsOfType("planning_state_changed").length;
		const checkpointEventCount = harness
			.eventsOfType("message_end")
			.filter(
				(event) => event.message.role === "custom" && event.message.customType === "volt-plan-checkpoint",
			).length;
		harness.setResponses([fauxAssistantMessage("feedback admitted")]);
		harness.session.agent.steer(createUserMessage("first feedback"));
		harness.session.agent.steer(createUserMessage("second feedback"));

		await harness.session.agent.continue();

		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(
			harness
				.eventsOfType("message_end")
				.filter((event) => event.message.role === "custom" && event.message.customType === "volt-plan-checkpoint"),
		).toHaveLength(checkpointEventCount + 1);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventCount + 1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change")).toHaveLength(
			planningEntryCount + 1,
		);
	});

	it("persists one tool-free final response and restores Build tools for the next delivery", async () => {
		const harness = await createHarness({
			tools: [createBuildMarkerTool()],
			initialActiveToolNames: ["build_marker"],
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({
			title: "Complete issue 199",
			summary: "Finalize the approved implementation visibly.",
			steps: [{ text: "Finish implementation and verification" }],
		});
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-199",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const requestSnapshots: Array<{ tools: string[]; systemPrompt: string }> = [];
		harness.setResponses([
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage(
					fauxToolCall("update_plan_progress", {
						planId: active.id,
						expectedRevision: active.revision,
						updates: [{ id: active.steps[0]!.id, status: "completed", note: "Verified" }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("Implementation and verification completed.");
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("Build tools restored.");
			},
		]);

		await harness.session.prompt("Complete the approved plan");

		expect(harness.session.planningState.plan).toMatchObject({ phase: "completed" });
		expect(harness.session.getActiveToolNames()).toEqual(["build_marker"]);
		expect(harness.session.state.systemPrompt).not.toContain("[VOLT APPROVED PLAN — TRUSTED HOST POLICY]");
		expect(requestSnapshots[0]!.tools).toContain("update_plan_progress");
		expect(requestSnapshots[1]!.tools).toEqual([]);
		expect(requestSnapshots[1]!.systemPrompt).toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");

		const persistedMessages = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const progressToolCallIndex = persistedMessages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.name === "update_plan_progress"),
		);
		expect(
			persistedMessages.slice(progressToolCallIndex, progressToolCallIndex + 3).map((message) => message.role),
		).toEqual(["assistant", "toolResult", "assistant"]);
		expect(persistedMessages[progressToolCallIndex + 2]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Implementation and verification completed." }],
		});

		await harness.session.prompt("Continue with Build tools");
		expect(requestSnapshots[2]!.tools).toEqual(["build_marker"]);
		expect(requestSnapshots[2]!.systemPrompt).not.toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
	});

	it("retains tool-free final-response authority across a transient provider retry", async () => {
		const harness = await createHarness({
			tools: [createBuildMarkerTool()],
			initialActiveToolNames: ["build_marker"],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Finish implementation" }] });
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Finish implementation",
			summary: "Complete the approved work and report it.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-final-response-retry",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const requestSnapshots: Array<{ tools: string[]; systemPrompt: string }> = [];
		let retriedRequestContainedQueuedInput: boolean | undefined;
		let clearedQueuedDeliveries: number | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: active.id,
					expectedRevision: active.revision,
					updates: [{ id: active.steps[0]!.id, status: "completed" }],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				harness.session.agent.followUp(createUserMessage("queued during final-response retry"));
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				retriedRequestContainedQueuedInput = JSON.stringify(context.messages).includes(
					"queued during final-response retry",
				);
				clearedQueuedDeliveries = harness.session.agent.clearFollowUpQueue().length;
				return fauxAssistantMessage("Final response after retry");
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("Build tools restored after retry");
			},
		]);

		await harness.session.prompt("Complete the approved plan despite a transient failure");

		expect(requestSnapshots).toHaveLength(2);
		expect(retriedRequestContainedQueuedInput).toBe(false);
		expect(clearedQueuedDeliveries).toBe(1);
		for (const snapshot of requestSnapshots) {
			expect(snapshot.tools).toEqual([]);
			expect(snapshot.systemPrompt).toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
		}
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Final response after retry" }],
		});

		await harness.session.prompt("Start a fresh Build turn");
		expect(requestSnapshots[2]!.tools).toEqual(["build_marker"]);
		expect(requestSnapshots[2]!.systemPrompt).not.toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
	});

	it("retains tool-free final-response authority across overflow compaction", async () => {
		const harness = await createHarness({
			tools: [createBuildMarkerTool()],
			initialActiveToolNames: ["build_marker"],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.session.setSessionName("final response compaction regression");
		const olderUser = createUserMessage("older compactable turn");
		const olderAssistant = fauxAssistantMessage("older completed response");
		harness.sessionManager.appendMessage(olderUser);
		harness.sessionManager.appendMessage(olderAssistant);
		harness.session.agent.state.messages = [olderUser, olderAssistant];
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Finish compacted implementation" }] });
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Finish compacted implementation",
			summary: "Complete the approved work after overflow compaction.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "execution-final-response-compaction",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		const requestSnapshots: Array<{ tools: string[]; systemPrompt: string }> = [];
		let compactedRequestContainedQueuedInput: boolean | undefined;
		let clearedQueuedDeliveries: number | undefined;
		harness.faux.setSimpleResponses([
			fauxAssistantMessage("compacted final-response context"),
			fauxAssistantMessage("compacted active-turn prefix"),
		]);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan_progress", {
					planId: active.id,
					expectedRevision: active.revision,
					updates: [{ id: active.steps[0]!.id, status: "completed" }],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				harness.session.agent.followUp(createUserMessage("queued during final-response compaction"));
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
			},
			(context) => {
				requestSnapshots.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					systemPrompt: context.systemPrompt ?? "",
				});
				compactedRequestContainedQueuedInput = JSON.stringify(context.messages).includes(
					"queued during final-response compaction",
				);
				clearedQueuedDeliveries = harness.session.agent.clearFollowUpQueue().length;
				return fauxAssistantMessage("Final response after compaction");
			},
		]);

		await harness.session.prompt("Complete the approved plan despite context overflow");

		expect(requestSnapshots).toHaveLength(2);
		expect(compactedRequestContainedQueuedInput).toBe(false);
		expect(clearedQueuedDeliveries).toBe(1);
		for (const snapshot of requestSnapshots) {
			expect(snapshot.tools).toEqual([]);
			expect(snapshot.systemPrompt).toContain("[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]");
		}
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Final response after compaction" }],
		});
	});
});
