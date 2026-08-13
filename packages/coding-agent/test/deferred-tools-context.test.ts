import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { createToolSetSnapshot, fauxAssistantMessage, type Tool } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../src/core/compaction/compaction.ts";

const toolSchema = Type.Object({ value: Type.String() });

function createTool(name: string, descriptionLength: number): Tool {
	return { name, description: "x".repeat(descriptionLength), parameters: toolSchema };
}

const smallTool = createTool("small_tool", 40);
const largeTool = createTool("large_tool", 4000);
const messagesWithUsage: AgentMessage[] = [
	{
		...fauxAssistantMessage("ready"),
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
];

describe("deferred tool context estimates", () => {
	it("does not double count durable request snapshots already represented by provider usage", () => {
		const assistant = messagesWithUsage[0];
		if (assistant.role !== "assistant") throw new Error("Expected assistant fixture");
		const messages: AgentMessage[] = [{ ...assistant, toolSetSnapshot: createToolSetSnapshot([largeTool]) }];

		expect(estimateContextTokens(messages, [largeTool])).toEqual(estimateContextTokens(messages));
	});

	it("counts all live tool definitions when no provider usage exists", () => {
		const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }];

		expect(estimateContextTokens(messages, [smallTool]).tokens).toBeGreaterThan(
			estimateContextTokens(messages).tokens,
		);
	});
});
