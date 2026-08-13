/** Durable branch-local tool intent. */
export type ToolSelection =
	| { readonly kind: "inherit" }
	| { readonly kind: "explicit"; readonly requestedNames: readonly string[] };

/** Copy tool names while preserving first-seen order and removing duplicates. */
export function deduplicateToolNames(names: readonly string[]): string[] {
	return [...new Set(names)];
}

/** Create an explicit selection with an owned, ordered, deduplicated name list. */
export function createExplicitToolSelection(
	requestedNames: readonly string[],
): Extract<ToolSelection, { kind: "explicit" }> {
	return { kind: "explicit", requestedNames: deduplicateToolNames(requestedNames) };
}

/** Reduce a nullable persisted entry into inherited or explicit branch intent. */
export function reduceToolSelection(requestedNames: readonly string[] | null | undefined): ToolSelection {
	return requestedNames == null ? { kind: "inherit" } : createExplicitToolSelection(requestedNames);
}

/** Compare durable tool intent, including explicit name order. */
export function toolSelectionsEqual(left: ToolSelection, right: ToolSelection): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "inherit" || right.kind === "inherit") return true;
	return (
		left.requestedNames.length === right.requestedNames.length &&
		left.requestedNames.every((name, index) => name === right.requestedNames[index])
	);
}

/** Resolve the requested names for the current runtime without changing durable intent. */
export function resolveRequestedToolNames(
	selection: ToolSelection,
	inheritedBaselineNames: readonly string[],
): string[] {
	return deduplicateToolNames(selection.kind === "inherit" ? inheritedBaselineNames : selection.requestedNames);
}

export interface DerivedToolSelection<TTool extends { readonly name: string }> {
	/** Current baseline names for inherited intent, or durable names for explicit intent. */
	requestedNames: string[];
	/** Requested names that are registered and allowed by the current runtime policy. */
	effectiveNames: string[];
	/** Concrete registered tools corresponding to {@link effectiveNames}. */
	tools: TTool[];
}

/**
 * Derive effective tools from current registry availability and policy without
 * mutating or filtering the inherited/explicit selection that supplied intent.
 */
export function deriveToolSelection<TTool extends { readonly name: string }>(
	registry: ReadonlyMap<string, TTool>,
	inheritedBaselineNames: readonly string[],
	selection: ToolSelection,
	isAllowed: (tool: TTool) => boolean = () => true,
): DerivedToolSelection<TTool> {
	const requestedNames = resolveRequestedToolNames(selection, inheritedBaselineNames);
	const effectiveNames: string[] = [];
	const tools: TTool[] = [];
	for (const name of requestedNames) {
		const tool = registry.get(name);
		if (tool === undefined || !isAllowed(tool)) continue;
		effectiveNames.push(name);
		tools.push(tool);
	}
	return { requestedNames, effectiveNames, tools };
}
