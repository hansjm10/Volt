import type { SessionEntry } from "../session-manager.ts";

/** One provider tool-call occurrence anchored to its durable assistant entry. */
export interface ResolvedSessionToolCall {
	assistantEntryId: string;
	contentIndex: number;
	providerCallId: string;
	name: string;
	arguments: Record<string, unknown>;
}

type ActiveToolCall = ResolvedSessionToolCall | null;

interface ActiveToolCallChange {
	providerCallId: string;
	hadPrevious: boolean;
	previous: ActiveToolCall | undefined;
}

type TraversalFrame =
	| { phase: "enter"; entry: SessionEntry }
	| { phase: "exit"; entryId: string; changes: ActiveToolCallChange[] };

/**
 * Resolve each tool result against the nearest matching tool-call occurrence
 * on its own ancestor branch. Provider call ids are correlation tokens, not
 * session-global identities, so sibling branches must never share lookup state.
 */
export function resolveSessionToolCallsByResultEntryId(
	entries: readonly SessionEntry[],
): ReadonlyMap<string, ResolvedSessionToolCall> {
	const entriesById = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entriesById.has(entry.id)) {
			throw new Error(`Session contains duplicate entry id ${entry.id}`);
		}
		entriesById.set(entry.id, entry);
	}

	const roots: SessionEntry[] = [];
	const childrenByParentId = new Map<string, SessionEntry[]>();
	for (const entry of entries) {
		if (entry.parentId === null || entry.parentId === entry.id || !entriesById.has(entry.parentId)) {
			roots.push(entry);
			continue;
		}
		const children = childrenByParentId.get(entry.parentId) ?? [];
		children.push(entry);
		childrenByParentId.set(entry.parentId, children);
	}

	const resolvedByResultEntryId = new Map<string, ResolvedSessionToolCall>();
	const activeToolCalls = new Map<string, ActiveToolCall>();
	const activeEntryIds = new Set<string>();
	const visitedEntryIds = new Set<string>();

	const traverseFrom = (root: SessionEntry): void => {
		const stack: TraversalFrame[] = [{ phase: "enter", entry: root }];
		while (stack.length > 0) {
			const frame = stack.pop()!;
			if (frame.phase === "exit") {
				for (let index = frame.changes.length - 1; index >= 0; index--) {
					const change = frame.changes[index]!;
					if (change.hadPrevious) {
						activeToolCalls.set(change.providerCallId, change.previous!);
					} else {
						activeToolCalls.delete(change.providerCallId);
					}
				}
				activeEntryIds.delete(frame.entryId);
				continue;
			}

			const entry = frame.entry;
			if (activeEntryIds.has(entry.id)) {
				throw new Error(`Session branch contains a parent cycle at ${entry.id}`);
			}
			if (visitedEntryIds.has(entry.id)) {
				continue;
			}
			visitedEntryIds.add(entry.id);
			activeEntryIds.add(entry.id);

			const changes: ActiveToolCallChange[] = [];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const seenProviderCallIds = new Set<string>();
				for (let contentIndex = 0; contentIndex < entry.message.content.length; contentIndex++) {
					const block = entry.message.content[contentIndex];
					if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") {
						continue;
					}
					changes.push({
						providerCallId: block.id,
						hadPrevious: activeToolCalls.has(block.id),
						previous: activeToolCalls.get(block.id),
					});
					if (seenProviderCallIds.has(block.id) || typeof block.name !== "string" || !isRecord(block.arguments)) {
						seenProviderCallIds.add(block.id);
						activeToolCalls.set(block.id, null);
						continue;
					}
					seenProviderCallIds.add(block.id);
					activeToolCalls.set(block.id, {
						assistantEntryId: entry.id,
						contentIndex,
						providerCallId: block.id,
						name: block.name,
						arguments: block.arguments,
					});
				}
			}

			if (entry.type === "message" && entry.message.role === "toolResult") {
				const toolCall = activeToolCalls.get(entry.message.toolCallId);
				if (toolCall && toolCall.name === entry.message.toolName) {
					resolvedByResultEntryId.set(entry.id, toolCall);
				}
			}

			stack.push({ phase: "exit", entryId: entry.id, changes });
			const children = childrenByParentId.get(entry.id) ?? [];
			for (let index = children.length - 1; index >= 0; index--) {
				stack.push({ phase: "enter", entry: children[index]! });
			}
		}
	};

	for (const root of roots) {
		if (!visitedEntryIds.has(root.id)) {
			traverseFrom(root);
		}
	}
	for (const entry of entries) {
		if (!visitedEntryIds.has(entry.id)) {
			traverseFrom(entry);
		}
	}

	return resolvedByResultEntryId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
