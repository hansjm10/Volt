import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

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
		title: "Committed preparation",
		summary: "Keep committed preparation ordered across abort.",
		steps: [{ text: "Apply feedback" }],
	});
	harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

describe("regression #199: delivery transaction failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("canonicalizes committed prompt preparation before a replacement prompt runs", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [...delivery.messages];
				const sourceText = getMessageText(delivery.messages.find((message) => message.role === "user"));
				return {
					messages,
					commit: () => {
						predecessorCommits++;
						messages.unshift(createUserMessage(`predecessor for ${sourceText}`));
					},
				};
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("replacement completed")]);

		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		let failDraftPersistence = true;
		harness.sessionManager.appendPlanningState = (planning) => {
			if (planning.plan?.phase === "draft" && failDraftPersistence) {
				throw new Error("transient prompt planning failure");
			}
			return appendPlanningState(planning);
		};

		await harness.session.agent.prompt(createUserMessage("feedback before abort"));
		expect(harness.session.agent.state.errorMessage).toBe("transient prompt planning failure");
		expect(predecessorCommits).toBe(1);

		failDraftPersistence = false;
		await harness.session.abort("host_action");
		await harness.session.prompt("replacement prompt");

		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(getUserTexts(harness)).toEqual([
			"predecessor for feedback before abort",
			"feedback before abort",
			"predecessor for replacement prompt",
			"replacement prompt",
		]);
		expect(predecessorCommits).toBe(2);
	});

	it("blocks replacement input while abort cannot canonicalize committed preparation", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [...delivery.messages];
				return {
					messages,
					commit: () => {
						predecessorCommits++;
						messages.unshift(createUserMessage("committed predecessor"));
					},
				};
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);

		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		let failDraftPersistence = true;
		harness.sessionManager.appendPlanningState = (planning) => {
			if (planning.plan?.phase === "draft" && failDraftPersistence) {
				throw new Error("persistent prompt planning failure");
			}
			return appendPlanningState(planning);
		};

		await harness.session.agent.prompt(createUserMessage("feedback still unsettled"));
		expect(predecessorCommits).toBe(1);

		await harness.session.abort("host_action");
		failDraftPersistence = false;

		await expect(harness.session.prompt("replacement must remain blocked")).rejects.toThrow(
			/committed delivery preparation|retained prompt/,
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)).toEqual([]);

		await harness.session.abort("host_action");
		expect(getUserTexts(harness)).toEqual(["committed predecessor", "feedback still unsettled"]);
		expect(predecessorCommits).toBe(1);
	});

	it("does not promote retained steering preparation when abort only revokes a prompt", async () => {
		let predecessorCommits = 0;
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				const messages = [...delivery.messages];
				return {
					messages,
					commit: () => {
						predecessorCommits++;
						messages.unshift(createUserMessage("steering predecessor"));
					},
				};
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.agent.state.messages = [fauxAssistantMessage("tail")];
		harness.session.agent.steer(createUserMessage("retained steering feedback"));
		harness.setResponses([fauxAssistantMessage("steering completed")]);

		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		let failDraftPersistence = true;
		harness.sessionManager.appendPlanningState = (planning) => {
			if (planning.plan?.phase === "draft" && failDraftPersistence) {
				throw new Error("steering planning failure");
			}
			return appendPlanningState(planning);
		};

		await harness.session.agent.continue();
		expect(predecessorCommits).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		failDraftPersistence = false;
		await harness.session.abort("host_action");
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		await harness.session.agent.continue();
		expect(getUserTexts(harness)).toEqual(["steering predecessor", "retained steering feedback"]);
		expect(predecessorCommits).toBe(1);
	});
});
