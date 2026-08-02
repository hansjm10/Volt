import { randomUUID } from "node:crypto";
import type { LeaseReleaseReason } from "./control-protocol.ts";

/**
 * Conversation lease broker: the single authority on which process owns the
 * live runtime for a (workspaceName, sessionId). Runtimes and relays are
 * effects driven by its transitions. Runs single-threaded on the daemon event
 * loop; every transition is a synchronous state mutation followed by async
 * effects.
 */

export type LeaseState = "unowned" | "daemon-active" | "daemon-detached" | "daemon-draining" | "tui-owned";

export type LeaseHandoff = "cold" | "warm" | "none";

export type LeaseDenyReason = "held_by_tui" | "force_unsupported" | "draining_elsewhere";
export type DaemonAttachRejectionReason = "tui_owned" | "draining" | "runtime_owner_fenced";

export interface LeaseRecord {
	key: string;
	workspaceName: string;
	sessionId: string;
	state: LeaseState;
	/** control connectionId of owning TUI when tui-owned / target of daemon-draining */
	tuiConnectionId?: string;
	/** live phone stream count when daemon-* */
	streamCount: number;
	/** active relayIds when tui-owned */
	relayIds: Set<string>;
	/** drain bookkeeping when daemon-draining */
	drain?: {
		connectionId: string;
		viewerFeedId: string;
		startedAtMs: number;
		cancelled: boolean;
		/**
		 * Runtime disposal has started; the drain can no longer revert to a
		 * daemon-owned state, so a cancellation must defer the final transition
		 * to runDrain's continuation.
		 */
		disposing: boolean;
		resolveGranted: (result: { handoff: "warm" }) => void;
		rejectGranted: (error: Error) => void;
	};
	/** Provisional daemon runtime creations that have not committed ownership. */
	pendingDaemonAttaches: number;
	/** pending lazy-resume shared by racing attaches (daemon-active sub-flag) */
	resuming?: Promise<void>;
}

export interface DaemonAttachClaim {
	readonly id: string;
	readonly workspaceName: string;
	readonly sessionId?: string;
}

/**
 * Opaque capability for undoing one provisional daemon-runtime lease commit.
 * The broker retains the rollback snapshot; callers can neither reconstruct nor
 * apply it to a different lease record.
 */
export interface DaemonRuntimeCommitToken {
	readonly id: string;
}

/** Opaque durable authority held by exactly one daemon runtime generation. */
export interface DaemonRuntimeOwnerCapability {
	readonly id: string;
}

export type DaemonRuntimeCommitLeaseObservation =
	| { kind: "exact"; state: LeaseState }
	| { kind: "rekeyed"; state: LeaseState; workspaceName: string; sessionId: string }
	| { kind: "replaced"; state: LeaseState }
	| { kind: "missing" };

export type DaemonRuntimeCommitFinalizeOutcome =
	| { kind: "finalized"; generation: number; owner: DaemonRuntimeOwnerCapability }
	| { kind: "already_finalized"; generation: number; owner: DaemonRuntimeOwnerCapability }
	| {
			kind: "fenced";
			generation: { expected: number | null; current: number | null };
			lease: DaemonRuntimeCommitLeaseObservation;
	  };

export type DaemonAttachBeginOutcome =
	| { kind: "proceed"; claim: DaemonAttachClaim }
	| { kind: "relay"; tuiConnectionId: string }
	| { kind: "retry"; retryAfterMs: number };

export type DaemonAttachCommitOutcome =
	| { ok: true; token: DaemonRuntimeCommitToken; owner: DaemonRuntimeOwnerCapability }
	| { ok: false; reason: DaemonAttachRejectionReason; tuiConnectionId?: string };

interface DaemonRuntimeCommitCohort {
	readonly record: LeaseRecord;
	readonly key: string;
	readonly generation: number;
	readonly baseState: LeaseState;
	readonly baseStreamCount: number;
	readonly outstanding: Set<DaemonRuntimeCommitToken>;
	readonly owner: DaemonRuntimeOwnerCapability;
	readonly ownerKind: "candidate" | "existing";
	readonly settled: Promise<"runtime_published" | "no_runtime">;
	readonly resolveSettled: (outcome: "runtime_published" | "no_runtime") => void;
	settlement?: "runtime_published" | "no_runtime";
	finalized: boolean;
}

interface PendingTuiAcquireBarrier {
	cancelled: boolean;
	resolveCancelled: () => void;
}

interface DaemonRuntimeCommitTokenRecord {
	readonly cohort: DaemonRuntimeCommitCohort;
	settlement: "outstanding" | "finalized" | "rolled_back" | "fenced";
}

interface DaemonRuntimeOwnerRecord {
	readonly record: LeaseRecord;
	generation?: number;
	provisionalCohort?: DaemonRuntimeCommitCohort;
}

export type LeaseAcquireOutcome =
	| { kind: "granted"; handoff: LeaseHandoff }
	| { kind: "pending"; viewerFeedId: string; granted: Promise<{ handoff: "warm" }> }
	| { kind: "denied"; reason: LeaseDenyReason };

export type LeaseRekeyOutcome = { ok: true } | { ok: false; code: "not_found" | "not_held" | "target_in_use" };

export interface TuiLeaseRekeyReservation {
	readonly id: string;
	readonly connectionId: string;
	readonly workspaceName: string;
	readonly oldSessionId: string;
	readonly newSessionId: string;
	readonly sourceKey: string;
	readonly targetKey: string;
	readonly record: LeaseRecord;
}

export type TuiLeaseRekeyPrepareOutcome =
	| { ok: true; reservation: TuiLeaseRekeyReservation }
	| {
			ok: false;
			code: "not_found" | "not_held" | "target_in_use" | "transition_in_progress" | "coordinator_unavailable";
	  };

export type TuiLeaseRekeyTransactionOutcome =
	| { ok: true; reservation: TuiLeaseRekeyReservation }
	| { ok: false; code: "not_found" | "not_held" | "target_in_use" | "authority_commit_failed" };

export interface DaemonLeaseRekeyReservation {
	readonly id: string;
	readonly owner: DaemonRuntimeOwnerCapability;
	readonly workspaceName: string;
	readonly oldSessionId: string;
	readonly newSessionId: string;
	readonly sourceKey: string;
	readonly targetKey: string;
	readonly record: LeaseRecord;
}

export type DaemonLeaseRekeyPrepareOutcome =
	| { ok: true; reservation: DaemonLeaseRekeyReservation }
	| { ok: false; code: "not_found" | "not_held" | "target_in_use" | "transition_in_progress" };

export type DaemonLeaseRekeyTransactionOutcome =
	| { ok: true; reservation: DaemonLeaseRekeyReservation }
	| { ok: false; code: "not_found" | "not_held" | "target_in_use" };

export interface LeaseBrokerEffects {
	/** True when the daemon runtime for the key is mid-turn. */
	isRuntimeStreaming(workspaceName: string, sessionId: string): boolean;
	/** Resolves when the daemon runtime's current turn ends. */
	waitForRuntimeIdle(workspaceName: string, sessionId: string): Promise<void>;
	/** Dispose the daemon runtime through the normal dispose path (session_shutdown "quit"). */
	disposeRuntime(workspaceName: string, sessionId: string, reason: string): Promise<void>;
	/** Close daemon-attached phone streams for the key with the given reason. */
	closePhoneStreams(workspaceName: string, sessionId: string, reason: string): Promise<void> | void;
	/** Close open relays for a tui-owned lease. */
	closeRelays(
		record: LeaseRecord,
		reason: "lease_transferred" | "session_rekeyed_reconnect" | "workspace_unregistered" | "host_shutdown" | "error",
	): void;
	/** Reserve the stable conversation authority before daemon-runtime retirement begins. */
	beginTuiLeaseHandoff(workspaceName: string, sessionId: string, connectionId: string): void;
	/** Promote the reserved authority after the daemon runtime and its lease are terminal. */
	commitTuiLeaseHandoff(workspaceName: string, sessionId: string, connectionId: string): void;
	/** Drop an uncommitted handoff reservation after cancellation or failure. */
	cancelTuiLeaseHandoff(workspaceName: string, sessionId: string, connectionId: string): void;
	/** Release committed or pending TUI authority for a connection. */
	releaseTuiLease(workspaceName: string, sessionId: string, connectionId: string): void;
	/** Reserve the stable authority's target key during broker rekey preflight. */
	prepareTuiLeaseRekey(
		transactionId: string,
		workspaceName: string,
		oldSessionId: string,
		newSessionId: string,
		connectionId: string,
	): void;
	/** Commit the prepared stable-authority rekey before the broker record moves. */
	commitTuiLeaseRekey(transactionId: string, connectionId: string): void;
	/** Release a prepared stable-authority rekey after rollback, disposal, or failure. */
	rollbackTuiLeaseRekey(transactionId: string, connectionId: string): void;
	onDrainStarted?(record: LeaseRecord, viewerFeedId: string): void;
	onDrainEnded?(record: LeaseRecord, viewerFeedId: string, reason: "granted" | "cancelled" | "error"): void;
	audit(event: {
		type: "lease_acquired" | "lease_released" | "lease_denied";
		workspaceName: string;
		sessionId: string;
		details: Record<string, unknown>;
	}): void;
	generateViewerFeedId?(): string;
}

const LEASE_TRANSFERRED_CLOSE_REASON = "lease_transferred";

function getLeaseKey(workspaceName: string, sessionId: string): string {
	return `${workspaceName}\0${sessionId}`;
}

export class LeaseBroker {
	private readonly effects: LeaseBrokerEffects;
	private readonly records = new Map<string, LeaseRecord>();
	/**
	 * Claims retain the record object they incremented. A session rekey may move
	 * that record to another map key while an attach is still provisioning; using
	 * the claim's original session id to decrement would otherwise strand a
	 * permanent pending-attach count.
	 */
	private readonly daemonAttachRecords = new Map<string, LeaseRecord>();
	/** Monotonic CAS generation for provisional daemon-runtime commit cohorts. */
	private readonly daemonRuntimeCommitGenerations = new WeakMap<LeaseRecord, number>();
	/** The current provisional cohort for a record, when one is still open. */
	private readonly daemonRuntimeCommitCohorts = new WeakMap<LeaseRecord, DaemonRuntimeCommitCohort>();
	/** Commit capabilities are keyed by token object identity, not caller data. */
	private readonly daemonRuntimeCommitTokens = new WeakMap<DaemonRuntimeCommitToken, DaemonRuntimeCommitTokenRecord>();
	/** Monotonic durable owner generation for each lease record. */
	private readonly daemonRuntimeOwnerGenerations = new WeakMap<LeaseRecord, number>();
	/** Current durable daemon owner for a lease record. */
	private readonly daemonRuntimeOwners = new WeakMap<LeaseRecord, DaemonRuntimeOwnerCapability>();
	/** Identity and provisional/durable epoch retained behind each opaque owner capability. */
	private readonly daemonRuntimeOwnerRecords = new WeakMap<DaemonRuntimeOwnerCapability, DaemonRuntimeOwnerRecord>();
	/** Prepared TUI rekeys lock both names until commit, rollback, or disposal. */
	private readonly tuiRekeyReservations = new Map<string, TuiLeaseRekeyReservation>();
	private readonly tuiRekeyReservationsBySource = new Map<string, TuiLeaseRekeyReservation>();
	private readonly tuiRekeyReservationsByTarget = new Map<string, TuiLeaseRekeyReservation>();
	private readonly daemonRekeyReservations = new Map<string, DaemonLeaseRekeyReservation>();
	private readonly daemonRekeyReservationsBySource = new Map<string, DaemonLeaseRekeyReservation>();
	private readonly daemonRekeyReservationsByTarget = new Map<string, DaemonLeaseRekeyReservation>();
	/** TUI acquires serialized behind a runtime publication, grouped for disconnect cancellation. */
	private readonly pendingTuiAcquireBarriers = new Map<string, Set<PendingTuiAcquireBarrier>>();
	private readonly worktreeRemovalReservations = new Set<string>();

	constructor(effects: LeaseBrokerEffects) {
		this.effects = effects;
	}

	lookup(workspaceName: string, sessionId: string): LeaseRecord | undefined {
		return this.records.get(getLeaseKey(workspaceName, sessionId));
	}

	list(): LeaseRecord[] {
		return Array.from(this.records.values());
	}

	reserveSessionsForWorktreeRemoval(workspaceName: string, sessionIds: string[]): (() => void) | undefined {
		const keys = sessionIds.map((sessionId) => getLeaseKey(workspaceName, sessionId));
		if (
			keys.some((key) => {
				if (
					this.worktreeRemovalReservations.has(key) ||
					this.tuiRekeyReservationsByTarget.has(key) ||
					this.daemonRekeyReservationsByTarget.has(key)
				) {
					return true;
				}
				const record = this.records.get(key);
				return (
					record !== undefined &&
					(record.state !== "unowned" || record.pendingDaemonAttaches > 0 || record.streamCount > 0)
				);
			})
		) {
			return undefined;
		}
		for (const key of keys) this.worktreeRemovalReservations.add(key);
		return () => {
			for (const key of keys) this.worktreeRemovalReservations.delete(key);
		};
	}

	private getOrCreateRecord(workspaceName: string, sessionId: string): LeaseRecord {
		const key = getLeaseKey(workspaceName, sessionId);
		let record = this.records.get(key);
		if (!record) {
			record = {
				key,
				workspaceName,
				sessionId,
				state: "unowned",
				streamCount: 0,
				relayIds: new Set(),
				pendingDaemonAttaches: 0,
			};
			this.records.set(key, record);
		}
		return record;
	}

	private dropIfUnowned(record: LeaseRecord): void {
		if (
			record.state === "unowned" &&
			record.relayIds.size === 0 &&
			record.streamCount === 0 &&
			record.pendingDaemonAttaches === 0
		) {
			this.records.delete(record.key);
		}
	}

	beginDaemonAttach(workspaceName: string, sessionId: string | undefined): DaemonAttachBeginOutcome {
		const claim: DaemonAttachClaim = {
			id: randomUUID(),
			workspaceName,
			...(sessionId === undefined ? {} : { sessionId }),
		};
		if (sessionId === undefined) {
			return { kind: "proceed", claim };
		}
		const attachKey = getLeaseKey(workspaceName, sessionId);
		if (
			this.worktreeRemovalReservations.has(attachKey) ||
			this.tuiRekeyReservationsBySource.has(attachKey) ||
			this.tuiRekeyReservationsByTarget.has(attachKey) ||
			this.daemonRekeyReservationsBySource.has(attachKey) ||
			this.daemonRekeyReservationsByTarget.has(attachKey)
		) {
			return { kind: "retry", retryAfterMs: 1000 };
		}
		const record = this.getOrCreateRecord(workspaceName, sessionId);
		if (record.state === "tui-owned" && record.tuiConnectionId) {
			this.dropIfUnowned(record);
			return { kind: "relay", tuiConnectionId: record.tuiConnectionId };
		}
		if (record.state === "daemon-draining") {
			this.dropIfUnowned(record);
			return { kind: "retry", retryAfterMs: 1000 };
		}
		record.pendingDaemonAttaches++;
		this.daemonAttachRecords.set(claim.id, record);
		return { kind: "proceed", claim };
	}

	abortDaemonAttach(claim: DaemonAttachClaim): void {
		if (claim.sessionId === undefined) {
			return;
		}
		const record = this.daemonAttachRecords.get(claim.id);
		if (!record) {
			return;
		}
		this.daemonAttachRecords.delete(claim.id);
		record.pendingDaemonAttaches = Math.max(0, record.pendingDaemonAttaches - 1);
		this.dropIfUnowned(record);
	}

	commitDaemonRuntime(
		claim: DaemonAttachClaim,
		workspaceName: string,
		sessionId: string,
		existingOwner?: DaemonRuntimeOwnerCapability,
	): DaemonAttachCommitOutcome {
		this.abortDaemonAttach(claim);
		const key = getLeaseKey(workspaceName, sessionId);
		if (
			this.worktreeRemovalReservations.has(key) ||
			this.tuiRekeyReservationsBySource.has(key) ||
			this.tuiRekeyReservationsByTarget.has(key) ||
			this.daemonRekeyReservationsBySource.has(key) ||
			this.daemonRekeyReservationsByTarget.has(key)
		) {
			return { ok: false, reason: "draining" };
		}
		const record = this.getOrCreateRecord(workspaceName, sessionId);
		if (record.state === "tui-owned") {
			return {
				ok: false,
				reason: "tui_owned",
				...(record.tuiConnectionId ? { tuiConnectionId: record.tuiConnectionId } : {}),
			};
		}
		if (record.state === "daemon-draining") {
			return { ok: false, reason: "draining" };
		}
		if (existingOwner && !this.isDaemonRuntimeOwnerCurrent(existingOwner, workspaceName, sessionId)) {
			this.dropIfUnowned(record);
			return { ok: false, reason: "runtime_owner_fenced" };
		}
		let cohort = this.daemonRuntimeCommitCohorts.get(record);
		const cohortIsOpen =
			cohort !== undefined &&
			!cohort.finalized &&
			cohort.key === key &&
			this.daemonRuntimeCommitGenerations.get(record) === cohort.generation;
		if (
			cohortIsOpen &&
			!((existingOwner && cohort?.owner === existingOwner) || (!existingOwner && cohort?.ownerKind === "candidate"))
		) {
			return { ok: false, reason: "runtime_owner_fenced" };
		}
		if (!cohortIsOpen) {
			const generation = (this.daemonRuntimeCommitGenerations.get(record) ?? 0) + 1;
			this.daemonRuntimeCommitGenerations.set(record, generation);
			const owner: DaemonRuntimeOwnerCapability = existingOwner ?? { id: randomUUID() };
			let resolveSettled: (outcome: "runtime_published" | "no_runtime") => void = () => {};
			const settled = new Promise<"runtime_published" | "no_runtime">((resolve) => {
				resolveSettled = resolve;
			});
			cohort = {
				record,
				key,
				generation,
				baseState: record.state,
				baseStreamCount: record.streamCount,
				outstanding: new Set(),
				owner,
				ownerKind: existingOwner ? "existing" : "candidate",
				settled,
				resolveSettled,
				finalized: false,
			};
			this.daemonRuntimeCommitCohorts.set(record, cohort);
			if (!existingOwner) {
				this.daemonRuntimeOwnerRecords.set(owner, { record, provisionalCohort: cohort });
			}
		}
		if (!cohort) {
			throw new Error("Daemon runtime commit cohort was not created");
		}
		if (record.state === "unowned" || record.state === "daemon-detached") {
			record.state = "daemon-active";
			this.effects.audit({
				type: "lease_acquired",
				workspaceName,
				sessionId,
				details: { owner: "daemon", handoff: "none" },
			});
		} else if (record.state === "daemon-active") {
			record.state = "daemon-active";
		}
		const token: DaemonRuntimeCommitToken = { id: randomUUID() };
		cohort.outstanding.add(token);
		this.daemonRuntimeCommitTokens.set(token, { cohort, settlement: "outstanding" });
		return { ok: true, token, owner: cohort.owner };
	}

	finalizeDaemonRuntimeCommit(token: DaemonRuntimeCommitToken): DaemonRuntimeCommitFinalizeOutcome {
		const tokenRecord = this.daemonRuntimeCommitTokens.get(token);
		if (!tokenRecord) {
			return {
				kind: "fenced",
				generation: { expected: null, current: null },
				lease: { kind: "missing" },
			};
		}
		const { cohort } = tokenRecord;
		if (tokenRecord.settlement === "finalized") {
			return this.isDaemonRuntimeOwnerCurrentAnywhere(cohort.owner)
				? { kind: "already_finalized", generation: cohort.generation, owner: cohort.owner }
				: this.getFencedDaemonRuntimeCommitOutcome(cohort);
		}
		if (tokenRecord.settlement !== "outstanding" || !cohort.outstanding.delete(token)) {
			return this.getFencedDaemonRuntimeCommitOutcome(cohort);
		}
		if (cohort.finalized) {
			this.dropSettledDaemonRuntimeCommitCohort(cohort);
			if (this.isDaemonRuntimeOwnerCurrentAnywhere(cohort.owner)) {
				tokenRecord.settlement = "finalized";
				return { kind: "already_finalized", generation: cohort.generation, owner: cohort.owner };
			}
			tokenRecord.settlement = "fenced";
			return this.getFencedDaemonRuntimeCommitOutcome(cohort);
		}
		if (!this.isCurrentDaemonRuntimeCommitCohort(cohort)) {
			tokenRecord.settlement = "fenced";
			this.fenceDaemonRuntimeCommitCohort(cohort);
			return this.getFencedDaemonRuntimeCommitOutcome(cohort);
		}
		if (!this.promoteDaemonRuntimeCommitOwner(cohort)) {
			tokenRecord.settlement = "fenced";
			this.fenceDaemonRuntimeCommitCohort(cohort);
			return this.getFencedDaemonRuntimeCommitOutcome(cohort);
		}
		tokenRecord.settlement = "finalized";
		cohort.finalized = true;
		this.settleDaemonRuntimeCommitCohort(cohort, "runtime_published");
		// Closing this generation prevents a later cohort from sharing its stable
		// base while outstanding peers can still settle idempotently against it.
		this.daemonRuntimeCommitGenerations.set(cohort.record, cohort.generation + 1);
		this.dropSettledDaemonRuntimeCommitCohort(cohort);
		return { kind: "finalized", generation: cohort.generation, owner: cohort.owner };
	}

	rollbackDaemonRuntimeCommit(token: DaemonRuntimeCommitToken): boolean {
		const tokenRecord = this.daemonRuntimeCommitTokens.get(token);
		if (!tokenRecord || tokenRecord.settlement !== "outstanding" || !tokenRecord.cohort.outstanding.delete(token)) {
			return false;
		}
		tokenRecord.settlement = "rolled_back";
		const { cohort } = tokenRecord;
		if (cohort.finalized) {
			this.dropSettledDaemonRuntimeCommitCohort(cohort);
			return false;
		}
		if (!this.isCurrentDaemonRuntimeCommitCohort(cohort)) {
			this.fenceDaemonRuntimeCommitCohort(cohort);
			return false;
		}
		if (cohort.outstanding.size > 0) {
			return false;
		}
		const record = cohort.record;
		this.invalidateProvisionalDaemonRuntimeOwner(cohort);
		this.daemonRuntimeCommitGenerations.set(record, cohort.generation + 1);
		this.daemonRuntimeCommitCohorts.delete(record);
		this.restoreDaemonRuntimeCommitBase(cohort);
		this.settleDaemonRuntimeCommitCohort(
			cohort,
			this.daemonRuntimeOwners.has(record) ? "runtime_published" : "no_runtime",
		);
		return true;
	}

	private settleDaemonRuntimeCommitCohort(
		cohort: DaemonRuntimeCommitCohort,
		outcome: "runtime_published" | "no_runtime",
	): void {
		if (cohort.settlement) {
			return;
		}
		cohort.settlement = outcome;
		cohort.resolveSettled(outcome);
	}

	private restoreDaemonRuntimeCommitBase(cohort: DaemonRuntimeCommitCohort): void {
		const { record } = cohort;
		record.state =
			cohort.baseState === "unowned" || record.streamCount === cohort.baseStreamCount
				? cohort.baseState
				: record.streamCount > 0
					? "daemon-active"
					: "daemon-detached";
		if (cohort.baseState === "unowned") {
			record.streamCount = 0;
			this.dropIfUnowned(record);
		}
	}

	private getFencedDaemonRuntimeCommitOutcome(cohort: DaemonRuntimeCommitCohort): DaemonRuntimeCommitFinalizeOutcome {
		return {
			kind: "fenced",
			generation: {
				expected: cohort.generation,
				current: this.daemonRuntimeCommitGenerations.get(cohort.record) ?? null,
			},
			lease: this.observeDaemonRuntimeCommitLease(cohort),
		};
	}

	private observeDaemonRuntimeCommitLease(cohort: DaemonRuntimeCommitCohort): DaemonRuntimeCommitLeaseObservation {
		const exactRecord = this.records.get(cohort.key);
		if (exactRecord === cohort.record) {
			const ownerRecord = this.daemonRuntimeOwnerRecords.get(cohort.owner);
			const currentOwner = this.daemonRuntimeOwners.get(cohort.record);
			if (ownerRecord?.generation !== undefined && currentOwner && currentOwner !== cohort.owner) {
				return { kind: "replaced", state: exactRecord.state };
			}
			return { kind: "exact", state: cohort.record.state };
		}
		if (this.records.get(cohort.record.key) === cohort.record) {
			return {
				kind: "rekeyed",
				state: cohort.record.state,
				workspaceName: cohort.record.workspaceName,
				sessionId: cohort.record.sessionId,
			};
		}
		if (exactRecord) {
			return { kind: "replaced", state: exactRecord.state };
		}
		return { kind: "missing" };
	}

	isDaemonRuntimeOwnerCurrent(owner: DaemonRuntimeOwnerCapability, workspaceName: string, sessionId: string): boolean {
		const ownerRecord = this.daemonRuntimeOwnerRecords.get(owner);
		if (!ownerRecord || this.records.get(getLeaseKey(workspaceName, sessionId)) !== ownerRecord.record) {
			return false;
		}
		return this.isDaemonRuntimeOwnerCurrentAnywhere(owner);
	}

	private isDaemonRuntimeOwnerCurrentAnywhere(owner: DaemonRuntimeOwnerCapability): boolean {
		const ownerRecord = this.daemonRuntimeOwnerRecords.get(owner);
		return (
			ownerRecord?.generation !== undefined &&
			this.daemonRuntimeOwners.get(ownerRecord.record) === owner &&
			this.daemonRuntimeOwnerGenerations.get(ownerRecord.record) === ownerRecord.generation &&
			this.records.get(ownerRecord.record.key) === ownerRecord.record
		);
	}

	private promoteDaemonRuntimeCommitOwner(cohort: DaemonRuntimeCommitCohort): boolean {
		if (cohort.ownerKind === "existing") {
			return (
				this.records.get(cohort.key) === cohort.record && this.isDaemonRuntimeOwnerCurrentAnywhere(cohort.owner)
			);
		}
		const ownerRecord = this.daemonRuntimeOwnerRecords.get(cohort.owner);
		if (ownerRecord?.record !== cohort.record || ownerRecord.provisionalCohort !== cohort) {
			return false;
		}
		const generation = (this.daemonRuntimeOwnerGenerations.get(cohort.record) ?? 0) + 1;
		this.daemonRuntimeOwnerGenerations.set(cohort.record, generation);
		this.daemonRuntimeOwners.set(cohort.record, cohort.owner);
		ownerRecord.generation = generation;
		ownerRecord.provisionalCohort = undefined;
		return true;
	}

	private invalidateProvisionalDaemonRuntimeOwner(cohort: DaemonRuntimeCommitCohort): void {
		if (cohort.ownerKind !== "candidate") {
			return;
		}
		const ownerRecord = this.daemonRuntimeOwnerRecords.get(cohort.owner);
		if (ownerRecord?.provisionalCohort === cohort) {
			ownerRecord.provisionalCohort = undefined;
		}
	}

	private invalidateDaemonRuntimeOwner(record: LeaseRecord, owner: DaemonRuntimeOwnerCapability): void {
		if (this.daemonRuntimeOwners.get(record) !== owner) {
			return;
		}
		this.daemonRuntimeOwners.delete(record);
		this.daemonRuntimeOwnerGenerations.set(record, (this.daemonRuntimeOwnerGenerations.get(record) ?? 0) + 1);
	}

	private isCurrentDaemonRuntimeCommitCohort(cohort: DaemonRuntimeCommitCohort): boolean {
		return (
			this.records.get(cohort.key) === cohort.record &&
			this.daemonRuntimeCommitCohorts.get(cohort.record) === cohort &&
			this.daemonRuntimeCommitGenerations.get(cohort.record) === cohort.generation &&
			(cohort.record.state === "daemon-active" || cohort.record.state === "daemon-detached")
		);
	}

	private dropSettledDaemonRuntimeCommitCohort(cohort: DaemonRuntimeCommitCohort): void {
		if (cohort.outstanding.size === 0 && this.daemonRuntimeCommitCohorts.get(cohort.record) === cohort) {
			this.daemonRuntimeCommitCohorts.delete(cohort.record);
		}
	}

	private fenceDaemonRuntimeCommitCohort(cohort: DaemonRuntimeCommitCohort): void {
		this.invalidateProvisionalDaemonRuntimeOwner(cohort);
		if (this.daemonRuntimeCommitCohorts.get(cohort.record) !== cohort) {
			this.settleDaemonRuntimeCommitCohort(
				cohort,
				this.daemonRuntimeOwners.has(cohort.record) ? "runtime_published" : "no_runtime",
			);
			return;
		}
		this.daemonRuntimeCommitCohorts.delete(cohort.record);
		if (this.daemonRuntimeCommitGenerations.get(cohort.record) === cohort.generation) {
			this.daemonRuntimeCommitGenerations.set(cohort.record, cohort.generation + 1);
		}
		this.settleDaemonRuntimeCommitCohort(
			cohort,
			this.daemonRuntimeOwners.has(cohort.record) ? "runtime_published" : "no_runtime",
		);
	}

	private fenceCurrentDaemonRuntimeCommitCohort(record: LeaseRecord): void {
		const cohort = this.daemonRuntimeCommitCohorts.get(record);
		if (cohort) {
			this.fenceDaemonRuntimeCommitCohort(cohort);
		}
	}

	// ==========================================================================
	// TUI acquire / release / rekey
	// ==========================================================================

	private getCurrentDaemonRuntimePublication(record: LeaseRecord): DaemonRuntimeCommitCohort | undefined {
		const cohort = this.daemonRuntimeCommitCohorts.get(record);
		if (
			!cohort ||
			cohort.finalized ||
			cohort.settlement !== undefined ||
			this.records.get(cohort.key) !== record ||
			this.daemonRuntimeCommitGenerations.get(record) !== cohort.generation
		) {
			return undefined;
		}
		return cohort;
	}

	private async waitForDaemonRuntimePublication(
		connectionId: string,
		cohort: DaemonRuntimeCommitCohort,
	): Promise<boolean> {
		let resolveCancelled: () => void = () => {};
		const cancelled = new Promise<"cancelled">((resolve) => {
			resolveCancelled = () => resolve("cancelled");
		});
		const barrier: PendingTuiAcquireBarrier = { cancelled: false, resolveCancelled };
		const barriers = this.pendingTuiAcquireBarriers.get(connectionId) ?? new Set();
		barriers.add(barrier);
		this.pendingTuiAcquireBarriers.set(connectionId, barriers);
		try {
			await Promise.race([cohort.settled, cancelled]);
			return !barrier.cancelled;
		} finally {
			barriers.delete(barrier);
			if (barriers.size === 0) {
				this.pendingTuiAcquireBarriers.delete(connectionId);
			}
		}
	}

	private cancelPendingTuiAcquireBarriers(connectionId: string): void {
		const barriers = this.pendingTuiAcquireBarriers.get(connectionId);
		if (!barriers) {
			return;
		}
		this.pendingTuiAcquireBarriers.delete(connectionId);
		for (const barrier of barriers) {
			barrier.cancelled = true;
			barrier.resolveCancelled();
		}
	}

	async acquireForTui(request: {
		connectionId: string;
		workspaceName: string;
		sessionId: string;
		force?: boolean;
	}): Promise<LeaseAcquireOutcome> {
		const { connectionId, workspaceName, sessionId } = request;
		if (request.force) {
			this.effects.audit({
				type: "lease_denied",
				workspaceName,
				sessionId,
				details: { requester: connectionId, reason: "force_unsupported" },
			});
			return { kind: "denied", reason: "force_unsupported" };
		}
		for (;;) {
			const leaseKey = getLeaseKey(workspaceName, sessionId);
			if (this.worktreeRemovalReservations.has(leaseKey)) {
				return { kind: "denied", reason: "draining_elsewhere" };
			}
			const targetReservation = this.tuiRekeyReservationsByTarget.get(leaseKey);
			if (targetReservation) {
				this.effects.audit({
					type: "lease_denied",
					workspaceName,
					sessionId,
					details: {
						requester: connectionId,
						reason: "rekey_target_reserved",
						reservationOwner: targetReservation.connectionId,
					},
				});
				return { kind: "denied", reason: "held_by_tui" };
			}
			if (this.daemonRekeyReservationsByTarget.has(getLeaseKey(workspaceName, sessionId))) {
				return { kind: "denied", reason: "draining_elsewhere" };
			}
			if (this.daemonRekeyReservationsBySource.has(getLeaseKey(workspaceName, sessionId))) {
				return { kind: "denied", reason: "draining_elsewhere" };
			}
			const record = this.getOrCreateRecord(workspaceName, sessionId);
			const publication = this.getCurrentDaemonRuntimePublication(record);
			if (publication) {
				// A successful commit publishes the runtime into the registry only after
				// the broker has reserved daemon ownership. Crossing that interval would
				// make an idle TUI handoff dispose/fence a runtime that is not discoverable
				// yet. Serialize behind publication, then re-read every lease/rekey state.
				if (!(await this.waitForDaemonRuntimePublication(connectionId, publication))) {
					return { kind: "denied", reason: "draining_elsewhere" };
				}
				continue;
			}
			switch (record.state) {
				case "unowned": {
					let handoffBegan = false;
					try {
						this.effects.beginTuiLeaseHandoff(workspaceName, sessionId, connectionId);
						handoffBegan = true;
						this.fenceCurrentDaemonRuntimeCommitCohort(record);
						record.state = "tui-owned";
						record.tuiConnectionId = connectionId;
						this.effects.commitTuiLeaseHandoff(workspaceName, sessionId, connectionId);
					} catch (error) {
						if (record.state === "tui-owned" && record.tuiConnectionId === connectionId) {
							record.state = "unowned";
							record.tuiConnectionId = undefined;
						}
						if (handoffBegan) {
							this.effects.cancelTuiLeaseHandoff(workspaceName, sessionId, connectionId);
						}
						this.dropIfUnowned(record);
						throw error;
					}
					this.effects.audit({
						type: "lease_acquired",
						workspaceName,
						sessionId,
						details: { owner: "tui", handoff: "none", connectionId },
					});
					return { kind: "granted", handoff: "none" };
				}
				case "tui-owned": {
					if (record.tuiConnectionId === connectionId) {
						return { kind: "granted", handoff: "none" };
					}
					this.effects.audit({
						type: "lease_denied",
						workspaceName,
						sessionId,
						details: { requester: connectionId, reason: "held_by_tui" },
					});
					return { kind: "denied", reason: "held_by_tui" };
				}
				case "daemon-draining": {
					if (record.tuiConnectionId === connectionId && record.drain) {
						const drain = record.drain;
						return {
							kind: "pending",
							viewerFeedId: drain.viewerFeedId,
							granted: new Promise((resolve, reject) => {
								const previousResolve = drain.resolveGranted;
								const previousReject = drain.rejectGranted;
								drain.resolveGranted = (result) => {
									previousResolve(result);
									resolve(result);
								};
								drain.rejectGranted = (error) => {
									previousReject(error);
									reject(error);
								};
							}),
						};
					}
					this.effects.audit({
						type: "lease_denied",
						workspaceName,
						sessionId,
						details: { requester: connectionId, reason: "draining_elsewhere" },
					});
					return { kind: "denied", reason: "draining_elsewhere" };
				}
				case "daemon-detached":
				case "daemon-active": {
					if (this.effects.isRuntimeStreaming(workspaceName, sessionId)) {
						// A mid-turn runtime ALWAYS drains before the handoff, even when
						// every phone has detached. Disposing a busy runtime abandons the
						// turn: its results (including completed subagent work buffered in
						// an in-flight tool call) are never persisted, and the transcript
						// is left with a dangling tool call. The acquiring TUI watches the
						// rest of the turn through the drain viewer feed and is granted
						// ownership once the runtime goes idle; it can cancel the drain by
						// releasing (Esc/quit), which leaves the turn running on the daemon.
						return this.beginDrain(record, connectionId);
					}
					// Idle: dispose and grant immediately.
					// The flip to tui-owned happens before terminal delivery/disposal so
					// no new daemon attach can race the handoff and the disposal callback
					// no-ops (it is part of this grant). Streams close first while their
					// runtime-owned ordered writer still exists.
					this.effects.beginTuiLeaseHandoff(workspaceName, sessionId, connectionId);
					this.fenceCurrentDaemonRuntimeCommitCohort(record);
					record.state = "tui-owned";
					record.tuiConnectionId = connectionId;
					try {
						await this.effects.closePhoneStreams(workspaceName, sessionId, LEASE_TRANSFERRED_CLOSE_REASON);
						record.streamCount = 0;
						await this.effects.disposeRuntime(workspaceName, sessionId, "lease_transferred_to_tui");
					} catch (error) {
						// Disposal failed after the premature tui-owned flip. Leaving the
						// lease tui-owned would strand the still-alive daemon runtime and
						// phone streams. Revert to a daemon-owned state and fail the acquire
						// (unless the connection already died and released the lease).
						if (record.state === "tui-owned" && record.tuiConnectionId === connectionId) {
							record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
							record.tuiConnectionId = undefined;
						}
						this.effects.cancelTuiLeaseHandoff(workspaceName, sessionId, connectionId);
						throw error;
					}
					record.streamCount = 0;
					if ((record.state as LeaseState) !== "tui-owned" || record.tuiConnectionId !== connectionId) {
						// The connection died while the disposal effects ran and the lease
						// was already released (releaseAllForConnection). The release path
						// audited; there is no live owner left to grant to.
						this.dropIfUnowned(record);
						return { kind: "granted", handoff: "warm" };
					}
					try {
						this.effects.commitTuiLeaseHandoff(workspaceName, sessionId, connectionId);
					} catch (error) {
						record.state = "unowned";
						record.tuiConnectionId = undefined;
						this.effects.releaseTuiLease(workspaceName, sessionId, connectionId);
						this.dropIfUnowned(record);
						throw error;
					}
					this.effects.audit({
						type: "lease_acquired",
						workspaceName,
						sessionId,
						details: { owner: "tui", handoff: "warm", connectionId },
					});
					return { kind: "granted", handoff: "warm" };
				}
			}
		}
	}

	private beginDrain(record: LeaseRecord, connectionId: string): LeaseAcquireOutcome {
		const viewerFeedId = this.effects.generateViewerFeedId?.() ?? `vf-${randomUUID()}`;
		this.effects.beginTuiLeaseHandoff(record.workspaceName, record.sessionId, connectionId);
		this.fenceCurrentDaemonRuntimeCommitCohort(record);
		record.state = "daemon-draining";
		record.tuiConnectionId = connectionId;
		let resolveGranted: (result: { handoff: "warm" }) => void = () => {};
		let rejectGranted: (error: Error) => void = () => {};
		const granted = new Promise<{ handoff: "warm" }>((resolve, reject) => {
			resolveGranted = resolve;
			rejectGranted = reject;
		});
		granted.catch(() => {});
		record.drain = {
			connectionId,
			viewerFeedId,
			startedAtMs: Date.now(),
			cancelled: false,
			disposing: false,
			resolveGranted,
			rejectGranted,
		};
		this.effects.onDrainStarted?.(record, viewerFeedId);
		void this.runDrain(record);
		return { kind: "pending", viewerFeedId, granted };
	}

	private async runDrain(record: LeaseRecord): Promise<void> {
		const drain = record.drain;
		if (!drain) {
			return;
		}
		try {
			await this.effects.waitForRuntimeIdle(record.workspaceName, record.sessionId);
		} catch (error) {
			if (!drain.cancelled && record.drain === drain) {
				record.drain = undefined;
				record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
				record.tuiConnectionId = undefined;
				this.effects.cancelTuiLeaseHandoff(record.workspaceName, record.sessionId, drain.connectionId);
				this.effects.onDrainEnded?.(record, drain.viewerFeedId, "error");
				drain.rejectGranted(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		if (drain.cancelled || record.drain !== drain) {
			return;
		}
		// From here terminal delivery/disposal is irreversible: record.drain stays set so a
		// cancellation landing during these awaits is visible afterwards, and
		// cancelDrain defers the final transition to this continuation.
		drain.disposing = true;
		try {
			await this.effects.closePhoneStreams(record.workspaceName, record.sessionId, LEASE_TRANSFERRED_CLOSE_REASON);
			record.streamCount = 0;
			await this.effects.disposeRuntime(record.workspaceName, record.sessionId, "lease_transferred_to_tui");
		} catch (error) {
			// This phase is otherwise unguarded, so a disposal failure (e.g. a
			// state-manager IO error) would wedge the lease in daemon-draining forever
			// and leave the acquiring TUI's grant promise unsettled. Recover: clear the
			// drain, settle the grant, and move to a state a later acquire can retry
			// from (unowned when the requester already gave up, else daemon-owned).
			if (record.drain === drain) {
				record.drain = undefined;
				record.tuiConnectionId = undefined;
			}
			if (drain.cancelled) {
				// Zero the stream count before dropping. dropIfUnowned requires
				// streamCount === 0, so leaving it stale here (the success path resets it
				// at the bottom of runDrain, but this early return skips that) would
				// strand the record in `records` as an undroppable "unowned" ghost that
				// then hands a phantom stream count to the next acquire.
				record.streamCount = 0;
				record.state = "unowned";
				this.effects.releaseTuiLease(record.workspaceName, record.sessionId, drain.connectionId);
				this.dropIfUnowned(record);
			} else {
				record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
				this.effects.cancelTuiLeaseHandoff(record.workspaceName, record.sessionId, drain.connectionId);
				this.effects.onDrainEnded?.(record, drain.viewerFeedId, "error");
				drain.rejectGranted(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		record.drain = undefined;
		record.streamCount = 0;
		if (drain.cancelled) {
			// The requesting connection died mid-disposal. The runtime is gone, so
			// the lease returns to unowned instead of granting to a dead owner.
			record.state = "unowned";
			record.tuiConnectionId = undefined;
			this.effects.releaseTuiLease(record.workspaceName, record.sessionId, drain.connectionId);
			this.effects.audit({
				type: "lease_released",
				workspaceName: record.workspaceName,
				sessionId: record.sessionId,
				details: { owner: "daemon", reason: "connection_lost", drainCancelledDuringDisposal: true },
			});
			this.dropIfUnowned(record);
			return;
		}
		if (record.tuiConnectionId !== drain.connectionId) {
			record.state = "unowned";
			record.tuiConnectionId = undefined;
			this.effects.releaseTuiLease(record.workspaceName, record.sessionId, drain.connectionId);
			const error = new Error("daemon drain lost its TUI handoff connection");
			this.effects.onDrainEnded?.(record, drain.viewerFeedId, "error");
			drain.rejectGranted(error);
			this.dropIfUnowned(record);
			return;
		}
		try {
			this.effects.commitTuiLeaseHandoff(record.workspaceName, record.sessionId, drain.connectionId);
		} catch (error) {
			record.state = "unowned";
			record.tuiConnectionId = undefined;
			this.effects.releaseTuiLease(record.workspaceName, record.sessionId, drain.connectionId);
			this.effects.onDrainEnded?.(record, drain.viewerFeedId, "error");
			drain.rejectGranted(error instanceof Error ? error : new Error(String(error)));
			this.dropIfUnowned(record);
			return;
		}
		record.state = "tui-owned";
		this.effects.onDrainEnded?.(record, drain.viewerFeedId, "granted");
		this.effects.audit({
			type: "lease_acquired",
			workspaceName: record.workspaceName,
			sessionId: record.sessionId,
			details: { owner: "tui", handoff: "warm", connectionId: record.tuiConnectionId },
		});
		drain.resolveGranted({ handoff: "warm" });
	}

	private cancelDrain(record: LeaseRecord): void {
		const drain = record.drain;
		if (!drain || drain.cancelled) {
			return;
		}
		drain.cancelled = true;
		if (drain.disposing) {
			// Runtime disposal already started and cannot be reverted; fail the
			// grant now and let runDrain's continuation finish the transition
			// (to unowned) once the disposal effects settle.
			this.effects.onDrainEnded?.(record, drain.viewerFeedId, "cancelled");
			drain.rejectGranted(new Error("drain cancelled"));
			return;
		}
		record.drain = undefined;
		record.tuiConnectionId = undefined;
		record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
		this.effects.cancelTuiLeaseHandoff(record.workspaceName, record.sessionId, drain.connectionId);
		this.effects.onDrainEnded?.(record, drain.viewerFeedId, "cancelled");
		drain.rejectGranted(new Error("drain cancelled"));
	}

	releaseFromTui(
		connectionId: string,
		workspaceName: string,
		sessionId: string,
		reason: LeaseReleaseReason = "quit",
	): { ok: true } | { ok: false; code: "not_held" } {
		const record = this.lookup(workspaceName, sessionId);
		if (record?.state === "daemon-draining" && record.tuiConnectionId === connectionId) {
			// The requesting TUI is abandoning its own pending drain (a change of
			// mind). Cancel it rather than letting runDrain complete and force-grant
			// an unwanted warm lease — which would needlessly dispose the daemon
			// runtime and close every phone stream for a handoff no one wants.
			this.cancelDrain(record);
			this.dropIfUnowned(record);
			return { ok: true };
		}
		if (!record || record.state !== "tui-owned" || record.tuiConnectionId !== connectionId) {
			return { ok: false, code: "not_held" };
		}
		this.clearTuiRekeyReservationsForRecord(record);
		this.effects.closeRelays(
			record,
			reason === "workspace_unregistered" ? "workspace_unregistered" : "lease_transferred",
		);
		record.relayIds.clear();
		record.state = "unowned";
		record.tuiConnectionId = undefined;
		this.effects.releaseTuiLease(workspaceName, sessionId, connectionId);
		this.effects.audit({
			type: "lease_released",
			workspaceName,
			sessionId,
			details: { owner: "tui", reason, connectionId },
		});
		this.dropIfUnowned(record);
		return { ok: true };
	}

	/** Connection died: implicit release of ALL leases held by connectionId. */
	releaseAllForConnection(connectionId: string): void {
		this.cancelPendingTuiAcquireBarriers(connectionId);
		for (const record of Array.from(this.records.values())) {
			if (record.state === "tui-owned" && record.tuiConnectionId === connectionId) {
				this.releaseFromTui(connectionId, record.workspaceName, record.sessionId, "connection_lost");
				continue;
			}
			if (record.state === "daemon-draining" && record.tuiConnectionId === connectionId) {
				this.cancelDrain(record);
			}
		}
		for (const reservation of Array.from(this.tuiRekeyReservations.values())) {
			if (reservation.connectionId === connectionId) {
				this.clearTuiRekeyReservation(reservation);
			}
		}
	}

	prepareTuiRekey(
		workspaceName: string,
		oldSessionId: string,
		newSessionId: string,
		connectionId: string,
	): TuiLeaseRekeyPrepareOutcome {
		const sourceKey = getLeaseKey(workspaceName, oldSessionId);
		const targetKey = getLeaseKey(workspaceName, newSessionId);
		const record = this.records.get(sourceKey);
		if (!record) {
			return { ok: false, code: "not_found" };
		}
		if (record.state !== "tui-owned" || record.tuiConnectionId !== connectionId) {
			return { ok: false, code: "not_held" };
		}

		const existingSourceReservation = this.tuiRekeyReservationsBySource.get(sourceKey);
		if (existingSourceReservation) {
			if (
				existingSourceReservation.connectionId === connectionId &&
				existingSourceReservation.targetKey === targetKey
			) {
				return { ok: true, reservation: existingSourceReservation };
			}
			return { ok: false, code: "transition_in_progress" };
		}
		if (this.daemonRekeyReservationsBySource.has(sourceKey)) {
			return { ok: false, code: "transition_in_progress" };
		}

		if (sourceKey !== targetKey) {
			if (this.worktreeRemovalReservations.has(targetKey)) {
				return { ok: false, code: "transition_in_progress" };
			}
			const displaced = this.records.get(targetKey);
			const targetReservation = this.tuiRekeyReservationsByTarget.get(targetKey);
			const daemonTargetReservation = this.daemonRekeyReservationsByTarget.get(targetKey);
			if (displaced || targetReservation || daemonTargetReservation) {
				this.effects.audit({
					type: "lease_denied",
					workspaceName,
					sessionId: newSessionId,
					details: {
						reason:
							targetReservation || daemonTargetReservation ? "rekey_target_reserved" : "rekey_target_in_use",
						oldSessionId,
						...(displaced ? { displacedState: displaced.state } : {}),
					},
				});
				return { ok: false, code: "target_in_use" };
			}
		}

		const reservation: TuiLeaseRekeyReservation = {
			id: randomUUID(),
			connectionId,
			workspaceName,
			oldSessionId,
			newSessionId,
			sourceKey,
			targetKey,
			record,
		};
		try {
			this.effects.prepareTuiLeaseRekey(reservation.id, workspaceName, oldSessionId, newSessionId, connectionId);
		} catch (error) {
			this.effects.audit({
				type: "lease_denied",
				workspaceName,
				sessionId: newSessionId,
				details: {
					reason: "coordinator_rekey_unavailable",
					oldSessionId,
					error: error instanceof Error ? error.message : String(error),
				},
			});
			return { ok: false, code: "coordinator_unavailable" };
		}
		this.tuiRekeyReservations.set(reservation.id, reservation);
		this.tuiRekeyReservationsBySource.set(sourceKey, reservation);
		if (sourceKey !== targetKey) {
			this.tuiRekeyReservationsByTarget.set(targetKey, reservation);
		}
		return { ok: true, reservation };
	}

	getTuiRekeyReservation(transactionId: string, connectionId: string): TuiLeaseRekeyReservation | undefined {
		const reservation = this.tuiRekeyReservations.get(transactionId);
		return reservation?.connectionId === connectionId ? reservation : undefined;
	}

	commitTuiRekey(transactionId: string, connectionId: string): TuiLeaseRekeyTransactionOutcome {
		const reservation = this.getTuiRekeyReservation(transactionId, connectionId);
		if (!reservation) {
			return { ok: false, code: "not_found" };
		}
		const record = this.records.get(reservation.sourceKey);
		if (record !== reservation.record || record.state !== "tui-owned" || record.tuiConnectionId !== connectionId) {
			this.clearTuiRekeyReservation(reservation);
			return { ok: false, code: "not_held" };
		}
		if (
			reservation.sourceKey !== reservation.targetKey &&
			(this.records.has(reservation.targetKey) || this.worktreeRemovalReservations.has(reservation.targetKey))
		) {
			return { ok: false, code: "target_in_use" };
		}

		try {
			if (record.relayIds.size > 0) {
				this.effects.closeRelays(record, "session_rekeyed_reconnect");
			}
			this.effects.commitTuiLeaseRekey(reservation.id, connectionId);
		} catch {
			this.clearTuiRekeyReservation(reservation);
			return { ok: false, code: "authority_commit_failed" };
		}
		record.relayIds.clear();
		this.clearTuiRekeyReservation(reservation, false);
		if (reservation.sourceKey !== reservation.targetKey) {
			this.records.delete(reservation.sourceKey);
			record.sessionId = reservation.newSessionId;
			record.key = reservation.targetKey;
			this.records.set(reservation.targetKey, record);
		}
		return { ok: true, reservation };
	}

	rollbackTuiRekey(transactionId: string, connectionId: string): TuiLeaseRekeyTransactionOutcome {
		const reservation = this.getTuiRekeyReservation(transactionId, connectionId);
		if (!reservation) {
			return { ok: false, code: "not_found" };
		}
		this.clearTuiRekeyReservation(reservation);
		return { ok: true, reservation };
	}

	disposeTuiRekey(transactionId: string, connectionId: string): TuiLeaseRekeyTransactionOutcome {
		const reservation = this.getTuiRekeyReservation(transactionId, connectionId);
		if (!reservation) {
			return { ok: false, code: "not_found" };
		}
		this.clearTuiRekeyReservation(reservation);
		const released = this.releaseFromTui(connectionId, reservation.workspaceName, reservation.oldSessionId, "rekey");
		return released.ok ? { ok: true, reservation } : released;
	}

	private clearTuiRekeyReservationsForRecord(record: LeaseRecord): void {
		for (const reservation of Array.from(this.tuiRekeyReservations.values())) {
			if (reservation.record === record) {
				this.clearTuiRekeyReservation(reservation);
			}
		}
	}

	private clearTuiRekeyReservation(reservation: TuiLeaseRekeyReservation, rollbackAuthority = true): void {
		if (rollbackAuthority) {
			this.effects.rollbackTuiLeaseRekey(reservation.id, reservation.connectionId);
		}
		this.tuiRekeyReservations.delete(reservation.id);
		if (this.tuiRekeyReservationsBySource.get(reservation.sourceKey) === reservation) {
			this.tuiRekeyReservationsBySource.delete(reservation.sourceKey);
		}
		if (this.tuiRekeyReservationsByTarget.get(reservation.targetKey) === reservation) {
			this.tuiRekeyReservationsByTarget.delete(reservation.targetKey);
		}
	}

	prepareDaemonRekey(
		owner: DaemonRuntimeOwnerCapability,
		workspaceName: string,
		oldSessionId: string,
		newSessionId: string,
	): DaemonLeaseRekeyPrepareOutcome {
		const sourceKey = getLeaseKey(workspaceName, oldSessionId);
		const targetKey = getLeaseKey(workspaceName, newSessionId);
		const record = this.records.get(sourceKey);
		if (!record) {
			return { ok: false, code: "not_found" };
		}
		if (!this.isDaemonRuntimeOwnerCurrent(owner, workspaceName, oldSessionId)) {
			return { ok: false, code: "not_held" };
		}
		if (record.state !== "daemon-active" && record.state !== "daemon-detached") {
			return { ok: false, code: "not_held" };
		}
		const existing = this.daemonRekeyReservationsBySource.get(sourceKey);
		if (existing) {
			return existing.owner === owner && existing.targetKey === targetKey
				? { ok: true, reservation: existing }
				: { ok: false, code: "transition_in_progress" };
		}
		if (this.tuiRekeyReservationsBySource.has(sourceKey)) {
			return { ok: false, code: "transition_in_progress" };
		}
		if (sourceKey !== targetKey) {
			if (
				this.worktreeRemovalReservations.has(targetKey) ||
				this.records.has(targetKey) ||
				this.tuiRekeyReservationsByTarget.has(targetKey) ||
				this.daemonRekeyReservationsByTarget.has(targetKey)
			) {
				this.effects.audit({
					type: "lease_denied",
					workspaceName,
					sessionId: newSessionId,
					details: { reason: "rekey_target_in_use", oldSessionId },
				});
				return { ok: false, code: "target_in_use" };
			}
		}
		const reservation: DaemonLeaseRekeyReservation = {
			id: randomUUID(),
			owner,
			workspaceName,
			oldSessionId,
			newSessionId,
			sourceKey,
			targetKey,
			record,
		};
		this.daemonRekeyReservations.set(reservation.id, reservation);
		this.daemonRekeyReservationsBySource.set(sourceKey, reservation);
		if (sourceKey !== targetKey) {
			this.daemonRekeyReservationsByTarget.set(targetKey, reservation);
		}
		return { ok: true, reservation };
	}

	commitDaemonRekey(transactionId: string): DaemonLeaseRekeyTransactionOutcome {
		const reservation = this.daemonRekeyReservations.get(transactionId);
		if (!reservation) {
			return { ok: false, code: "not_found" };
		}
		const record = this.records.get(reservation.sourceKey);
		if (
			record !== reservation.record ||
			!this.isDaemonRuntimeOwnerCurrent(reservation.owner, reservation.workspaceName, reservation.oldSessionId) ||
			(record.state !== "daemon-active" && record.state !== "daemon-detached")
		) {
			this.clearDaemonRekeyReservation(reservation);
			return { ok: false, code: "not_held" };
		}
		if (
			reservation.sourceKey !== reservation.targetKey &&
			(this.records.has(reservation.targetKey) || this.worktreeRemovalReservations.has(reservation.targetKey))
		) {
			return { ok: false, code: "target_in_use" };
		}
		this.clearDaemonRekeyReservation(reservation);
		if (reservation.sourceKey !== reservation.targetKey) {
			this.fenceCurrentDaemonRuntimeCommitCohort(record);
			this.records.delete(reservation.sourceKey);
			record.sessionId = reservation.newSessionId;
			record.key = reservation.targetKey;
			this.records.set(reservation.targetKey, record);
		}
		return { ok: true, reservation };
	}

	rollbackDaemonRekey(transactionId: string): DaemonLeaseRekeyTransactionOutcome {
		const reservation = this.daemonRekeyReservations.get(transactionId);
		if (!reservation) {
			return { ok: false, code: "not_found" };
		}
		this.clearDaemonRekeyReservation(reservation);
		return { ok: true, reservation };
	}

	private clearDaemonRekeyReservationsForRecord(record: LeaseRecord): void {
		for (const reservation of Array.from(this.daemonRekeyReservations.values())) {
			if (reservation.record === record) {
				this.clearDaemonRekeyReservation(reservation);
			}
		}
	}

	private clearDaemonRekeyReservation(reservation: DaemonLeaseRekeyReservation): void {
		this.daemonRekeyReservations.delete(reservation.id);
		if (this.daemonRekeyReservationsBySource.get(reservation.sourceKey) === reservation) {
			this.daemonRekeyReservationsBySource.delete(reservation.sourceKey);
		}
		if (this.daemonRekeyReservationsByTarget.get(reservation.targetKey) === reservation) {
			this.daemonRekeyReservationsByTarget.delete(reservation.targetKey);
		}
	}

	rekeyDaemonRuntime(
		owner: DaemonRuntimeOwnerCapability,
		workspaceName: string,
		oldSessionId: string,
		newSessionId: string,
	): LeaseRekeyOutcome {
		if (oldSessionId === newSessionId) {
			return this.isDaemonRuntimeOwnerCurrent(owner, workspaceName, oldSessionId)
				? { ok: true }
				: { ok: false, code: "not_held" };
		}
		const record = this.lookup(workspaceName, oldSessionId);
		if (!record) {
			const alreadyRekeyed = this.lookup(workspaceName, newSessionId);
			if (alreadyRekeyed && this.isDaemonRuntimeOwnerCurrent(owner, workspaceName, newSessionId)) {
				return { ok: true };
			}
			return { ok: false, code: "not_found" };
		}
		if (!this.isDaemonRuntimeOwnerCurrent(owner, workspaceName, oldSessionId)) {
			return { ok: false, code: "not_held" };
		}
		const newKey = getLeaseKey(workspaceName, newSessionId);
		if (
			this.worktreeRemovalReservations.has(newKey) ||
			this.tuiRekeyReservationsBySource.has(record.key) ||
			this.tuiRekeyReservationsByTarget.has(newKey) ||
			this.daemonRekeyReservationsBySource.has(record.key) ||
			this.daemonRekeyReservationsByTarget.has(newKey)
		) {
			return { ok: false, code: "target_in_use" };
		}
		const displaced = this.records.get(newKey);
		if (displaced) {
			// The target session id already has its own lease record. A destructive
			// rekey would either orphan `record` (its old key removed but never
			// re-inserted) or silently drop the live `displaced` record from all
			// lease accounting, stranding its runtime/streams/relays. Refuse instead
			// and leave both records on their current keys; the caller re-acquires
			// under the new id on its next reconnect.
			this.effects.audit({
				type: "lease_denied",
				workspaceName,
				sessionId: newSessionId,
				details: { reason: "rekey_target_in_use", oldSessionId, displacedState: displaced.state },
			});
			return { ok: false, code: "target_in_use" };
		}
		this.fenceCurrentDaemonRuntimeCommitCohort(record);
		this.records.delete(record.key);
		record.sessionId = newSessionId;
		record.key = newKey;
		this.records.set(newKey, record);
		return { ok: true };
	}

	// ==========================================================================
	// Relay bookkeeping (tui-owned)
	// ==========================================================================

	registerRelay(workspaceName: string, sessionId: string, relayId: string): boolean {
		const key = getLeaseKey(workspaceName, sessionId);
		if (
			this.tuiRekeyReservationsBySource.has(key) ||
			this.tuiRekeyReservationsByTarget.has(key) ||
			this.daemonRekeyReservationsBySource.has(key) ||
			this.daemonRekeyReservationsByTarget.has(key)
		) {
			return false;
		}
		const record = this.lookup(workspaceName, sessionId);
		if (record?.state === "tui-owned") {
			record.relayIds.add(relayId);
			return true;
		}
		return false;
	}

	unregisterRelay(workspaceName: string, sessionId: string, relayId: string): void {
		const record = this.lookup(workspaceName, sessionId);
		if (record) {
			record.relayIds.delete(relayId);
			this.dropIfUnowned(record);
		}
	}

	// ==========================================================================
	// Daemon runtime lifecycle notifications
	// ==========================================================================

	onDaemonRuntimeStreamCountChanged(
		owner: DaemonRuntimeOwnerCapability,
		workspaceName: string,
		sessionId: string,
		liveStreams: number,
	): boolean {
		if (!this.isDaemonRuntimeOwnerCurrent(owner, workspaceName, sessionId)) {
			return false;
		}
		const record = this.lookup(workspaceName, sessionId);
		if (!record) {
			return false;
		}
		record.streamCount = liveStreams;
		if (record.state === "daemon-draining" || record.state === "tui-owned" || record.state === "unowned") {
			// Drain completes regardless of stream count; tui-owned counts relays instead.
			return true;
		}
		record.state = liveStreams > 0 ? "daemon-active" : "daemon-detached";
		return true;
	}

	onDaemonRuntimeDisposed(
		owner: DaemonRuntimeOwnerCapability,
		workspaceName: string,
		sessionId: string,
		reason: string,
	): boolean {
		const key = getLeaseKey(workspaceName, sessionId);
		const ownerRecord = this.daemonRuntimeOwnerRecords.get(owner);
		const provisionalCohort = ownerRecord?.provisionalCohort;
		if (
			provisionalCohort &&
			provisionalCohort.owner === owner &&
			provisionalCohort.key === key &&
			this.records.get(key) === provisionalCohort.record &&
			this.daemonRuntimeCommitCohorts.get(provisionalCohort.record) === provisionalCohort &&
			this.daemonRuntimeCommitGenerations.get(provisionalCohort.record) === provisionalCohort.generation
		) {
			this.fenceDaemonRuntimeCommitCohort(provisionalCohort);
			this.restoreDaemonRuntimeCommitBase(provisionalCohort);
			return true;
		}
		if (!this.isDaemonRuntimeOwnerCurrent(owner, workspaceName, sessionId)) {
			return false;
		}
		const record = this.lookup(workspaceName, sessionId);
		if (!record) {
			return false;
		}
		this.fenceCurrentDaemonRuntimeCommitCohort(record);
		this.clearDaemonRekeyReservationsForRecord(record);
		this.invalidateDaemonRuntimeOwner(record, owner);
		if (record.state === "daemon-draining") {
			// Disposal is part of the drain flow (or shutdown subsumed it); the drain
			// path handles its own transition.
			return true;
		}
		if (record.state === "tui-owned") {
			// The runtime disposal that accompanies an immediate grant.
			return true;
		}
		record.streamCount = 0;
		record.state = "unowned";
		this.effects.audit({
			type: "lease_released",
			workspaceName,
			sessionId,
			details: {
				owner: "daemon",
				reason: reason === "detached_runtime_ttl_expired" ? "retention_expired" : reason,
			},
		});
		this.dropIfUnowned(record);
		return true;
	}

	isDraining(workspaceName: string, sessionId: string): boolean {
		return this.lookup(workspaceName, sessionId)?.state === "daemon-draining";
	}
}
