import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool } from "../src/types.ts";
import {
	classifyToolSetTransition,
	createToolSetSnapshot,
	fingerprintToolDefinition,
	toolSetSnapshotsEqual,
} from "../src/utils/tool-state.ts";
import { estimateToolDefinitionTokens } from "../src/utils/tool-tokens.ts";

function tool(name: string, description = `${name} description`): Tool {
	return {
		name,
		description,
		parameters: Type.Object({ value: Type.String() }),
	};
}

describe("tool state", () => {
	it("captures ordered fingerprints and definition-token estimates without schemas", () => {
		const tools = [tool("read"), tool("write")];
		const snapshot = createToolSetSnapshot(tools);

		expect(snapshot).toEqual({
			definitions: tools.map(fingerprintToolDefinition),
			estimatedTokens: estimateToolDefinitionTokens(tools),
		});
		expect(JSON.stringify(snapshot)).not.toContain("parameters");
	});

	it("treats equivalent ordered definitions as unchanged regardless of object key order", () => {
		const previous = [
			{ ...tool("read"), parameters: { type: "object", properties: { value: { type: "string" } } } },
			{ ...tool("write"), parameters: { type: "object", properties: { value: { type: "string" } } } },
		] as Tool[];
		const next = [
			{ ...tool("read"), parameters: { properties: { value: { type: "string" } }, type: "object" } },
			{ ...tool("write"), parameters: { properties: { value: { type: "string" } }, type: "object" } },
		] as Tool[];

		expect(classifyToolSetTransition(previous, next)).toBeUndefined();
		expect(toolSetSnapshotsEqual(createToolSetSnapshot(previous), createToolSetSnapshot(next))).toBe(true);
	});

	it("classifies unique additions while preserving prior relative order", () => {
		const previous = [tool("read"), tool("write")];
		const search = tool("search");
		const inspect = tool("inspect");

		expect(classifyToolSetTransition(previous, [search, ...previous, inspect])).toEqual({
			kind: "additive",
			added: [fingerprintToolDefinition(search), fingerprintToolDefinition(inspect)],
		});
	});

	it.each([
		["removal", [tool("read"), tool("write")], [tool("read")]],
		["reorder", [tool("read"), tool("write")], [tool("write"), tool("read")]],
		["description replacement", [tool("read")], [tool("read", "changed")]],
		["schema replacement", [tool("read")], [{ ...tool("read"), parameters: Type.Object({ value: Type.Number() }) }]],
		["previous duplicate ambiguity", [tool("read"), tool("read")], [tool("read"), tool("read"), tool("write")]],
		["next duplicate ambiguity", [tool("read")], [tool("read"), tool("write"), tool("write")]],
	])("classifies %s as reset", (_label, previous, next) => {
		expect(classifyToolSetTransition(previous, next)).toEqual({ kind: "reset" });
	});
});
