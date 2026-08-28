import { Buffer } from "node:buffer";
import { minimatch } from "minimatch";
import type { ReviewRunControls } from "./review.ts";
import type { ParsedReview, ReviewFinding, ReviewFindingOutcomeReason, ReviewFindingStatus } from "./review-report.ts";
import type {
	ReviewBranchBase,
	ReviewChangedFile,
	ReviewSnapshot,
	ReviewSnapshotIdentity,
	ReviewSnapshotTreeEntry,
} from "./review-snapshot.ts";
import type { CustomEntry, SessionEntry, SessionManager } from "./session-manager.ts";

export const REVIEW_RUN_CUSTOM_ENTRY_TYPE = "volt.review.run";
export const REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE = "volt.review.acknowledgment";
export const REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE = "volt.review.finding-transition";
export const REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE = "volt.review.publication";
export const REVIEW_STATE_SCHEMA_VERSION = 1;
export const MAX_REVIEW_STATE_RECORD_BYTES = 512 * 1024;
export const MAX_HYDRATED_REVIEW_RUNS = 32;
export const MAX_REVIEW_INVENTORY_FILES = 5_000;
const MAX_REVIEW_INVENTORY_BYTES = 64 * 1024;
const MAX_PERSISTED_COVERAGE_ITEMS = 500;
const MAX_COMPACT_COVERAGE_ITEMS = 10;
const MAX_REVIEW_FOCUS_BYTES = 4_000;
const MAX_REVIEW_SCOPE_PATTERNS = 50;
const MAX_REVIEW_SCOPE_PATTERN_BYTES = 500;

export type ReviewRunStatus = "completed" | "incomplete" | "failed" | "cancelled";

export interface ReviewRunFileIdentity {
	path: string;
	previousPath?: string;
	status?: ReviewChangedFile["status"];
	baseOid?: string;
	baseMode?: string;
	baseType?: ReviewSnapshotTreeEntry["type"];
	headOid?: string;
	headMode?: string;
	headType?: ReviewSnapshotTreeEntry["type"];
	hunkIds: string[];
	reviewable: boolean;
}

export interface ReviewRunContextMetadata {
	captureStatus: "complete" | "incomplete";
	linkedIssueCount: number;
	discussionEntryCount: number;
	renderedLinkedIssueCount: number;
	renderedDiscussionEntryCount: number;
	renderedBytes: number;
	limitationCodes: string[];
	fingerprint: string;
}

export interface ReviewRunRecord {
	schemaVersion: 1;
	runId: string;
	workflowAction: string;
	status: ReviewRunStatus;
	startedAt: number;
	endedAt: number;
	target: {
		description: string;
		diffCommand: string;
		identity: ReviewSnapshotIdentity;
		branchBase?: ReviewBranchBase;
		context?: ReviewRunContextMetadata;
		files: ReviewRunFileIdentity[];
	};
	options: ReviewRunControls;
	result?: ParsedReview;
	errorMessage?: string;
	parentRunId?: string;
	incrementalFallbackReason?: string;
}

export interface HydratedReviewRunRecord extends ReviewRunRecord {
	acknowledgedAt?: number;
}

export interface ReviewAcknowledgmentRecord {
	schemaVersion: 1;
	runId: string;
	acknowledgedAt: number;
}

export interface ReviewFindingTransitionRecord {
	schemaVersion: 1;
	runId: string;
	findingId: string;
	status: ReviewFindingStatus;
	reason?: ReviewFindingOutcomeReason;
	note?: string;
	createdAt: number;
}

export interface ReviewPublicationRecord {
	schemaVersion: 1;
	runId: string;
	reviewId?: number;
	url?: string;
	inlineFindingIds: string[];
	summaryOnlyFindingIds: string[];
	createdAt: number;
}

export interface ReviewRunPage {
	runs: HydratedReviewRunRecord[];
	nextCursor?: string;
}

export interface ReviewIncrementalPlan {
	mode: "incremental" | "full";
	previousRun?: ReviewRunRecord;
	changedPaths: string[];
	priorOpenFindings: ReviewFinding[];
	suppressedDismissedFingerprints: string[];
	fallbackReason?: string;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertRecordSize(value: unknown): void {
	const size = serializedBytes(value);
	if (size > MAX_REVIEW_STATE_RECORD_BYTES) {
		throw new Error(`Review state record is ${size} bytes; the maximum is ${MAX_REVIEW_STATE_RECORD_BYTES}.`);
	}
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const suffix = "…";
	let truncated = Buffer.from(value, "utf8")
		.subarray(0, maximumBytes - Buffer.byteLength(suffix, "utf8"))
		.toString("utf8");
	while (Buffer.byteLength(truncated + suffix, "utf8") > maximumBytes) truncated = truncated.slice(0, -1);
	return truncated + suffix;
}

function boundedStrings(values: readonly string[], maximumBytes: number, maximumItems: number): string[] {
	return values.slice(0, maximumItems).map((value) => truncateUtf8(value, maximumBytes));
}

function boundSnapshotIdentity(identity: ReviewSnapshotIdentity): ReviewSnapshotIdentity {
	return {
		...structuredClone(identity),
		...(identity.pullRequest
			? {
					pullRequest: {
						...identity.pullRequest,
						title: truncateUtf8(identity.pullRequest.title, 1_000),
						body: truncateUtf8(identity.pullRequest.body, 4_000),
						url: truncateUtf8(identity.pullRequest.url, 2_000),
						baseRefName: truncateUtf8(identity.pullRequest.baseRefName, 500),
						headRefName: truncateUtf8(identity.pullRequest.headRefName, 500),
					},
				}
			: {}),
	};
}

export function assertReviewControlsPersistLosslessly(controls: ReviewRunControls): void {
	if (controls.focus && Buffer.byteLength(controls.focus, "utf8") > MAX_REVIEW_FOCUS_BYTES) {
		throw new Error(`Review focus must be at most ${MAX_REVIEW_FOCUS_BYTES} UTF-8 bytes.`);
	}
	if (controls.scope.length > MAX_REVIEW_SCOPE_PATTERNS) {
		throw new Error(`Review scope must contain at most ${MAX_REVIEW_SCOPE_PATTERNS} patterns.`);
	}
	if (controls.scope.some((pattern) => Buffer.byteLength(pattern, "utf8") > MAX_REVIEW_SCOPE_PATTERN_BYTES)) {
		throw new Error(`Each review scope pattern must be at most ${MAX_REVIEW_SCOPE_PATTERN_BYTES} UTF-8 bytes.`);
	}
}

function cloneControls(controls: ReviewRunControls): ReviewRunControls {
	return {
		...(controls.focus === undefined ? {} : { focus: controls.focus }),
		scope: [...controls.scope],
		effort: controls.effort,
		includeOptional: controls.includeOptional,
		scopeMode: controls.scopeMode,
	};
}

/** Bounds an already-declassified public result; private analysis reports must never reach persistence. */
function boundPublicReviewResult(result: ParsedReview, includeEvidence: boolean): ParsedReview {
	const maximumCoverageItems = includeEvidence ? MAX_PERSISTED_COVERAGE_ITEMS : MAX_COMPACT_COVERAGE_ITEMS;
	const coverageWasCompacted = [
		result.coverage.filesInspected.length,
		result.coverage.hunksInspected.length,
		result.coverage.commandsRun.length,
		result.coverage.failedVerificationAttempts.length,
		result.coverage.exclusions.length,
		result.coverage.uncheckedAreas.length,
		result.coverage.residualRisk.length,
		result.coverage.modelReportedLimitations.length,
	].some((length) => length > maximumCoverageItems);
	return {
		...structuredClone(result),
		summary: truncateUtf8(result.summary, 4_000),
		findings: result.findings.map((finding) => ({
			...structuredClone(finding),
			title: truncateUtf8(finding.title, includeEvidence ? 300 : 200),
			body: truncateUtf8(finding.body, includeEvidence ? 2_000 : 1_000),
			trigger: truncateUtf8(finding.trigger, includeEvidence ? 500 : 300),
			impact: truncateUtf8(finding.impact, includeEvidence ? 500 : 300),
			category: truncateUtf8(finding.category, 80),
			rootCauseKey: truncateUtf8(finding.rootCauseKey, includeEvidence ? 160 : 100),
			evidenceLocations: includeEvidence
				? finding.evidenceLocations.slice(0, 4).map((location) => ({ ...location }))
				: [],
			verification: {
				...finding.verification,
				method: truncateUtf8(finding.verification.method, includeEvidence ? 500 : 300),
				rationale: truncateUtf8(finding.verification.rationale, includeEvidence ? 1_000 : 500),
			},
		})),
		coverage: {
			changedFileInventoryComplete: result.coverage.changedFileInventoryComplete,
			...(result.coverage.context
				? {
						context: {
							...result.coverage.context,
							limitationCodes: boundedStrings(result.coverage.context.limitationCodes, 100, 20),
							fingerprint: truncateUtf8(result.coverage.context.fingerprint, 128),
						},
					}
				: {}),
			filesInspected: boundedStrings(result.coverage.filesInspected, 1_000, maximumCoverageItems),
			hunksInspected: boundedStrings(result.coverage.hunksInspected, 500, maximumCoverageItems),
			commandsRun: boundedStrings(result.coverage.commandsRun, 1_000, maximumCoverageItems),
			failedVerificationAttempts: boundedStrings(
				result.coverage.failedVerificationAttempts,
				1_000,
				maximumCoverageItems,
			),
			exclusions: result.coverage.exclusions.slice(0, maximumCoverageItems).map((entry) => ({
				path: truncateUtf8(entry.path, 1_000),
				reason: truncateUtf8(entry.reason, 1_000),
			})),
			uncheckedAreas: boundedStrings(result.coverage.uncheckedAreas, 1_000, maximumCoverageItems),
			residualRisk: [
				...boundedStrings(result.coverage.residualRisk, 1_000, maximumCoverageItems),
				...(coverageWasCompacted ? ["Durable coverage details were compacted to the host persistence bound."] : []),
			],
			modelReportedLimitations: boundedStrings(
				result.coverage.modelReportedLimitations,
				1_000,
				maximumCoverageItems,
			),
		},
		overallExplanation: truncateUtf8(result.overallExplanation, 4_000),
		...(result.verificationChallenge
			? { verificationChallenge: truncateUtf8(result.verificationChallenge, 4_000) }
			: {}),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRun(value: unknown): ReviewRunRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) return undefined;
	if (typeof value.runId !== "string" || typeof value.workflowAction !== "string") return undefined;
	if (
		value.status !== "completed" &&
		value.status !== "incomplete" &&
		value.status !== "failed" &&
		value.status !== "cancelled"
	)
		return undefined;
	if (
		!Number.isFinite(value.startedAt) ||
		!Number.isFinite(value.endedAt) ||
		!isObject(value.target) ||
		!isObject(value.options)
	)
		return undefined;
	if (
		typeof value.target.description !== "string" ||
		typeof value.target.diffCommand !== "string" ||
		!isObject(value.target.identity) ||
		!Array.isArray(value.target.files)
	)
		return undefined;
	return structuredClone(value) as unknown as ReviewRunRecord;
}

function parseAcknowledgment(value: unknown): ReviewAcknowledgmentRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) return undefined;
	if (typeof value.runId !== "string" || !Number.isFinite(value.acknowledgedAt)) return undefined;
	return structuredClone(value) as unknown as ReviewAcknowledgmentRecord;
}

function parseTransition(value: unknown): ReviewFindingTransitionRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) return undefined;
	if (typeof value.runId !== "string" || typeof value.findingId !== "string" || !Number.isFinite(value.createdAt))
		return undefined;
	if (
		value.status !== "open" &&
		value.status !== "accepted" &&
		value.status !== "fixed" &&
		value.status !== "dismissed" &&
		value.status !== "uncertain"
	)
		return undefined;
	return structuredClone(value) as unknown as ReviewFindingTransitionRecord;
}

function branchCustomEntries(sessionManager: SessionManager): CustomEntry[] {
	return sessionManager.getBranch().filter((entry: SessionEntry): entry is CustomEntry => entry.type === "custom");
}

function acknowledgmentMap(entries: readonly CustomEntry[]): Map<string, ReviewAcknowledgmentRecord> {
	const acknowledgments = new Map<string, ReviewAcknowledgmentRecord>();
	for (const entry of entries) {
		if (entry.customType !== REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE) continue;
		const acknowledgment = parseAcknowledgment(entry.data);
		if (acknowledgment) acknowledgments.set(acknowledgment.runId, acknowledgment);
	}
	return acknowledgments;
}

function transitionMap(entries: readonly CustomEntry[]): Map<string, ReviewFindingTransitionRecord> {
	const transitions = new Map<string, ReviewFindingTransitionRecord>();
	for (const entry of entries) {
		if (entry.customType !== REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE) continue;
		const transition = parseTransition(entry.data);
		if (transition) transitions.set(`${transition.runId}\0${transition.findingId}`, transition);
	}
	return transitions;
}

function applyReviewState(
	run: ReviewRunRecord,
	acknowledgments: ReadonlyMap<string, ReviewAcknowledgmentRecord>,
	transitions: ReadonlyMap<string, ReviewFindingTransitionRecord>,
): HydratedReviewRunRecord {
	const result: HydratedReviewRunRecord = structuredClone(run);
	const acknowledgment = acknowledgments.get(run.runId);
	if (acknowledgment) result.acknowledgedAt = acknowledgment.acknowledgedAt;
	for (const finding of result.result?.findings ?? []) {
		const transition = transitions.get(`${run.runId}\0${finding.id}`);
		if (transition) finding.status = transition.status;
	}
	return result;
}

function encodeCursor(endedAt: number, runId: string): string {
	return Buffer.from(JSON.stringify({ endedAt, runId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { endedAt: number; runId: string } {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (!isObject(value) || !Number.isFinite(value.endedAt) || typeof value.runId !== "string") throw new Error();
		return { endedAt: value.endedAt as number, runId: value.runId };
	} catch {
		throw new Error("Review result cursor is invalid.");
	}
}

function compareRuns(left: ReviewRunRecord, right: ReviewRunRecord): number {
	return right.endedAt - left.endedAt || right.runId.localeCompare(left.runId);
}

export function listReviewRuns(
	sessionManager: SessionManager,
	options: { cursor?: string; limit?: number } = {},
): ReviewRunPage {
	const limit = options.limit ?? 10;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
		throw new Error("Review result limit must be between 1 and 50.");
	const entries = branchCustomEntries(sessionManager);
	const acknowledgments = acknowledgmentMap(entries);
	const transitions = transitionMap(entries);
	const byRunId = new Map<string, ReviewRunRecord>();
	for (const entry of entries) {
		if (entry.customType !== REVIEW_RUN_CUSTOM_ENTRY_TYPE) continue;
		const run = parseRun(entry.data);
		if (run) byRunId.set(run.runId, run);
	}
	let runs = [...byRunId.values()].sort(compareRuns).slice(0, MAX_HYDRATED_REVIEW_RUNS);
	if (options.cursor) {
		const cursor = decodeCursor(options.cursor);
		const index = runs.findIndex((run) => run.endedAt === cursor.endedAt && run.runId === cursor.runId);
		if (index < 0) throw new Error("Review result cursor no longer identifies a retained run.");
		runs = runs.slice(index + 1);
	}
	const selected = runs.slice(0, limit).map((run) => applyReviewState(run, acknowledgments, transitions));
	const finalRun = selected.at(-1);
	return {
		runs: selected,
		...(runs.length > selected.length && finalRun
			? { nextCursor: encodeCursor(finalRun.endedAt, finalRun.runId) }
			: {}),
	};
}

export function getReviewRun(sessionManager: SessionManager, runId: string): HydratedReviewRunRecord | undefined {
	let cursor: string | undefined;
	do {
		const page = listReviewRuns(sessionManager, { cursor, limit: 50 });
		const match = page.runs.find((run) => run.runId === runId);
		if (match) return match;
		cursor = page.nextCursor;
	} while (cursor);
	return undefined;
}

export function appendReviewRun(sessionManager: SessionManager, record: ReviewRunRecord): void {
	const persistedRecord = structuredClone(record) as HydratedReviewRunRecord;
	delete persistedRecord.acknowledgedAt;
	assertRecordSize(persistedRecord);
	sessionManager.appendCustomEntry(REVIEW_RUN_CUSTOM_ENTRY_TYPE, persistedRecord);
}

export async function appendReviewRunDurably(sessionManager: SessionManager, record: ReviewRunRecord): Promise<void> {
	appendReviewRun(sessionManager, record);
	await sessionManager.materialize();
}

export function acknowledgeReviewRun(
	sessionManager: SessionManager,
	runId: string,
	acknowledgedAt = Date.now(),
): ReviewAcknowledgmentRecord {
	const run = getReviewRun(sessionManager, runId);
	if (!run) throw new Error(`Unknown durable review run: ${runId}`);
	if (!Number.isFinite(acknowledgedAt)) throw new Error("Review acknowledgment timestamp must be finite.");
	if (run.acknowledgedAt !== undefined) {
		return { schemaVersion: REVIEW_STATE_SCHEMA_VERSION, runId, acknowledgedAt: run.acknowledgedAt };
	}
	const record: ReviewAcknowledgmentRecord = {
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId,
		acknowledgedAt,
	};
	assertRecordSize(record);
	sessionManager.appendCustomEntry(REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE, record);
	return record;
}

export function appendReviewFindingTransition(
	sessionManager: SessionManager,
	transition: Omit<ReviewFindingTransitionRecord, "schemaVersion" | "createdAt"> & { createdAt?: number },
): ReviewFindingTransitionRecord {
	const record: ReviewFindingTransitionRecord = {
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId: transition.runId,
		findingId: transition.findingId,
		status: transition.status,
		...(transition.reason ? { reason: transition.reason } : {}),
		...(transition.note ? { note: transition.note.slice(0, 2_000) } : {}),
		createdAt: transition.createdAt ?? Date.now(),
	};
	assertRecordSize(record);
	sessionManager.appendCustomEntry(REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE, record);
	return record;
}

export function appendReviewPublication(
	sessionManager: SessionManager,
	publication: Omit<ReviewPublicationRecord, "schemaVersion" | "createdAt"> & { createdAt?: number },
): ReviewPublicationRecord {
	const record: ReviewPublicationRecord = {
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId: publication.runId,
		...(publication.reviewId === undefined ? {} : { reviewId: publication.reviewId }),
		...(publication.url === undefined ? {} : { url: publication.url }),
		inlineFindingIds: [...publication.inlineFindingIds],
		summaryOnlyFindingIds: [...publication.summaryOnlyFindingIds],
		createdAt: publication.createdAt ?? Date.now(),
	};
	assertRecordSize(record);
	sessionManager.appendCustomEntry(REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE, record);
	return record;
}

export function snapshotFileIdentities(snapshot: ReviewSnapshot): ReviewRunFileIdentity[] {
	if (snapshot.changedFiles.length > MAX_REVIEW_INVENTORY_FILES) return [];
	const files = snapshot.changedFiles.map((file) => ({
		path: file.path,
		...(file.previousPath ? { previousPath: file.previousPath } : {}),
		status: file.status,
		...(file.base ? { baseOid: file.base.oid, baseMode: file.base.mode, baseType: file.base.type } : {}),
		...(file.head ? { headOid: file.head.oid, headMode: file.head.mode, headType: file.head.type } : {}),
		hunkIds: file.hunks.map((hunk) => hunk.id),
		reviewable: file.reviewable,
	}));
	return serializedBytes(files) <= MAX_REVIEW_INVENTORY_BYTES ? files : [];
}

function snapshotContextMetadata(snapshot: ReviewSnapshot): ReviewRunContextMetadata | undefined {
	const manifest = snapshot.codeHostContext?.manifest;
	if (!manifest) return undefined;
	return {
		captureStatus: manifest.status,
		linkedIssueCount: manifest.linkedIssueCount,
		discussionEntryCount: manifest.discussionEntryCount,
		renderedLinkedIssueCount: manifest.renderedLinkedIssueCount,
		renderedDiscussionEntryCount: manifest.renderedDiscussionEntryCount,
		renderedBytes: manifest.renderedBytes,
		limitationCodes: [...new Set(manifest.limitations.map((limitation) => limitation.code))].sort(),
		fingerprint: manifest.fingerprint,
	};
}

export function createReviewRunRecord(options: {
	workflowId: string;
	workflowAction: string;
	startedAt: number;
	endedAt?: number;
	snapshot: ReviewSnapshot;
	controls: ReviewRunControls;
	status: ReviewRunStatus;
	result?: ParsedReview;
	errorMessage?: string;
	incrementalPlan?: ReviewIncrementalPlan;
}): ReviewRunRecord {
	assertReviewControlsPersistLosslessly(options.controls);
	const createRecord = (includeEvidence: boolean): ReviewRunRecord => ({
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId: options.workflowId,
		workflowAction: options.workflowAction,
		status: options.status,
		startedAt: options.startedAt,
		endedAt: options.endedAt ?? Date.now(),
		target: {
			description: truncateUtf8(options.snapshot.description, 4_000),
			diffCommand: truncateUtf8(options.snapshot.diffCommand, 4_000),
			identity: boundSnapshotIdentity(options.snapshot.identity),
			...(options.snapshot.branchBase ? { branchBase: structuredClone(options.snapshot.branchBase) } : {}),
			...(snapshotContextMetadata(options.snapshot) ? { context: snapshotContextMetadata(options.snapshot) } : {}),
			files: snapshotFileIdentities(options.snapshot),
		},
		options: cloneControls(options.controls),
		...(options.result ? { result: boundPublicReviewResult(options.result, includeEvidence) } : {}),
		...(options.errorMessage ? { errorMessage: truncateUtf8(options.errorMessage, 4_000) } : {}),
		...(options.incrementalPlan?.previousRun ? { parentRunId: options.incrementalPlan.previousRun.runId } : {}),
		...(options.incrementalPlan?.fallbackReason
			? { incrementalFallbackReason: truncateUtf8(options.incrementalPlan.fallbackReason, 4_000) }
			: {}),
	});
	let record = createRecord(true);
	if (serializedBytes(record) > MAX_REVIEW_STATE_RECORD_BYTES) record = createRecord(false);
	assertRecordSize(record);
	return record;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fileIdentityChanged(previous: ReviewRunFileIdentity | undefined, current: ReviewChangedFile): boolean {
	if (!previous) return true;
	return (
		previous.previousPath !== current.previousPath ||
		previous.status !== current.status ||
		previous.baseOid !== current.base?.oid ||
		previous.baseMode !== current.base?.mode ||
		previous.baseType !== current.base?.type ||
		previous.headOid !== current.head?.oid ||
		previous.headMode !== current.head?.mode ||
		previous.headType !== current.head?.type ||
		previous.reviewable !== current.reviewable ||
		!sameStrings(
			previous.hunkIds,
			current.hunks.map((hunk) => hunk.id),
		)
	);
}

function fullReviewPlan(snapshot: ReviewSnapshot, fallbackReason?: string): ReviewIncrementalPlan {
	return {
		mode: "full",
		changedPaths: snapshot.changedFiles.map((file) => file.path),
		priorOpenFindings: [],
		suppressedDismissedFingerprints: [],
		...(fallbackReason ? { fallbackReason } : {}),
	};
}

function controlsCompatible(previous: ReviewRunControls, current: ReviewRunControls): boolean {
	return (
		previous.focus === current.focus &&
		sameStrings(previous.scope, current.scope) &&
		previous.effort === current.effort &&
		previous.includeOptional === current.includeOptional
	);
}

function pathInControlScope(path: string, controls: ReviewRunControls): boolean {
	return (
		controls.scope.length === 0 ||
		controls.scope.some((pattern) => minimatch(path, pattern, { dot: true, matchBase: false }))
	);
}

export function planIncrementalReview(
	sessionManager: SessionManager | undefined,
	snapshot: ReviewSnapshot,
	controls: ReviewRunControls,
	options: { parentRunId?: string } = {},
): ReviewIncrementalPlan {
	if (controls.scopeMode === "full" || !sessionManager) return fullReviewPlan(snapshot);
	const previousRun = options.parentRunId
		? getReviewRun(sessionManager, options.parentRunId)
		: listReviewRuns(sessionManager, { limit: 1 }).runs[0];
	if (!previousRun) {
		return fullReviewPlan(
			snapshot,
			options.parentRunId
				? `The requested parent review does not exist: ${options.parentRunId}.`
				: "No compatible prior completed review exists.",
		);
	}
	if (
		previousRun.status !== "completed" ||
		previousRun.result?.completionStatus !== "complete" ||
		!previousRun.result.coverage.changedFileInventoryComplete
	) {
		return fullReviewPlan(snapshot, "The prior review did not complete with a verified changed-file inventory.");
	}
	if (
		previousRun.target.identity.kind !== snapshot.identity.kind ||
		previousRun.target.identity.baseTree !== snapshot.identity.baseTree
	) {
		return fullReviewPlan(snapshot, "The prior review target or base tree is incompatible.");
	}
	const previousContextFingerprint = previousRun.target.context?.fingerprint;
	const currentContextFingerprint = snapshot.codeHostContext?.manifest.fingerprint;
	if (previousContextFingerprint !== currentContextFingerprint) {
		return fullReviewPlan(snapshot, "The pull request code-host context changed since the prior review.");
	}
	if (!controlsCompatible(previousRun.options, controls)) {
		return fullReviewPlan(snapshot, "The prior review controls are incompatible with this run.");
	}
	if (previousRun.target.files.length === 0 && snapshot.changedFiles.length > 0) {
		return fullReviewPlan(snapshot, "The prior changed-file inventory exceeded its persistence bound.");
	}
	const priorFiles = new Map(previousRun.target.files.map((file) => [file.path, file]));
	const priorRenameAliases = new Map<string, Set<string>>();
	for (const file of previousRun.target.files) {
		if (file.status !== "renamed" || !file.previousPath) continue;
		const sourceAliases = priorRenameAliases.get(file.previousPath);
		if (sourceAliases) sourceAliases.add(file.path);
		else priorRenameAliases.set(file.previousPath, new Set([file.path]));
		const destinationAliases = priorRenameAliases.get(file.path);
		if (destinationAliases) destinationAliases.add(file.previousPath);
		else priorRenameAliases.set(file.path, new Set([file.previousPath]));
	}
	const changedPaths: string[] = [];
	const changedFindingPaths = new Set<string>();
	const inspectedFiles = new Set(previousRun.result.coverage.filesInspected);
	const inspectedHunks = new Set(previousRun.result.coverage.hunksInspected);
	const excludedPaths = new Set(previousRun.result.coverage.exclusions.map((entry) => entry.path));
	const uncoveredUnchangedPaths: string[] = [];
	for (const file of snapshot.changedFiles) {
		const priorFile = priorFiles.get(file.path);
		if (fileIdentityChanged(priorFile, file)) {
			changedPaths.push(file.path);
			const pendingFindingPaths = [
				file.path,
				...(file.status === "renamed" && file.previousPath ? [file.previousPath] : []),
			];
			for (let index = 0; index < pendingFindingPaths.length; index++) {
				const path = pendingFindingPaths[index];
				if (!path || changedFindingPaths.has(path)) continue;
				changedFindingPaths.add(path);
				const aliases = priorRenameAliases.get(path);
				if (aliases) pendingFindingPaths.push(...aliases);
			}
			continue;
		}
		if (!pathInControlScope(file.path, controls)) continue;
		if (
			!file.reviewable ||
			excludedPaths.has(file.path) ||
			!inspectedFiles.has(file.path) ||
			file.hunks.some((hunk) => !inspectedHunks.has(hunk.id))
		) {
			uncoveredUnchangedPaths.push(file.path);
		}
	}
	if (uncoveredUnchangedPaths.length > 0) {
		return fullReviewPlan(
			snapshot,
			`The prior review lacks verified coverage for unchanged paths: ${uncoveredUnchangedPaths.join(", ")}.`,
		);
	}
	const priorOpenFindings = previousRun.result.findings.filter(
		(finding) =>
			finding.status !== "fixed" &&
			finding.status !== "dismissed" &&
			!changedFindingPaths.has(finding.changeLocation.path),
	);
	const suppressedDismissedFingerprints = previousRun.result.findings
		.filter((finding) => finding.status === "dismissed")
		.map((finding) => finding.fingerprint);
	return { mode: "incremental", previousRun, changedPaths, priorOpenFindings, suppressedDismissedFingerprints };
}

export function reconcileFindingIdentities(
	findings: readonly ReviewFinding[],
	plan: ReviewIncrementalPlan | undefined,
): ReviewFinding[] {
	if (!plan?.previousRun?.result) return findings.map((finding) => structuredClone(finding));
	const previousByFingerprint = new Map(
		plan.previousRun.result.findings.map((finding) => [finding.fingerprint, finding]),
	);
	return findings.flatMap((finding) => {
		if (plan.suppressedDismissedFingerprints.includes(finding.fingerprint)) return [];
		const previous = previousByFingerprint.get(finding.fingerprint);
		return [{ ...structuredClone(finding), ...(previous ? { id: previous.id, status: previous.status } : {}) }];
	});
}

export function exportReviewFeedback(sessionManager: SessionManager): {
	schemaVersion: 1;
	exportedAt: string;
	outcomes: ReviewFindingTransitionRecord[];
} {
	const outcomes = branchCustomEntries(sessionManager)
		.filter((entry) => entry.customType === REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE)
		.flatMap((entry) => {
			const transition = parseTransition(entry.data);
			return transition ? [transition] : [];
		});
	return { schemaVersion: REVIEW_STATE_SCHEMA_VERSION, exportedAt: new Date().toISOString(), outcomes };
}
