import type {
	FileSystem,
	JsonlSessionMetadata,
	LeafEntry,
	ProjectionCursor,
	SessionMutationBatch,
	SessionMutationReceipt,
	SessionMutationReceiptRecord,
	SessionStorage,
	SessionStorageBranchSnapshot,
	SessionStorageCommitResult,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { getFileSystemResultOrThrow } from "./repo-utils.ts";
import { uuidv7 } from "./uuid.ts";

type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) labelsById.set(entry.targetId, label);
	else labelsById.delete(entry.targetId);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}

function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	if (!isRecord(parsed) || parsed["type"] !== "session") {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	if (parsed["version"] !== 3) throw invalidSession(filePath, "unsupported session version");
	if (typeof parsed["id"] !== "string" || !parsed["id"]) {
		throw invalidSession(filePath, "session header is missing id");
	}
	if (typeof parsed["timestamp"] !== "string" || !parsed["timestamp"]) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof parsed["cwd"] !== "string" || !parsed["cwd"]) {
		throw invalidSession(filePath, "session header is missing cwd");
	}
	if (parsed["parentSession"] !== undefined && typeof parsed["parentSession"] !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	return {
		type: "session",
		version: 3,
		id: parsed["id"],
		timestamp: parsed["timestamp"],
		cwd: parsed["cwd"],
		...(parsed["parentSession"] === undefined ? {} : { parentSession: parsed["parentSession"] }),
	};
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
	}
	if (!isRecord(parsed)) throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	if (typeof parsed["type"] !== "string") throw invalidEntry(filePath, lineNumber, "is missing entry type");
	if (typeof parsed["id"] !== "string" || !parsed["id"]) {
		throw invalidEntry(filePath, lineNumber, "is missing entry id");
	}
	if (parsed["parentId"] !== null && typeof parsed["parentId"] !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid parentId");
	}
	if (typeof parsed["timestamp"] !== "string" || !parsed["timestamp"]) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	if (parsed["type"] === "leaf" && parsed["targetId"] !== null && typeof parsed["targetId"] !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid targetId");
	}
	return parsed as unknown as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		...(header.parentSession === undefined ? {} : { parentSessionPath: header.parentSession }),
	};
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

export async function loadJsonlSessionMetadata(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	const line = lines[0];
	if (line?.trim()) return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
	throw invalidSession(filePath, "missing session header");
}

async function loadJsonlStorage(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<{ header: SessionHeader; entries: SessionTreeEntry[]; leafId: string | null }> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) throw invalidSession(filePath, "missing session header");
	const header = parseHeaderLine(lines[0]!, filePath);
	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i]!, filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
	return { header, entries, leafId };
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	private readonly authorityGeneration = uuidv7();
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;
	private revision: number;
	private mutationTail: Promise<void> = Promise.resolve();
	private retiredError: SessionError | undefined;
	private readonly issuedCursors = new WeakSet<object>();
	private readonly receiptRecords = new WeakMap<object, SessionMutationReceiptRecord>();

	private constructor(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionTreeEntry[],
		leafId: string | null,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.metadata = headerToSessionMetadata(header, this.filePath);
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
		this.revision = entries.length;
	}

	static async open(fs: JsonlSessionStorageFileSystem, filePath: string): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath);
		return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
	}

	static async create(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		options: { cwd: string; sessionId: string; parentSessionPath?: string },
	): Promise<JsonlSessionStorage> {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			...(options.parentSessionPath === undefined ? {} : { parentSession: options.parentSessionPath }),
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSessionStorage(fs, filePath, header, [], null);
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

	private requireActiveAuthority(): void {
		if (this.retiredError) throw this.retiredError;
	}

	private retireAuthority(cause: Error): SessionError {
		this.retiredError ??= new SessionError(
			"authority_retired",
			`Session authority for ${this.filePath} requires reconciliation after an uncertain write`,
			cause,
		);
		return this.retiredError;
	}

	private issueCursor(revision = this.revision, branchIdentity = this.currentLeafId): ProjectionCursor {
		const cursor = Object.freeze({
			authorityGeneration: this.authorityGeneration,
			revision,
			branchIdentity,
		}) as ProjectionCursor;
		this.issuedCursors.add(cursor);
		return cursor;
	}

	private requireCursor(cursor: ProjectionCursor): void {
		this.requireActiveAuthority();
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
		return this.pathToRoot(this.currentLeafId).some((entry) => entry.id === branchIdentity);
	}

	private validateGuard(batch: SessionMutationBatch): SessionError | undefined {
		try {
			this.requireCursor(batch.guard.cursor);
		} catch (error) {
			return error instanceof SessionError ? error : new SessionError("conflict", "Invalid projection cursor");
		}
		const cursor = batch.guard.cursor;
		if (batch.guard.kind === "exact") {
			if (cursor.revision !== this.revision || cursor.branchIdentity !== this.currentLeafId) {
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
		let stagedLeafId = this.currentLeafId;
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

	private applyMaterialized(entries: readonly SessionTreeEntry[]): void {
		for (const entry of entries) {
			this.entries.push(entry);
			this.byId.set(entry.id, entry);
			updateLabelCache(this.labelsById, entry);
			this.currentLeafId = leafIdAfterEntry(entry);
		}
		this.revision += entries.length;
	}

	private async appendSerialized(entries: readonly SessionTreeEntry[], message: string): Promise<void> {
		const serialized = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const result = await this.fs.appendFile(this.filePath, serialized);
		if (!result.ok)
			throw this.retireAuthority(new SessionError("storage", `${message}: ${result.error.message}`, result.error));
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async getBranchSnapshot(cursor?: ProjectionCursor): Promise<SessionStorageBranchSnapshot> {
		return await this.inMutationLane(() => {
			this.requireActiveAuthority();
			if (cursor === undefined) return this.currentSnapshot();
			this.requireCursor(cursor);
			return this.snapshotForCursor(cursor);
		});
	}

	async commitBatch(batch: SessionMutationBatch): Promise<SessionStorageCommitResult> {
		return await this.inMutationLane(async () => {
			if (this.retiredError) return { outcome: "uncertain", error: this.retiredError };
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
			if (appended.length > 0) {
				try {
					await this.appendSerialized(appended, "Failed to append canonical session batch");
				} catch (error) {
					return { outcome: "uncertain", error: this.retireAuthority(toError(error)) };
				}
			}
			this.applyMaterialized(appended);
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
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}

	/** Identity-preserving repository bootstrap. Runtime mutations must use commitBatch. */
	async appendImportedEntry(entry: SessionTreeEntry): Promise<string> {
		return await this.inMutationLane(async () => {
			this.requireActiveAuthority();
			const storedEntry = structuredClone(entry);
			await this.appendSerialized([storedEntry], `Failed to append session entry ${entry.id}`);
			this.applyMaterialized([storedEntry]);
			return storedEntry.id;
		});
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
