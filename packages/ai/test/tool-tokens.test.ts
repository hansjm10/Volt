import { describe, expect, it } from "vitest";
import { estimateToolDefinitionTokens, type Tool, Type } from "../src/index.ts";

describe("estimateToolDefinitionTokens", () => {
	it("estimates ordered provider-neutral definitions", () => {
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			},
		];
		const serialized = JSON.stringify(
			tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		);

		expect(estimateToolDefinitionTokens(tools)).toBe(Math.ceil(serialized.length / 4));
		expect(estimateToolDefinitionTokens(undefined)).toBe(0);
		expect(estimateToolDefinitionTokens([])).toBe(0);
	});
});
