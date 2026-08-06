import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { cloneStructuredData } from "../structured-clone.ts";

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			let invalidUpdate: Error | undefined;
			const wrappedOnUpdate = onUpdate
				? (partialResult: AgentToolResult<TDetails>) => {
						if (invalidUpdate) return;
						let snapshot: AgentToolResult<TDetails>;
						try {
							snapshot = cloneStructuredData(partialResult, `Tool ${definition.name} partial result`);
						} catch (error) {
							invalidUpdate = error instanceof Error ? error : new Error(String(error));
							return;
						}
						onUpdate(snapshot);
					}
				: undefined;
			const result = await definition.execute(
				toolCallId,
				params,
				signal,
				wrappedOnUpdate,
				ctxFactory?.() as ExtensionContext,
			);
			if (invalidUpdate) throw invalidUpdate;
			return cloneStructuredData(result, `Tool ${definition.name} final result`);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
