import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
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

function assertReadonlyAgentSessionState(session: AgentSession): void {
	// @ts-expect-error AgentSession state properties are readonly.
	session.state.systemPrompt = "mutated";
	// @ts-expect-error AgentSession state properties are readonly.
	session.state.model = undefined;
	// @ts-expect-error AgentSession tool arrays are readonly.
	session.state.tools.push(session.state.tools[0]!);
	// @ts-expect-error AgentSession message arrays are readonly.
	session.state.messages = [];
	// @ts-expect-error AgentSession message arrays are readonly.
	session.state.messages.push({ role: "user", content: "mutated", timestamp: 1 });
	// @ts-expect-error AgentSession pending-tool sets are readonly.
	session.state.pendingToolCalls.add("mutated");
	// @ts-expect-error AgentSession pending-tool maps are readonly.
	session.state.pendingToolExecutions.set("mutated", {
		toolCallId: "mutated",
		toolName: "mutated",
		args: {},
	});
}
void assertReadonlyAgentSessionState;

describe("AgentSession message projection", () => {
	it("returns deep detached snapshots from messages and state", async () => {
		harness = createHarness({ responses: ["assistant original"] });
		await harness.session.prompt("user original");

		const messages = harness.session.messages;
		replaceMessageText(messages[0]!, "mutated messages getter");
		messages.pop();
		const firstState = harness.session.state;
		const stateMessages = [...firstState.messages];
		replaceMessageText(stateMessages[1]!, "mutated state getter");
		stateMessages.splice(0, stateMessages.length);
		const stateTools = [...firstState.tools];
		const firstTool = stateTools[0];
		stateTools.splice(0, stateTools.length);

		const freshProjection = harness.session.messages;
		expect(freshProjection.map(messageText)).toEqual(["user original", "assistant original"]);
		expect(harness.sessionManager.buildSessionContext().messages.map(messageText)).toEqual([
			"user original",
			"assistant original",
		]);
		expect(harness.session.state.tools.length).toBeGreaterThan(0);
		expect(harness.session.state.tools[0]).toBe(firstTool);
	});
});
