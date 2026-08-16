import {
	type AgentMessage,
	type SessionTreeEntry as HarnessSessionTreeEntry,
	type PendingSessionWrite,
	type ProjectionCursor,
	Session,
	SessionError,
	type SessionMetadata,
	type SessionMutationBatch,
	type SessionMutationReceipt,
	type SessionMutationReceiptRecord,
	type SessionStorage,
	type SessionStorageBranchSnapshot,
	type SessionStorageCommitResult,
	uuidv7,
} from "@hansjm10/volt-agent-core";
import {
	SessionAtomicAppendError,
	type SessionCanonicalAppend,
	type SessionCanonicalCommitEvidence,
	SessionCanonicalConflictError,
	type SessionCanonicalMutation,
	type SessionCanonicalProjection,
	type SessionCanonicalProjectionToken,
	type SessionDeliveryAttemptIdentity,
	type SessionDeliveryCommitInput,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.ts";

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

function cloneSnapshot(snapshot: SessionStorageBranchSnapshot): SessionStorageBranchSnapshot {
	return Object.freeze({
		cursor: snapshot.cursor,
		entries: Object.freeze(snapshot.entries.map((entry) => deepFreeze(structuredClone(entry)))),
	});
}

function cloneReceiptRecord(record: SessionMutationReceiptRecord): SessionMutationReceiptRecord {
	return Object.freeze({
		basis: cloneSnapshot(record.basis),
		before: cloneSnapshot(record.before),
		after: cloneSnapshot(record.after),
		appendedEntryIds: Object.freeze([...record.appendedEntryIds]),
		...(record.deliveryAttribution === undefined
			? {}
			: { deliveryAttribution: Object.freeze({ ...record.deliveryAttribution }) }),
	});
}

function isHarnessEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "thinking_level_change" ||
		entry.type === "model_change" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "custom" ||
		entry.type === "custom_message" ||
		entry.type === "label" ||
		entry.type === "session_info"
	);
}

function toHarnessEntry(entry: SessionEntry, parentId: string | null): HarnessSessionTreeEntry | undefined {
	const base = { id: entry.id, parentId, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return { ...base, type: "message", message: structuredClone(entry.message) };
		case "thinking_level_change":
			return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
		case "model_change":
			return { ...base, type: "model_change", provider: entry.provider, modelId: entry.modelId };
		case "compaction":
			return {
				...base,
				type: "compaction",
				summary: entry.summary,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
				...(entry.details === undefined ? {} : { details: structuredClone(entry.details) }),
				...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
			};
		case "branch_summary":
			return {
				...base,
				type: "branch_summary",
				fromId: entry.fromId,
				summary: entry.summary,
				...(entry.details === undefined ? {} : { details: structuredClone(entry.details) }),
				...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
			};
		case "custom":
			return {
				...base,
				type: "custom",
				customType: entry.customType,
				...(entry.data === undefined ? {} : { data: structuredClone(entry.data) }),
			};
		case "custom_message":
			return {
				...base,
				type: "custom_message",
				customType: entry.customType,
				content: structuredClone(entry.content),
				display: entry.display,
				...(entry.details === undefined ? {} : { details: structuredClone(entry.details) }),
			};
		case "label":
			return {
				...base,
				type: "label",
				targetId: entry.targetId,
				...(entry.label === undefined ? {} : { label: entry.label }),
			};
		case "session_info":
			return {
				...base,
				type: "session_info",
				...(entry.name === undefined ? {} : { name: entry.name }),
			};
		default:
			return undefined;
	}
}

/**
 * Projects SessionManager's canonical tree through the generic Harness storage contract.
 * Coding-only policy/WAL entries remain in SessionManager and are transparent here.
 */
export class SessionManagerHarnessStorage implements SessionStorage {
	readonly sessionManager: SessionManager;
	private readonly isRetired: () => boolean;
	private readonly authorityGeneration = uuidv7();
	private revision = 0;
	private currentFingerprint: string | undefined;
	private currentSnapshot: SessionStorageBranchSnapshot | undefined;
	private readonly snapshots = new WeakMap<ProjectionCursor, SessionStorageBranchSnapshot>();
	private readonly canonicalTokens = new WeakMap<ProjectionCursor, SessionCanonicalProjectionToken>();
	private readonly canonicalRevisions = new WeakMap<ProjectionCursor, number>();
	private readonly mutationReceipts = new WeakMap<SessionMutationReceipt, SessionMutationReceiptRecord>();

	constructor(sessionManager: SessionManager, isRetired: () => boolean = () => false) {
		this.sessionManager = sessionManager;
		this.isRetired = isRetired;
	}

	private cannotWrite(): boolean {
		return this.isRetired() || this.sessionManager.getConversationAuthorityStatus().status !== "available";
	}

	private assertAuthorityAvailable(): void {
		if (this.isRetired()) throw new SessionError("authority_retired", "SessionManager storage is retired");
		try {
			this.sessionManager.assertConversationAuthorityAvailable();
		} catch (error) {
			throw new SessionError(
				"authority_retired",
				error instanceof Error ? error.message : String(error),
				error instanceof Error ? error : undefined,
			);
		}
	}

	private failStopCanonicalEvidence(error: unknown): never {
		const cause = error instanceof Error ? error : new Error(String(error));
		const retired = this.sessionManager.retireConversationAuthority(cause);
		throw new SessionError("authority_retired", retired.message, retired);
	}

	private getVisibleParentId(parentId: string | null): string | null {
		let currentId = parentId;
		while (currentId !== null) {
			const current = this.sessionManager.getEntry(currentId);
			if (!current) return null;
			if (isHarnessEntry(current)) return current.id;
			currentId = current.parentId;
		}
		return null;
	}

	private getVisibleFirstKeptEntryId(
		entry: Extract<SessionEntry, { type: "compaction" }>,
		capturedEntries?: ReadonlyMap<string, SessionEntry>,
	): string {
		const firstKeptEntry = capturedEntries
			? capturedEntries.get(entry.firstKeptEntryId)
			: this.sessionManager.getEntry(entry.firstKeptEntryId);
		if (!firstKeptEntry || isHarnessEntry(firstKeptEntry)) return entry.firstKeptEntryId;

		let currentId = entry.parentId;
		let firstVisibleDescendantId: string | undefined;
		while (currentId !== null) {
			const current = capturedEntries ? capturedEntries.get(currentId) : this.sessionManager.getEntry(currentId);
			if (!current) return entry.firstKeptEntryId;
			if (isHarnessEntry(current)) firstVisibleDescendantId = current.id;
			if (current.id === entry.firstKeptEntryId) {
				return firstVisibleDescendantId ?? entry.firstKeptEntryId;
			}
			currentId = current.parentId;
		}
		return entry.firstKeptEntryId;
	}

	private projectEntry(
		entry: SessionEntry,
		parentId: string | null,
		capturedEntries?: ReadonlyMap<string, SessionEntry>,
	): HarnessSessionTreeEntry | undefined {
		const projected = toHarnessEntry(entry, parentId);
		if (!projected || projected.type !== "compaction" || entry.type !== "compaction") return projected;
		return { ...projected, firstKeptEntryId: this.getVisibleFirstKeptEntryId(entry, capturedEntries) };
	}

	private mapPath(entries: readonly SessionEntry[]): HarnessSessionTreeEntry[] {
		const mapped: HarnessSessionTreeEntry[] = [];
		const capturedEntries = new Map(entries.map((entry) => [entry.id, entry]));
		let parentId: string | null = null;
		for (const entry of entries) {
			const projected = this.projectEntry(entry, parentId, capturedEntries);
			if (!projected) continue;
			mapped.push(projected);
			parentId = projected.id;
		}
		return mapped;
	}

	private normalizePendingEntry(entry: PendingSessionWrite): SessionCanonicalAppend {
		switch (entry.type) {
			case "message":
				if (entry.message.role === "branchSummary" || entry.message.role === "compactionSummary") {
					throw new SessionError(
						"invalid_session",
						`${entry.message.role} messages must use their canonical SessionManager entry type`,
					);
				}
				return { type: "message", message: entry.message };
			case "thinking_level_change":
				return { type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
			case "model_change":
				return { type: "model_change", provider: entry.provider, modelId: entry.modelId };
			case "active_tools_change":
				throw new SessionError("invalid_session", "SessionManager does not persist active tool projections");
			case "compaction":
				return {
					type: "compaction",
					summary: entry.summary,
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					...(entry.details === undefined ? {} : { details: entry.details }),
					...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
				};
			case "branch_summary":
				return {
					type: "branch_summary",
					fromId: entry.fromId === "root" ? null : entry.fromId,
					summary: entry.summary,
					...(entry.details === undefined ? {} : { details: entry.details }),
					...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
				};
			case "custom":
				return {
					type: "custom",
					customType: entry.customType,
					...(entry.data === undefined ? {} : { data: entry.data }),
				};
			case "custom_message":
				return {
					type: "custom_message",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					...(entry.details === undefined ? {} : { details: entry.details }),
				};
			case "label":
				return {
					type: "label",
					targetId: entry.targetId,
					...(entry.label === undefined ? {} : { label: entry.label }),
				};
			case "session_info":
				return { type: "session_info", ...(entry.name === undefined ? {} : { name: entry.name }) };
		}
	}

	private projectCanonicalProjection(
		projection: SessionCanonicalProjection,
		preferred?: SessionStorageBranchSnapshot,
	): SessionStorageBranchSnapshot {
		const entries = this.mapPath(projection.entries);
		const leafId = entries.at(-1)?.id ?? null;
		const fingerprint = `${entries.map((entry) => entry.id).join(":")}:${leafId ?? "root"}`;
		if (
			preferred &&
			this.canonicalRevisions.get(preferred.cursor) === projection.revision &&
			preferred.cursor.branchIdentity === leafId &&
			preferred.entries.length === entries.length &&
			preferred.entries.every((entry, index) => entry.id === entries[index]?.id)
		) {
			this.currentFingerprint = fingerprint;
			this.currentSnapshot = preferred;
			this.canonicalTokens.set(preferred.cursor, projection.token);
			return cloneSnapshot(preferred);
		}
		if (
			this.currentSnapshot &&
			this.currentFingerprint === fingerprint &&
			this.canonicalRevisions.get(this.currentSnapshot.cursor) === projection.revision
		) {
			this.canonicalTokens.set(this.currentSnapshot.cursor, projection.token);
			return cloneSnapshot(this.currentSnapshot);
		}
		this.revision++;
		const nextCursor = Object.freeze({
			authorityGeneration: this.authorityGeneration,
			revision: this.revision,
			branchIdentity: leafId,
		}) as ProjectionCursor;
		const snapshot = cloneSnapshot({ cursor: nextCursor, entries });
		this.currentFingerprint = fingerprint;
		this.currentSnapshot = snapshot;
		this.snapshots.set(nextCursor, snapshot);
		this.canonicalTokens.set(nextCursor, projection.token);
		this.canonicalRevisions.set(nextCursor, projection.revision);
		return cloneSnapshot(snapshot);
	}

	private issueBranchSnapshot(cursor?: ProjectionCursor): SessionStorageBranchSnapshot {
		this.assertAuthorityAvailable();
		if (cursor !== undefined) {
			const snapshot = this.snapshots.get(cursor);
			if (!snapshot) throw new SessionError("conflict", "Projection cursor was not issued by this storage");
			return cloneSnapshot(snapshot);
		}
		return this.projectCanonicalProjection(this.sessionManager.issueCanonicalProjection());
	}

	async getBranchSnapshot(cursor?: ProjectionCursor): Promise<SessionStorageBranchSnapshot> {
		return this.issueBranchSnapshot(cursor);
	}

	async commitBatch(batch: SessionMutationBatch): Promise<SessionStorageCommitResult> {
		this.assertAuthorityAvailable();
		const basis = this.snapshots.get(batch.guard.cursor);
		const token = this.canonicalTokens.get(batch.guard.cursor);
		if (!basis || !token) throw new SessionError("conflict", "Mutation guard was not issued by this storage");
		const mutations: SessionCanonicalMutation[] = batch.mutations.map((mutation) => {
			if (mutation.kind === "append") {
				return { kind: "append", entry: this.normalizePendingEntry(mutation.entry) };
			}
			return structuredClone(mutation);
		});
		let evidence: SessionCanonicalCommitEvidence;
		try {
			evidence = await this.sessionManager.commitCanonicalCommand({
				guard: { kind: batch.guard.kind, token },
				mutations,
			});
		} catch (error) {
			if (
				error instanceof SessionAtomicAppendError &&
				(error.effect === "uncertain" ||
					error.effect === "committed" ||
					error.authority === "reconciliation_required")
			) {
				return {
					outcome: "uncertain",
					error: new SessionError("authority_retired", error.message, error),
				};
			}
			if (error instanceof SessionCanonicalConflictError) {
				return {
					outcome: "rolled_back",
					cursor: this.issueBranchSnapshot().cursor,
					error: new SessionError("conflict", error.message, error),
				};
			}
			return {
				outcome: "rolled_back",
				cursor: (await this.getBranchSnapshot()).cursor,
				error: new SessionError(
					"storage",
					error instanceof Error ? error.message : String(error),
					error instanceof Error ? error : undefined,
				),
			};
		}
		let record: SessionMutationReceiptRecord;
		try {
			const before = this.projectCanonicalProjection(
				evidence.before,
				batch.guard.kind === "exact" ? basis : undefined,
			);
			const after = this.projectCanonicalProjection(evidence.after);
			record = Object.freeze({
				basis,
				before,
				after,
				appendedEntryIds: Object.freeze([...evidence.appendedEntryIds]),
				...(batch.deliveryAttribution === undefined
					? {}
					: { deliveryAttribution: Object.freeze({ ...batch.deliveryAttribution }) }),
			});
		} catch (error) {
			this.failStopCanonicalEvidence(error);
		}
		const receipt = Object.freeze({}) as SessionMutationReceipt;
		this.mutationReceipts.set(receipt, record);
		return { outcome: "committed", receipt, record: cloneReceiptRecord(record) };
	}

	resolveMutationReceipt(receipt: SessionMutationReceipt): SessionMutationReceiptRecord | undefined {
		const record = this.mutationReceipts.get(receipt);
		return record ? cloneReceiptRecord(record) : undefined;
	}

	private issueMutationReceipt(record: SessionMutationReceiptRecord): SessionMutationReceipt {
		const receipt = Object.freeze({}) as SessionMutationReceipt;
		this.mutationReceipts.set(receipt, record);
		return receipt;
	}

	private issueDeliveryMutationReceipt(
		beforeProjection: SessionCanonicalProjection,
		afterProjection: SessionCanonicalProjection,
		identity: SessionDeliveryAttemptIdentity,
		appendedEntryIds: readonly string[],
	): SessionMutationReceipt {
		try {
			const before = this.projectCanonicalProjection(beforeProjection);
			const after = this.projectCanonicalProjection(afterProjection, before);
			return this.issueMutationReceipt(
				Object.freeze({
					basis: before,
					before,
					after,
					appendedEntryIds: Object.freeze([...appendedEntryIds]),
					deliveryAttribution: Object.freeze({ ...identity }),
				}),
			);
		} catch (error) {
			this.failStopCanonicalEvidence(error);
		}
	}

	/** Bridge an AgentSession delivery transaction into Harness's opaque canonical receipt authority. */
	async commitOwnedDelivery(input: SessionDeliveryCommitInput): Promise<SessionMutationReceipt> {
		const managerReceipt = await this.sessionManager.commitDelivery(input);
		const verified = this.sessionManager.verifyDeliveryReceipt(managerReceipt);
		if (
			verified?.outcome !== "committed" ||
			verified.deliveryId !== input.deliveryId ||
			verified.epoch !== input.epoch ||
			verified.attemptId !== input.attemptId
		) {
			this.failStopCanonicalEvidence(new Error("SessionManager returned an invalid delivery commit receipt"));
		}
		return this.issueDeliveryMutationReceipt(
			verified.beforeProjection,
			verified.afterProjection,
			input,
			verified.entryIds,
		);
	}

	/** Issue a store-authenticated zero-delta receipt for an explicitly retained attempt. */
	async attestOwnedDeliveryNoEffect(identity: SessionDeliveryAttemptIdentity): Promise<SessionMutationReceipt> {
		const managerReceipt = await this.sessionManager.attestDeliveryNoEffect(identity);
		const verified = this.sessionManager.verifyDeliveryReceipt(managerReceipt);
		if (
			verified?.outcome !== "no_effect" ||
			verified.deliveryId !== identity.deliveryId ||
			verified.epoch !== identity.epoch ||
			verified.attemptId !== identity.attemptId
		) {
			this.failStopCanonicalEvidence(new Error("SessionManager returned an invalid no-effect receipt"));
		}
		return this.issueDeliveryMutationReceipt(verified.beforeProjection, verified.afterProjection, identity, []);
	}

	/** Roll direct input dispatch markers back to recoverable state without changing provider context. */
	async retainOwnedDelivery(
		identity: SessionDeliveryAttemptIdentity,
		messages: readonly AgentMessage[],
	): Promise<SessionMutationReceipt> {
		const managerReceipt = await this.sessionManager.retainDelivery(identity, messages);
		const verified = this.sessionManager.verifyDeliveryReceipt(managerReceipt);
		if (
			verified?.outcome !== "no_effect" ||
			verified.deliveryId !== identity.deliveryId ||
			verified.epoch !== identity.epoch ||
			verified.attemptId !== identity.attemptId
		) {
			this.failStopCanonicalEvidence(new Error("SessionManager could not attest a retained delivery attempt"));
		}
		return this.issueDeliveryMutationReceipt(verified.beforeProjection, verified.afterProjection, identity, []);
	}

	async getMetadata(): Promise<SessionMetadata> {
		const header = this.sessionManager.getHeader();
		if (!header) throw new SessionError("invalid_session", "SessionManager has no session header");
		return { id: header.id, createdAt: header.timestamp };
	}

	async getLeafId(): Promise<string | null> {
		if (this.cannotWrite()) return null;
		return this.mapPath(this.sessionManager.getBranch()).at(-1)?.id ?? null;
	}

	async getEntry(id: string): Promise<HarnessSessionTreeEntry | undefined> {
		const entry = this.sessionManager.getEntry(id);
		return entry && isHarnessEntry(entry)
			? this.projectEntry(entry, this.getVisibleParentId(entry.parentId))
			: undefined;
	}

	async findEntries<TType extends HarnessSessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<HarnessSessionTreeEntry, { type: TType }>>> {
		return (await this.getEntries()).filter(
			(entry): entry is Extract<HarnessSessionTreeEntry, { type: TType }> => entry.type === type,
		);
	}

	async getLabel(id: string): Promise<string | undefined> {
		const entry = this.sessionManager.getEntry(id);
		return entry && isHarnessEntry(entry) ? this.sessionManager.getLabel(id) : undefined;
	}

	async getPathToRoot(leafId: string | null): Promise<HarnessSessionTreeEntry[]> {
		if (leafId === null) return [];
		const entry = this.sessionManager.getEntry(leafId);
		if (!entry || !isHarnessEntry(entry)) throw new SessionError("not_found", `Entry ${leafId} not found`);
		return this.mapPath(this.sessionManager.getBranch(leafId));
	}

	async getEntries(): Promise<HarnessSessionTreeEntry[]> {
		return this.sessionManager.getEntries().flatMap((entry) => {
			const projected = this.projectEntry(entry, this.getVisibleParentId(entry.parentId));
			return projected ? [projected] : [];
		});
	}
}

export function createSessionManagerHarnessSession(
	sessionManager: SessionManager,
	isRetired: () => boolean = () => false,
	storage: SessionManagerHarnessStorage = new SessionManagerHarnessStorage(sessionManager, isRetired),
): Session {
	return new Session(storage);
}
