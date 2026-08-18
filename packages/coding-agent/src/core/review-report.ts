import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";
import {
	normalizeReviewPath,
	type ReviewChangedFile,
	type ReviewSnapshot,
	type ReviewSnapshotLineRange,
	type ReviewSnapshotRevision,
} from "./review-snapshot.ts";
import type { ReviewObservedCoverage } from "./review-tools.ts";

export type ReviewPriority = 0 | 1 | 2 | 3;
export type ReviewCompletionStatus = "complete" | "incomplete";
export type ReviewOverallCorrectness = "correct" | "incorrect";
export type ReviewFindingStatus = "open" | "accepted" | "fixed" | "dismissed" | "uncertain";
export type ReviewFindingOutcomeReason = "false_positive" | "intentional" | "not_actionable" | "other";

export interface ReviewLocation {
	path: string;
	side: ReviewSnapshotRevision;
	startLine: number;
	endLine: number;
}

export interface ReviewCandidate {
	candidateId: string;
	title: string;
	body: string;
	trigger: string;
	impact: string;
	category: string;
	rootCauseKey: string;
	priority: ReviewPriority;
	confidence: number;
	changeLocation: ReviewLocation;
	evidenceLocations: ReviewLocation[];
}

export interface ReviewCandidateReport {
	summary: string;
	candidates: ReviewCandidate[];
	limitations: string[];
}

export interface ReviewVerificationDecision {
	candidateId: string;
	outcome: "accept" | "reject";
	method: string;
	rationale: string;
	confidence: number;
}

export interface ReviewPriorFindingDecision {
	findingId: string;
	outcome: "open" | "fixed" | "uncertain";
	method: string;
	rationale: string;
	confidence: number;
}

export interface ReviewVerificationReport {
	summary: string;
	assessment: "complete" | "incomplete";
	challenge?: string;
	decisions: ReviewVerificationDecision[];
	priorFindingDecisions: ReviewPriorFindingDecision[];
	limitations: string[];
}

export interface ReviewFindingPresentation {
	presentationId: string;
	title: string;
	body: string;
	trigger: string;
	impact: string;
	category: string;
	rootCauseKey: string;
	rationale: string;
}

export interface ReviewPresentationReport {
	findings: ReviewFindingPresentation[];
}

export interface DeclassifiedReviewFinding {
	presentationId: string;
	id: string;
	fingerprint: string;
	status: ReviewFindingStatus;
	priority: ReviewPriority;
	confidence: number;
	changeLocation: ReviewLocation;
	evidenceLocations: ReviewLocation[];
	hunkIds: string[];
}

export interface ReviewFindingVerification {
	outcome: "accepted";
	method: string;
	rationale: string;
	confidence: number;
}

export interface ReviewFinding {
	id: string;
	fingerprint: string;
	status: ReviewFindingStatus;
	title: string;
	body: string;
	trigger: string;
	impact: string;
	category: string;
	rootCauseKey: string;
	priority: ReviewPriority;
	confidence: number;
	changeLocation: ReviewLocation;
	evidenceLocations: ReviewLocation[];
	verification: ReviewFindingVerification;
}

export interface ReviewContextCoverage {
	captureStatus: "complete" | "incomplete";
	linkedIssueCount: number;
	discussionEntryCount: number;
	limitationCodes: string[];
	fingerprint: string;
	discoveryInspectionComplete: boolean;
	verificationInspectionComplete: boolean;
}

export interface ReviewCoverage {
	changedFileInventoryComplete: boolean;
	context?: ReviewContextCoverage;
	filesInspected: string[];
	hunksInspected: string[];
	commandsRun: string[];
	failedVerificationAttempts: string[];
	exclusions: Array<{ path: string; reason: string }>;
	uncheckedAreas: string[];
	residualRisk: string[];
	modelReportedLimitations: string[];
}

export interface ParsedReview {
	completionStatus: ReviewCompletionStatus;
	summary: string;
	findings: ReviewFinding[];
	coverage: ReviewCoverage;
	overallCorrectness?: ReviewOverallCorrectness;
	overallExplanation: string;
	verificationChallenge?: string;
}

export interface ReviewReportCollector<TReport> {
	readonly tool: ToolDefinition;
	getReport(): TReport | undefined;
	clear(): void;
}

export interface ReviewCandidateValidationOptions {
	includeOptional: boolean;
	inScopeHunkIds: ReadonlySet<string>;
	maximumAnchorLines?: number;
}

export interface ReviewCandidateValidationResult {
	candidates: ValidatedReviewCandidate[];
	errors: string[];
}

export interface ValidatedReviewCandidate extends ReviewCandidate {
	fingerprint: string;
	hunkIds: string[];
}

export interface BuildParsedReviewOptions {
	snapshot: ReviewSnapshot;
	candidateReport: ReviewCandidateReport;
	validatedCandidates: ValidatedReviewCandidate[];
	verificationReport: ReviewVerificationReport;
	declassifiedFindings?: DeclassifiedReviewFinding[];
	presentationReport?: ReviewPresentationReport;
	discoveryCoverage: ReviewObservedCoverage;
	verificationCoverage: ReviewObservedCoverage;
	commandsRun: string[];
	failedVerificationAttempts: string[];
	excludedPaths: Array<{ path: string; reason: string }>;
}

const LocationSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 4_096 }),
		side: Type.Union([Type.Literal("base"), Type.Literal("head")]),
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const CandidateSchema = Type.Object(
	{
		candidateId: Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
		title: Type.String({ minLength: 1, maxLength: 200 }),
		body: Type.String({ minLength: 1, maxLength: 4_000 }),
		trigger: Type.String({ minLength: 1, maxLength: 1_000 }),
		impact: Type.String({ minLength: 1, maxLength: 1_000 }),
		category: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
		rootCauseKey: Type.String({ minLength: 1, maxLength: 160, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
		priority: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		changeLocation: LocationSchema,
		evidenceLocations: Type.Array(LocationSchema, { maxItems: 12 }),
	},
	{ additionalProperties: false },
);

export const ReviewCandidateReportSchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 2_000 }),
		candidates: Type.Array(CandidateSchema, { maxItems: 50 }),
		limitations: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 }),
	},
	{ additionalProperties: false },
);

const VerificationDecisionSchema = Type.Object(
	{
		candidateId: Type.String({ minLength: 1, maxLength: 120 }),
		outcome: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
		method: Type.String({ minLength: 1, maxLength: 1_000 }),
		rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
	},
	{ additionalProperties: false },
);

const PriorFindingDecisionSchema = Type.Object(
	{
		findingId: Type.String({ minLength: 1, maxLength: 120 }),
		outcome: Type.Union([Type.Literal("open"), Type.Literal("fixed"), Type.Literal("uncertain")]),
		method: Type.String({ minLength: 1, maxLength: 1_000 }),
		rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
	},
	{ additionalProperties: false },
);

export const ReviewVerificationReportSchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 2_000 }),
		assessment: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
		challenge: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
		decisions: Type.Array(VerificationDecisionSchema, { maxItems: 50 }),
		priorFindingDecisions: Type.Array(PriorFindingDecisionSchema, { maxItems: 50 }),
		limitations: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 }),
	},
	{ additionalProperties: false },
);

const FindingPresentationSchema = Type.Object(
	{
		presentationId: Type.String({ minLength: 1, maxLength: 120 }),
		title: Type.String({ minLength: 1, maxLength: 200 }),
		body: Type.String({ minLength: 1, maxLength: 4_000 }),
		trigger: Type.String({ minLength: 1, maxLength: 1_000 }),
		impact: Type.String({ minLength: 1, maxLength: 1_000 }),
		category: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
		rootCauseKey: Type.String({ minLength: 1, maxLength: 160, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
		rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
	},
	{ additionalProperties: false },
);

export const ReviewPresentationReportSchema = Type.Object(
	{ findings: Type.Array(FindingPresentationSchema, { maxItems: 50 }) },
	{ additionalProperties: false },
);

export function createReviewCandidateReportCollector(): ReviewReportCollector<ReviewCandidateReport> {
	let report: ReviewCandidateReport | undefined;
	const tool = defineTool({
		name: "report_review_candidates",
		label: "report_review_candidates",
		description:
			"Submit the complete candidate finding report. This terminates the discovery pass. Use an empty candidates array when no substantiated P0-P2 findings remain (P3 only when explicitly enabled).",
		parameters: ReviewCandidateReportSchema,
		async execute(_toolCallId, params) {
			report = structuredClone(params);
			return {
				content: [
					{
						type: "text",
						text: `Candidate report accepted (${params.candidates.length} candidate${params.candidates.length === 1 ? "" : "s"}).`,
					},
				],
				details: params,
				disposition: "stop",
			};
		},
	});
	return {
		tool,
		getReport: () => report,
		clear: () => {
			report = undefined;
		},
	};
}

export function createReviewVerificationReportCollector(): ReviewReportCollector<ReviewVerificationReport> {
	let report: ReviewVerificationReport | undefined;
	const tool = defineTool({
		name: "report_review_verification",
		label: "report_review_verification",
		description:
			"Submit one accept/reject decision for every supplied candidate, one evidence-backed state decision for every prior open finding, and assess completeness. This terminates verification. Do not originate final findings; use assessment=incomplete with a challenge when a credible issue was omitted.",
		parameters: ReviewVerificationReportSchema,
		async execute(_toolCallId, params) {
			report = structuredClone(params);
			return {
				content: [
					{
						type: "text",
						text: `Verification report accepted (${params.decisions.length} decision${params.decisions.length === 1 ? "" : "s"}).`,
					},
				],
				details: params,
				disposition: "stop",
			};
		},
	});
	return {
		tool,
		getReport: () => report,
		clear: () => {
			report = undefined;
		},
	};
}

export function createReviewPresentationReportCollector(): ReviewReportCollector<ReviewPresentationReport> {
	let report: ReviewPresentationReport | undefined;
	const tool = defineTool({
		name: "report_review_presentations",
		label: "report_review_presentations",
		description:
			"Submit code-derived prose for every supplied presentation id. This terminates the context-blind presentation pass.",
		parameters: ReviewPresentationReportSchema,
		async execute(_toolCallId, params) {
			report = structuredClone(params);
			return {
				content: [
					{
						type: "text",
						text: `Presentation report accepted (${params.findings.length} finding${params.findings.length === 1 ? "" : "s"}).`,
					},
				],
				details: params,
				disposition: "stop",
			};
		},
	});
	return {
		tool,
		getReport: () => report,
		clear: () => {
			report = undefined;
		},
	};
}

function rangesOverlap(left: ReviewSnapshotLineRange, right: ReviewSnapshotLineRange): boolean {
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function matchingChangedFile(snapshot: ReviewSnapshot, location: ReviewLocation): ReviewChangedFile | undefined {
	return snapshot.changedFiles.find((file) =>
		location.side === "head" ? file.path === location.path : (file.previousPath ?? file.path) === location.path,
	);
}

function changedRanges(
	file: ReviewChangedFile,
	side: ReviewSnapshotRevision,
): Array<{ hunkId: string; range: ReviewSnapshotLineRange }> {
	return file.hunks.flatMap((hunk) =>
		(side === "head" ? hunk.headChangedLines : hunk.baseChangedLines).map((range) => ({ hunkId: hunk.id, range })),
	);
}

async function validateLocationExists(
	snapshot: ReviewSnapshot,
	location: ReviewLocation,
	label: string,
): Promise<string[]> {
	const errors: string[] = [];
	let path: string;
	try {
		path = normalizeReviewPath(location.path);
	} catch (error) {
		return [`${label}.path: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (path !== location.path) errors.push(`${label}.path must be normalized as ${path}`);
	if (
		!Number.isSafeInteger(location.startLine) ||
		!Number.isSafeInteger(location.endLine) ||
		location.startLine < 1 ||
		location.endLine < location.startLine
	) {
		return [...errors, `${label} must be a positive, non-reversed line range`];
	}
	const file = await snapshot.readFile(location.side, path);
	if (!file) return [...errors, `${label} does not exist in the ${location.side} snapshot: ${path}`];
	if (!file.available) return [...errors, `${label} points to unavailable content: ${path} (${file.message})`];
	if (file.binary) return [...errors, `${label} points to binary content: ${path}`];
	if (location.endLine > (file.lineCount ?? 0)) errors.push(`${label} exceeds ${path}'s ${location.side} line count`);
	return errors;
}

function candidateFingerprint(
	snapshot: ReviewSnapshot,
	candidate: ReviewCandidate,
	file: ReviewChangedFile,
	hunkIds: string[],
): string {
	const sideEntry = candidate.changeLocation.side === "head" ? file.head : file.base;
	return createHash("sha256")
		.update(snapshot.identity.kind)
		.update("\0")
		.update(snapshot.identity.baseTree)
		.update("\0")
		.update(candidate.changeLocation.path)
		.update("\0")
		.update(candidate.changeLocation.side)
		.update("\0")
		.update(candidate.category)
		.update("\0")
		.update(candidate.rootCauseKey)
		.update("\0")
		.update(sideEntry?.oid ?? "absent")
		.update("\0")
		.update(hunkIds.sort().join(","))
		.digest("hex");
}

export async function validateReviewCandidates(
	snapshot: ReviewSnapshot,
	report: ReviewCandidateReport,
	options: ReviewCandidateValidationOptions,
): Promise<ReviewCandidateValidationResult> {
	const errors: string[] = [];
	const candidates: ValidatedReviewCandidate[] = [];
	const candidateIds = new Set<string>();
	const rootCauses = new Set<string>();
	const fingerprints = new Set<string>();
	const maximumAnchorLines = options.maximumAnchorLines ?? 10;
	for (const [index, candidate] of report.candidates.entries()) {
		const label = `candidates[${index}]`;
		if (candidateIds.has(candidate.candidateId)) {
			errors.push(`${label}.candidateId is duplicated: ${candidate.candidateId}`);
			continue;
		}
		candidateIds.add(candidate.candidateId);
		if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
			errors.push(`${label}.confidence must be finite and between 0 and 1`);
		}
		if (![0, 1, 2, 3].includes(candidate.priority) || !Number.isInteger(candidate.priority)) {
			errors.push(`${label}.priority must be an integer from 0 through 3`);
		}
		if (candidate.priority === 3 && !options.includeOptional) errors.push(`${label} uses P3 without includeOptional`);
		errors.push(...(await validateLocationExists(snapshot, candidate.changeLocation, `${label}.changeLocation`)));
		const anchorLength = candidate.changeLocation.endLine - candidate.changeLocation.startLine + 1;
		if (anchorLength > maximumAnchorLines) errors.push(`${label}.changeLocation exceeds ${maximumAnchorLines} lines`);
		const file = matchingChangedFile(snapshot, candidate.changeLocation);
		if (!file) {
			errors.push(`${label}.changeLocation is not a changed path on the selected side`);
			continue;
		}
		const overlapping = changedRanges(file, candidate.changeLocation.side).filter(({ range }) =>
			rangesOverlap(candidate.changeLocation, range),
		);
		if (overlapping.length === 0) {
			errors.push(`${label}.changeLocation does not overlap a changed ${candidate.changeLocation.side} line`);
			continue;
		}
		const inScopeOverlapping = overlapping.filter(({ hunkId }) => options.inScopeHunkIds.has(hunkId));
		if (inScopeOverlapping.length === 0) {
			errors.push(`${label}.changeLocation is outside the effective review scope`);
			continue;
		}
		for (const [evidenceIndex, evidence] of candidate.evidenceLocations.entries()) {
			errors.push(
				...(await validateLocationExists(snapshot, evidence, `${label}.evidenceLocations[${evidenceIndex}]`)),
			);
		}
		const rootCauseIdentity = `${candidate.changeLocation.path}\0${candidate.category}\0${candidate.rootCauseKey}`;
		if (rootCauses.has(rootCauseIdentity)) {
			errors.push(
				`${label} has a duplicate root-cause anchor for ${candidate.rootCauseKey} at ${candidate.changeLocation.path}`,
			);
			continue;
		}
		rootCauses.add(rootCauseIdentity);
		const hunkIds = [...new Set(inScopeOverlapping.map(({ hunkId }) => hunkId))];
		const fingerprint = candidateFingerprint(snapshot, candidate, file, hunkIds);
		if (fingerprints.has(fingerprint)) {
			errors.push(`${label} duplicates finding fingerprint ${fingerprint}`);
			continue;
		}
		fingerprints.add(fingerprint);
		candidates.push({ ...candidate, fingerprint, hunkIds });
	}
	return { candidates, errors };
}

export function validateReviewVerification(
	candidates: readonly ValidatedReviewCandidate[],
	report: ReviewVerificationReport,
	priorFindings: readonly ReviewFinding[] = [],
): string[] {
	const errors: string[] = [];
	const expectedIds = new Set(candidates.map((candidate) => candidate.candidateId));
	const seen = new Set<string>();
	for (const [index, decision] of report.decisions.entries()) {
		if (!expectedIds.has(decision.candidateId))
			errors.push(`decisions[${index}] references unknown candidate ${decision.candidateId}`);
		if (seen.has(decision.candidateId))
			errors.push(`decisions[${index}] duplicates candidate ${decision.candidateId}`);
		seen.add(decision.candidateId);
		if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
			errors.push(`decisions[${index}].confidence must be finite and between 0 and 1`);
		}
	}
	for (const candidateId of expectedIds)
		if (!seen.has(candidateId)) errors.push(`Missing verification decision for ${candidateId}`);
	const expectedPriorIds = new Set(priorFindings.map((finding) => finding.id));
	const seenPrior = new Set<string>();
	for (const [index, decision] of report.priorFindingDecisions.entries()) {
		if (!expectedPriorIds.has(decision.findingId))
			errors.push(`priorFindingDecisions[${index}] references unknown finding ${decision.findingId}`);
		if (seenPrior.has(decision.findingId))
			errors.push(`priorFindingDecisions[${index}] duplicates finding ${decision.findingId}`);
		seenPrior.add(decision.findingId);
		if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
			errors.push(`priorFindingDecisions[${index}].confidence must be finite and between 0 and 1`);
		}
	}
	for (const findingId of expectedPriorIds)
		if (!seenPrior.has(findingId)) errors.push(`Missing prior finding decision for ${findingId}`);
	if (report.assessment === "incomplete" && !report.challenge?.trim())
		errors.push("Incomplete verification requires a challenge");
	if (report.assessment === "complete" && report.challenge !== undefined)
		errors.push("Complete verification must not include a challenge");
	return errors;
}

export function declassifyReviewFindings(
	candidates: readonly ValidatedReviewCandidate[],
	report: ReviewVerificationReport,
): DeclassifiedReviewFinding[] {
	const decisions = new Map(report.decisions.map((decision) => [decision.candidateId, decision]));
	return candidates.flatMap((candidate) => {
		const decision = decisions.get(candidate.candidateId);
		if (!decision || decision.outcome !== "accept") return [];
		return [
			{
				presentationId: randomUUID(),
				id: randomUUID(),
				fingerprint: candidate.fingerprint,
				status: "open" as const,
				priority: candidate.priority,
				confidence: Math.round(Math.min(candidate.confidence, decision.confidence) * 100) / 100,
				changeLocation: structuredClone(candidate.changeLocation),
				evidenceLocations: structuredClone(candidate.evidenceLocations),
				hunkIds: [...candidate.hunkIds],
			},
		];
	});
}

export function validateReviewPresentations(
	findings: readonly DeclassifiedReviewFinding[],
	report: ReviewPresentationReport,
	coverage?: ReviewObservedCoverage,
): string[] {
	const errors: string[] = [];
	const expectedIds = new Set(findings.map((finding) => finding.presentationId));
	const seen = new Set<string>();
	for (const [index, presentation] of report.findings.entries()) {
		if (!expectedIds.has(presentation.presentationId)) {
			errors.push(`findings[${index}] references unknown presentation ${presentation.presentationId}`);
		}
		if (seen.has(presentation.presentationId)) {
			errors.push(`findings[${index}] duplicates presentation ${presentation.presentationId}`);
		}
		seen.add(presentation.presentationId);
	}
	for (const presentationId of expectedIds) {
		if (!seen.has(presentationId)) errors.push(`Missing presentation for ${presentationId}`);
	}
	if (coverage) {
		const inspectedHunks = new Set(coverage.hunksInspected);
		for (const finding of findings) {
			for (const hunkId of finding.hunkIds) {
				if (!inspectedHunks.has(hunkId)) {
					errors.push(`Presentation ${finding.presentationId} did not inspect changed hunk ${hunkId}`);
				}
			}
		}
	}
	return errors;
}

function presentationFromPrivateAnalysis(
	findings: readonly DeclassifiedReviewFinding[],
	candidates: readonly ValidatedReviewCandidate[],
	report: ReviewVerificationReport,
): ReviewPresentationReport {
	const candidatesByFingerprint = new Map(candidates.map((candidate) => [candidate.fingerprint, candidate]));
	const decisions = new Map(report.decisions.map((decision) => [decision.candidateId, decision]));
	return {
		findings: findings.map((finding) => {
			const candidate = candidatesByFingerprint.get(finding.fingerprint);
			const decision = candidate ? decisions.get(candidate.candidateId) : undefined;
			if (!candidate || !decision || decision.outcome !== "accept") {
				throw new Error(`Missing private analysis for presentation ${finding.presentationId}`);
			}
			return {
				presentationId: finding.presentationId,
				title: candidate.title,
				body: candidate.body,
				trigger: candidate.trigger,
				impact: candidate.impact,
				category: candidate.category,
				rootCauseKey: candidate.rootCauseKey,
				rationale: decision.rationale,
			};
		}),
	};
}

function expectedReviewableHunkIds(snapshot: ReviewSnapshot, excludedPaths: ReadonlySet<string>): string[] {
	return snapshot.changedFiles
		.filter((file) => file.reviewable && !excludedPaths.has(file.path))
		.flatMap((file) => file.hunks.map((hunk) => hunk.id))
		.sort();
}

const REVIEW_PRESENTATION_VERIFICATION_METHOD =
	"Independent verification accepted this finding; a separate context-blind pass rendered the code-based rationale.";

export function hostReviewSummary(completionStatus: ReviewCompletionStatus, findingCount: number): string {
	const findings = `${findingCount} verified finding${findingCount === 1 ? "" : "s"}`;
	return completionStatus === "complete"
		? `Review completed with ${findings}.`
		: `Review incomplete with ${findings}.`;
}

export function buildParsedReview(options: BuildParsedReviewOptions): ParsedReview {
	const declassifiedFindings =
		options.declassifiedFindings ?? declassifyReviewFindings(options.validatedCandidates, options.verificationReport);
	const presentationReport =
		options.presentationReport ??
		(options.snapshot.githubContext && declassifiedFindings.length > 0
			? undefined
			: presentationFromPrivateAnalysis(
					declassifiedFindings,
					options.validatedCandidates,
					options.verificationReport,
				));
	if (!presentationReport) throw new Error("PR findings require a context-blind presentation report.");
	const presentationErrors = validateReviewPresentations(declassifiedFindings, presentationReport);
	if (presentationErrors.length > 0)
		throw new Error(`Review presentation is invalid: ${presentationErrors.join("; ")}`);
	const presentations = new Map(
		presentationReport.findings.map((presentation) => [presentation.presentationId, presentation]),
	);
	const findings: ReviewFinding[] = declassifiedFindings.map((finding) => {
		const presentation = presentations.get(finding.presentationId);
		if (!presentation) throw new Error(`Missing presentation for ${finding.presentationId}`);
		return {
			id: finding.id,
			fingerprint: finding.fingerprint,
			status: finding.status,
			title: presentation.title,
			body: presentation.body,
			trigger: presentation.trigger,
			impact: presentation.impact,
			category: presentation.category,
			rootCauseKey: presentation.rootCauseKey,
			priority: finding.priority,
			confidence: finding.confidence,
			changeLocation: structuredClone(finding.changeLocation),
			evidenceLocations: structuredClone(finding.evidenceLocations),
			verification: {
				outcome: "accepted",
				method: REVIEW_PRESENTATION_VERIFICATION_METHOD,
				rationale: presentation.rationale,
				confidence: finding.confidence,
			},
		};
	});
	const excluded = new Set(options.excludedPaths.map((entry) => entry.path));
	const expectedHunks = expectedReviewableHunkIds(options.snapshot, excluded);
	const inspected = new Set(options.verificationCoverage.hunksInspected);
	const uninspectedHunks = expectedHunks.filter((hunkId) => !inspected.has(hunkId));
	const contextCoverage = options.snapshot.githubContext
		? {
				captureStatus: options.snapshot.githubContext.manifest.status,
				linkedIssueCount: options.snapshot.githubContext.manifest.linkedIssueCount,
				discussionEntryCount: options.snapshot.githubContext.manifest.discussionEntryCount,
				limitationCodes: [
					...new Set(options.snapshot.githubContext.manifest.limitations.map((limitation) => limitation.code)),
				].sort(),
				fingerprint: options.snapshot.githubContext.manifest.fingerprint,
				discoveryInspectionComplete: options.discoveryCoverage.contextInspectionComplete,
				verificationInspectionComplete: options.verificationCoverage.contextInspectionComplete,
			}
		: undefined;
	const uncheckedAreas = [
		...options.snapshot.changedFiles.flatMap((file) =>
			file.reviewable || excluded.has(file.path)
				? []
				: [`${file.path}: ${file.unsupportedReason ?? "unsupported change"}`],
		),
		...(options.verificationCoverage.changedFileInventoryComplete
			? []
			: ["Changed-file inventory was not paged to completion."]),
		...(contextCoverage?.captureStatus === "incomplete"
			? ["GitHub pull request context capture was incomplete."]
			: []),
		...(contextCoverage && !contextCoverage.discoveryInspectionComplete
			? ["Discovery did not page GitHub pull request context to completion."]
			: []),
		...(contextCoverage && !contextCoverage.verificationInspectionComplete
			? ["Verification did not page GitHub pull request context to completion."]
			: []),
		...uninspectedHunks.map((hunkId) => `Changed hunk was not fully inspected: ${hunkId}`),
	];
	const completionStatus: ReviewCompletionStatus =
		options.verificationReport.assessment === "complete" && uncheckedAreas.length === 0 ? "complete" : "incomplete";
	const blockingFindings = findings.filter((finding) => finding.priority <= 2);
	const overallCorrectness =
		completionStatus === "complete"
			? blockingFindings.length > 0
				? ("incorrect" as const)
				: ("correct" as const)
			: undefined;
	const protectedContext = contextCoverage !== undefined;
	const challenge = options.verificationReport.challenge
		? protectedContext
			? "Independent verification reported a completeness challenge."
			: options.verificationReport.challenge
		: undefined;
	const residualRisk = [...uncheckedAreas, ...(challenge ? [`Verifier challenge: ${challenge}`] : [])];
	const modelReportedLimitations = protectedContext
		? [
				...(options.candidateReport.limitations.length > 0
					? [`Discovery reported ${options.candidateReport.limitations.length} model limitation(s).`]
					: []),
				...(options.verificationReport.limitations.length > 0
					? [`Verification reported ${options.verificationReport.limitations.length} model limitation(s).`]
					: []),
			]
		: [...options.candidateReport.limitations, ...options.verificationReport.limitations];
	const commandsRun = protectedContext
		? options.commandsRun.length > 0
			? [`${options.commandsRun.length} bash command(s) completed during review.`]
			: []
		: [...options.commandsRun];
	const failedVerificationAttempts = protectedContext
		? options.failedVerificationAttempts.length > 0
			? [`${options.failedVerificationAttempts.length} verification tool attempt(s) failed.`]
			: []
		: [...options.failedVerificationAttempts];
	return {
		completionStatus,
		summary: protectedContext
			? hostReviewSummary(completionStatus, findings.length)
			: [options.candidateReport.summary, options.verificationReport.summary].filter(Boolean).join(" "),
		findings,
		coverage: {
			changedFileInventoryComplete: options.verificationCoverage.changedFileInventoryComplete,
			...(contextCoverage ? { context: contextCoverage } : {}),
			filesInspected: [
				...new Set([...options.verificationCoverage.filesRead, ...options.verificationCoverage.diffFilesFullyRead]),
			].sort(),
			hunksInspected: options.verificationCoverage.hunksInspected,
			commandsRun,
			failedVerificationAttempts,
			exclusions: options.excludedPaths,
			uncheckedAreas,
			residualRisk,
			modelReportedLimitations,
		},
		...(overallCorrectness ? { overallCorrectness } : {}),
		overallExplanation:
			completionStatus === "incomplete"
				? "Review verification is incomplete; no correctness verdict is available."
				: overallCorrectness === "incorrect"
					? `${blockingFindings.length} verified P0-P2 finding${blockingFindings.length === 1 ? " remains" : "s remain"}.`
					: "No verified P0-P2 findings remain.",
		...(challenge ? { verificationChallenge: challenge } : {}),
	};
}
