import type { Tool } from "../types.ts";

/** Estimate provider-neutral tool-definition tokens using the shared character heuristic. */
export function estimateToolDefinitionTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	const definitions = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return Math.ceil(JSON.stringify(definitions).length / 4);
}
