import {
	type LeafEntry,
	type ProjectionCursor,
	SessionError,
	type SessionMetadata,
	type SessionMutationBatch,
	type SessionMutationReceipt,
	type SessionMutationReceiptRecord,
	type SessionStorage,
	type SessionStorageBranchSnapshot,
	type SessionStorageCommitResult,
	type SessionTreeEntry,
} from "../types.ts";
import { uuidv7 } from "./uuid.ts";

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId);
	}
}

function buildLabelsById(entries: readonly SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) updateLabelCache(labelsById, entry);
	return labelsById;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv7().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

function cloneEntries(entries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	return entries.map((entry) => structuredClone(entry));
}

function cloneReceiptRecord(record: SessionMutationReceiptRecord): SessionMutationReceiptRecord {
	return {
		basis: { cursor: record.basis.cursor, entries: cloneEntries(record.basis.entries) },
		before: { cursor: record.before.cursor, entries: cloneEntries(record.before.entries) },
		after: { cursor: record.after.cursor, entries: cloneEntries(record.after.entries) },
		appendedEntryIds: [...record.appendedEntryIds],
		...(record.deliveryAttribution === undefined ? {} : { deliveryAttribution: { ...record.deliveryAttribution } }),
	};
}

export class InMemorySessionStorage<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionStorage<TMetadata>
{
	private readonly metadata: TMetadata;
	private readonly authorityGeneration = uuidv7();
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private leafId: string | null;
	private revision: number;
	private mutationTail: Promise<void> = Promise.resolve();
	private readonly issuedCursors = new WeakSet<object>();
	private readonly receiptRecords = new WeakMap<object, SessionMutationReceiptRecord>();

	constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
		this.entries = options?.entries ? cloneEntries(options.entries) : [];
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(this.entries);
		this.leafId = null;
		for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		this.revision = this.entries.length;
		this.metadata = options?.metadata ?? ({ id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata);
	}

	private async inMutationLane<T>(operation: () => Promise<T> | T): Promise<T> {
		const previous = this.mutationTail;
		let release: (() => void) | undefined;
		this.mutationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}

	private issueCursor(revision = this.revision, branchIdentity = this.leafId): ProjectionCursor {
		const cursor = Object.freeze({
			authorityGeneration: this.authorityGeneration,
			revision,
			branchIdentity,
		}) as ProjectionCursor;
		this.issuedCursors.add(cursor);
		return cursor;
	}

	private requireCursor(cursor: ProjectionCursor): void {
		if (!this.issuedCursors.has(cursor)) {
			throw new SessionError("conflict", "Projection cursor was not issued by this session authority");
		}
		if (cursor.authorityGeneration !== this.authorityGeneration || cursor.revision > this.revision) {
			throw new SessionError("conflict", "Projection cursor does not belong to the current session authority");
		}
		if (cursor.branchIdentity !== null && !this.byId.has(cursor.branchIdentity)) {
			throw new SessionError("conflict", `Projection branch ${cursor.branchIdentity} no longer exists`);
		}
	}

	private pathToRoot(leafId: string | null, byId = this.byId): SessionTreeEntry[] {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let current = byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (!current.parentId) break;
			const parent = byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	private snapshotForCursor(cursor: ProjectionCursor): SessionStorageBranchSnapshot {
		return Object.freeze({ cursor, entries: Object.freeze(cloneEntries(this.pathToRoot(cursor.branchIdentity))) });
	}

	private currentSnapshot(): SessionStorageBranchSnapshot {
		return this.snapshotForCursor(this.issueCursor());
	}

	private isDescendantOf(branchIdentity: string | null): boolean {
		if (branchIdentity === null) return true;
		return this.pathToRoot(this.leafId).some((entry) => entry.id === branchIdentity);
	}

	private validateGuard(batch: SessionMutationBatch): SessionError | undefined {
		try {
			this.requireCursor(batch.guard.cursor);
		} catch (error) {
			return error instanceof SessionError ? error : new SessionError("conflict", "Invalid projection cursor");
		}
		const cursor = batch.guard.cursor;
		if (batch.guard.kind === "exact") {
			if (cursor.revision !== this.revision || cursor.branchIdentity !== this.leafId) {
				return new SessionError("conflict", "Canonical session changed after the exact projection cursor");
			}
		} else if (!this.isDescendantOf(cursor.branchIdentity)) {
			return new SessionError("conflict", "Canonical session branch diverged after the projection cursor");
		}
		return undefined;
	}

	private materializeMutations(batch: SessionMutationBatch): SessionTreeEntry[] {
		if (batch.mutations.length === 0 && batch.deliveryAttribution === undefined) {
			throw new SessionError("invalid_entry", "An empty canonical batch requires delivery attribution");
		}
		const appended: SessionTreeEntry[] = [];
		const stagedById = new Map(this.byId);
		let stagedLeafId = this.leafId;
		for (const mutation of batch.mutations) {
			if (mutation.kind === "move" || mutation.kind === "move_with_summary") {
				if (mutation.leafId !== null && !stagedById.has(mutation.leafId)) {
					throw new SessionError("not_found", `Entry ${mutation.leafId} not found`);
				}
				const entry: LeafEntry = {
					type: "leaf",
					id: generateEntryId(stagedById),
					parentId: stagedLeafId,
					timestamp: new Date().toISOString(),
					targetId: mutation.leafId,
				};
				appended.push(entry);
				stagedById.set(entry.id, entry);
				stagedLeafId = mutation.leafId;
				if (mutation.kind === "move_with_summary" && mutation.summary !== undefined) {
					const summaryEntry = {
						type: "branch_summary" as const,
						id: generateEntryId(stagedById),
						parentId: stagedLeafId,
						timestamp: new Date().toISOString(),
						fromId: mutation.leafId ?? "root",
						summary: mutation.summary.summary,
						...(mutation.summary.details === undefined
							? {}
							: { details: structuredClone(mutation.summary.details) }),
						...(mutation.summary.fromHook === undefined ? {} : { fromHook: mutation.summary.fromHook }),
					};
					appended.push(summaryEntry);
					stagedById.set(summaryEntry.id, summaryEntry);
					stagedLeafId = summaryEntry.id;
					if (mutation.summary.label !== undefined) {
						const labelEntry = {
							type: "label" as const,
							id: generateEntryId(stagedById),
							parentId: stagedLeafId,
							timestamp: new Date().toISOString(),
							targetId: summaryEntry.id,
							label: mutation.summary.label,
						};
						appended.push(labelEntry);
						stagedById.set(labelEntry.id, labelEntry);
						stagedLeafId = labelEntry.id;
					}
				}
				continue;
			}
			const entry = {
				...structuredClone(mutation.entry),
				id: generateEntryId(stagedById),
				parentId: stagedLeafId,
				timestamp: new Date().toISOString(),
			} as SessionTreeEntry;
			if (entry.type === "label" && !stagedById.has(entry.targetId)) {
				throw new SessionError("not_found", `Entry ${entry.targetId} not found`);
			}
			appended.push(entry);
			stagedById.set(entry.id, entry);
			stagedLeafId = entry.id;
		}
		return appended;
	}

	private appendMaterialized(entries: readonly SessionTreeEntry[]): void {
		for (const entry of entries) {
			this.entries.push(entry);
			this.byId.set(entry.id, entry);
			updateLabelCache(this.labelsById, entry);
			this.leafId = leafIdAfterEntry(entry);
		}
		this.revision += entries.length;
	}

	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}

	async getBranchSnapshot(cursor?: ProjectionCursor): Promise<SessionStorageBranchSnapshot> {
		return await this.inMutationLane(() => {
			if (cursor === undefined) return this.currentSnapshot();
			this.requireCursor(cursor);
			return this.snapshotForCursor(cursor);
		});
	}

	async commitBatch(batch: SessionMutationBatch): Promise<SessionStorageCommitResult> {
		return await this.inMutationLane(() => {
			const guardError = this.validateGuard(batch);
			if (guardError) return { outcome: "rolled_back", cursor: this.issueCursor(), error: guardError };
			const basis = this.snapshotForCursor(batch.guard.cursor);
			const before = this.currentSnapshot();
			let appended: SessionTreeEntry[];
			try {
				appended = this.materializeMutations(batch);
			} catch (error) {
				const failure =
					error instanceof SessionError
						? error
						: new SessionError("invalid_entry", "Failed to materialize canonical mutation batch");
				return { outcome: "rolled_back", cursor: before.cursor, error: failure };
			}
			this.appendMaterialized(appended);
			const after = this.currentSnapshot();
			const record: SessionMutationReceiptRecord = Object.freeze({
				basis,
				before,
				after,
				appendedEntryIds: Object.freeze(appended.map((entry) => entry.id)),
				...(batch.deliveryAttribution === undefined
					? {}
					: { deliveryAttribution: Object.freeze({ ...batch.deliveryAttribution }) }),
			});
			const receipt = Object.freeze({}) as SessionMutationReceipt;
			this.receiptRecords.set(receipt, record);
			return { outcome: "committed", receipt, record: cloneReceiptRecord(record) };
		});
	}

	resolveMutationReceipt(receipt: SessionMutationReceipt): SessionMutationReceiptRecord | undefined {
		const record = this.receiptRecords.get(receipt);
		return record === undefined ? undefined : cloneReceiptRecord(record);
	}

	async getLeafId(): Promise<string | null> {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return this.leafId;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		const entry = this.byId.get(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries
			.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type)
			.map((entry) => structuredClone(entry));
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		return cloneEntries(this.pathToRoot(leafId));
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return cloneEntries(this.entries);
	}
}
