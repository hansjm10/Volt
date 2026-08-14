import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-harness.ts";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function replaceMessageText(message: AgentMessage, text: string): void {
	if (!("content" in message)) return;
	if (typeof message.content === "string") {
		message.content = text;
		return;
	}
	const textPart = message.content.find((part) => part.type === "text");
	if (textPart?.type === "text") textPart.text = text;
}

describe("AgentSession message projection", () => {
	it("returns deep detached snapshots from messages and state", async () => {
		harness = createHarness({ responses: ["assistant original"] });
		await harness.session.prompt("user original");

		const messages = harness.session.messages;
		replaceMessageText(messages[0]!, "mutated messages getter");
		messages.pop();
		const stateMessages = harness.session.state.messages;
		replaceMessageText(stateMessages[1]!, "mutated state getter");
		stateMessages.splice(0, stateMessages.length);

		const freshProjection = harness.session.messages;
		expect(freshProjection.map(messageText)).toEqual(["user original", "assistant original"]);
		expect(harness.sessionManager.buildSessionContext().messages.map(messageText)).toEqual([
			"user original",
			"assistant original",
		]);
	});
});
