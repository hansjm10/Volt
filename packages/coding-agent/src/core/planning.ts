import { Buffer } from "node:buffer";

export type AgentMode = "build" | "plan";
export type PlanPhase = "draft" | "ready" | "active" | "completed" | "handed_off";
export type PlanStepStatus = "pending" | "in_progress" | "completed";
export type PlanExecutionStrategy = "retain_context" | "new_session";

export interface PlanStep {
	id: string;
	text: string;
	status: PlanStepStatus;
	note?: string;
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
export const PLAN_MAX_STEPS = 64;
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

function parsePlanStep(value: unknown, index: number): PlanStep {
	if (!isRecord(value)) {
		throw new Error(`plan.steps[${index}] must be an object`);
	}
	assertExactKeys(value, new Set(["id", "text", "status", "note"]), `plan.steps[${index}]`);
	const status = requireString(value.status, `plan.steps[${index}].status`);
	if (!PLAN_STEP_STATUSES.has(status as PlanStepStatus)) {
		throw new Error(`plan.steps[${index}].status is invalid`);
	}
	return {
		id: requireString(value.id, `plan.steps[${index}].id`, { nonempty: true }),
		text: requireString(value.text, `plan.steps[${index}].text`, { nonempty: true }).trim(),
		status: status as PlanStepStatus,
		...(value.note === undefined
			? {}
			: { note: requireString(value.note, `plan.steps[${index}].note`, { nonempty: true }).trim() }),
	};
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
	if (value.steps.length > PLAN_MAX_STEPS) {
		throw new Error(`Plans may contain at most ${PLAN_MAX_STEPS} steps`);
	}
	const steps = value.steps.map(parsePlanStep);
	const stepIds = new Set<string>();
	for (const step of steps) {
		if (stepIds.has(step.id)) {
			throw new Error(`Plan step id is duplicated: ${step.id}`);
		}
		stepIds.add(step.id);
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

export function clonePlanningState(state: PlanningState): PlanningState {
	return {
		mode: state.mode,
		plan:
			state.plan === null
				? null
				: {
						...state.plan,
						steps: state.plan.steps.map((step) => ({ ...step })),
						...(state.plan.execution ? { execution: { ...state.plan.execution } } : {}),
					},
	};
}

export function assertPlanningStateWithinBounds(state: PlanningState): void {
	if (state.plan && state.plan.steps.length > PLAN_MAX_STEPS) {
		throw new Error(`Plans may contain at most ${PLAN_MAX_STEPS} steps`);
	}
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
			"Research before finalizing, not before drafting. Begin with one targeted read-only orientation pass through the relevant code, configuration, tests, documentation, or history.",
			"After that orientation, create an initial working draft with update_plan; do not wait until research is complete. Treat its summary as a concise rolling synthesis and its steps as the current candidate implementation path.",
			"Continue investigating and revise the draft whenever evidence materially changes the scope, approach, ordering, or verification. Do not update it mechanically after every read.",
			"Resolve discoverable repository facts with tools before asking the user. Ask only about intent, preferences, or tradeoffs that the workspace cannot answer.",
			"Distinguish evidence from assumptions and evaluate meaningful alternatives. Before submit_plan, remove investigation-only steps, explicitly state remaining assumptions, and make the plan decision-complete with verification criteria; preserve canonical ids only for unchanged steps.",
			"Finish by calling submit_plan. The host-enforced research capability profile permits workspace/network reads, vetted Git/GitHub inspection, and explicitly trusted integration reads. Arbitrary process execution, mutation, untrusted integrations, custom tools, and delegation are blocked.",
		].join("\n");
	}
	if (phase === "active") {
		return [
			"[VOLT APPROVED PLAN — TRUSTED HOST POLICY]",
			"Execute the exact approved checklist. Its title, summary, step text, order, and scope are immutable during execution.",
			"Use update_plan_progress only to change status or attach concise execution evidence to existing step ids.",
			"If implementation evidence requires a structural change, call request_replan with the reason. It pauses execution, returns the plan to draft, and requires fresh user approval.",
		].join("\n");
	}
	return "";
}

export function formatPlanCheckpoint(state: PlanningState): string {
	if (!state.plan) return "";
	const steps =
		state.plan.steps.length === 0
			? "(No checklist steps yet.)"
			: state.plan.steps
					.map((step, index) => {
						const marker = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
						return `${index + 1}. ${marker} ${step.text}${step.note ? ` — ${step.note}` : ""} (id: ${step.id})`;
					})
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
		"Work through the immutable checklist, keep existing step statuses current with update_plan_progress, and verify the completed result. If the approved scope must change, pause with request_replan instead of rewriting it.",
		formatPlanCheckpoint({ mode: "build", plan }),
	].join("\n\n");
}
