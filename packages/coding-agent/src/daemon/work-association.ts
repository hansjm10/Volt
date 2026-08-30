import { githubCliPullRequestDiscoveryProvider } from "../core/code-host/github-cli-discovery.ts";
import type {
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryProvider,
} from "../core/code-host/types.ts";
import type {
	WorkBindingMutationResult,
	WorkChangeRecord,
	WorkDiscoveryApplyOutcome,
	WorkDiscoveryFence,
	WorkStateStore,
	WorkStateWireContext,
} from "./work-state.ts";

const DEFAULT_BASE_BRANCHES = ["main", "master", "trunk", "develop", "development"] as const;
const DEFAULT_PROVIDER_CONCURRENCY = 2;
const DEFAULT_CACHE_MAX_ENTRIES = 128;
const RESOLVED_TTL_MS = 5 * 60_000;
const NONE_TTL_MS = 60_000;
const AMBIGUOUS_TTL_MS = 60_000;
const UNAVAILABLE_INITIAL_BACKOFF_MS = 30_000;
const UNAVAILABLE_MAX_BACKOFF_MS = 15 * 60_000;

export interface WorkAssociationObservation {
	workspaceName: string;
	workspaceGeneration: number;
	sessionId: string;
	cwd: string;
	commonGitDir: string;
	repositoryDisplayName: string;
	branch: string;
	headOid: string;
	trusted: boolean;
	baseBranches?: readonly string[];
}

interface ActiveObservation {
	readonly key: string;
	readonly cwd: string;
	readonly trusted: boolean;
	readonly fence: WorkDiscoveryFence;
	readonly change: WorkChangeRecord;
}

interface CachedDiscovery {
	readonly outcome: CodeHostPullRequestDiscoveryOutcome;
	readonly expiresAt: number;
}

export type WorkAssociationRefreshFailurePhase = "discovery" | "scheduled_refresh";

export interface WorkAssociationServiceOptions {
	store: WorkStateStore;
	discoveryProvider?: CodeHostPullRequestDiscoveryProvider;
	enabled?: boolean;
	isOnline?: () => boolean;
	now?: () => number;
	providerConcurrency?: number;
	cacheMaxEntries?: number;
	onRefreshError?: (phase: WorkAssociationRefreshFailurePhase, error: unknown) => void;
}

function observationKey(workspaceName: string, workspaceGeneration: number, sessionId: string): string {
	return `${workspaceGeneration}\0${workspaceName}\0${sessionId}`;
}

function normalizedBaseBranch(value: string): string {
	return value
		.trim()
		.replace(/^refs\/heads\//, "")
		.replace(/^refs\/remotes\/[^/]+\//, "");
}

export function isConfiguredBaseBranch(branch: string, configured: readonly string[] = []): boolean {
	const candidates = new Set(
		[...DEFAULT_BASE_BRANCHES, ...configured].map(normalizedBaseBranch).filter((value) => value.length > 0),
	);
	return candidates.has(normalizedBaseBranch(branch));
}

function discoveryKey(fence: WorkDiscoveryFence): string {
	return `${fence.repositoryId}\0${fence.branch}\0${fence.headOid}`;
}

function toStoreOutcome(outcome: CodeHostPullRequestDiscoveryOutcome): WorkDiscoveryApplyOutcome {
	if (outcome.state !== "resolved") return { state: outcome.state };
	return {
		state: "resolved",
		pullRequest: {
			provider: outcome.pullRequest.providerId.slice(0, 64),
			number: outcome.pullRequest.number,
			title: outcome.pullRequest.title.slice(0, 512),
			status: outcome.pullRequest.status,
			matchedHeadOid: outcome.pullRequest.matchedHeadOid,
		},
	};
}

function isSameResolvedPullRequest(change: WorkChangeRecord, outcome: CodeHostPullRequestDiscoveryOutcome): boolean {
	return (
		change.resolutionState === "resolved" &&
		change.pullRequest !== undefined &&
		outcome.state === "resolved" &&
		change.pullRequest.provider === outcome.pullRequest.providerId &&
		change.pullRequest.number === outcome.pullRequest.number
	);
}

function backoffMs(failureCount: number): number {
	return Math.min(
		UNAVAILABLE_MAX_BACKOFF_MS,
		UNAVAILABLE_INITIAL_BACKOFF_MS * 2 ** Math.min(Math.max(0, failureCount), 8),
	);
}

function ttlForOutcome(outcome: CodeHostPullRequestDiscoveryOutcome): number {
	switch (outcome.state) {
		case "resolved":
			return RESOLVED_TTL_MS;
		case "none":
			return NONE_TTL_MS;
		case "ambiguous":
			return AMBIGUOUS_TTL_MS;
		case "unavailable":
			return UNAVAILABLE_INITIAL_BACKOFF_MS;
	}
}

export class WorkAssociationService {
	private readonly store: WorkStateStore;
	private readonly discoveryProvider: CodeHostPullRequestDiscoveryProvider;
	private readonly enabled: boolean;
	private readonly isOnline: () => boolean;
	private readonly now: () => number;
	private readonly providerConcurrency: number;
	private readonly cacheMaxEntries: number;
	private readonly onRefreshError: NonNullable<WorkAssociationServiceOptions["onRefreshError"]>;
	private readonly active = new Map<string, ActiveObservation>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly cache = new Map<string, CachedDiscovery>();
	private readonly inFlight = new Map<string, Promise<CodeHostPullRequestDiscoveryOutcome>>();
	private readonly providerWaiters: Array<() => void> = [];
	private readonly abortController = new AbortController();
	private activeProviderCalls = 0;
	private closed = false;

	constructor(options: WorkAssociationServiceOptions) {
		this.store = options.store;
		this.discoveryProvider = options.discoveryProvider ?? githubCliPullRequestDiscoveryProvider;
		this.enabled = options.enabled !== false;
		this.isOnline = options.isOnline ?? (() => true);
		this.now = options.now ?? (() => Date.now());
		this.providerConcurrency = Math.max(1, Math.floor(options.providerConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY));
		this.cacheMaxEntries = Math.max(1, Math.floor(options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES));
		this.onRefreshError = options.onRefreshError ?? (() => {});
	}

	async observe(observation: WorkAssociationObservation): Promise<void> {
		if (this.closed) return;
		const now = this.now();
		const binding = await this.store.bindObservation({
			workspaceName: observation.workspaceName,
			workspaceGeneration: observation.workspaceGeneration,
			sessionId: observation.sessionId,
			commonGitDir: observation.commonGitDir,
			repositoryDisplayName: observation.repositoryDisplayName,
			branch: observation.branch,
			headOid: observation.headOid.toLowerCase(),
			baseBranch: isConfiguredBaseBranch(observation.branch, observation.baseBranches),
			now,
		});
		if (this.closed) return;
		const key = observationKey(observation.workspaceName, observation.workspaceGeneration, observation.sessionId);
		const active: ActiveObservation = {
			key,
			cwd: observation.cwd,
			trusted: observation.trusted,
			fence: binding.fence,
			change: binding.change,
		};
		this.active.set(key, active);
		this.clearTimer(key);
		if (!binding.shouldDiscover) return;
		if (binding.change.nextRefreshAt > now) {
			this.schedule(active, binding.change.nextRefreshAt);
			return;
		}
		await this.resolve(active);
	}

	retireSession(workspaceName: string, workspaceGeneration: number, sessionId: string): void {
		const key = observationKey(workspaceName, workspaceGeneration, sessionId);
		this.active.delete(key);
		this.clearTimer(key);
	}

	retireWorkspace(workspaceName: string, workspaceGeneration?: number): void {
		for (const [key, active] of this.active) {
			if (
				active.fence.workspaceName === workspaceName &&
				(workspaceGeneration === undefined || active.fence.workspaceGeneration === workspaceGeneration)
			) {
				this.active.delete(key);
				this.clearTimer(key);
			}
		}
	}

	getWorkContext(
		workspaceName: string,
		workspaceGeneration: number,
		sessionId: string,
	): WorkStateWireContext | undefined {
		return this.store.getWorkContext(workspaceName, workspaceGeneration, sessionId, this.now());
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.abortController.abort(new Error("Work association service closed"));
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.active.clear();
		while (this.providerWaiters.length > 0) this.providerWaiters.shift()?.();
		await Promise.allSettled(this.inFlight.values());
		await this.store.close();
	}

	private isCurrent(active: ActiveObservation): boolean {
		return !this.closed && this.active.get(active.key) === active;
	}

	private async resolve(active: ActiveObservation): Promise<void> {
		if (!this.isCurrent(active)) return;
		let outcome: CodeHostPullRequestDiscoveryOutcome;
		if (!this.enabled || !active.trusted) {
			outcome = { state: "unavailable", reason: "unsupported_repository" };
		} else if (!this.isOnline()) {
			outcome = { state: "unavailable", reason: "network" };
		} else {
			try {
				outcome = await this.discover(active);
			} catch (error) {
				if (!this.isCurrent(active)) return;
				this.reportRefreshError("discovery", error);
				outcome = { state: "unavailable", reason: "provider_error" };
			}
		}
		if (!this.isCurrent(active)) return;
		const latestChange = this.store.getChange(active.fence.changeId);
		if (!latestChange) return;
		const refreshSucceeded =
			latestChange.resolutionState === "resolved"
				? isSameResolvedPullRequest(latestChange, outcome)
				: outcome.state !== "unavailable";
		const nextDelay = refreshSucceeded ? ttlForOutcome(outcome) : backoffMs(latestChange.failureCount);
		const nextRefreshAt = this.now() + nextDelay;
		const applied = await this.store.applyDiscovery(active.fence, toStoreOutcome(outcome), {
			now: this.now(),
			nextRefreshAt,
			refreshSucceeded,
		});
		if (!applied || !this.isCurrent(active)) return;
		const change = this.store.getChange(active.fence.changeId);
		if (!change) return;
		const next: ActiveObservation = { ...active, change };
		this.active.set(active.key, next);
		this.schedule(next, change.nextRefreshAt);
	}

	private async discover(active: ActiveObservation): Promise<CodeHostPullRequestDiscoveryOutcome> {
		const key = discoveryKey(active.fence);
		const cached = this.cache.get(key);
		const now = this.now();
		if (cached && cached.expiresAt > now) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached.outcome;
		}
		if (cached) this.cache.delete(key);
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const operation = this.withProviderSlot(async () => {
			if (this.closed) return { state: "unavailable", reason: "cancelled" } as const;
			return this.discoveryProvider.discoverPullRequest({
				cwd: active.cwd,
				branch: active.fence.branch,
				headOid: active.fence.headOid,
				signal: this.abortController.signal,
			});
		});
		this.inFlight.set(key, operation);
		try {
			const outcome = await operation;
			this.cache.set(key, { outcome, expiresAt: this.now() + ttlForOutcome(outcome) });
			while (this.cache.size > this.cacheMaxEntries) {
				const oldest = this.cache.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				this.cache.delete(oldest);
			}
			return outcome;
		} finally {
			if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
		}
	}

	private async withProviderSlot<T>(operation: () => Promise<T>): Promise<T> {
		if (this.activeProviderCalls >= this.providerConcurrency) {
			await new Promise<void>((resolve) => this.providerWaiters.push(resolve));
		}
		if (this.closed) return operation();
		this.activeProviderCalls++;
		try {
			return await operation();
		} finally {
			this.activeProviderCalls--;
			this.providerWaiters.shift()?.();
		}
	}

	private reportRefreshError(phase: WorkAssociationRefreshFailurePhase, error: unknown): void {
		try {
			this.onRefreshError(phase, error);
		} catch {
			// Error reporting must not break refresh supervision.
		}
	}

	private async runScheduledRefresh(active: ActiveObservation): Promise<void> {
		try {
			await this.resolve(active);
		} catch (error) {
			if (!this.isCurrent(active)) return;
			this.reportRefreshError("scheduled_refresh", error);
			const change = this.store.getChange(active.fence.changeId);
			if (!change) return;
			this.schedule(active, this.now() + backoffMs(change.failureCount));
		}
	}

	private schedule(active: ActiveObservation, refreshAt: number): void {
		if (!this.isCurrent(active)) return;
		this.clearTimer(active.key);
		const timer = setTimeout(
			() => {
				this.timers.delete(active.key);
				if (this.isCurrent(active)) void this.runScheduledRefresh(active);
			},
			Math.max(1, Math.min(2_147_483_647, refreshAt - this.now())),
		);
		timer.unref?.();
		this.timers.set(active.key, timer);
	}

	private clearTimer(key: string): void {
		const timer = this.timers.get(key);
		if (timer) clearTimeout(timer);
		this.timers.delete(key);
	}
}

export function createWorkAssociationService(
	store: WorkStateStore,
	options: Omit<WorkAssociationServiceOptions, "store"> = {},
): WorkAssociationService {
	return new WorkAssociationService({ store, ...options });
}

export function workBindingNeedsDiscovery(binding: WorkBindingMutationResult): boolean {
	return binding.shouldDiscover;
}
