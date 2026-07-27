import { randomUUID } from "node:crypto";
import type { SubagentDefinitionSource } from "./index.ts";

export type SubagentRegistryStatus = "running" | "completed" | "failed" | "aborted";

export type SubagentRegistryFollowability = "followable" | "current" | "ancestor" | "dependency-cycle";

/** Public snapshot of one delegated run, safe to hand to any runtime in the tree. */
export interface SubagentRegistryRecord {
	id: string;
	/** Immutable registration order. List-mode pagination cursors compare against it. */
	sequence: number;
	/** Registry id of the runtime that started this run; absent for root-session starts. */
	parentId?: string;
	agent: {
		name: string;
		source?: SubagentDefinitionSource;
	};
	/** Delegation path of agent names from the root session down to this run. */
	path: string[];
	/** Bounded task prompt this run was started with. */
	task?: string;
	status: SubagentRegistryStatus;
	/** Caller-relative follow safety. Present on records returned for a specific runtime. */
	followability?: SubagentRegistryFollowability;
	/** True for runs recovered from persisted transcripts rather than started by this process. */
	hydrated?: true;
	startedAt: number;
	finishedAt?: number;
	error?: string;
}

/** Bounded newest-first view of the registry plus its unbounded logical size. */
export interface SubagentRegistrySnapshot {
	records: SubagentRegistryRecord[];
	total: number;
}

/** Terminal outcome of a followed run, including its bounded final output. */
export interface SubagentFollowResult {
	id: string;
	agent: SubagentRegistryRecord["agent"];
	task?: string;
	status: Exclude<SubagentRegistryStatus, "running">;
	output?: string;
	error?: string;
	startedAt: number;
	finishedAt: number;
}

export type SubagentSpawnConfirmationStatus = "reserved" | "pending" | "claimed";

/** Atomic registry snapshot and reservation result for a proposed spawn request. */
export interface SubagentSpawnConfirmationPreflight {
	records: SubagentRegistryRecord[];
	/** Full registry size when records is a bounded first page. */
	total?: number;
	/** Full-registry status counts when records is bounded. */
	statusCounts?: Record<SubagentRegistryStatus, number>;
	status: SubagentSpawnConfirmationStatus;
	expiresAt: number;
	/** Present only when this call created the reservation. */
	token?: string;
}

/** One claimed spawn reservation. Release it when the confirmed tool call settles. */
export interface SubagentSpawnConfirmationLease {
	release(): void;
}

interface SubagentRegistryEntry {
	id: string;
	/** Monotonic registration order, so listing stays stable within one millisecond. */
	sequence: number;
	previousRunning: SubagentRegistryEntry | undefined;
	nextRunning: SubagentRegistryEntry | undefined;
	parentId: string | undefined;
	agent: SubagentRegistryRecord["agent"];
	path: string[];
	task: string | undefined;
	status: SubagentRegistryStatus;
	hydrated: boolean;
	startedAt: number;
	finishedAt: number | undefined;
	error: string | undefined;
	output: string | undefined;
	waiters: Array<{ resolve: (result: SubagentFollowResult) => void }>;
}

interface SubagentSpawnConfirmationEntry {
	token: string;
	status: "pending" | "claimed";
	expiresAt: number;
}

const REGISTRY_TASK_LIMIT_CHARS = 2_000;
const REGISTRY_OUTPUT_LIMIT_CHARS = 50_000;
const REGISTRY_ERROR_LIMIT_CHARS = 4_000;
const REGISTRY_ID_PREVIEW_LIMIT_CHARS = 120;
const REGISTRY_KNOWN_ID_PREVIEW_LIMIT = 20;
const MAX_REGISTRY_RECORDS = 500;
const SUBAGENT_SPAWN_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_SPAWN_CONFIRMATIONS = 500;
const SPAWN_CONFIRMATION_RECORD_LIMIT = 50;
/** Node key representing the root session in the wait-dependency graph. */
const ROOT_NODE = "root";

function boundText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

/**
 * Session-wide index of every delegated subagent run in one runtime tree.
 *
 * The root session's manager owns one registry for its lifetime and every
 * descendant runtime shares it through its subagent context, so any branch can
 * discover sibling/cousin runs and follow their results instead of duplicating
 * work. Completed outputs are retained bounded; waiting on a running run is
 * cycle-checked against parent-awaits-child and active follow edges so a
 * follow can never deadlock the tree.
 */
export class SubagentRegistry {
	private readonly entries = new Map<string, SubagentRegistryEntry>();
	/** Terminal entries stay sorted by registration sequence and are capped at 500. */
	private readonly terminalEntries: SubagentRegistryEntry[] = [];
	private runningTail: SubagentRegistryEntry | undefined;
	private readonly spawnConfirmations = new Map<string, SubagentSpawnConfirmationEntry>();
	/** Active follow waits, follower node key -> target id and waiter count, for deadlock detection. */
	private readonly activeFollows = new Map<string, Map<string, number>>();
	private nextSequence = 0;

	register(options: { id: string; parentId?: string; agent: SubagentRegistryRecord["agent"]; path: string[] }): void {
		const entry: SubagentRegistryEntry = {
			id: options.id,
			sequence: this.nextSequence++,
			previousRunning: undefined,
			nextRunning: undefined,
			parentId: options.parentId,
			agent: { ...options.agent },
			path: [...options.path],
			task: undefined,
			status: "running",
			hydrated: false,
			startedAt: Date.now(),
			finishedAt: undefined,
			error: undefined,
			output: undefined,
			waiters: [],
		};
		this.entries.set(options.id, entry);
		this.appendRunning(entry);
		this.evictOldestTerminal();
	}

	/**
	 * Register a run recovered from persisted transcripts in a terminal state
	 * (issue #129). Hydrated entries behave like ordinary terminal records —
	 * follow returns them immediately — but keep their historical timestamps
	 * and are marked so consumers can tell recovered pre-restart work from
	 * runs started by this process. No-op when the id is already known.
	 */
	hydrate(options: {
		id: string;
		parentId?: string;
		agent: SubagentRegistryRecord["agent"];
		path: string[];
		task?: string;
		status: Exclude<SubagentRegistryStatus, "running">;
		output?: string;
		error?: string;
		startedAt: number;
		finishedAt: number;
	}): void {
		if (this.entries.has(options.id)) {
			return;
		}
		const entry: SubagentRegistryEntry = {
			id: options.id,
			sequence: this.nextSequence++,
			previousRunning: undefined,
			nextRunning: undefined,
			parentId: options.parentId,
			agent: { ...options.agent },
			path: [...options.path],
			task: options.task === undefined ? undefined : boundText(options.task, REGISTRY_TASK_LIMIT_CHARS),
			status: options.status,
			hydrated: true,
			startedAt: options.startedAt,
			finishedAt: options.finishedAt,
			error: options.error === undefined ? undefined : boundText(options.error, REGISTRY_ERROR_LIMIT_CHARS),
			output: options.output === undefined ? undefined : boundText(options.output, REGISTRY_OUTPUT_LIMIT_CHARS),
			waiters: [],
		};
		this.entries.set(options.id, entry);
		this.insertTerminal(entry);
		this.evictOldestTerminal();
	}

	setTask(id: string, task: string): void {
		const entry = this.entries.get(id);
		if (!entry || entry.status !== "running" || entry.task !== undefined) {
			return;
		}
		entry.task = boundText(task, REGISTRY_TASK_LIMIT_CHARS);
	}

	complete(
		id: string,
		status: Exclude<SubagentRegistryStatus, "running">,
		result: { output?: string; error?: string } = {},
	): void {
		const entry = this.entries.get(id);
		if (!entry || entry.status !== "running") {
			return;
		}
		this.removeRunning(entry);
		entry.status = status;
		entry.finishedAt = Date.now();
		entry.error = result.error === undefined ? undefined : boundText(result.error, REGISTRY_ERROR_LIMIT_CHARS);
		entry.output = result.output === undefined ? undefined : boundText(result.output, REGISTRY_OUTPUT_LIMIT_CHARS);
		this.insertTerminal(entry);
		const waiters = entry.waiters;
		entry.waiters = [];
		for (const waiter of waiters) {
			waiter.resolve(this.toFollowResult(entry));
		}
		this.evictOldestTerminal();
	}

	/** All known runs, running first, then newest first — mirrors activity ordering. */
	list(): SubagentRegistryRecord[] {
		return this.collectRecords(this.entries.size);
	}

	/** Newest records without sorting or cloning entries beyond the requested bound. */
	snapshot(limit: number): SubagentRegistrySnapshot {
		if (!Number.isSafeInteger(limit) || limit < 0) {
			throw new Error("Subagent registry snapshot limit must be a non-negative safe integer");
		}
		return { records: this.collectRecords(limit), total: this.entries.size };
	}

	/** Bounded registry snapshot annotated with follow safety relative to one runtime. */
	snapshotForFollower(
		limit: number,
		followerId: string | undefined,
		followerParentId?: string,
	): SubagentRegistrySnapshot {
		const snapshot = this.snapshot(limit);
		return {
			...snapshot,
			records: this.annotateFollowability(snapshot.records, followerId, followerParentId),
		};
	}

	/** All known runs annotated with whether the specified runtime may safely follow each one. */
	listForFollower(followerId: string | undefined, followerParentId?: string): SubagentRegistryRecord[] {
		return this.annotateFollowability(this.list(), followerId, followerParentId);
	}

	get(id: string): SubagentRegistryRecord | undefined {
		const entry = this.entries.get(id);
		return entry ? this.toRecord(entry) : undefined;
	}

	/**
	 * List current runs and atomically reserve one exact normalized spawn request.
	 * Concurrent callers for the same key observe the existing reservation instead
	 * of receiving independent confirmation tokens. A caller that just failed a
	 * claim may pass `reissuePending` to rotate a still-pending token: a garbled
	 * token must not lock the request out until the reservation expires, and
	 * rotation keeps exactly one token valid at a time.
	 */
	prepareSpawnConfirmation(
		requestKey: string,
		followerId?: string,
		followerParentId?: string,
		options?: { reissuePending?: boolean },
	): SubagentSpawnConfirmationPreflight {
		const snapshot = this.snapshotForFollower(SPAWN_CONFIRMATION_RECORD_LIMIT, followerId, followerParentId);
		const registrySummary = {
			records: snapshot.records,
			total: snapshot.total,
			statusCounts: this.getStatusCounts(),
		};
		const now = Date.now();
		this.pruneExpiredSpawnConfirmations(now);
		const existing = this.spawnConfirmations.get(requestKey);
		if (existing) {
			if (existing.status === "pending" && options?.reissuePending) {
				existing.token = randomUUID();
				existing.expiresAt = now + SUBAGENT_SPAWN_CONFIRMATION_TTL_MS;
				return {
					...registrySummary,
					status: "reserved",
					expiresAt: existing.expiresAt,
					token: existing.token,
				};
			}
			return {
				...registrySummary,
				status: existing.status,
				expiresAt: existing.expiresAt,
			};
		}

		this.evictOldestPendingSpawnConfirmation();
		const confirmation: SubagentSpawnConfirmationEntry = {
			token: randomUUID(),
			status: "pending",
			expiresAt: now + SUBAGENT_SPAWN_CONFIRMATION_TTL_MS,
		};
		this.spawnConfirmations.set(requestKey, confirmation);
		return {
			...registrySummary,
			status: "reserved",
			expiresAt: confirmation.expiresAt,
			token: confirmation.token,
		};
	}

	/** Atomically claim a pending token for its exact normalized spawn request. */
	claimSpawnConfirmation(requestKey: string, token: string): SubagentSpawnConfirmationLease | undefined {
		this.pruneExpiredSpawnConfirmations(Date.now());
		const confirmation = this.spawnConfirmations.get(requestKey);
		if (!confirmation || confirmation.status !== "pending" || confirmation.token !== token) {
			return undefined;
		}
		confirmation.status = "claimed";
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				if (this.spawnConfirmations.get(requestKey) === confirmation) {
					this.spawnConfirmations.delete(requestKey);
				}
			},
		};
	}

	/**
	 * Return the target run's terminal result, waiting for completion when it is
	 * still running. `followerId` is the registry id of the waiting runtime
	 * (undefined for the root session) and is used to refuse waits that would
	 * deadlock the tree: a run can never complete while one of its ancestors or
	 * (transitively) awaited dependencies is blocked on it.
	 */
	async follow(followerId: string | undefined, targetId: string, signal?: AbortSignal): Promise<SubagentFollowResult> {
		const entry = this.entries.get(targetId);
		if (!entry) {
			const known = Array.from(this.entries.keys());
			const shown = known
				.slice(0, REGISTRY_KNOWN_ID_PREVIEW_LIMIT)
				.map((id) => boundText(id, REGISTRY_ID_PREVIEW_LIMIT_CHARS));
			const omitted = known.length - shown.length;
			const targetPreview = boundText(targetId, REGISTRY_ID_PREVIEW_LIMIT_CHARS);
			throw new Error(
				known.length > 0
					? `Subagent run "${targetPreview}" is not in the delegation registry. Known runs: ${shown.join(", ")}${omitted > 0 ? ` (${omitted} more omitted)` : ""}.`
					: `Subagent run "${targetPreview}" is not in the delegation registry. No runs have been recorded yet.`,
			);
		}
		if (entry.status !== "running") {
			return this.toFollowResult(entry);
		}
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const followerKey = followerId ?? ROOT_NODE;
		if (followerId === targetId) {
			throw new Error(
				`Following subagent run "${targetId}" would deadlock because it is the current runtime. Continue the current task independently instead.`,
			);
		}
		if (this.getAncestorIds(followerId).has(targetId)) {
			throw new Error(
				`Following subagent run "${targetId}" would deadlock because it is an ancestor waiting for the current runtime to finish. Continue independently instead.`,
			);
		}
		if (this.wouldDeadlock(followerKey, targetId)) {
			throw new Error(
				`Following subagent run "${targetId}" would deadlock: its completion depends on the current runtime finishing first. Continue independently instead.`,
			);
		}

		let followTargets = this.activeFollows.get(followerKey);
		if (!followTargets) {
			followTargets = new Map();
			this.activeFollows.set(followerKey, followTargets);
		}
		followTargets.set(targetId, (followTargets.get(targetId) ?? 0) + 1);

		try {
			return await new Promise<SubagentFollowResult>((resolve, reject) => {
				const waiter = { resolve: (result: SubagentFollowResult) => resolve(result) };
				const onAbort = () => {
					entry.waiters = entry.waiters.filter((candidate) => candidate !== waiter);
					reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
				};
				waiter.resolve = (result) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				entry.waiters.push(waiter);
			});
		} finally {
			const remaining = (followTargets.get(targetId) ?? 0) - 1;
			if (remaining > 0) {
				followTargets.set(targetId, remaining);
			} else {
				followTargets.delete(targetId);
			}
			if (followTargets.size === 0) {
				this.activeFollows.delete(followerKey);
			}
		}
	}

	/**
	 * True when `followerKey` waiting on `targetId` closes a dependency cycle.
	 * Edges point from a node to what its completion depends on: running child
	 * runs (a parent's tool call awaits its children) and active follow targets.
	 */
	private wouldDeadlock(followerKey: string, targetId: string): boolean {
		return this.getDeadlockingTargetIds(followerKey).has(targetId);
	}

	/** Targets whose completion transitively depends on the specified follower. */
	private getDeadlockingTargetIds(followerKey: string): Set<string> {
		const dependentsByDependency = new Map<string, Set<string>>();
		const addDependency = (dependent: string, dependency: string): void => {
			let dependents = dependentsByDependency.get(dependency);
			if (!dependents) {
				dependents = new Set();
				dependentsByDependency.set(dependency, dependents);
			}
			dependents.add(dependent);
		};
		for (const entry of this.entries.values()) {
			if (entry.status === "running") {
				addDependency(entry.parentId ?? ROOT_NODE, entry.id);
			}
		}
		for (const [follower, targets] of this.activeFollows) {
			for (const target of targets.keys()) {
				addDependency(follower, target);
			}
		}

		const deadlockingTargetIds = new Set<string>();
		const stack = [followerKey];
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === undefined || deadlockingTargetIds.has(current)) {
				continue;
			}
			deadlockingTargetIds.add(current);
			const dependents = dependentsByDependency.get(current);
			if (dependents) {
				stack.push(...dependents);
			}
		}
		return deadlockingTargetIds;
	}

	private getAncestorIds(followerId: string | undefined, followerParentId?: string): Set<string> {
		const ancestorIds = new Set<string>();
		const followerEntry = followerId === undefined ? undefined : this.entries.get(followerId);
		let ancestorId = followerEntry ? followerEntry.parentId : followerParentId;
		while (ancestorId !== undefined && !ancestorIds.has(ancestorId)) {
			ancestorIds.add(ancestorId);
			ancestorId = this.entries.get(ancestorId)?.parentId;
		}
		return ancestorIds;
	}

	private annotateFollowability(
		records: readonly SubagentRegistryRecord[],
		followerId: string | undefined,
		followerParentId?: string,
	): SubagentRegistryRecord[] {
		const ancestorIds = this.getAncestorIds(followerId, followerParentId);
		const deadlockingTargetIds = this.getDeadlockingTargetIds(followerId ?? ROOT_NODE);
		return records.map((record) => {
			let followability: SubagentRegistryFollowability = "followable";
			if (record.status === "running") {
				if (record.id === followerId) {
					followability = "current";
				} else if (ancestorIds.has(record.id)) {
					followability = "ancestor";
				} else if (deadlockingTargetIds.has(record.id)) {
					followability = "dependency-cycle";
				}
			}
			return { ...record, followability };
		});
	}

	private toRecord(entry: SubagentRegistryEntry): SubagentRegistryRecord {
		return {
			id: entry.id,
			sequence: entry.sequence,
			...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
			agent: { ...entry.agent },
			path: [...entry.path],
			...(entry.task !== undefined ? { task: entry.task } : {}),
			status: entry.status,
			...(entry.hydrated ? { hydrated: true as const } : {}),
			startedAt: entry.startedAt,
			...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
			...(entry.error !== undefined ? { error: entry.error } : {}),
		};
	}

	private toFollowResult(entry: SubagentRegistryEntry): SubagentFollowResult {
		if (entry.status === "running") {
			throw new Error(`Subagent run "${entry.id}" has not completed`);
		}
		return {
			id: entry.id,
			agent: { ...entry.agent },
			...(entry.task !== undefined ? { task: entry.task } : {}),
			status: entry.status,
			...(entry.output !== undefined ? { output: entry.output } : {}),
			...(entry.error !== undefined ? { error: entry.error } : {}),
			startedAt: entry.startedAt,
			finishedAt: entry.finishedAt ?? entry.startedAt,
		};
	}

	private getStatusCounts(): Record<SubagentRegistryStatus, number> {
		const counts: Record<SubagentRegistryStatus, number> = {
			running: this.entries.size - this.terminalEntries.length,
			completed: 0,
			failed: 0,
			aborted: 0,
		};
		for (const entry of this.terminalEntries) {
			counts[entry.status] += 1;
		}
		return counts;
	}

	private collectRecords(limit: number): SubagentRegistryRecord[] {
		const records: SubagentRegistryRecord[] = [];
		let running = this.runningTail;
		while (running && records.length < limit) {
			records.push(this.toRecord(running));
			running = running.previousRunning;
		}
		for (let index = this.terminalEntries.length - 1; index >= 0 && records.length < limit; index -= 1) {
			const terminal = this.terminalEntries[index];
			if (terminal) {
				records.push(this.toRecord(terminal));
			}
		}
		return records;
	}

	private appendRunning(entry: SubagentRegistryEntry): void {
		entry.previousRunning = this.runningTail;
		entry.nextRunning = undefined;
		if (this.runningTail) {
			this.runningTail.nextRunning = entry;
		}
		this.runningTail = entry;
	}

	private removeRunning(entry: SubagentRegistryEntry): void {
		if (entry.previousRunning) {
			entry.previousRunning.nextRunning = entry.nextRunning;
		}
		if (entry.nextRunning) {
			entry.nextRunning.previousRunning = entry.previousRunning;
		} else {
			this.runningTail = entry.previousRunning;
		}
		entry.previousRunning = undefined;
		entry.nextRunning = undefined;
	}

	private insertTerminal(entry: SubagentRegistryEntry): void {
		let low = 0;
		let high = this.terminalEntries.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const candidate = this.terminalEntries[middle];
			if (candidate && candidate.sequence < entry.sequence) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		this.terminalEntries.splice(low, 0, entry);
	}

	private evictOldestTerminal(): void {
		while (this.entries.size > MAX_REGISTRY_RECORDS) {
			const oldestTerminal = this.terminalEntries.shift();
			if (!oldestTerminal) return;
			this.entries.delete(oldestTerminal.id);
		}
	}

	private pruneExpiredSpawnConfirmations(now: number): void {
		for (const [requestKey, confirmation] of this.spawnConfirmations) {
			if (confirmation.status === "pending" && confirmation.expiresAt <= now) {
				this.spawnConfirmations.delete(requestKey);
			}
		}
	}

	private evictOldestPendingSpawnConfirmation(): void {
		if (this.spawnConfirmations.size < MAX_PENDING_SPAWN_CONFIRMATIONS) {
			return;
		}
		for (const [requestKey, confirmation] of this.spawnConfirmations) {
			if (confirmation.status === "pending") {
				this.spawnConfirmations.delete(requestKey);
				return;
			}
		}
	}
}
