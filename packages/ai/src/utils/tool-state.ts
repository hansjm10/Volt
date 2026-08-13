import type { Tool, ToolDefinitionFingerprint, ToolSetSnapshot, ToolSetTransition } from "../types.ts";
import { shortHash } from "./hash.ts";
import { estimateToolDefinitionTokens } from "./tool-tokens.ts";

function serializeCanonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`)
		.join(",")}}`;
}

function serializeToolDefinition(tool: Tool): string {
	return serializeCanonical({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	});
}

/** Fingerprint one provider-neutral tool definition without persisting its schema. */
export function fingerprintToolDefinition(tool: Tool): ToolDefinitionFingerprint {
	return { name: tool.name, fingerprint: shortHash(serializeToolDefinition(tool)) };
}

/** Capture the exact ordered provider-request tool state. */
export function createToolSetSnapshot(tools: readonly Tool[] | undefined): ToolSetSnapshot {
	return {
		definitions: (tools ?? []).map(fingerprintToolDefinition),
		estimatedTokens: estimateToolDefinitionTokens(tools),
	};
}

function hasUniqueNames(definitions: readonly ToolDefinitionFingerprint[]): boolean {
	return new Set(definitions.map((definition) => definition.name)).size === definitions.length;
}

/** Compare two snapshots by ordered name and definition identity. */
export function toolSetSnapshotsEqual(left: ToolSetSnapshot, right: ToolSetSnapshot): boolean {
	if (left.definitions.length !== right.definitions.length) return false;
	return left.definitions.every((definition, index) => {
		const other = right.definitions[index];
		return definition.name === other?.name && definition.fingerprint === other.fingerprint;
	});
}

/**
 * Classify one committed tool-set mutation.
 *
 * Additions are safe only when both sets have unique names, every prior
 * definition is byte-equivalent, and prior relative order is unchanged.
 * Every other non-noop mutation resets deferred placement.
 */
export function classifyToolSetTransition(
	previousTools: readonly Tool[] | undefined,
	nextTools: readonly Tool[] | undefined,
): ToolSetTransition | undefined {
	const previous = createToolSetSnapshot(previousTools);
	const next = createToolSetSnapshot(nextTools);
	if (toolSetSnapshotsEqual(previous, next)) return undefined;
	if (!hasUniqueNames(previous.definitions) || !hasUniqueNames(next.definitions)) return { kind: "reset" };
	if (next.definitions.length <= previous.definitions.length) return { kind: "reset" };

	let previousIndex = 0;
	const added: ToolDefinitionFingerprint[] = [];
	for (const definition of next.definitions) {
		const prior = previous.definitions[previousIndex];
		if (definition.name === prior?.name) {
			if (definition.fingerprint !== prior.fingerprint) return { kind: "reset" };
			previousIndex += 1;
			continue;
		}
		if (previous.definitions.some((candidate) => candidate.name === definition.name)) return { kind: "reset" };
		added.push(definition);
	}

	if (previousIndex !== previous.definitions.length || added.length === 0) return { kind: "reset" };
	return { kind: "additive", added };
}
