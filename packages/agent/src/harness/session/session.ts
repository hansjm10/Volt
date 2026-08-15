import type { ImageContent, JsonCompatibleInput, JsonValue, TextContent } from "@hansjm10/volt-ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import type {
	CanonicalCommitResult,
	CompactionEntry,
	PendingSessionWrite,
	ProjectionAdvance,
	ProjectionCursor,
	ResolvedSessionMutationReceipt,
	SessionBranchSnapshot,
	SessionContext,
	SessionMetadata,
	SessionMutationBatch,
	SessionMutationReceipt,
	SessionStorage,
	SessionStorageBranchSnapshot,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionTreeEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message as AgentMessage);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(
					entry.customType,
					entry.content as string | (TextContent | ImageContent)[],
					entry.display,
					entry.details,
					entry.timestamp,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
		const compactionIdx = pathEntries.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = pathEntries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendMessage(entry);
		}
		for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
			appendMessage(pathEntries[i]!);
		}
	} else {
		for (const entry of pathEntries) {
			appendMessage(entry);
		}
	}

	return {
		messages,
		thinkingLevel,
		model,
		activeToolNames,
		anchorLeafId: pathEntries.at(-1)?.id ?? null,
	};
}

function sameStringArray(left: readonly string[] | null, right: readonly string[] | null): boolean {
	if (left === null || right === null) return left === right;
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePersistedPolicy(left: SessionContext, right: SessionContext): boolean {
	return (
		left.thinkingLevel === right.thinkingLevel &&
		left.model?.provider === right.model?.provider &&
		left.model?.modelId === right.model?.modelId &&
		sameStringArray(left.activeToolNames, right.activeToolNames)
	);
}

function toBranchSnapshot(snapshot: SessionStorageBranchSnapshot): SessionBranchSnapshot {
	return {
		...snapshot,
		context: buildSessionContext([...snapshot.entries]),
	};
}

function buildProjectionAdvance(
	basisStorageSnapshot: SessionStorageBranchSnapshot,
	targetStorageSnapshot: SessionStorageBranchSnapshot,
): ProjectionAdvance {
	const basis = toBranchSnapshot(basisStorageSnapshot);
	const target = toBranchSnapshot(targetStorageSnapshot);
	let branchRelation: ProjectionAdvance["branchRelation"];
	if (basis.cursor.branchIdentity === target.cursor.branchIdentity) {
		branchRelation = "same";
	} else if (
		basis.cursor.branchIdentity === null ||
		target.entries.some((entry) => entry.id === basis.cursor.branchIdentity)
	) {
		branchRelation = "descendant";
	} else {
		branchRelation = "diverged";
	}

	let messages: ProjectionAdvance["messages"];
	if (branchRelation === "same") {
		messages = { kind: "unchanged" };
	} else if (branchRelation === "diverged") {
		messages = { kind: "rewrite", values: target.context.messages.map((message) => structuredClone(message)) };
	} else {
		const suffixStart =
			basis.cursor.branchIdentity === null
				? 0
				: target.entries.findIndex((entry) => entry.id === basis.cursor.branchIdentity) + 1;
		const suffix = target.entries.slice(suffixStart);
		if (suffix.some((entry) => entry.type === "compaction")) {
			messages = { kind: "rewrite", values: target.context.messages.map((message) => structuredClone(message)) };
		} else {
			const appended = target.context.messages
				.slice(basis.context.messages.length)
				.map((message) => structuredClone(message));
			messages = appended.length === 0 ? { kind: "unchanged" } : { kind: "append", values: appended };
		}
	}

	return {
		cursor: target.cursor,
		branchRelation,
		messages,
		persistedPolicy: {
			model: target.context.model === null ? null : { ...target.context.model },
			thinkingLevel: target.context.thinkingLevel,
			activeToolNames: target.context.activeToolNames === null ? null : [...target.context.activeToolNames],
		},
		persistedPolicyChanged: !samePersistedPolicy(basis.context, target.context),
	};
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private storage: SessionStorage<TMetadata>;

	constructor(storage: SessionStorage<TMetadata>) {
		this.storage = storage;
	}

	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	getStorage(): SessionStorage<TMetadata> {
		return this.storage;
	}

	async getBranchSnapshot(cursor?: ProjectionCursor): Promise<SessionBranchSnapshot> {
		return toBranchSnapshot(await this.storage.getBranchSnapshot(cursor));
	}

	async advanceProjection(cursor: ProjectionCursor): Promise<ProjectionAdvance> {
		const basis = await this.storage.getBranchSnapshot(cursor);
		const target = await this.storage.getBranchSnapshot();
		return buildProjectionAdvance(basis, target);
	}

	async commitBatch(batch: SessionMutationBatch): Promise<CanonicalCommitResult> {
		const result = await this.storage.commitBatch(batch);
		if (result.outcome !== "committed") return result;
		return {
			outcome: "committed",
			advance: buildProjectionAdvance(result.record.before, result.record.after),
			receipt: result.receipt,
			appendedEntryIds: result.record.appendedEntryIds,
		};
	}

	resolveMutationReceipt(receipt: SessionMutationReceipt): ResolvedSessionMutationReceipt | undefined {
		const record = this.storage.resolveMutationReceipt(receipt);
		if (!record) return undefined;
		return {
			advance: buildProjectionAdvance(record.before, record.after),
			appendedEntryIds: [...record.appendedEntryIds],
			...(record.deliveryAttribution === undefined
				? {}
				: { deliveryAttribution: { ...record.deliveryAttribution } }),
		};
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	getEntries(): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries();
	}

	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const leafId = fromId ?? (await this.storage.getLeafId());
		return this.storage.getPathToRoot(leafId);
	}

	async buildContext(): Promise<SessionContext> {
		return (await this.getBranchSnapshot()).context;
	}

	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	async getSessionName(): Promise<string | undefined> {
		const entries = await this.storage.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}

	private async appendTypedEntry(entry: PendingSessionWrite): Promise<string> {
		const snapshot = await this.getBranchSnapshot();
		const result = await this.commitBatch({
			guard: { kind: "descendant", cursor: snapshot.cursor },
			mutations: [{ kind: "append", entry }],
		});
		if (result.outcome !== "committed") throw result.error;
		return result.appendedEntryIds[0]!;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			message,
		});
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			thinkingLevel,
		});
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			provider,
			modelId,
		});
	}

	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry({
			type: "active_tools_change",
			activeToolNames: [...activeToolNames],
		});
	}

	async appendCompaction<T = JsonValue>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: JsonCompatibleInput<T>,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			summary,
			firstKeptEntryId,
			tokensBefore,
			...(details === undefined ? {} : { details: details as JsonValue }),
			...(fromHook === undefined ? {} : { fromHook }),
		});
	}

	async appendCustomEntry<T = JsonValue>(customType: string, data?: JsonCompatibleInput<T>): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			customType,
			...(data === undefined ? {} : { data: data as JsonValue }),
		});
	}

	async appendCustomMessageEntry<T = JsonValue>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: JsonCompatibleInput<T>,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			customType,
			content,
			display,
			...(details === undefined ? {} : { details: details as JsonValue }),
		});
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.storage.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			targetId,
			...(label === undefined ? {} : { label }),
		});
	}

	async appendSessionName(name: string): Promise<string> {
		return this.appendTypedEntry({
			type: "session_info",
			name: name.trim(),
		});
	}

	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: JsonValue; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.storage.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		const snapshot = await this.getBranchSnapshot();
		const mutations: SessionMutationBatch["mutations"] = [
			{ kind: "move", leafId: entryId },
			...(summary
				? [
						{
							kind: "append" as const,
							entry: {
								type: "branch_summary" as const,
								fromId: entryId ?? "root",
								summary: summary.summary,
								...(summary.details === undefined ? {} : { details: summary.details }),
								...(summary.fromHook === undefined ? {} : { fromHook: summary.fromHook }),
							},
						},
					]
				: []),
		];
		const result = await this.commitBatch({ guard: { kind: "exact", cursor: snapshot.cursor }, mutations });
		if (result.outcome !== "committed") throw result.error;
		return summary ? result.appendedEntryIds.at(-1) : undefined;
	}
}
