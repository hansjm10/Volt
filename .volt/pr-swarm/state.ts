import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonLock, type DaemonLock } from "../../packages/coding-agent/src/daemon/daemon-lock.ts";
import { writeDurableAtomicFile } from "../../packages/coding-agent/src/utils/durable-atomic-write.ts";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
} from "../../packages/coding-agent/src/utils/private-files.ts";

export const SWARM_STATE_VERSION = 1 as const;

export type JobSourceKind = "thread" | "finding" | "check";
export type JobState =
	| "detected"
	| "planning"
	| "executing"
	| "verifying"
	| "ready_to_integrate"
	| "integrating"
	| "pushed_waiting_ci"
	| "completed"
	| "stale"
	| "failed"
	| "manual";

export type ReviewState = "none" | "running" | "complete" | "failed" | "manual";
export type GenerationPhase = "observing" | "integrating" | "pushed_waiting_ci" | "complete" | "manual" | "dry_run_complete";
export type IntentKind = "publish_review" | "push" | "thread_reply" | "thread_resolve" | "lgtm";
export type IntentStatus = "prepared" | "completed" | "suppressed" | "manual";

export interface ValidationRun {
	command: string;
	code: number | null;
	stdout: string;
	stderr: string;
	completedAt: number;
}

export interface IntegrationMapping {
	jobId: string;
	sourceCommit: string;
	integratedCommit: string;
}

export interface SwarmJob {
	id: string;
	sourceKind: JobSourceKind;
	sourceId: string;
	sourceVersion: string;
	generationSha: string;
	concern: string;
	state: JobState;
	attempts: number;
	attemptKey: string;
	createdAt: number;
	updatedAt: number;
	lastCommentId?: string;
	threadId?: string;
	worktreeId?: string;
	worktreePath?: string;
	worktreeBranch?: string;
	privateRef?: string;
	sessionId?: string;
	verifierSessionId?: string;
	fixCommit?: string;
	verifierRunId?: string;
	integrationCommit?: string;
	validationRuns?: ValidationRun[];
	rejectionEvidence?: string;
	manualReason?: string;
	fixedSourceVersion?: string;
	pushedHead?: string;
}

export interface SwarmReview {
	state: ReviewState;
	sessionId?: string;
	workflowId?: string;
	runId?: string;
	findingIds: string[];
	inlineFindingIds: string[];
	complete: boolean;
	zeroFindings: boolean;
	published: boolean;
	error?: string;
}

export interface SwarmGeneration {
	sha: string;
	headRefName: string;
	baseRefName: string;
	createdAt: number;
	phase: GenerationPhase;
	review: SwarmReview;
	manualBlockers: string[];
	intendedIntegrationHead?: string;
	pushedHead?: string;
	integrationWorktreeId?: string;
	integrationWorktreePath?: string;
	integrationBranch?: string;
	integrationMappings: IntegrationMapping[];
	combinedValidationRuns: ValidationRun[];
}

export interface ExternalIntent {
	id: string;
	kind: IntentKind;
	status: IntentStatus;
	generationSha: string;
	createdAt: number;
	updatedAt: number;
	payload: Record<string, string | number | boolean>;
	error?: string;
}

export interface SwarmState {
	version: typeof SWARM_STATE_VERSION;
	repository: string;
	prNumber: number;
	createdAt: number;
	updatedAt: number;
	currentGenerationSha: string;
	generations: Record<string, SwarmGeneration>;
	jobs: Record<string, SwarmJob>;
	intents: Record<string, ExternalIntent>;
	lgtmShas: string[];
}

export interface StateLock {
	release(): void;
}

export interface StateStore {
	load(): Promise<SwarmState | undefined>;
	save(state: SwarmState): Promise<void>;
	acquire(): Promise<StateLock>;
}

export class FileStateStore implements StateStore {
	readonly statePath: string;
	readonly lockPath: string;

	constructor(
		swarmDir: string,
		repository: string,
		prNumber: number,
	) {
		const [owner, repo] = splitRepository(repository);
		const stem = `${sanitizePathPart(owner)}--${sanitizePathPart(repo)}--pr-${prNumber}`;
		this.statePath = join(swarmDir, `${stem}.json`);
		this.lockPath = join(swarmDir, `${stem}.lock`);
	}

	async load(): Promise<SwarmState | undefined> {
		if (!existsSync(this.statePath)) return undefined;
		const stat = lstatSync(this.statePath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
			throw new Error(`Refusing to load non-private swarm state: ${this.statePath}`);
		}
		hardenPrivateRegularFileSync(this.statePath);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
		} catch (error) {
			throw new Error(`Corrupt swarm state at ${this.statePath}: ${toError(error).message}`);
		}
		try {
			return parseSwarmState(parsed);
		} catch (error) {
			throw new Error(`Invalid swarm state at ${this.statePath}: ${toError(error).message}`);
		}
	}

	async save(state: SwarmState): Promise<void> {
		ensurePrivateDirectorySync(join(this.statePath, ".."));
		await writeDurableAtomicFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
			directoryMode: 0o700,
			fileMode: 0o600,
		});
		chmodSync(this.statePath, 0o600);
	}

	async acquire(): Promise<StateLock> {
		ensurePrivateDirectorySync(join(this.lockPath, ".."));
		const acquired = await acquireDaemonLock(this.lockPath);
		if (!acquired.ok) {
			const owner = acquired.owner ? ` by pid ${acquired.owner.pid}` : "";
			throw new Error(`PR swarm state lock is ${acquired.reason}${owner}`);
		}
		return wrapDaemonLock(acquired.lock);
	}
}

function wrapDaemonLock(lock: DaemonLock): StateLock {
	return { release: () => lock.release() };
}

export function createInitialState(
	repository: string,
	prNumber: number,
	generation: Pick<SwarmGeneration, "sha" | "headRefName" | "baseRefName">,
	now: number,
): SwarmState {
	const firstGeneration = createGeneration(generation.sha, generation.headRefName, generation.baseRefName, now);
	return {
		version: SWARM_STATE_VERSION,
		repository,
		prNumber,
		createdAt: now,
		updatedAt: now,
		currentGenerationSha: generation.sha,
		generations: { [generation.sha]: firstGeneration },
		jobs: {},
		intents: {},
		lgtmShas: [],
	};
}

export function createGeneration(sha: string, headRefName: string, baseRefName: string, now: number): SwarmGeneration {
	return {
		sha,
		headRefName,
		baseRefName,
		createdAt: now,
		phase: "observing",
		review: {
			state: "none",
			findingIds: [],
			inlineFindingIds: [],
			complete: false,
			zeroFindings: false,
			published: false,
		},
		manualBlockers: [],
		integrationMappings: [],
		combinedValidationRuns: [],
	};
}

export function currentGeneration(state: SwarmState): SwarmGeneration {
	const generation = state.generations[state.currentGenerationSha];
	if (!generation) throw new Error(`Current generation is missing: ${state.currentGenerationSha}`);
	return generation;
}

export function createJobId(sourceKind: JobSourceKind, sourceId: string, generationSha: string): string {
	return `${sourceKind}:${sourceId}:${generationSha}`;
}

export function createIntentId(kind: IntentKind, generationSha: string, stableKey: string): string {
	return `${kind}:${generationSha}:${stableKey}`;
}

export function parseSwarmState(value: unknown): SwarmState {
	const record = expectRecord(value, "state");
	expectKeys(record, "state", [
		"version",
		"repository",
		"prNumber",
		"createdAt",
		"updatedAt",
		"currentGenerationSha",
		"generations",
		"jobs",
		"intents",
		"lgtmShas",
	]);
	if (record.version !== SWARM_STATE_VERSION) throw new Error(`state version must be ${SWARM_STATE_VERSION}`);
	const repository = expectString(record.repository, "state.repository");
	splitRepository(repository);
	const prNumber = expectPositiveInteger(record.prNumber, "state.prNumber");
	const generationsRecord = expectRecord(record.generations, "state.generations");
	const generations: Record<string, SwarmGeneration> = {};
	for (const [key, entry] of Object.entries(generationsRecord)) {
		const generation = parseGeneration(entry, `state.generations.${key}`);
		if (generation.sha !== key) throw new Error(`Generation key does not match sha: ${key}`);
		generations[key] = generation;
	}
	const jobsRecord = expectRecord(record.jobs, "state.jobs");
	const jobs: Record<string, SwarmJob> = {};
	for (const [key, entry] of Object.entries(jobsRecord)) {
		const job = parseJob(entry, `state.jobs.${key}`);
		if (job.id !== key) throw new Error(`Job key does not match id: ${key}`);
		jobs[key] = job;
	}
	const intentsRecord = expectRecord(record.intents, "state.intents");
	const intents: Record<string, ExternalIntent> = {};
	for (const [key, entry] of Object.entries(intentsRecord)) {
		const intent = parseIntent(entry, `state.intents.${key}`);
		if (intent.id !== key) throw new Error(`Intent key does not match id: ${key}`);
		intents[key] = intent;
	}
	const currentGenerationSha = expectSha(record.currentGenerationSha, "state.currentGenerationSha");
	if (!generations[currentGenerationSha]) throw new Error("state.currentGenerationSha is not present in generations");
	return {
		version: SWARM_STATE_VERSION,
		repository,
		prNumber,
		createdAt: expectFiniteNumber(record.createdAt, "state.createdAt"),
		updatedAt: expectFiniteNumber(record.updatedAt, "state.updatedAt"),
		currentGenerationSha,
		generations,
		jobs,
		intents,
		lgtmShas: expectStringArray(record.lgtmShas, "state.lgtmShas").map((sha) => expectSha(sha, "lgtm sha")),
	};
}

function parseGeneration(value: unknown, label: string): SwarmGeneration {
	const record = expectRecord(value, label);
	expectKeys(record, label, [
		"sha",
		"headRefName",
		"baseRefName",
		"createdAt",
		"phase",
		"review",
		"manualBlockers",
		"intendedIntegrationHead",
		"pushedHead",
		"integrationWorktreeId",
		"integrationWorktreePath",
		"integrationBranch",
		"integrationMappings",
		"combinedValidationRuns",
	]);
	return {
		sha: expectSha(record.sha, `${label}.sha`),
		headRefName: expectString(record.headRefName, `${label}.headRefName`),
		baseRefName: expectString(record.baseRefName, `${label}.baseRefName`),
		createdAt: expectFiniteNumber(record.createdAt, `${label}.createdAt`),
		phase: expectEnum(record.phase, `${label}.phase`, [
			"observing",
			"integrating",
			"pushed_waiting_ci",
			"complete",
			"manual",
			"dry_run_complete",
		]),
		review: parseReview(record.review, `${label}.review`),
		manualBlockers: expectStringArray(record.manualBlockers, `${label}.manualBlockers`),
		...optionalString(record, "intendedIntegrationHead", label, expectSha),
		...optionalString(record, "pushedHead", label, expectSha),
		...optionalString(record, "integrationWorktreeId", label),
		...optionalString(record, "integrationWorktreePath", label),
		...optionalString(record, "integrationBranch", label),
		integrationMappings: expectArray(record.integrationMappings, `${label}.integrationMappings`).map((entry, index) =>
			parseIntegrationMapping(entry, `${label}.integrationMappings.${index}`),
		),
		combinedValidationRuns: expectArray(record.combinedValidationRuns, `${label}.combinedValidationRuns`).map(
			(entry, index) => parseValidationRun(entry, `${label}.combinedValidationRuns.${index}`),
		),
	};
}

function parseReview(value: unknown, label: string): SwarmReview {
	const record = expectRecord(value, label);
	expectKeys(record, label, [
		"state",
		"sessionId",
		"workflowId",
		"runId",
		"findingIds",
		"inlineFindingIds",
		"complete",
		"zeroFindings",
		"published",
		"error",
	]);
	return {
		state: expectEnum(record.state, `${label}.state`, ["none", "running", "complete", "failed", "manual"]),
		...optionalString(record, "sessionId", label),
		...optionalString(record, "workflowId", label),
		...optionalString(record, "runId", label),
		findingIds: expectStringArray(record.findingIds, `${label}.findingIds`),
		inlineFindingIds: expectStringArray(record.inlineFindingIds, `${label}.inlineFindingIds`),
		complete: expectBoolean(record.complete, `${label}.complete`),
		zeroFindings: expectBoolean(record.zeroFindings, `${label}.zeroFindings`),
		published: expectBoolean(record.published, `${label}.published`),
		...optionalString(record, "error", label),
	};
}

function parseJob(value: unknown, label: string): SwarmJob {
	const record = expectRecord(value, label);
	expectKeys(record, label, [
		"id",
		"sourceKind",
		"sourceId",
		"sourceVersion",
		"generationSha",
		"concern",
		"state",
		"attempts",
		"attemptKey",
		"createdAt",
		"updatedAt",
		"lastCommentId",
		"threadId",
		"worktreeId",
		"worktreePath",
		"worktreeBranch",
		"privateRef",
		"sessionId",
		"verifierSessionId",
		"fixCommit",
		"verifierRunId",
		"integrationCommit",
		"validationRuns",
		"rejectionEvidence",
		"manualReason",
		"fixedSourceVersion",
		"pushedHead",
	]);
	const validationRuns = record.validationRuns;
	return {
		id: expectString(record.id, `${label}.id`),
		sourceKind: expectEnum(record.sourceKind, `${label}.sourceKind`, ["thread", "finding", "check"]),
		sourceId: expectString(record.sourceId, `${label}.sourceId`),
		sourceVersion: expectString(record.sourceVersion, `${label}.sourceVersion`),
		generationSha: expectSha(record.generationSha, `${label}.generationSha`),
		concern: expectString(record.concern, `${label}.concern`),
		state: expectEnum(record.state, `${label}.state`, [
			"detected",
			"planning",
			"executing",
			"verifying",
			"ready_to_integrate",
			"integrating",
			"pushed_waiting_ci",
			"completed",
			"stale",
			"failed",
			"manual",
		]),
		attempts: expectNonNegativeInteger(record.attempts, `${label}.attempts`),
		attemptKey: expectString(record.attemptKey, `${label}.attemptKey`),
		createdAt: expectFiniteNumber(record.createdAt, `${label}.createdAt`),
		updatedAt: expectFiniteNumber(record.updatedAt, `${label}.updatedAt`),
		...optionalString(record, "lastCommentId", label),
		...optionalString(record, "threadId", label),
		...optionalString(record, "worktreeId", label),
		...optionalString(record, "worktreePath", label),
		...optionalString(record, "worktreeBranch", label),
		...optionalString(record, "privateRef", label),
		...optionalString(record, "sessionId", label),
		...optionalString(record, "verifierSessionId", label),
		...optionalString(record, "fixCommit", label, expectSha),
		...optionalString(record, "verifierRunId", label),
		...optionalString(record, "integrationCommit", label, expectSha),
		...(validationRuns === undefined
			? {}
			: {
					validationRuns: expectArray(validationRuns, `${label}.validationRuns`).map((entry, index) =>
						parseValidationRun(entry, `${label}.validationRuns.${index}`),
					),
				}),
		...optionalString(record, "rejectionEvidence", label),
		...optionalString(record, "manualReason", label),
		...optionalString(record, "fixedSourceVersion", label),
		...optionalString(record, "pushedHead", label, expectSha),
	};
}

function parseValidationRun(value: unknown, label: string): ValidationRun {
	const record = expectRecord(value, label);
	expectKeys(record, label, ["command", "code", "stdout", "stderr", "completedAt"]);
	const code = record.code;
	if (code !== null && (!Number.isInteger(code) || typeof code !== "number")) throw new Error(`${label}.code is invalid`);
	return {
		command: expectString(record.command, `${label}.command`),
		code,
		stdout: expectStringValue(record.stdout, `${label}.stdout`),
		stderr: expectStringValue(record.stderr, `${label}.stderr`),
		completedAt: expectFiniteNumber(record.completedAt, `${label}.completedAt`),
	};
}

function parseIntegrationMapping(value: unknown, label: string): IntegrationMapping {
	const record = expectRecord(value, label);
	expectKeys(record, label, ["jobId", "sourceCommit", "integratedCommit"]);
	return {
		jobId: expectString(record.jobId, `${label}.jobId`),
		sourceCommit: expectSha(record.sourceCommit, `${label}.sourceCommit`),
		integratedCommit: expectSha(record.integratedCommit, `${label}.integratedCommit`),
	};
}

function parseIntent(value: unknown, label: string): ExternalIntent {
	const record = expectRecord(value, label);
	expectKeys(record, label, ["id", "kind", "status", "generationSha", "createdAt", "updatedAt", "payload", "error"]);
	const payloadRecord = expectRecord(record.payload, `${label}.payload`);
	const payload: Record<string, string | number | boolean> = {};
	for (const [key, entry] of Object.entries(payloadRecord)) {
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`${label}.payload.${key} must be scalar`);
		}
		payload[key] = entry;
	}
	return {
		id: expectString(record.id, `${label}.id`),
		kind: expectEnum(record.kind, `${label}.kind`, ["publish_review", "push", "thread_reply", "thread_resolve", "lgtm"]),
		status: expectEnum(record.status, `${label}.status`, ["prepared", "completed", "suppressed", "manual"]),
		generationSha: expectSha(record.generationSha, `${label}.generationSha`),
		createdAt: expectFiniteNumber(record.createdAt, `${label}.createdAt`),
		updatedAt: expectFiniteNumber(record.updatedAt, `${label}.updatedAt`),
		payload,
		...optionalString(record, "error", label),
	};
}

function splitRepository(repository: string): [string, string] {
	const parts = repository.split("/");
	if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`Invalid repository name: ${repository}`);
	return [parts[0]!, parts[1]!];
}

function sanitizePathPart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function expectKeys(record: Record<string, unknown>, label: string, allowed: readonly string[]): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(record)) if (!allowedSet.has(key)) throw new Error(`${label} has unknown field ${key}`);
	for (const key of allowed) {
		if (!Object.hasOwn(record, key) && !isOptionalField(key)) throw new Error(`${label} is missing field ${key}`);
	}
}

const OPTIONAL_FIELDS = new Set([
	"intendedIntegrationHead",
	"pushedHead",
	"integrationWorktreeId",
	"integrationWorktreePath",
	"integrationBranch",
	"sessionId",
	"workflowId",
	"runId",
	"error",
	"lastCommentId",
	"threadId",
	"worktreeId",
	"worktreePath",
	"worktreeBranch",
	"privateRef",
	"verifierSessionId",
	"fixCommit",
	"verifierRunId",
	"integrationCommit",
	"validationRuns",
	"rejectionEvidence",
	"manualReason",
	"fixedSourceVersion",
]);

function isOptionalField(field: string): boolean {
	return OPTIONAL_FIELDS.has(field);
}

function optionalString(
	record: Record<string, unknown>,
	field: string,
	label: string,
	validator: (value: unknown, label: string) => string = expectString,
): Record<string, string> {
	if (record[field] === undefined) return {};
	return { [field]: validator(record[field], `${label}.${field}`) };
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function expectStringValue(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function expectSha(value: unknown, label: string): string {
	const sha = expectString(value, label);
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a full lowercase commit SHA`);
	return sha;
}

function expectFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

function expectPositiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
	return value;
}

function expectNonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value;
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
	return value;
}

function expectArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function expectStringArray(value: unknown, label: string): string[] {
	return expectArray(value, label).map((entry, index) => expectString(entry, `${label}.${index}`));
}

function expectEnum<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is invalid`);
	return value as Values[number];
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
