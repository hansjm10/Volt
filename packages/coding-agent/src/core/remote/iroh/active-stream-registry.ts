export interface IrohRemoteActiveStreamEntry {
	readonly clientNodeId: string;
	readonly workspaceName: string;
	readonly sessionId: string;
	readonly connectionId: string;
	readonly streamId: string;
	close(reason: string): Promise<void> | void;
	closeConnection?(reason: string): Promise<void> | void;
}

export class IrohRemoteActiveStreamRegistry {
	private readonly entriesByClientNodeId = new Map<string, Set<IrohRemoteActiveStreamEntry>>();
	private readonly entriesByConnectionId = new Map<string, Set<IrohRemoteActiveStreamEntry>>();

	get size(): number {
		let count = 0;
		for (const entries of this.entriesByClientNodeId.values()) {
			count += entries.size;
		}
		return count;
	}

	register(entry: IrohRemoteActiveStreamEntry): () => void {
		let removed = false;
		this.addToMap(this.entriesByClientNodeId, entry.clientNodeId, entry);
		this.addToMap(this.entriesByConnectionId, entry.connectionId, entry);
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			this.unregister(entry);
		};
	}

	unregister(entry: IrohRemoteActiveStreamEntry): boolean {
		const removedFromClient = this.deleteFromMap(this.entriesByClientNodeId, entry.clientNodeId, entry);
		const removedFromConnection = this.deleteFromMap(this.entriesByConnectionId, entry.connectionId, entry);
		return removedFromClient || removedFromConnection;
	}

	entriesForClientNodeId(clientNodeId: string): IrohRemoteActiveStreamEntry[] {
		return Array.from(this.entriesByClientNodeId.get(clientNodeId) ?? []);
	}

	entriesForWorkspace(clientNodeId: string, workspaceName: string): IrohRemoteActiveStreamEntry[] {
		return this.entriesForClientNodeId(clientNodeId).filter((entry) => entry.workspaceName === workspaceName);
	}

	entriesForConversation(
		clientNodeId: string,
		workspaceName: string,
		sessionId: string,
	): IrohRemoteActiveStreamEntry[] {
		return this.entriesForWorkspace(clientNodeId, workspaceName).filter((entry) => entry.sessionId === sessionId);
	}

	entriesForConnection(connectionId: string): IrohRemoteActiveStreamEntry[] {
		return Array.from(this.entriesByConnectionId.get(connectionId) ?? []);
	}

	hasWorkspaceOnConnection(clientNodeId: string, workspaceName: string, connectionId: string): boolean {
		return this.entriesForConnection(connectionId).some(
			(entry) => entry.clientNodeId === clientNodeId && entry.workspaceName === workspaceName,
		);
	}

	hasConversationOnConnection(
		clientNodeId: string,
		workspaceName: string,
		sessionId: string,
		connectionId: string,
	): boolean {
		return this.entriesForConnection(connectionId).some(
			(entry) =>
				entry.clientNodeId === clientNodeId &&
				entry.workspaceName === workspaceName &&
				entry.sessionId === sessionId,
		);
	}

	private addToMap(
		map: Map<string, Set<IrohRemoteActiveStreamEntry>>,
		key: string,
		entry: IrohRemoteActiveStreamEntry,
	): void {
		let entries = map.get(key);
		if (!entries) {
			entries = new Set();
			map.set(key, entries);
		}
		entries.add(entry);
	}

	private deleteFromMap(
		map: Map<string, Set<IrohRemoteActiveStreamEntry>>,
		key: string,
		entry: IrohRemoteActiveStreamEntry,
	): boolean {
		const entries = map.get(key);
		if (!entries) {
			return false;
		}
		const removed = entries.delete(entry);
		if (entries.size === 0) {
			map.delete(key);
		}
		return removed;
	}
}
