import { Buffer } from "node:buffer";

export type AgentMode = "build" | "plan";
export type PlanPhase = "draft" | "ready" | "active" | "completed" | "handed_off";
export type PlanStepStatus = "pending" | "in_progress" | "completed";
export type PlanExecutionStrategy = "retain_context" | "new_session";

export interface PlanItem {
	id: string;
	text: string;
	status: PlanStepStatus;
	note?: string;
}

export type PlanSubstep = PlanItem;

export interface PlanStep extends PlanItem {
	/** Optional executable children. Group status is derived from these leaves. */
	substeps?: PlanSubstep[];
}

export interface PlanExecution {
	id: string;
	approvedRevision: number;
	strategy: PlanExecutionStrategy;
	sourceSessionId: string;
	targetSessionId: string;
}

export interface PlanState {
	id: string;
	revision: number;
	phase: PlanPhase;
	title?: string;
	summary?: string;
	steps: PlanStep[];
	execution?: PlanExecution;
}

export interface PlanningState {
	mode: AgentMode;
	plan: PlanState | null;
}

export const DEFAULT_PLANNING_STATE: PlanningState = Object.freeze({ mode: "build", plan: null });
export const PLAN_MAX_SERIALIZED_BYTES = 128 * 1024;
export const RESERVED_PLAN_COMMAND_NAMES: ReadonlySet<string> = new Set(["plan", "build"]);
export const PLAN_CHECKPOINT_CUSTOM_TYPE = "volt-plan-checkpoint";
export const PLAN_EXECUTION_CUSTOM_TYPE = "volt-plan-execution";
export const RESERVED_PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
	"update_plan",
	"submit_plan",
	"update_plan_progress",
	"request_replan",
]);

const AGENT_MODES = new Set<AgentMode>(["build", "plan"]);
const PLAN_PHASES = new Set<PlanPhase>(["draft", "ready", "active", "completed", "handed_off"]);
const PLAN_STEP_STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "completed"]);
const PLAN_EXECUTION_STRATEGIES = new Set<PlanExecutionStrategy>(["retain_context", "new_session"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, options?: { nonempty?: boolean }): string {
	if (typeof value !== "string" || (options?.nonempty && value.trim().length === 0)) {
		throw new Error(`${field} must be ${options?.nonempty ? "a non-empty" : "a"} string`);
	}
	return value;
}

function requireSafeRevision(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new Error(`${field} contains an unsupported field: ${key}`);
		}
	}
}

function parsePlanItem(value: Record<string, unknown>, field: string): PlanItem {
	const status = requireString(value.status, `${field}.status`);
	if (!PLAN_STEP_STATUSES.has(status as PlanStepStatus)) {
		throw new Error(`${field}.status is invalid`);
	}
	return {
		id: requireString(value.id, `${field}.id`, { nonempty: true }),
		text: requireString(value.text, `${field}.text`, { nonempty: true }).trim(),
		status: status as PlanStepStatus,
		...(value.note === undefined
			? {}
			: { note: requireString(value.note, `${field}.note`, { nonempty: true }).trim() }),
	};
}

function parsePlanSubstep(value: unknown, stepIndex: number, substepIndex: number): PlanSubstep {
	const field = `plan.steps[${stepIndex}].substeps[${substepIndex}]`;
	if (!isRecord(value)) {
		throw new Error(`${field} must be an object`);
	}
	assertExactKeys(value, new Set(["id", "text", "status", "note"]), field);
	return parsePlanItem(value, field);
}

export function derivePlanStepStatus(substeps: readonly PlanSubstep[]): PlanStepStatus {
	if (substeps.every((substep) => substep.status === "completed")) return "completed";
	if (substeps.some((substep) => substep.status !== "pending")) return "in_progress";
	return "pending";
}

function parsePlanStep(value: unknown, index: number): PlanStep {
	const field = `plan.steps[${index}]`;
	if (!isRecord(value)) {
		throw new Error(`${field} must be an object`);
	}
	assertExactKeys(value, new Set(["id", "text", "status", "note", "substeps"]), field);
	const item = parsePlanItem(value, field);
	if (value.substeps === undefined) return item;
	if (!Array.isArray(value.substeps) || value.substeps.length === 0) {
		throw new Error(`${field}.substeps must be a non-empty array`);
	}
	if (item.note !== undefined) {
		throw new Error(`${field} cannot have a note when it contains substeps`);
	}
	const substeps = value.substeps.map((substep, substepIndex) => parsePlanSubstep(substep, index, substepIndex));
	const derivedStatus = derivePlanStepStatus(substeps);
	if (item.status !== derivedStatus) {
		throw new Error(`${field}.status must match its derived substep status`);
	}
	return { id: item.id, text: item.text, status: derivedStatus, substeps };
}

function parsePlanExecution(value: unknown): PlanExecution {
	if (!isRecord(value)) {
		throw new Error("plan.execution must be an object");
	}
	assertExactKeys(
		value,
		new Set(["id", "approvedRevision", "strategy", "sourceSessionId", "targetSessionId"]),
		"plan.execution",
	);
	const strategy = requireString(value.strategy, "plan.execution.strategy");
	if (!PLAN_EXECUTION_STRATEGIES.has(strategy as PlanExecutionStrategy)) {
		throw new Error("plan.execution.strategy is invalid");
	}
	return {
		id: requireString(value.id, "plan.execution.id", { nonempty: true }),
		approvedRevision: requireSafeRevision(value.approvedRevision, "plan.execution.approvedRevision"),
		strategy: strategy as PlanExecutionStrategy,
		sourceSessionId: requireString(value.sourceSessionId, "plan.execution.sourceSessionId", { nonempty: true }),
		targetSessionId: requireString(value.targetSessionId, "plan.execution.targetSessionId", { nonempty: true }),
	};
}

function parsePlanState(value: unknown): PlanState {
	if (!isRecord(value)) {
		throw new Error("planning.plan must be an object or null");
	}
	assertExactKeys(
		value,
		new Set(["id", "revision", "phase", "title", "summary", "steps", "execution"]),
		"planning.plan",
	);
	const phase = requireString(value.phase, "planning.plan.phase");
	if (!PLAN_PHASES.has(phase as PlanPhase)) {
		throw new Error("planning.plan.phase is invalid");
	}
	if (!Array.isArray(value.steps)) {
		throw new Error("planning.plan.steps must be an array");
	}
	const steps = value.steps.map(parsePlanStep);
	const itemIds = new Set<string>();
	for (const step of steps) {
		for (const item of [step, ...(step.substeps ?? [])]) {
			if (itemIds.has(item.id)) {
				throw new Error(`Plan item id is duplicated: ${item.id}`);
			}
			itemIds.add(item.id);
		}
	}
	const execution = value.execution === undefined ? undefined : parsePlanExecution(value.execution);
	if ((phase === "active" || phase === "completed" || phase === "handed_off") && !execution) {
		throw new Error(`A ${phase} plan requires execution metadata`);
	}
	if ((phase === "draft" || phase === "ready") && execution) {
		throw new Error(`A ${phase} plan cannot have execution metadata`);
	}
	return {
		id: requireString(value.id, "planning.plan.id", { nonempty: true }),
		revision: requireSafeRevision(value.revision, "planning.plan.revision"),
		phase: phase as PlanPhase,
		...(value.title === undefined
			? {}
			: { title: requireString(value.title, "planning.plan.title", { nonempty: true }).trim() }),
		...(value.summary === undefined
			? {}
			: { summary: requireString(value.summary, "planning.plan.summary", { nonempty: true }).trim() }),
		steps,
		...(execution ? { execution } : {}),
	};
}

export function parsePlanningState(value: unknown): PlanningState {
	if (!isRecord(value)) {
		throw new Error("planning state must be an object");
	}
	assertExactKeys(value, new Set(["mode", "plan"]), "planning state");
	const mode = requireString(value.mode, "planning.mode");
	if (!AGENT_MODES.has(mode as AgentMode)) {
		throw new Error("planning.mode is invalid");
	}
	const parsed: PlanningState = {
		mode: mode as AgentMode,
		plan: value.plan === null ? null : parsePlanState(value.plan),
	};
	assertPlanningStateWithinBounds(parsed);
	return parsed;
}

export function clonePlanStep(step: PlanStep): PlanStep {
	return {
		...step,
		...(step.substeps ? { substeps: step.substeps.map((substep) => ({ ...substep })) } : {}),
	};
}

export function clonePlanState(plan: PlanState): PlanState {
	return {
		...plan,
		steps: plan.steps.map(clonePlanStep),
		...(plan.execution ? { execution: { ...plan.execution } } : {}),
	};
}

export function clonePlanningState(state: PlanningState): PlanningState {
	return { mode: state.mode, plan: state.plan === null ? null : clonePlanState(state.plan) };
}

export function getPlanLeafSteps(plan: Pick<PlanState, "steps">): PlanItem[] {
	return plan.steps.flatMap((step) => step.substeps ?? [step]);
}

export function assertPlanningStateWithinBounds(state: PlanningState): void {
	const serialized = JSON.stringify(state);
	if (Buffer.byteLength(serialized, "utf8") > PLAN_MAX_SERIALIZED_BYTES) {
		throw new Error(`Planning state exceeds the ${PLAN_MAX_SERIALIZED_BYTES}-byte limit`);
	}
}

export class StalePlanRevisionError extends Error {
	readonly code = "stale_plan_revision";

	constructor() {
		super("Plan changed; apply the latest planning state and retry");
		this.name = "StalePlanRevisionError";
	}
}

export function assertPlanRevision(
	state: PlanningState,
	planId: string,
	expectedRevision: number,
): asserts state is PlanningState & { plan: PlanState } {
	if (!state.plan || state.plan.id !== planId || state.plan.revision !== expectedRevision) {
		throw new StalePlanRevisionError();
	}
}

export function formatPlanPolicy(mode: AgentMode, phase?: PlanPhase): string {
	if (mode === "plan") {
		return [
			"[VOLT PLAN MODE — TRUSTED HOST POLICY]",
			"Treat the canonical plan—its title, summary, and checklist—as the complete handoff artifact. It may be executed in a fresh session that receives none of the planning transcript, review output, tool results, or prior discussion.",
			"Research before finalizing, not before drafting. Begin with one targeted read-only orientation pass through the relevant code, configuration, tests, documentation, or history.",
			"After that orientation, create an initial working draft with update_plan; do not wait until research is complete. Keep the draft compact and self-contained, but prioritize decisions over research chronology: name the objective or review target, current behavior that motivates the work, chosen direction, consequential constraints or assumptions, unresolved decisions, and verification intent. Omit facts that do not affect implementation. Replace context-dependent references such as `the review`, `the issues above`, or `as discussed` with the named subject and relevant details.",
			"Write the checklist as coherent, independently verifiable outcomes. Use the fewest items that preserve clear scope and execution detail, and add optional substeps when an outcome contains multiple executable actions. Large tasks may contain as many outcomes and substeps as required; never compress unrelated work to meet an arbitrary count. Keep the hierarchy to outcomes and one level of substeps. Mention files or symbols only when they help disambiguate or locate non-obvious work.",
			"Continue investigating and revise the draft whenever evidence materially changes the context, scope, approach, ordering, or verification. Do not update it mechanically after every read.",
			"Resolve discoverable repository facts with tools before asking the user. Ask only about intent, preferences, or tradeoffs that the workspace cannot answer.",
			"Distinguish evidence from assumptions and evaluate meaningful alternatives. Before submit_plan, optimize the user-facing artifact for scanability: keep the summary brief, retain only decision-driving findings and consequential assumptions, and remove research chronology, exhaustive file or symbol inventories, investigation-only steps, and resolved questions. Record the chosen approach with explicit acceptance and verification criteria. An executor reading only the submitted plan must understand why the work is needed, what must change, and how completion will be verified.",
			"Preserve canonical ids only for unchanged outcomes and substeps. Finish by calling submit_plan. The host-enforced research capability profile permits workspace/network reads, vetted Git/GitHub inspection, and explicitly trusted integration reads. Arbitrary process execution, mutation, untrusted integrations, custom tools, and delegation are blocked.",
		].join("\n");
	}
	if (phase === "active") {
		return [
			"[VOLT APPROVED PLAN — TRUSTED HOST POLICY]",
			"Execute the exact approved checklist. Its title, summary, outcome and substep text, ordering, hierarchy, and scope are immutable during execution.",
			"Use update_plan_progress only to change status or attach concise execution evidence to executable leaf ids. Group status is derived from its substeps.",
			"If implementation evidence requires a structural change, call request_replan with the reason. It pauses execution, returns the plan to draft, and requires fresh user approval.",
		].join("\n");
	}
	return "";
}

export function formatPlanCheckpoint(state: PlanningState): string {
	if (!state.plan) return "";
	const marker = (status: PlanStepStatus): string =>
		status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
	const steps =
		state.plan.steps.length === 0
			? "(No checklist steps yet.)"
			: state.plan.steps
					.flatMap((step, index) => [
						`${index + 1}. ${marker(step.status)} ${step.text}${step.note ? ` — ${step.note}` : ""} (id: ${step.id})`,
						...(step.substeps ?? []).map(
							(substep, substepIndex) =>
								`   ${index + 1}.${substepIndex + 1}. ${marker(substep.status)} ${substep.text}${substep.note ? ` — ${substep.note}` : ""} (id: ${substep.id})`,
						),
					])
					.join("\n");
	return [
		"[VOLT PLAN CHECKPOINT — TRUSTED HOST STATE]",
		`Mode: ${state.mode}`,
		`Plan id: ${state.plan.id}`,
		`Revision: ${state.plan.revision}`,
		`Phase: ${state.plan.phase}`,
		state.plan.title ? `Title: ${state.plan.title}` : "",
		state.plan.summary ? `Summary: ${state.plan.summary}` : "",
		`Checklist:\n${steps}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export function createPlanExecutionPrompt(plan: PlanState): string {
	return [
		`Execute the approved plan${plan.title ? `: ${plan.title}` : "."}`,
		"Work through the immutable checklist, keep executable leaf statuses current with update_plan_progress, and verify the completed result. Group status is derived from its substeps. If the approved scope must change, pause with request_replan instead of rewriting it.",
		formatPlanCheckpoint({ mode: "build", plan }),
	].join("\n\n");
}
