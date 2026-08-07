import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import type { TSchema } from "typebox";
import { cloneCanonicalData } from "../canonical-data.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

function ownToolResult<TDetails>(result: AgentToolResult<TDetails>, description: string): AgentToolResult<TDetails> {
	return cloneCanonicalData(result, description);
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TParameters extends TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParameters, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<TParameters, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			let acceptingUpdates = true;
			let invalidUpdate: Error | undefined;
			const invalidUpdateController = onUpdate ? new AbortController() : undefined;
			const executionSignal = invalidUpdateController
				? signal
					? AbortSignal.any([signal, invalidUpdateController.signal])
					: invalidUpdateController.signal
				: signal;
			const wrappedOnUpdate = onUpdate
				? (partialResult: AgentToolResult<TDetails>) => {
						if (!acceptingUpdates || invalidUpdate) return;
						let snapshot: AgentToolResult<TDetails>;
						try {
							snapshot = ownToolResult(partialResult, `Tool ${definition.name} partial result`);
						} catch (error) {
							invalidUpdate = error instanceof Error ? error : new Error(String(error));
							invalidUpdateController?.abort(invalidUpdate);
							return;
						}
						onUpdate(snapshot);
					}
				: undefined;
			try {
				const result = await definition.execute(
					toolCallId,
					params,
					executionSignal,
					wrappedOnUpdate,
					ctxFactory?.() as ExtensionContext,
				);
				if (invalidUpdate) throw invalidUpdate;
				return ownToolResult(result, `Tool ${definition.name} final result`);
			} catch (error) {
				if (invalidUpdate) throw invalidUpdate;
				throw error;
			} finally {
				acceptingUpdates = false;
			}
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any, any>): ToolDefinition<any, unknown> {
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
