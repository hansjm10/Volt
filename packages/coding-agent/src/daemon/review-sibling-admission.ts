import type { ConversationCoordinator } from "./conversation-coordinator.ts";

interface ReviewAdmissionLease {
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	release(): void;
}

import type {
	DaemonAttachClaim,
	DaemonRuntimeCommitToken,
	DaemonRuntimeOwnerCapability,
	LeaseBroker,
} from "./lease-broker.ts";

export interface ReviewSiblingAdmission {
	readonly signal: AbortSignal;
	assertCurrent(): void;
	validate(): Promise<void>;
	commit(coordinator: ConversationCoordinator): void;
	finalize(): void;
	rollback(): void;
	release(): void;
}

/** Uses the same broker transaction as a phone attach, without manufacturing a phone stream. */
export function beginReviewSiblingAdmission(options: {
	workspaceName: string;
	sessionId: string;
	broker: LeaseBroker;
	lease: ReviewAdmissionLease;
	validateWorkspace(): Promise<void>;
}): ReviewSiblingAdmission {
	let claim: DaemonAttachClaim;
	try {
		if (!options.lease.isCurrent()) throw new Error("Review sibling admission closed");
		if ((options.broker.lookup(options.workspaceName, options.sessionId)?.pendingDaemonAttaches ?? 0) > 0) {
			throw new Error("Review child is already opening through another producer; retry");
		}
		const begin = options.broker.beginDaemonAttach(options.workspaceName, options.sessionId);
		if (begin.kind !== "proceed") throw new Error("Review sibling is owned by a TUI or is draining; retry");
		claim = begin.claim;
	} catch (error) {
		options.lease.release();
		throw error;
	}
	let commit:
		| {
				coordinator: ConversationCoordinator;
				token: DaemonRuntimeCommitToken;
				owner: DaemonRuntimeOwnerCapability;
				installed: boolean;
		  }
		| undefined;
	let finalized = false;
	let released = false;
	const assertCurrent = () => {
		if (released || !options.lease.isCurrent()) throw new Error("Review sibling admission closed");
	};
	return {
		signal: options.lease.signal,
		assertCurrent,
		validate: async () => {
			assertCurrent();
			await options.validateWorkspace();
			assertCurrent();
		},
		commit: (coordinator) => {
			assertCurrent();
			if (
				commit ||
				finalized ||
				coordinator.workspaceName !== options.workspaceName ||
				coordinator.sessionId !== options.sessionId
			) {
				throw new Error("Review sibling commit identity changed");
			}
			const { outcome, installedProvisionalOwner } = coordinator.commitDaemonRuntime(claim);
			if (!outcome.ok) throw new Error(`Review sibling lease admission failed: ${outcome.reason}`);
			commit = { coordinator, token: outcome.token, owner: outcome.owner, installed: installedProvisionalOwner };
		},
		finalize: () => {
			assertCurrent();
			if (!commit) throw new Error("Review sibling has no provisional lease");
			const result = commit.coordinator.finalizeDaemonRuntimeCommit(commit.token);
			if (result.kind === "fenced") throw new Error("Review sibling lease changed before publication");
			finalized = true;
			if (!commit.coordinator.syncDaemonRuntimeStreamCount()) throw new Error("Review sibling lease owner changed");
		},
		rollback: () => {
			if (commit && !finalized) {
				commit.coordinator.rollbackDaemonRuntimeCommit(commit.token, commit.owner, commit.installed);
				commit = undefined;
			}
		},
		release: () => {
			if (released) return;
			released = true;
			options.broker.abortDaemonAttach(claim);
			options.lease.release();
		},
	};
}

/**
 * An unloaded canonical source needs a short producer reservation, not a second
 * provider runtime. Keep its broker cohort provisional until the metadata write
 * settles; a competing TUI waits for rollback before opening the source store.
 */
export async function withReviewSourceWriteLease<T>(options: {
	workspaceName: string;
	sessionId: string;
	broker: LeaseBroker;
	lease: ReviewAdmissionLease;
	validateWorkspace(): Promise<void>;
	write(): Promise<T>;
}): Promise<T> {
	let claim: DaemonAttachClaim | undefined;
	let token: DaemonRuntimeCommitToken | undefined;
	try {
		if (!options.lease.isCurrent()) throw new Error("Review source write admission closed");
		const owner = options.broker.lookup(options.workspaceName, options.sessionId);
		if (owner && (owner.state !== "unowned" || owner.pendingDaemonAttaches > 0))
			throw new Error("Canonical review source is owned or being opened by another runtime");
		const begin = options.broker.beginDaemonAttach(options.workspaceName, options.sessionId);
		if (begin.kind !== "proceed") throw new Error("Canonical review source is not writable");
		claim = begin.claim;
		const commit = options.broker.commitDaemonRuntime(claim, options.workspaceName, options.sessionId);
		if (!commit.ok) throw new Error("Canonical review source write lease changed");
		token = commit.token;
		await options.validateWorkspace();
		if (!options.lease.isCurrent()) throw new Error("Review source write admission closed");
		return await options.write();
	} finally {
		// No runtime was published. This settlement, after the store write has
		// finished, is the barrier that releases a waiting TUI/phone contender.
		if (token) options.broker.rollbackDaemonRuntimeCommit(token);
		if (claim) options.broker.abortDaemonAttach(claim);
		options.lease.release();
	}
}
