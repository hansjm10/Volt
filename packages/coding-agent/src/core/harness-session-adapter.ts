import {
	type SessionTreeEntry as HarnessSessionTreeEntry,
	Session,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	uuidv7,
} from "@hansjm10/volt-agent-core";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

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

	constructor(sessionManager: SessionManager, isRetired: () => boolean = () => false) {
		this.sessionManager = sessionManager;
		this.isRetired = isRetired;
	}

	private cannotWrite(): boolean {
		return this.isRetired() || this.sessionManager.getConversationAuthorityStatus().status !== "available";
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

	private getVisibleFirstKeptEntryId(entry: Extract<SessionEntry, { type: "compaction" }>): string {
		const firstKeptEntry = this.sessionManager.getEntry(entry.firstKeptEntryId);
		if (!firstKeptEntry || isHarnessEntry(firstKeptEntry)) return entry.firstKeptEntryId;

		let currentId = entry.parentId;
		let firstVisibleDescendantId: string | undefined;
		while (currentId !== null) {
			const current = this.sessionManager.getEntry(currentId);
			if (!current) return entry.firstKeptEntryId;
			if (isHarnessEntry(current)) firstVisibleDescendantId = current.id;
			if (current.id === entry.firstKeptEntryId) {
				return firstVisibleDescendantId ?? entry.firstKeptEntryId;
			}
			currentId = current.parentId;
		}
		return entry.firstKeptEntryId;
	}

	private projectEntry(entry: SessionEntry, parentId: string | null): HarnessSessionTreeEntry | undefined {
		const projected = toHarnessEntry(entry, parentId);
		if (!projected || projected.type !== "compaction" || entry.type !== "compaction") return projected;
		return { ...projected, firstKeptEntryId: this.getVisibleFirstKeptEntryId(entry) };
	}

	private mapPath(entries: readonly SessionEntry[]): HarnessSessionTreeEntry[] {
		const mapped: HarnessSessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (const entry of entries) {
			const projected = this.projectEntry(entry, parentId);
			if (!projected) continue;
			mapped.push(projected);
			parentId = projected.id;
		}
		return mapped;
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

	async setLeafId(leafId: string | null): Promise<void> {
		if (this.cannotWrite()) return;
		if (leafId === null) {
			this.sessionManager.resetLeaf();
			return;
		}
		const entry = this.sessionManager.getEntry(leafId);
		if (!entry || !isHarnessEntry(entry)) throw new SessionError("not_found", `Entry ${leafId} not found`);
		this.sessionManager.branch(leafId);
	}

	async createEntryId(): Promise<string> {
		return uuidv7();
	}

	async appendEntry(entry: HarnessSessionTreeEntry): Promise<string> {
		if (this.cannotWrite()) {
			// Delivery settlement already fenced canonical authority. Harness may
			// still settle runtime events and queued state writes, but none may append
			// through the retired manager generation.
			return entry.id;
		}
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "branchSummary" || message.role === "compactionSummary") {
					throw new SessionError(
						"invalid_session",
						`${message.role} messages must use their canonical SessionManager entry type`,
					);
				}
				return this.sessionManager.appendMessage(message);
			}
			case "thinking_level_change":
				return this.sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
			case "model_change":
				return this.sessionManager.appendModelChange(entry.provider, entry.modelId);
			case "active_tools_change":
				throw new SessionError("invalid_session", "SessionManager does not persist active tool projections");
			case "compaction":
				return this.sessionManager.appendCompaction(
					entry.summary,
					entry.firstKeptEntryId,
					entry.tokensBefore,
					entry.details,
					entry.fromHook,
				);
			case "branch_summary":
				return this.sessionManager.branchWithSummary(entry.parentId, entry.summary, entry.details, entry.fromHook);
			case "custom":
				return this.sessionManager.appendCustomEntry(entry.customType, entry.data);
			case "custom_message":
				return this.sessionManager.appendCustomMessageEntry(
					entry.customType,
					entry.content,
					entry.display,
					entry.details,
				);
			case "label":
				return this.sessionManager.appendLabelChange(entry.targetId, entry.label);
			case "session_info":
				return this.sessionManager.appendSessionInfo(entry.name ?? "");
			case "leaf":
				await this.setLeafId(entry.targetId);
				return entry.id;
		}
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
): Session {
	return new Session(new SessionManagerHarnessStorage(sessionManager, isRetired));
}
