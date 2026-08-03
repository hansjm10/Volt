import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

async function createWaitingHarness(
	options: {
		tools?: AgentTool[];
		extensionFactories?: Harness["session"]["extensionRunner"] extends never
			? never
			: Array<(volt: ExtensionAPI) => void>;
	} = {},
): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("does not run an extension command after its prompt generation is aborted", async () => {
		let commandRuns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("must-not-run", {
						description: "Must not run",
						handler: async () => {
							commandRuns++;
						},
					});
				},
			],
		});
		harnesses.push(harness);

		const prompt = harness.session.prompt("/must-not-run");
		const abort = harness.session.abort();

		await expect(prompt).rejects.toThrow("Prompt aborted before preflight started");
		await abort;
		expect(commandRuns).toBe(0);
	});

	it("does not replay an initial prompt canceled during agent_start with the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("replacement response")]);
		let cancellation: Promise<void> | undefined;
		const unsubscribe = harness.session.agent.subscribe((event) => {
			if (event.type !== "agent_start" || cancellation) return;
			cancellation = harness.session.abort();
		});

		await harness.session.prompt("canceled prompt");
		await cancellation;
		unsubscribe();
		await harness.session.prompt("replacement prompt");

		expect(getUserTexts(harness)).toEqual(["replacement prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["replacement response"]);
	});

	it("does not start a public custom turn after its generation is aborted", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);

		const customTurn = harness.session.sendCustomMessage(
			{ customType: "abort", content: "must not run", display: false },
			{ triggerTurn: true },
		);
		const abort = harness.session.abort();

		await customTurn;
		await abort;
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("allows extension commands to trigger a turn and await agent idle without self-deadlocking", async () => {
		const idleStates: boolean[] = [];
		let commandCompleted = false;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("custom-turn", {
						description: "Start a custom turn",
						handler: async (_args, ctx) => {
							idleStates.push(ctx.isIdle());
							volt.sendMessage(
								{ customType: "command", content: "custom turn", display: true },
								{ triggerTurn: true },
							);
							await ctx.waitForIdle();
							commandCompleted = true;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("custom turn response")]);

		const outcome = await Promise.race([
			harness.session.prompt("/custom-turn").then(() => "completed" as const),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
		]);

		expect(outcome).toBe("completed");
		expect(commandCompleted).toBe(true);
		expect(idleStates).toEqual([false]);
		expect(getAssistantTexts(harness)).toContain("custom turn response");
		expect(harness.session.isBusy).toBe(false);
	});

	it("rejects a queued prompt when its delayed preflight outlives the active run", async () => {
		let releaseQueuedInput: () => void = () => undefined;
		const queuedInputRelease = new Promise<void>((resolve) => {
			releaseQueuedInput = resolve;
		});
		let notifyQueuedInputStarted: () => void = () => undefined;
		const queuedInputStarted = new Promise<void>((resolve) => {
			notifyQueuedInputStarted = resolve;
		});
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", async (event) => {
						if (event.text === "queued after delayed input") {
							notifyQueuedInputStarted();
							await queuedInputRelease;
						}
						return { action: "continue" };
					});
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original run complete"),
		]);

		await waitForToolStart;
		const queuedPrompt = harness.session.prompt("queued after delayed input", { streamingBehavior: "followUp" });
		await queuedInputStarted;
		releaseToolExecution();
		await promptPromise;
		expect(harness.session.isStreaming).toBe(false);

		releaseQueuedInput();
		await expect(queuedPrompt).rejects.toThrow(
			"Agent finished processing while queued prompt preflight was running. Resubmit the prompt.",
		);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("rejects public custom turns during prompt preflight instead of racing the prompt", async () => {
		let releaseCommand: () => void = () => undefined;
		const commandRelease = new Promise<void>((resolve) => {
			releaseCommand = resolve;
		});
		let notifyCommandStarted: () => void = () => undefined;
		const commandStarted = new Promise<void>((resolve) => {
			notifyCommandStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("block", {
						description: "Block preflight",
						handler: async () => {
							notifyCommandStarted();
							await commandRelease;
						},
					});
				},
			],
		});
		harnesses.push(harness);

		const command = harness.session.prompt("/block");
		await commandStarted;
		expect(harness.session.isBusy).toBe(true);
		expect(harness.session.isStreaming).toBe(false);

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "race", content: "must not run", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("Agent is already processing a prompt transaction");

		releaseCommand();
		await command;
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(volt) => {
					extensionApi = volt;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1", undefined, "client-steer-1");
		await harness.session.steer("steer 2", undefined, "client-steer-2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(
			harness.session.messages
				.filter((message) => message.role === "user")
				.map((message) => message.clientMessageId),
		).toEqual([undefined, "client-steer-1", "client-steer-2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1", undefined, "client-follow-up-1");
		await harness.session.followUp("follow-up 2", undefined, "client-follow-up-2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(
			harness.session.messages
				.filter((message) => message.role === "user")
				.map((message) => message.clientMessageId),
		).toEqual([undefined, "client-follow-up-1", "client-follow-up-2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it("queues custom messages with deliverAs steer while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
			{ deliverAs: "steer" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("queues custom messages with deliverAs followUp while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
			{ deliverAs: "followUp" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "custom", "assistant"]);
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("delivers follow-ups queued during agent_end", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(volt: ExtensionAPI) => {
					volt.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						volt.sendUserMessage("conflict report", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
	});
});
