import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { writeDurableAtomicFile } from "../utils/durable-atomic-write.ts";
import {
	ensurePrivateDirectorySync,
	openPrivateRegularFile,
	PRIVATE_DIRECTORY_MODE,
	PRIVATE_FILE_MODE,
} from "../utils/private-files.ts";

export const WORK_STATE_VERSION = 1;
export const WORK_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const WORK_STATE_MAX_REPOSITORIES = 512;
export const WORK_STATE_MAX_CHANGES = 2048;
export const WORK_STATE_MAX_BINDINGS = 4096;
const MAX_ID_CHARS = 128;
const MAX_WORKSPACE_CHARS = 256;
const MAX_REPOSITORY_DISPLAY_CHARS = 256;
const MAX_BRANCH_CHARS = 1024;
const MAX_PROVIDER_CHARS = 64;
const MAX_PR_TITLE_CHARS = 512;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type WorkResolutionState = "resolved" | "none" | "ambiguous" | "unavailable";

export interface WorkPullRequestRecord {
	provider: string;
	number: number;
	title: string;
	status: "open" | "draft" | "merged" | "closed";
	matchedHeadOid: string;
}

export interface WorkRepositoryRecord {
	id: string;
	workspaceName: string;
	workspaceGeneration: number;
	commonGitDirHash: string;
	displayName: string;
	updatedAt: number;
}

export interface WorkChangeRecord {
	id: string;
	repositoryId: string;
	branch: string;
	headOid: string;
	baseBranch: boolean;
	resolutionState: WorkResolutionState;
	pullRequest?: WorkPullRequestRecord;
	checkedAt: number;
	nextRefreshAt: number;
	failureCount: number;
	lastRefreshSucceeded: boolean;
	updatedAt: number;
}

export interface WorkSessionBindingRecord {
	workspaceName: string;
	workspaceGeneration: number;
	sessionId: string;
	bindingGeneration: number;
	repositoryId: string;
	changeId: string;
	observedRepositoryId: string;
	observedBranch: string;
	observedHeadOid: string;
	updatedAt: number;
}

export interface WorkStateFileV1 {
	version: 1;
	repositoryHashSalt: string;
	repositories: WorkRepositoryRecord[];
	changes: WorkChangeRecord[];
	bindings: WorkSessionBindingRecord[];
}

interface WorkStateWireContextBase {
	changeId: string;
	repository: string;
	branch: string;
}

export type WorkStateWireContext =
	| (WorkStateWireContextBase & {
			resolutionState: "resolved";
			pullRequest: {
				provider: string;
				number: number;
				title: string;
				status: WorkPullRequestRecord["status"];
				stale: boolean;
			};
	  })
	| (WorkStateWireContextBase & { resolutionState: "none" | "ambiguous" | "unavailable" });

export interface WorkObservationInput {
	workspaceName: string;
	workspaceGeneration: number;
	sessionId: string;
	commonGitDir: string;
	repositoryDisplayName: string;
	branch: string;
	headOid: string;
	baseBranch: boolean;
	now: number;
}

export type WorkObservationRevisionGuard = () => boolean;

export interface WorkBindingInheritanceInput {
	workspaceName: string;
	workspaceGeneration: number;
	sourceSessionId: string;
	targetSessionId: string;
	now: number;
}

export interface WorkDiscoveryFence {
	workspaceName: string;
	workspaceGeneration: number;
	sessionId: string;
	bindingGeneration: number;
	repositoryId: string;
	changeId: string;
	branch: string;
	headOid: string;
}

export interface WorkBindingMutationResult {
	binding: WorkSessionBindingRecord;
	change: WorkChangeRecord;
	repository: WorkRepositoryRecord;
	fence: WorkDiscoveryFence;
	shouldDiscover: boolean;
}

export type WorkDiscoveryApplyOutcome =
	| { state: "resolved"; pullRequest: WorkPullRequestRecord }
	| { state: "none" }
	| { state: "ambiguous" }
	| { state: "unavailable" };

export interface WorkStateStoreOptions {
	path: string;
	now?: () => number;
	writeStateFile?: (path: string, content: string) => Promise<void>;
}

export interface WorkStateLoadResult {
	state: WorkStateFileV1;
	corruptBackupPath?: string;
}

function emptyWorkState(): WorkStateFileV1 {
	return {
		version: WORK_STATE_VERSION,
		repositoryHashSalt: randomBytes(32).toString("hex"),
		repositories: [],
		changes: [],
		bindings: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value);
}

function safePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePullRequest(value: unknown): WorkPullRequestRecord {
	if (!isRecord(value) || !hasExactKeys(value, ["provider", "number", "title", "status", "matchedHeadOid"])) {
		throw new Error("invalid Work pull request record");
	}
	if (
		!boundedString(value.provider, MAX_PROVIDER_CHARS) ||
		!safePositiveInteger(value.number) ||
		typeof value.title !== "string" ||
		value.title.length > MAX_PR_TITLE_CHARS ||
		(value.status !== "open" && value.status !== "draft" && value.status !== "merged" && value.status !== "closed") ||
		typeof value.matchedHeadOid !== "string" ||
		!OID_PATTERN.test(value.matchedHeadOid)
	) {
		throw new Error("invalid Work pull request record");
	}
	return {
		provider: value.provider,
		number: value.number,
		title: value.title,
		status: value.status,
		matchedHeadOid: value.matchedHeadOid,
	};
}

function parseRepository(value: unknown): WorkRepositoryRecord {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"id",
			"workspaceName",
			"workspaceGeneration",
			"commonGitDirHash",
			"displayName",
			"updatedAt",
		]) ||
		!boundedString(value.id, MAX_ID_CHARS) ||
		!boundedString(value.workspaceName, MAX_WORKSPACE_CHARS) ||
		!safePositiveInteger(value.workspaceGeneration) ||
		typeof value.commonGitDirHash !== "string" ||
		!HASH_PATTERN.test(value.commonGitDirHash) ||
		!boundedString(value.displayName, MAX_REPOSITORY_DISPLAY_CHARS) ||
		!safeNonNegativeInteger(value.updatedAt)
	) {
		throw new Error("invalid Work repository record");
	}
	return { ...value } as unknown as WorkRepositoryRecord;
}

function parseChange(value: unknown): WorkChangeRecord {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			[
				"id",
				"repositoryId",
				"branch",
				"headOid",
				"baseBranch",
				"resolutionState",
				"checkedAt",
				"nextRefreshAt",
				"failureCount",
				"lastRefreshSucceeded",
				"updatedAt",
			],
			["pullRequest"],
		) ||
		!boundedString(value.id, MAX_ID_CHARS) ||
		!boundedString(value.repositoryId, MAX_ID_CHARS) ||
		!boundedString(value.branch, MAX_BRANCH_CHARS) ||
		typeof value.headOid !== "string" ||
		!OID_PATTERN.test(value.headOid) ||
		typeof value.baseBranch !== "boolean" ||
		(value.resolutionState !== "resolved" &&
			value.resolutionState !== "none" &&
			value.resolutionState !== "ambiguous" &&
			value.resolutionState !== "unavailable") ||
		!safeNonNegativeInteger(value.checkedAt) ||
		!safeNonNegativeInteger(value.nextRefreshAt) ||
		!safeNonNegativeInteger(value.failureCount) ||
		typeof value.lastRefreshSucceeded !== "boolean" ||
		!safeNonNegativeInteger(value.updatedAt)
	) {
		throw new Error("invalid Work change record");
	}
	const pullRequest = value.pullRequest === undefined ? undefined : parsePullRequest(value.pullRequest);
	if ((value.resolutionState === "resolved") !== (pullRequest !== undefined)) {
		throw new Error("resolved Work change must have exactly one pull request record");
	}
	return {
		id: value.id,
		repositoryId: value.repositoryId,
		branch: value.branch,
		headOid: value.headOid,
		baseBranch: value.baseBranch,
		resolutionState: value.resolutionState,
		...(pullRequest === undefined ? {} : { pullRequest }),
		checkedAt: value.checkedAt,
		nextRefreshAt: value.nextRefreshAt,
		failureCount: value.failureCount,
		lastRefreshSucceeded: value.lastRefreshSucceeded,
		updatedAt: value.updatedAt,
	};
}

function parseBinding(value: unknown): WorkSessionBindingRecord {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"workspaceName",
			"workspaceGeneration",
			"sessionId",
			"bindingGeneration",
			"repositoryId",
			"changeId",
			"observedRepositoryId",
			"observedBranch",
			"observedHeadOid",
			"updatedAt",
		]) ||
		!boundedString(value.workspaceName, MAX_WORKSPACE_CHARS) ||
		!safePositiveInteger(value.workspaceGeneration) ||
		!boundedString(value.sessionId, MAX_ID_CHARS) ||
		!safePositiveInteger(value.bindingGeneration) ||
		!boundedString(value.repositoryId, MAX_ID_CHARS) ||
		!boundedString(value.changeId, MAX_ID_CHARS) ||
		!boundedString(value.observedRepositoryId, MAX_ID_CHARS) ||
		!boundedString(value.observedBranch, MAX_BRANCH_CHARS) ||
		typeof value.observedHeadOid !== "string" ||
		!OID_PATTERN.test(value.observedHeadOid) ||
		!safeNonNegativeInteger(value.updatedAt)
	) {
		throw new Error("invalid Work session binding record");
	}
	return { ...value } as unknown as WorkSessionBindingRecord;
}

export function parseWorkState(value: unknown): WorkStateFileV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["version", "repositoryHashSalt", "repositories", "changes", "bindings"]) ||
		value.version !== WORK_STATE_VERSION ||
		typeof value.repositoryHashSalt !== "string" ||
		!HASH_PATTERN.test(value.repositoryHashSalt) ||
		!Array.isArray(value.repositories) ||
		value.repositories.length > WORK_STATE_MAX_REPOSITORIES ||
		!Array.isArray(value.changes) ||
		value.changes.length > WORK_STATE_MAX_CHANGES ||
		!Array.isArray(value.bindings) ||
		value.bindings.length > WORK_STATE_MAX_BINDINGS
	) {
		throw new Error("invalid or unsupported Work state file");
	}
	const repositories = value.repositories.map(parseRepository);
	const changes = value.changes.map(parseChange);
	const bindings = value.bindings.map(parseBinding);
	const repositoryIds = new Set(repositories.map((record) => record.id));
	const changeIds = new Set(changes.map((record) => record.id));
	if (repositoryIds.size !== repositories.length || changeIds.size !== changes.length) {
		throw new Error("Work state contains duplicate opaque identities");
	}
	for (const change of changes) {
		if (!repositoryIds.has(change.repositoryId)) throw new Error("Work change references an unknown repository");
	}
	const bindingKeys = new Set<string>();
	for (const binding of bindings) {
		const key = bindingKey(binding.workspaceName, binding.workspaceGeneration, binding.sessionId);
		if (bindingKeys.has(key)) throw new Error("Work state contains duplicate session bindings");
		bindingKeys.add(key);
		if (
			!repositoryIds.has(binding.repositoryId) ||
			!repositoryIds.has(binding.observedRepositoryId) ||
			!changeIds.has(binding.changeId)
		) {
			throw new Error("Work session binding references unknown state");
		}
	}
	return {
		version: WORK_STATE_VERSION,
		repositoryHashSalt: value.repositoryHashSalt,
		repositories,
		changes,
		bindings,
	};
}

function bindingKey(workspaceName: string, workspaceGeneration: number, sessionId: string): string {
	return `${workspaceGeneration}\0${workspaceName}\0${sessionId}`;
}

function cloneRecord<T>(value: T): T {
	return structuredClone(value);
}

function trimState(state: WorkStateFileV1): void {
	state.bindings.sort((left, right) => right.updatedAt - left.updatedAt);
	state.bindings.splice(WORK_STATE_MAX_BINDINGS);
	const boundChangeIds = new Set(state.bindings.map((binding) => binding.changeId));
	state.changes.sort(
		(left, right) =>
			Number(boundChangeIds.has(right.id)) - Number(boundChangeIds.has(left.id)) || right.updatedAt - left.updatedAt,
	);
	state.changes.splice(WORK_STATE_MAX_CHANGES);
	const retainedChanges = new Set(state.changes.map((change) => change.id));
	state.bindings = state.bindings.filter((binding) => retainedChanges.has(binding.changeId));
	const usedRepositoryIds = new Set<string>();
	for (const change of state.changes) usedRepositoryIds.add(change.repositoryId);
	for (const binding of state.bindings) {
		usedRepositoryIds.add(binding.repositoryId);
		usedRepositoryIds.add(binding.observedRepositoryId);
	}
	state.repositories.sort(
		(left, right) =>
			Number(usedRepositoryIds.has(right.id)) - Number(usedRepositoryIds.has(left.id)) ||
			right.updatedAt - left.updatedAt,
	);
	state.repositories.splice(WORK_STATE_MAX_REPOSITORIES);
	const retainedRepositories = new Set(state.repositories.map((repository) => repository.id));
	state.changes = state.changes.filter((change) => retainedRepositories.has(change.repositoryId));
	const finalChanges = new Set(state.changes.map((change) => change.id));
	state.bindings = state.bindings.filter(
		(binding) =>
			retainedRepositories.has(binding.repositoryId) &&
			retainedRepositories.has(binding.observedRepositoryId) &&
			finalChanges.has(binding.changeId),
	);
}

export class WorkStateStore {
	private readonly path: string;
	private readonly now: () => number;
	private readonly writeStateFile: (path: string, content: string) => Promise<void>;
	private current: WorkStateFileV1 | undefined;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(options: WorkStateStoreOptions) {
		this.path = options.path;
		this.now = options.now ?? (() => Date.now());
		this.writeStateFile =
			options.writeStateFile ??
			((path, content) =>
				writeDurableAtomicFile(path, content, {
					directoryMode: PRIVATE_DIRECTORY_MODE,
					fileMode: PRIVATE_FILE_MODE,
				}));
	}

	async load(): Promise<WorkStateLoadResult> {
		if (this.current) return { state: this.current };
		ensurePrivateDirectorySync(dirname(this.path));
		let next: WorkStateFileV1;
		let corruptBackupPath: string | undefined;
		if (existsSync(this.path)) {
			try {
				const handle = await openPrivateRegularFile(this.path, constants.O_RDONLY);
				let content: string;
				try {
					if ((await handle.stat()).size > WORK_STATE_MAX_BYTES) {
						throw new Error("Work state exceeds its size bound");
					}
					content = await handle.readFile({ encoding: "utf8" });
				} finally {
					await handle.close();
				}
				next = parseWorkState(JSON.parse(content) as unknown);
			} catch {
				corruptBackupPath = `${this.path}.corrupt-${this.now()}`;
				await rename(this.path, corruptBackupPath).catch(() => {
					corruptBackupPath = undefined;
				});
				next = emptyWorkState();
				await this.write(next);
			}
		} else {
			next = emptyWorkState();
			await this.write(next);
		}
		this.current = next;
		return { state: next, ...(corruptBackupPath === undefined ? {} : { corruptBackupPath }) };
	}

	get state(): WorkStateFileV1 {
		if (!this.current) throw new Error("Work state store is not loaded");
		return this.current;
	}

	hashCommonGitDirectory(commonGitDir: string): string {
		if (!commonGitDir || commonGitDir.includes("\0")) throw new Error("invalid common Git directory");
		return createHmac("sha256", Buffer.from(this.state.repositoryHashSalt, "hex")).update(commonGitDir).digest("hex");
	}

	async bindObservation(input: WorkObservationInput): Promise<WorkBindingMutationResult>;
	async bindObservation(
		input: WorkObservationInput,
		isCurrentRevision: WorkObservationRevisionGuard,
	): Promise<WorkBindingMutationResult | undefined>;
	async bindObservation(
		input: WorkObservationInput,
		isCurrentRevision: WorkObservationRevisionGuard = () => true,
	): Promise<WorkBindingMutationResult | undefined> {
		if (!isCurrentRevision()) return undefined;
		if (
			!boundedString(input.workspaceName, MAX_WORKSPACE_CHARS) ||
			!safePositiveInteger(input.workspaceGeneration) ||
			!boundedString(input.sessionId, MAX_ID_CHARS) ||
			!boundedString(input.repositoryDisplayName, MAX_REPOSITORY_DISPLAY_CHARS) ||
			!boundedString(input.branch, MAX_BRANCH_CHARS) ||
			!OID_PATTERN.test(input.headOid) ||
			!safeNonNegativeInteger(input.now)
		) {
			throw new Error("invalid Work observation");
		}
		const commonGitDirHash = this.hashCommonGitDirectory(input.commonGitDir);
		return this.mutateGuarded(isCurrentRevision, (state) => {
			let repository = state.repositories.find(
				(candidate) =>
					candidate.workspaceName === input.workspaceName &&
					candidate.workspaceGeneration === input.workspaceGeneration &&
					candidate.commonGitDirHash === commonGitDirHash,
			);
			if (!repository) {
				repository = {
					id: randomUUID(),
					workspaceName: input.workspaceName,
					workspaceGeneration: input.workspaceGeneration,
					commonGitDirHash,
					displayName: input.repositoryDisplayName,
					updatedAt: input.now,
				};
				state.repositories.push(repository);
			} else {
				repository.displayName = input.repositoryDisplayName;
				repository.updatedAt = input.now;
			}

			const key = bindingKey(input.workspaceName, input.workspaceGeneration, input.sessionId);
			let binding = state.bindings.find(
				(candidate) =>
					bindingKey(candidate.workspaceName, candidate.workspaceGeneration, candidate.sessionId) === key,
			);
			let change = binding ? state.changes.find((candidate) => candidate.id === binding!.changeId) : undefined;
			let sticky = change?.resolutionState === "resolved";
			const staysOnChange =
				change !== undefined &&
				binding !== undefined &&
				(sticky || (binding.repositoryId === repository.id && change.branch === input.branch));
			if (!staysOnChange) {
				change = input.baseBranch
					? undefined
					: state.changes.find(
							(candidate) => candidate.repositoryId === repository!.id && candidate.branch === input.branch,
						);
				if (!change) {
					change = {
						id: randomUUID(),
						repositoryId: repository.id,
						branch: input.branch,
						headOid: input.headOid,
						baseBranch: input.baseBranch,
						resolutionState: "unavailable",
						checkedAt: 0,
						nextRefreshAt: 0,
						failureCount: 0,
						lastRefreshSucceeded: false,
						updatedAt: input.now,
					};
					state.changes.push(change);
				}
				sticky = change.resolutionState === "resolved";
			}
			if (!change) throw new Error("Work observation did not resolve a change record");
			if (!sticky || (change.repositoryId === repository.id && change.branch === input.branch)) {
				change.headOid = input.headOid;
			}
			change.updatedAt = input.now;
			const observationChanged =
				!binding ||
				binding.changeId !== change.id ||
				binding.observedRepositoryId !== repository.id ||
				binding.observedBranch !== input.branch ||
				binding.observedHeadOid !== input.headOid;
			if (!binding) {
				binding = {
					workspaceName: input.workspaceName,
					workspaceGeneration: input.workspaceGeneration,
					sessionId: input.sessionId,
					bindingGeneration: 1,
					repositoryId: change.repositoryId,
					changeId: change.id,
					observedRepositoryId: repository.id,
					observedBranch: input.branch,
					observedHeadOid: input.headOid,
					updatedAt: input.now,
				};
				state.bindings.push(binding);
			} else {
				if (observationChanged) {
					if (binding.bindingGeneration === Number.MAX_SAFE_INTEGER) {
						throw new Error("Work binding generation is exhausted");
					}
					binding.bindingGeneration++;
				}
				if (!sticky) {
					binding.repositoryId = change.repositoryId;
					binding.changeId = change.id;
				}
				binding.observedRepositoryId = repository.id;
				binding.observedBranch = input.branch;
				binding.observedHeadOid = input.headOid;
				binding.updatedAt = input.now;
			}
			const shouldDiscover =
				binding.observedRepositoryId === change.repositoryId && binding.observedBranch === change.branch;
			return {
				binding: cloneRecord(binding),
				change: cloneRecord(change),
				repository: cloneRecord(repository),
				fence: {
					workspaceName: binding.workspaceName,
					workspaceGeneration: binding.workspaceGeneration,
					sessionId: binding.sessionId,
					bindingGeneration: binding.bindingGeneration,
					repositoryId: binding.observedRepositoryId,
					changeId: binding.changeId,
					branch: binding.observedBranch,
					headOid: binding.observedHeadOid,
				},
				shouldDiscover,
			};
		});
	}

	async inheritSessionBinding(input: WorkBindingInheritanceInput): Promise<boolean> {
		if (
			!boundedString(input.workspaceName, MAX_WORKSPACE_CHARS) ||
			!safePositiveInteger(input.workspaceGeneration) ||
			!boundedString(input.sourceSessionId, MAX_ID_CHARS) ||
			!boundedString(input.targetSessionId, MAX_ID_CHARS) ||
			input.sourceSessionId === input.targetSessionId ||
			!safeNonNegativeInteger(input.now)
		) {
			throw new Error("invalid Work binding inheritance");
		}
		return this.mutate((state) => {
			const targetKey = bindingKey(input.workspaceName, input.workspaceGeneration, input.targetSessionId);
			if (
				state.bindings.some(
					(candidate) =>
						bindingKey(candidate.workspaceName, candidate.workspaceGeneration, candidate.sessionId) === targetKey,
				)
			) {
				return false;
			}
			const sourceKey = bindingKey(input.workspaceName, input.workspaceGeneration, input.sourceSessionId);
			const source = state.bindings.find(
				(candidate) =>
					bindingKey(candidate.workspaceName, candidate.workspaceGeneration, candidate.sessionId) === sourceKey,
			);
			if (!source) return false;
			state.bindings.push({
				...source,
				sessionId: input.targetSessionId,
				bindingGeneration: 1,
				updatedAt: input.now,
			});
			return true;
		});
	}

	async applyDiscovery(
		fence: WorkDiscoveryFence,
		outcome: WorkDiscoveryApplyOutcome,
		options: { now: number; nextRefreshAt: number; refreshSucceeded: boolean },
	): Promise<boolean> {
		return this.mutate((state) => {
			const binding = state.bindings.find(
				(candidate) =>
					candidate.workspaceName === fence.workspaceName &&
					candidate.workspaceGeneration === fence.workspaceGeneration &&
					candidate.sessionId === fence.sessionId,
			);
			if (
				!binding ||
				binding.bindingGeneration !== fence.bindingGeneration ||
				binding.observedRepositoryId !== fence.repositoryId ||
				binding.changeId !== fence.changeId ||
				binding.observedBranch !== fence.branch ||
				binding.observedHeadOid !== fence.headOid
			) {
				return false;
			}
			const change = state.changes.find((candidate) => candidate.id === fence.changeId);
			if (
				!change ||
				change.repositoryId !== fence.repositoryId ||
				change.branch !== fence.branch ||
				change.headOid !== fence.headOid
			) {
				return false;
			}
			change.checkedAt = options.now;
			change.nextRefreshAt = options.nextRefreshAt;
			change.updatedAt = options.now;
			change.lastRefreshSucceeded = options.refreshSucceeded;
			if (change.resolutionState === "resolved" && change.pullRequest) {
				if (
					outcome.state === "resolved" &&
					outcome.pullRequest.provider === change.pullRequest.provider &&
					outcome.pullRequest.number === change.pullRequest.number
				) {
					change.pullRequest = cloneRecord(outcome.pullRequest);
					change.headOid = fence.headOid;
					change.failureCount = 0;
				} else if (!options.refreshSucceeded) {
					change.failureCount++;
				}
				return true;
			}
			change.failureCount = outcome.state === "unavailable" ? change.failureCount + 1 : 0;
			change.resolutionState = outcome.state;
			if (outcome.state === "resolved") {
				change.pullRequest = cloneRecord(outcome.pullRequest);
				change.headOid = fence.headOid;
			} else {
				delete change.pullRequest;
			}
			return true;
		});
	}

	getBinding(
		workspaceName: string,
		workspaceGeneration: number,
		sessionId: string,
	): WorkSessionBindingRecord | undefined {
		const binding = this.state.bindings.find(
			(candidate) =>
				candidate.workspaceName === workspaceName &&
				candidate.workspaceGeneration === workspaceGeneration &&
				candidate.sessionId === sessionId,
		);
		return binding ? cloneRecord(binding) : undefined;
	}

	getChange(changeId: string): WorkChangeRecord | undefined {
		const change = this.state.changes.find((candidate) => candidate.id === changeId);
		return change ? cloneRecord(change) : undefined;
	}

	getWorkContext(
		workspaceName: string,
		workspaceGeneration: number,
		sessionId: string,
		now: number = this.now(),
	): WorkStateWireContext | undefined {
		const binding = this.state.bindings.find(
			(candidate) =>
				candidate.workspaceName === workspaceName &&
				candidate.workspaceGeneration === workspaceGeneration &&
				candidate.sessionId === sessionId,
		);
		if (!binding) return undefined;
		const change = this.state.changes.find((candidate) => candidate.id === binding.changeId);
		const repository = change
			? this.state.repositories.find((candidate) => candidate.id === change.repositoryId)
			: undefined;
		if (!change || !repository) return undefined;
		const base = {
			changeId: change.id,
			repository: repository.displayName,
			branch: change.branch,
		};
		if (change.resolutionState === "resolved" && change.pullRequest) {
			return {
				...base,
				resolutionState: "resolved",
				pullRequest: {
					provider: change.pullRequest.provider,
					number: change.pullRequest.number,
					title: change.pullRequest.title,
					status: change.pullRequest.status,
					stale: !change.lastRefreshSucceeded || now >= change.nextRefreshAt,
				},
			};
		}
		return { ...base, resolutionState: change.resolutionState as "none" | "ambiguous" | "unavailable" };
	}

	async flush(): Promise<void> {
		await this.mutationQueue;
	}

	async close(): Promise<void> {
		await this.flush();
	}

	private mutate<T>(mutation: (draft: WorkStateFileV1) => T): Promise<T> {
		const operation = this.mutationQueue.then(async () => {
			const draft = cloneRecord(this.state);
			const result = mutation(draft);
			trimState(draft);
			await this.write(draft);
			this.current = draft;
			return result;
		});
		this.mutationQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private mutateGuarded<T>(
		isCurrentRevision: WorkObservationRevisionGuard,
		mutation: (draft: WorkStateFileV1) => T,
	): Promise<T | undefined> {
		if (!isCurrentRevision()) return Promise.resolve(undefined);
		const operation = this.mutationQueue.then(async () => {
			if (!isCurrentRevision()) return undefined;
			const draft = cloneRecord(this.state);
			const result = mutation(draft);
			trimState(draft);
			await this.write(draft);
			this.current = draft;
			return result;
		});
		this.mutationQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async write(state: WorkStateFileV1): Promise<void> {
		const content = `${JSON.stringify(state, null, 2)}\n`;
		if (Buffer.byteLength(content, "utf8") > WORK_STATE_MAX_BYTES) {
			throw new Error("Work state exceeds its size bound");
		}
		await this.writeStateFile(this.path, content);
	}
}
