import { Buffer } from "node:buffer";
import type { SessionEntry } from "../session-manager.ts";
import type { RpcConversationTranscriptItem, RpcSessionTreeNode, RpcSessionTreePage } from "./types.ts";
import {
	RPC_SESSION_TREE_MAX_SERIALIZED_BYTES,
	RPC_SESSION_TREE_PAGE_DEFAULT_ITEMS,
	RPC_SESSION_TREE_PAGE_MAX_ITEMS,
} from "./wire-limits.ts";

export const RPC_SESSION_TREE_PROJECTION_VERSION = 1;

export interface ProjectSessionTreePageOptions {
	sessionId: string;
	workspaceName?: string;
	afterOrdinal?: number;
	limit?: number;
	maxSerializedBytes?: number;
	projectTranscriptEntry(entry: SessionEntry): RpcConversationTranscriptItem | undefined;
}

function normalizeSessionTreeTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}

function normalizeSessionTreeLimit(limit: number | undefined): number {
	if (limit === undefined) return RPC_SESSION_TREE_PAGE_DEFAULT_ITEMS;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("Session tree page limit must be a positive safe integer");
	}
	return Math.min(limit, RPC_SESSION_TREE_PAGE_MAX_ITEMS);
}

function requireSessionTreeOrdinal(entry: SessionEntry): number {
	if (!Number.isSafeInteger(entry.ordinal) || (entry.ordinal ?? 0) <= 0) {
		throw new Error(`Session tree entry ${entry.id} is missing its positive commit ordinal`);
	}
	return entry.ordinal!;
}

function measureSessionTreePageBytes(
	fixedFields: Omit<RpcSessionTreePage, "nodes" | "hasMore" | "nextAfterOrdinal">,
	serializedNodeBytes: number,
	nodeCount: number,
	hasMore: boolean,
	nextAfterOrdinal: number | null,
): number {
	const emptyPageBytes = Buffer.byteLength(
		JSON.stringify({ ...fixedFields, nodes: [], hasMore, nextAfterOrdinal }),
		"utf8",
	);
	return emptyPageBytes + serializedNodeBytes + Math.max(0, nodeCount - 1);
}

/**
 * Project one bounded append-order page of a session tree. The structural lane
 * contains only stable ids, ordinals, timestamps, and active-branch membership;
 * callers supply the transport-specific sanitized transcript projection.
 */
export function projectSessionTreePage(
	entries: SessionEntry[],
	activeBranch: SessionEntry[],
	options: ProjectSessionTreePageOptions,
): RpcSessionTreePage {
	const afterOrdinal = options.afterOrdinal ?? 0;
	if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
		throw new Error("Session tree cursor must be a non-negative safe integer");
	}
	const limit = normalizeSessionTreeLimit(options.limit);
	const maxSerializedBytes = options.maxSerializedBytes ?? RPC_SESSION_TREE_MAX_SERIALIZED_BYTES;
	if (!Number.isSafeInteger(maxSerializedBytes) || maxSerializedBytes <= 0) {
		throw new Error("Session tree page byte budget must be a positive safe integer");
	}

	const orderedEntries = entries
		.map((entry) => ({ entry, ordinal: requireSessionTreeOrdinal(entry) }))
		.sort((left, right) => left.ordinal - right.ordinal);
	for (let index = 1; index < orderedEntries.length; index++) {
		if (orderedEntries[index - 1]!.ordinal === orderedEntries[index]!.ordinal) {
			throw new Error(`Session tree contains duplicate commit ordinal ${orderedEntries[index]!.ordinal}`);
		}
	}

	const visibleEntryIds = new Set(orderedEntries.map(({ entry }) => entry.id));
	const activeEntryIds = new Set(activeBranch.map((entry) => entry.id));
	const eligibleEntries = orderedEntries.filter(({ ordinal }) => ordinal > afterOrdinal);
	const activeLeaf = activeBranch.at(-1);
	const head =
		activeLeaf === undefined ? null : { entryId: activeLeaf.id, ordinal: requireSessionTreeOrdinal(activeLeaf) };
	const fixedFields: Omit<RpcSessionTreePage, "nodes" | "hasMore" | "nextAfterOrdinal"> = {
		...(options.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
		sessionId: options.sessionId,
		projectionVersion: RPC_SESSION_TREE_PROJECTION_VERSION,
		head,
	};

	const nodes: RpcSessionTreeNode[] = [];
	let serializedNodeBytes = 0;
	for (let index = 0; index < eligibleEntries.length && nodes.length < limit; index++) {
		const candidate = eligibleEntries[index]!;
		const transcript = options.projectTranscriptEntry(candidate.entry) ?? null;
		if (
			transcript !== null &&
			(transcript.entryId !== candidate.entry.id || transcript.ordinal !== candidate.ordinal)
		) {
			throw new Error(`Session tree transcript projection identity mismatch for ${candidate.entry.id}`);
		}
		const node: RpcSessionTreeNode = {
			entryId: candidate.entry.id,
			parentEntryId:
				candidate.entry.parentId !== null && visibleEntryIds.has(candidate.entry.parentId)
					? candidate.entry.parentId
					: null,
			ordinal: candidate.ordinal,
			createdAt: normalizeSessionTreeTimestamp(candidate.entry.timestamp),
			activeBranch: activeEntryIds.has(candidate.entry.id),
			transcript,
		};
		const candidateNodeBytes = Buffer.byteLength(JSON.stringify(node), "utf8");
		const candidateHasMore = index + 1 < eligibleEntries.length;
		const candidatePageBytes = measureSessionTreePageBytes(
			fixedFields,
			serializedNodeBytes + candidateNodeBytes,
			nodes.length + 1,
			candidateHasMore,
			candidateHasMore ? candidate.ordinal : null,
		);
		if (candidatePageBytes > maxSerializedBytes) {
			if (nodes.length === 0) {
				throw new Error(`Projected session tree entry ${candidate.entry.id} exceeds the page byte budget`);
			}
			break;
		}
		nodes.push(node);
		serializedNodeBytes += candidateNodeBytes;
	}

	const hasMore = nodes.length < eligibleEntries.length;
	const nextAfterOrdinal = hasMore ? (nodes.at(-1)?.ordinal ?? null) : null;
	if (
		measureSessionTreePageBytes(fixedFields, serializedNodeBytes, nodes.length, hasMore, nextAfterOrdinal) >
		maxSerializedBytes
	) {
		throw new Error("Session tree page metadata exceeds the page byte budget");
	}
	return { ...fixedFields, nodes, hasMore, nextAfterOrdinal };
}
