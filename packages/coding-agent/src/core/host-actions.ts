import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, type Model, supportsFastInference } from "@hansjm10/volt-ai";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { AgentMode, PlanExecutionStrategy, PlanningState } from "./planning.ts";
import type { ReviewRunControls, ReviewTarget, ReviewWorkflowResult } from "./review.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationResponse,
	UiActionSlashAlias,
	UiActionStateDescriptor,
} from "./rpc/types.ts";
import { validateUiActionArgs } from "./rpc/ui-action-args.ts";

type RuntimeNewSession = AgentSessionRuntime["newSession"];
type RuntimeSession = AgentSessionRuntime["session"];

export type HostActionNewSessionOptions = Parameters<RuntimeNewSession>[0];
export type HostActionNewSessionResult = Awaited<ReturnType<RuntimeNewSession>>;
export type HostActionCompactResult = Awaited<ReturnType<RuntimeSession["compact"]>>;

export interface HostActionSessionState {
	/** Falls back to isStreaming for legacy host integrations. */
	isBusy?: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled?: boolean;
	planningState?: PlanningState;
}

export interface HostActionDescriptorContext {
	session: HostActionSessionState;
	/**
	 * True when the host runs review actions detached from the session (RPC
	 * mode): reviews stay available while the session is busy and the invocation
	 * returns an accepted response with a workflowId instead of blocking.
	 */
	detachedReviews?: boolean;
}

export interface HostActionInvocationContext extends HostActionDescriptorContext {
	abortRun(): Promise<void>;
	compactContext(customInstructions?: string): Promise<HostActionCompactResult>;
	newSession(options?: HostActionNewSessionOptions): Promise<HostActionNewSessionResult>;
	afterSessionSwitch?: () => Promise<void>;
	renameSession(name: string): void;
	setFastModeEnabled?(enabled: boolean): void;
	setAgentMode?(mode: AgentMode): Promise<PlanningState>;
	executePlan?(
		planId: string,
		expectedRevision: number,
		strategy: PlanExecutionStrategy,
	): Promise<{ planning: PlanningState; selectedSessionId: string; started: boolean }>;
	changePlan?(planId: string, expectedRevision: number): PlanningState;
	discardPlan?(planId: string, expectedRevision: number): PlanningState;
	runReviewAction?(target: ReviewTarget, options: HostActionReviewOptions): Promise<ReviewWorkflowResult>;
	runReviewLifecycleAction?(action: string, args: Record<string, unknown>): Promise<UiActionInvocationResponse>;
}

export type HostActionAvailability =
	| {
			enabled: true;
			disabledReason?: null;
	  }
	| {
			enabled: false;
			disabledReason: string;
	  };

export interface HostActionDefinition {
	id: string;
	label: string;
	description?: string;
	category: UiActionDescriptor["category"];
	presentation: UiActionDescriptor["presentation"];
	args?: ReadonlyArray<UiActionArgumentDescriptor>;
	destructive?: boolean;
	requiresConfirmation?: boolean;
	streamingBehavior?: UiActionDescriptor["streamingBehavior"];
	remoteSafe: boolean;
	state?: UiActionStateDescriptor | ((context: HostActionDescriptorContext) => UiActionStateDescriptor | undefined);
	slashAliases?: ReadonlyArray<UiActionSlashAlias>;
	slash?: UiActionSlashAlias;
	availability?: (context: HostActionDescriptorContext, args?: unknown) => HostActionAvailability;
	handler: (
		context: HostActionInvocationContext,
		args: unknown,
		options: HostActionInvokeOptions,
	) => Promise<UiActionInvocationResponse>;
}

export interface HostActionInvokeOptions {
	requireRemoteSafe?: boolean;
}

export interface HostActionSlashCommand {
	name: string;
	description: string;
}

export const CONTEXT_COMPACT_ACTION_ID = "context.compact";
export const CONTEXT_COMPACT_SLASH_ALIAS = "compact";
export const REVIEW_BRANCH_ACTION_ID = "review.branch";
export const REVIEW_COMMIT_ACTION_ID = "review.commit";
export const REVIEW_PR_ACTION_ID = "review.pr";
export const REVIEW_UNCOMMITTED_ACTION_ID = "review.uncommitted";
export const REVIEW_FIX_ACTION_ID = "review.fix";
export const REVIEW_FEEDBACK_ACTION_ID = "review.feedback";
export const REVIEW_RERUN_ACTION_ID = "review.rerun";
export const REVIEW_PUBLISH_ACTION_ID = "review.publish";
export const REVIEW_EXPORT_FEEDBACK_ACTION_ID = "review.export_feedback";
export const RUN_CANCEL_ACTION_ID = "run.cancel";
export const SESSION_NEW_ACTION_ID = "session.new";
export const SESSION_NEW_SLASH_ALIAS = "clear";
export const SESSION_RENAME_ACTION_ID = "session.rename";
export const SESSION_RENAME_SLASH_ALIAS = "name";
export const THINKING_FAST_MODE_ACTION_ID = "thinking.fast_mode";
export const THINKING_FAST_MODE_SLASH_ALIAS = "fast";
export const AGENT_MODE_ACTION_ID = "agent.mode";
export const PLAN_EXECUTE_ACTION_ID = "plan.execute";
export const PLAN_CHANGE_ACTION_ID = "plan.change";
export const PLAN_DISCARD_ACTION_ID = "plan.discard";

export interface HostActionReviewOptions {
	remote: boolean;
	requireConfirmation: boolean;
	controls?: Partial<ReviewRunControls>;
	parentRunId?: string;
}

const REVIEW_OPTION_ARGUMENTS: ReadonlyArray<UiActionArgumentDescriptor> = [
	{
		name: "focus",
		label: "Review focus",
		type: "string",
		required: false,
		placeholder: "Security and authorization",
	},
	{
		name: "scope",
		label: "Path scope",
		type: "string",
		required: false,
		placeholder: "src/**/*.ts,test/**/*.ts",
		description: "Comma-separated repository-relative globs.",
	},
	{
		name: "effort",
		label: "Effort",
		type: "enum",
		required: false,
		options: [
			{ value: "low", label: "Low" },
			{ value: "standard", label: "Standard" },
			{ value: "high", label: "High" },
		],
	},
	{ name: "includeOptional", label: "Include optional P3 findings", type: "boolean", required: false },
	{
		name: "scopeMode",
		label: "Review mode",
		type: "enum",
		required: false,
		options: [
			{ value: "incremental", label: "Incremental" },
			{ value: "full", label: "Full" },
		],
	},
];

const REMOTE_SAFE_BUILTIN_HOST_ACTION_IDS = new Set<string>([
	SESSION_NEW_ACTION_ID,
	RUN_CANCEL_ACTION_ID,
	THINKING_FAST_MODE_ACTION_ID,
	AGENT_MODE_ACTION_ID,
	PLAN_EXECUTE_ACTION_ID,
	PLAN_CHANGE_ACTION_ID,
	PLAN_DISCARD_ACTION_ID,
	REVIEW_UNCOMMITTED_ACTION_ID,
	REVIEW_BRANCH_ACTION_ID,
	REVIEW_PR_ACTION_ID,
	REVIEW_COMMIT_ACTION_ID,
	REVIEW_FIX_ACTION_ID,
	REVIEW_FEEDBACK_ACTION_ID,
	REVIEW_RERUN_ACTION_ID,
	REVIEW_PUBLISH_ACTION_ID,
]);

export class HostActionRegistry {
	private readonly actionIds: string[] = [];
	private readonly actions = new Map<string, HostActionDefinition>();
	private readonly slashAliases = new Map<string, string>();

	register(definition: HostActionDefinition): this {
		if (definition.id.length === 0) {
			throw new Error("Host action id must be a non-empty string");
		}
		if (this.actions.has(definition.id)) {
			throw new Error(`Host action already registered: ${definition.id}`);
		}

		for (const alias of definition.slashAliases ?? []) {
			const name = normalizeSlashAlias(alias.name);
			const existingActionId = this.slashAliases.get(name);
			if (existingActionId) {
				throw new Error(`Host action slash alias already registered: ${name}`);
			}
		}

		this.actions.set(definition.id, definition);
		this.actionIds.push(definition.id);
		for (const alias of definition.slashAliases ?? []) {
			this.slashAliases.set(normalizeSlashAlias(alias.name), definition.id);
		}
		return this;
	}

	get(actionId: string): HostActionDefinition | undefined {
		return this.actions.get(actionId);
	}

	resolveSlashAlias(alias: string): HostActionDefinition | undefined {
		const actionId = this.slashAliases.get(normalizeSlashAlias(alias));
		return actionId ? this.actions.get(actionId) : undefined;
	}

	getSlashCommand(alias: string): HostActionSlashCommand | undefined {
		const action = this.resolveSlashAlias(alias);
		if (!action) {
			return undefined;
		}
		const normalizedAlias = normalizeSlashAlias(alias);
		const slashAlias = action.slashAliases?.find(
			(candidate) => normalizeSlashAlias(candidate.name) === normalizedAlias,
		);
		if (!slashAlias) {
			return undefined;
		}
		return {
			name: normalizedAlias,
			description: action.description ?? action.label,
		};
	}

	getSlashCommands(): HostActionSlashCommand[] {
		return this.actionIds.flatMap((actionId) => {
			const action = this.actions.get(actionId);
			if (!action) {
				return [];
			}
			return (action.slashAliases ?? []).map((alias) => ({
				name: normalizeSlashAlias(alias.name),
				description: action.description ?? action.label,
			}));
		});
	}

	getDescriptor(actionId: string, context: HostActionDescriptorContext): UiActionDescriptor | undefined {
		const action = this.actions.get(actionId);
		return action ? createDescriptor(action, context) : undefined;
	}

	getDescriptors(context: HostActionDescriptorContext): UiActionDescriptor[] {
		return this.actionIds.flatMap((actionId) => {
			const action = this.actions.get(actionId);
			return action ? [createDescriptor(action, context)] : [];
		});
	}

	async invoke(
		actionId: string,
		context: HostActionInvocationContext,
		args: unknown,
		options: HostActionInvokeOptions = {},
	): Promise<UiActionInvocationResponse> {
		if (actionId.length === 0) {
			throw new Error("UI action id must be a non-empty string");
		}
		const action = this.actions.get(actionId);
		if (!action) {
			throw new Error(`UI action not available: ${actionId}`);
		}
		if (options.requireRemoteSafe && !action.remoteSafe) {
			throw new Error(`UI action not available over remote host: ${actionId}`);
		}
		const availability = action.availability?.(context, args) ?? { enabled: true };
		if (!availability.enabled) {
			throw new Error(availability.disabledReason ?? `UI action is disabled: ${actionId}`);
		}
		const validatedArgs = validateUiActionArgs(args, action.args ?? []);
		return action.handler(context, validatedArgs, options);
	}

	invokeBySlashAlias(
		alias: string,
		context: HostActionInvocationContext,
		args?: unknown,
		options?: HostActionInvokeOptions,
	): Promise<UiActionInvocationResponse> {
		const action = this.resolveSlashAlias(alias);
		if (!action) {
			throw new Error(`Host action slash alias not available: ${normalizeSlashAlias(alias)}`);
		}
		return this.invoke(action.id, context, args, options);
	}
}

export async function runSessionNewHostAction(
	context: HostActionInvocationContext,
	options?: HostActionNewSessionOptions,
): Promise<HostActionNewSessionResult> {
	const result = await context.newSession(options);
	if (!result.cancelled) {
		await context.afterSessionSwitch?.();
	}
	return result;
}

export async function runCancelHostAction(context: HostActionInvocationContext): Promise<void> {
	await context.abortRun();
}

export async function runContextCompactHostAction(
	context: HostActionInvocationContext,
	customInstructions?: string,
): Promise<HostActionCompactResult> {
	return context.compactContext(customInstructions);
}

export function runSessionRenameHostAction(context: HostActionInvocationContext, name: string): string {
	const trimmedName = name.trim();
	if (!trimmedName) {
		throw new Error("Session name cannot be empty");
	}
	context.renameSession(trimmedName);
	return trimmedName;
}

export async function runReviewHostAction(
	context: HostActionInvocationContext,
	target: ReviewTarget,
	options: HostActionReviewOptions,
): Promise<ReviewWorkflowResult> {
	if (!context.runReviewAction) {
		throw new Error("Review actions are not available in this host");
	}
	return context.runReviewAction(target, options);
}

export function registerBuiltinHostActions(registry: HostActionRegistry): HostActionRegistry {
	registry.register({
		id: AGENT_MODE_ACTION_ID,
		label: "Agent mode",
		description: "Switch between Build and read-only Plan mode",
		category: "session",
		presentation: { kind: "picker", group: "Session", priority: 110 },
		args: [
			{
				name: "mode",
				label: "Mode",
				type: "enum",
				required: true,
				options: [
					{ value: "build", label: "Build" },
					{ value: "plan", label: "Plan" },
				],
			},
		],
		streamingBehavior: "disabled",
		remoteSafe: true,
		state: createAgentModeState,
		availability: () => ({ enabled: true }),
		handler: invokeAgentModeAction,
	});
	registry.register({
		id: PLAN_EXECUTE_ACTION_ID,
		label: "Execute Plan",
		description: "Approve the exact ready plan revision and begin execution",
		category: "session",
		presentation: { kind: "detail", group: "Plan", priority: 100 },
		args: [
			{ name: "planId", label: "Plan ID", type: "string", required: true },
			{ name: "expectedRevision", label: "Revision", type: "integer", required: true },
			{
				name: "strategy",
				label: "Execution context",
				type: "enum",
				required: true,
				options: [
					{ value: "retain_context", label: "Execute Plan" },
					{ value: "new_session", label: "Execute Plan & Clear Context" },
				],
			},
		],
		streamingBehavior: "disabled",
		remoteSafe: true,
		availability: planReadyAvailability,
		handler: invokePlanExecuteAction,
	});
	registry.register({
		id: PLAN_CHANGE_ACTION_ID,
		label: "Change Plan",
		description: "Return the exact ready plan revision to draft",
		category: "session",
		presentation: { kind: "detail", group: "Plan", priority: 90 },
		args: [
			{ name: "planId", label: "Plan ID", type: "string", required: true },
			{ name: "expectedRevision", label: "Revision", type: "integer", required: true },
		],
		streamingBehavior: "disabled",
		remoteSafe: true,
		availability: planReadyAvailability,
		handler: invokePlanChangeAction,
	});
	registry.register({
		id: PLAN_DISCARD_ACTION_ID,
		label: "Discard plan",
		description: "Discard the exact current plan revision",
		category: "session",
		presentation: { kind: "detail", group: "Plan", priority: 80 },
		args: [
			{ name: "planId", label: "Plan ID", type: "string", required: true },
			{ name: "expectedRevision", label: "Revision", type: "integer", required: true },
		],
		destructive: true,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		availability: planPresentAvailability,
		handler: invokePlanDiscardAction,
	});
	registry.register({
		id: SESSION_NEW_ACTION_ID,
		label: "New session",
		description: "Start a new session",
		category: "session",
		presentation: { kind: "palette", group: "Session" },
		args: [],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slashAliases: [
			{
				name: SESSION_NEW_SLASH_ALIAS,
				example: `/${SESSION_NEW_SLASH_ALIAS}`,
			},
		],
		availability: () => ({ enabled: true }),
		handler: invokeSessionNewAction,
	});
	registry.register({
		id: RUN_CANCEL_ACTION_ID,
		label: "Cancel run",
		description: "Abort the current agent operation",
		category: "session",
		presentation: { kind: "button", group: "Session" },
		args: [],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "immediate",
		remoteSafe: true,
		availability: (context) =>
			isHostSessionBusy(context.session) || context.session.isCompacting
				? { enabled: true }
				: { enabled: false, disabledReason: "No active run to cancel" },
		handler: invokeRunCancelAction,
	});
	registry.register({
		id: CONTEXT_COMPACT_ACTION_ID,
		label: "Compact context",
		description: "Summarize the current session context",
		category: "context",
		presentation: { kind: "palette", group: "Context" },
		args: [
			{
				name: "customInstructions",
				label: "Custom instructions",
				type: "string",
				required: false,
				multiline: true,
			},
		],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "disabled",
		remoteSafe: false,
		slashAliases: [
			{
				name: CONTEXT_COMPACT_SLASH_ALIAS,
				example: `/${CONTEXT_COMPACT_SLASH_ALIAS}`,
			},
		],
		availability: (context) =>
			context.session.isCompacting
				? { enabled: false, disabledReason: "Compaction is already running" }
				: { enabled: true },
		handler: invokeContextCompactAction,
	});
	registry.register({
		id: SESSION_RENAME_ACTION_ID,
		label: "Rename session",
		description: "Set the current session display name",
		category: "session",
		presentation: { kind: "palette", group: "Session" },
		args: [
			{
				name: "name",
				label: "Name",
				type: "string",
				required: true,
				placeholder: "Session name",
			},
		],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "immediate",
		remoteSafe: false,
		slashAliases: [
			{
				name: SESSION_RENAME_SLASH_ALIAS,
				example: `/${SESSION_RENAME_SLASH_ALIAS} <name>`,
			},
		],
		availability: () => ({ enabled: true }),
		handler: invokeSessionRenameAction,
	});
	registry.register({
		id: THINKING_FAST_MODE_ACTION_ID,
		label: "Fast mode",
		description: "Request premium low-latency inference capacity for the current session.",
		category: "model",
		presentation: { kind: "toggle", group: "Model", priority: 100 },
		args: [
			{
				name: "enabled",
				label: "Enabled",
				type: "boolean",
				required: true,
			},
		],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slashAliases: [
			{
				name: THINKING_FAST_MODE_SLASH_ALIAS,
				example: `/${THINKING_FAST_MODE_SLASH_ALIAS} [on|off]`,
			},
		],
		state: createThinkingFastModeState,
		availability: thinkingFastModeAvailability,
		handler: invokeThinkingFastModeAction,
	});
	registry.register({
		id: REVIEW_UNCOMMITTED_ACTION_ID,
		label: "Review changes",
		description: "Review uncommitted workspace changes.",
		category: "review",
		presentation: { kind: "card", group: "Review", priority: 100, icon: "magnifyingglass" },
		args: [...REVIEW_OPTION_ARGUMENTS],
		destructive: false,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slash: {
			name: "review",
			example: "/review uncommitted",
		},
		availability: reviewAvailability,
		handler: invokeReviewUncommittedAction,
	});
	registry.register({
		id: REVIEW_BRANCH_ACTION_ID,
		label: "Review branch",
		description: "Review the current branch against its merge base.",
		category: "review",
		presentation: {
			kind: "card",
			group: "Review",
			priority: 90,
			icon: "point.topleft.down.curvedto.point.bottomright.up",
		},
		args: [
			{
				name: "base",
				label: "Base branch",
				type: "string",
				required: false,
				placeholder: "main",
				completion: "gitBranches",
			},
			...REVIEW_OPTION_ARGUMENTS,
		],
		destructive: false,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slash: {
			name: "review",
			example: "/review branch [base]",
		},
		availability: reviewAvailability,
		handler: invokeReviewBranchAction,
	});
	registry.register({
		id: REVIEW_PR_ACTION_ID,
		label: "Review pull request",
		description:
			"Review a GitHub pull request using the host's GitHub credentials and network; its metadata, diff, authoritative linked issues, comments, submitted review summaries, and inline review threads are sent to both review model passes.",
		category: "review",
		presentation: { kind: "card", group: "Review", priority: 80, icon: "arrow.triangle.pull" },
		args: [
			{
				name: "number",
				label: "Pull request number",
				type: "string",
				required: false,
				placeholder: "Current branch",
				description: "Leave empty to review the pull request for the current branch.",
			},
			...REVIEW_OPTION_ARGUMENTS,
		],
		destructive: false,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slash: {
			name: "review",
			example: "/review pr [number]",
		},
		availability: reviewAvailability,
		handler: invokeReviewPullRequestAction,
	});
	registry.register({
		id: REVIEW_COMMIT_ACTION_ID,
		label: "Review commit",
		description: "Review a commit from workspace history; its metadata and diff are sent to the review model.",
		category: "review",
		presentation: { kind: "card", group: "Review", priority: 70, icon: "clock.arrow.circlepath" },
		args: [
			{
				name: "ref",
				label: "Commit ref",
				type: "string",
				required: true,
				placeholder: "HEAD",
				description: "A commit SHA, tag, or revision such as HEAD~1.",
			},
			...REVIEW_OPTION_ARGUMENTS,
		],
		destructive: false,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slash: {
			name: "review",
			example: "/review commit <ref>",
		},
		availability: reviewAvailability,
		handler: invokeReviewCommitAction,
	});
	registry.register({
		id: REVIEW_FIX_ACTION_ID,
		label: "Fix review findings",
		description: "Open a fresh session seeded with selected durable review findings.",
		category: "review",
		presentation: { kind: "detail", group: "Review", priority: 60 },
		args: [
			{ name: "runId", label: "Review run ID", type: "string", required: true },
			{
				name: "findingIds",
				label: "Finding IDs",
				type: "string",
				required: false,
				description: "Comma-separated durable finding IDs; empty selects all.",
			},
		],
		requiresConfirmation: false,
		remoteSafe: true,
		handler: (context, args) => invokeReviewLifecycleAction(context, REVIEW_FIX_ACTION_ID, args),
	});
	registry.register({
		id: REVIEW_FEEDBACK_ACTION_ID,
		label: "Label review finding",
		description: "Record an explicit local outcome for a durable review finding.",
		category: "review",
		presentation: { kind: "detail", group: "Review", priority: 50 },
		args: [
			{ name: "runId", label: "Review run ID", type: "string", required: true },
			{ name: "findingId", label: "Finding ID", type: "string", required: true },
			{
				name: "status",
				label: "Outcome",
				type: "enum",
				required: true,
				options: [
					{ value: "accepted", label: "Accepted" },
					{ value: "fixed", label: "Fixed" },
					{ value: "dismissed", label: "Dismissed" },
				],
			},
			{
				name: "reason",
				label: "Dismissal reason",
				type: "enum",
				required: false,
				options: [
					{ value: "false_positive", label: "False positive" },
					{ value: "intentional", label: "Intentional" },
					{ value: "not_actionable", label: "Not actionable" },
					{ value: "other", label: "Other" },
				],
			},
			{ name: "note", label: "Note", type: "string", required: false },
		],
		requiresConfirmation: false,
		remoteSafe: true,
		handler: (context, args) => invokeReviewLifecycleAction(context, REVIEW_FEEDBACK_ACTION_ID, args),
	});
	registry.register({
		id: REVIEW_RERUN_ACTION_ID,
		label: "Re-run review",
		description: "Run an incremental or full review from a durable prior run.",
		category: "review",
		presentation: { kind: "detail", group: "Review", priority: 40 },
		args: [
			{ name: "runId", label: "Review run ID", type: "string", required: true },
			{
				name: "scopeMode",
				label: "Mode",
				type: "enum",
				required: false,
				options: [
					{ value: "incremental", label: "Incremental" },
					{ value: "full", label: "Full" },
				],
			},
		],
		requiresConfirmation: true,
		remoteSafe: true,
		handler: (context, args) => invokeReviewLifecycleAction(context, REVIEW_RERUN_ACTION_ID, args),
	});
	registry.register({
		id: REVIEW_PUBLISH_ACTION_ID,
		label: "Publish PR review",
		description: "Atomically publish a complete, non-stale pull request review.",
		category: "review",
		presentation: { kind: "detail", group: "Review", priority: 30 },
		args: [{ name: "runId", label: "Review run ID", type: "string", required: true }],
		requiresConfirmation: true,
		remoteSafe: true,
		handler: (context, args) => invokeReviewLifecycleAction(context, REVIEW_PUBLISH_ACTION_ID, args),
	});
	registry.register({
		id: REVIEW_EXPORT_FEEDBACK_ACTION_ID,
		label: "Export review feedback",
		description: "Explicitly export locally recorded review outcomes for evaluation.",
		category: "review",
		presentation: { kind: "detail", group: "Review", priority: 20 },
		args: [{ name: "path", label: "Output path", type: "string", required: false }],
		requiresConfirmation: false,
		remoteSafe: false,
		handler: (context, args) => invokeReviewLifecycleAction(context, REVIEW_EXPORT_FEEDBACK_ACTION_ID, args),
	});
	return registry;
}

export function createBuiltinHostActionRegistry(): HostActionRegistry {
	return registerBuiltinHostActions(new HostActionRegistry());
}

export const BUILTIN_HOST_ACTION_REGISTRY = createBuiltinHostActionRegistry();

export function getBuiltinHostActionSlashCommand(alias: string): HostActionSlashCommand | undefined {
	return BUILTIN_HOST_ACTION_REGISTRY.getSlashCommand(alias);
}

export function isRemoteSafeBuiltinHostActionId(actionId: string): boolean {
	return REMOTE_SAFE_BUILTIN_HOST_ACTION_IDS.has(actionId);
}

async function invokeAgentModeAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const mode = getRequiredStringArg(args, "mode");
	if (mode !== "build" && mode !== "plan") {
		throw new Error('UI action argument "mode" must be "build" or "plan"');
	}
	const setAgentMode = context.setAgentMode;
	if (!setAgentMode) {
		throw new Error("Agent mode is not available in this host");
	}
	const previousMode = context.session.planningState?.mode;
	await setAgentMode(mode);
	return {
		action: AGENT_MODE_ACTION_ID,
		status: "completed",
		state: createAgentModeState(context),
		stateChanged: previousMode !== mode,
		actionsChanged: previousMode !== mode,
		message: mode === "plan" ? "Plan mode enabled" : "Build mode enabled",
	};
}

async function invokePlanExecuteAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const executePlan = context.executePlan;
	if (!executePlan) {
		throw new Error("Plan execution is not available in this host");
	}
	const { planId, expectedRevision, strategy } = getPlanActionArgs(args, true);
	const result = await executePlan(planId, expectedRevision, strategy);
	return {
		action: PLAN_EXECUTE_ACTION_ID,
		status: "completed",
		stateChanged: result.started,
		actionsChanged: result.started,
		message:
			strategy === "new_session"
				? result.started
					? "Plan started in a clear execution session"
					: "Plan was already started in its execution session"
				: result.started
					? "Plan execution started"
					: "Plan execution was already started",
	};
}

function invokePlanChangeAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const changePlan = context.changePlan;
	if (!changePlan) {
		throw new Error("Changing a plan is not available in this host");
	}
	const { planId, expectedRevision } = getPlanActionArgs(args, false);
	changePlan(planId, expectedRevision);
	return Promise.resolve({
		action: PLAN_CHANGE_ACTION_ID,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: "Plan returned to draft",
	});
}

function invokePlanDiscardAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const discardPlan = context.discardPlan;
	if (!discardPlan) {
		throw new Error("Discarding a plan is not available in this host");
	}
	const { planId, expectedRevision } = getPlanActionArgs(args, false);
	discardPlan(planId, expectedRevision);
	return Promise.resolve({
		action: PLAN_DISCARD_ACTION_ID,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: "Plan discarded",
	});
}

async function invokeSessionNewAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	assertNoActionArgs(args);
	const result = await runSessionNewHostAction(context);
	const response: UiActionInvocationResponse = {
		action: SESSION_NEW_ACTION_ID,
		status: result.cancelled ? "cancelled" : "completed",
	};
	if (!result.cancelled) {
		response.stateChanged = true;
		response.actionsChanged = true;
	}
	return response;
}

async function invokeRunCancelAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	assertNoActionArgs(args);
	await runCancelHostAction(context);
	return {
		action: RUN_CANCEL_ACTION_ID,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: "Run cancelled",
	};
}

async function invokeContextCompactAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const customInstructions = getOptionalStringArg(args, "customInstructions");
	await runContextCompactHostAction(context, customInstructions);
	return {
		action: CONTEXT_COMPACT_ACTION_ID,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: "Context compacted",
	};
}

async function invokeSessionRenameAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const name = getRequiredStringArg(args, "name");
	const trimmedName = runSessionRenameHostAction(context, name);
	return {
		action: SESSION_RENAME_ACTION_ID,
		status: "completed",
		stateChanged: true,
		message: `Session name set: ${trimmedName}`,
	};
}

function invokeThinkingFastModeAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	return Promise.resolve(runThinkingFastModeHostAction(context, getRequiredBooleanArg(args, "enabled")));
}

export function runThinkingFastModeHostAction(
	context: HostActionInvocationContext,
	enabled: boolean,
): UiActionInvocationResponse {
	const setFastModeEnabled = context.setFastModeEnabled;
	if (!setFastModeEnabled) {
		throw new Error("Fast mode is not available in this host");
	}

	const wasEnabled = isThinkingFastModeEnabled(context.session);
	setFastModeEnabled(enabled);
	const changed = wasEnabled !== isThinkingFastModeEnabled(context.session);
	return {
		action: THINKING_FAST_MODE_ACTION_ID,
		status: "completed",
		state: createThinkingFastModeState(context),
		stateChanged: changed,
		actionsChanged: changed,
		message: enabled
			? changed
				? "Fast mode enabled. Priority processing may cost more."
				: "Fast mode already enabled. Priority processing may cost more."
			: changed
				? "Fast mode disabled"
				: "Fast mode already disabled",
	};
}

async function invokeReviewLifecycleAction(
	context: HostActionInvocationContext,
	action: string,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	if (!context.runReviewLifecycleAction) throw new Error("Review lifecycle actions are not available in this host");
	return context.runReviewLifecycleAction(action, getArgsRecord(args));
}

async function invokeReviewUncommittedAction(
	context: HostActionInvocationContext,
	args: unknown,
	options: HostActionInvokeOptions,
): Promise<UiActionInvocationResponse> {
	return createReviewInvocationResponse(
		REVIEW_UNCOMMITTED_ACTION_ID,
		await runReviewHostAction(context, { kind: "uncommitted" }, createReviewOptions(options, args)),
	);
}

async function invokeReviewBranchAction(
	context: HostActionInvocationContext,
	args: unknown,
	options: HostActionInvokeOptions,
): Promise<UiActionInvocationResponse> {
	const record = getArgsRecord(args);
	const base = typeof record.base === "string" ? record.base.trim() || undefined : undefined;
	return createReviewInvocationResponse(
		REVIEW_BRANCH_ACTION_ID,
		await runReviewHostAction(context, { kind: "branch", base }, createReviewOptions(options, args)),
	);
}

async function invokeReviewPullRequestAction(
	context: HostActionInvocationContext,
	args: unknown,
	options: HostActionInvokeOptions,
): Promise<UiActionInvocationResponse> {
	const record = getArgsRecord(args);
	const number = typeof record.number === "string" ? record.number.trim() || undefined : undefined;
	return createReviewInvocationResponse(
		REVIEW_PR_ACTION_ID,
		await runReviewHostAction(context, { kind: "pr", number }, createReviewOptions(options, args)),
	);
}

async function invokeReviewCommitAction(
	context: HostActionInvocationContext,
	args: unknown,
	options: HostActionInvokeOptions,
): Promise<UiActionInvocationResponse> {
	const record = getArgsRecord(args);
	const ref = typeof record.ref === "string" ? record.ref : "";
	if (!ref) throw new Error('UI action argument "ref" must be a non-empty string');
	return createReviewInvocationResponse(
		REVIEW_COMMIT_ACTION_ID,
		await runReviewHostAction(context, { kind: "commit", sha: ref }, createReviewOptions(options, args)),
	);
}

function reviewAvailability(context: HostActionDescriptorContext): HostActionAvailability {
	if (context.detachedReviews) {
		// Detached reviews run in an isolated session and never touch the
		// current conversation, so session busy states do not gate them.
		return { enabled: true };
	}
	if (context.session.isStreaming) {
		return { enabled: false, disabledReason: "Review is not available while the agent is streaming" };
	}
	if (isHostSessionBusy(context.session)) {
		return { enabled: false, disabledReason: "Review is not available while an agent operation is running" };
	}
	if (context.session.isCompacting) {
		return { enabled: false, disabledReason: "Review is not available while compaction is running" };
	}
	return { enabled: true };
}

function thinkingFastModeAvailability(context: HostActionDescriptorContext, args?: unknown): HostActionAvailability {
	if (context.session.isStreaming) {
		return { enabled: false, disabledReason: "Fast mode is not available while the agent is streaming" };
	}
	if (isHostSessionBusy(context.session)) {
		return { enabled: false, disabledReason: "Fast mode is not available while an agent operation is running" };
	}
	if (context.session.isCompacting) {
		return { enabled: false, disabledReason: "Fast mode is not available while compaction is running" };
	}
	const requestedEnabled = getOptionalBooleanArg(args, "enabled");
	if (isThinkingFastModeEnabled(context.session) || requestedEnabled === false) {
		return { enabled: true };
	}
	if (!context.session.model || !supportsFastInference(context.session.model)) {
		return {
			enabled: false,
			disabledReason: "Fast mode is not supported for the current provider and model",
		};
	}
	return { enabled: true };
}

function createReviewOptions(options: HostActionInvokeOptions, args: unknown): HostActionReviewOptions {
	const record = getArgsRecord(args);
	const focus = typeof record.focus === "string" ? record.focus : undefined;
	const scope = typeof record.scope === "string" ? record.scope : undefined;
	const effort = record.effort;
	const scopeMode = record.scopeMode;
	return {
		remote: options.requireRemoteSafe === true,
		requireConfirmation: options.requireRemoteSafe === true,
		controls: {
			...(focus ? { focus } : {}),
			...(scope
				? {
						scope: scope
							.split(",")
							.map((entry) => entry.trim())
							.filter(Boolean),
					}
				: {}),
			...(effort === "low" || effort === "standard" || effort === "high" ? { effort } : {}),
			...(typeof record.includeOptional === "boolean" ? { includeOptional: record.includeOptional } : {}),
			...(scopeMode === "incremental" || scopeMode === "full" ? { scopeMode } : {}),
		},
	};
}

function createReviewInvocationResponse(action: string, result: ReviewWorkflowResult): UiActionInvocationResponse {
	if (result.status === "accepted") {
		return {
			action,
			status: "accepted",
			workflowId: result.workflowId,
			actionsChanged: true,
			message: result.message ?? "Review started",
		};
	}
	if (result.status === "cancelled") {
		return {
			action,
			status: "cancelled",
			actionsChanged: true,
			message: "Review cancelled",
		};
	}
	const findingCount = result.findingsCount;
	const summary =
		result.completionStatus === "incomplete"
			? `Review incomplete${findingCount ? `: ${findingCount} verified finding${findingCount === 1 ? "" : "s"}` : ""}`
			: findingCount === undefined
				? "Review complete"
				: findingCount === 0
					? "Review complete: no issues found"
					: `Review complete: ${findingCount} finding${findingCount === 1 ? "" : "s"}`;
	return {
		action,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: result.sessionSwitchCancelled
			? `${summary}; findings added to the current session`
			: `${summary}; fresh session created with findings`,
	};
}

function createDescriptor(action: HostActionDefinition, context: HostActionDescriptorContext): UiActionDescriptor {
	const availability = action.availability?.(context) ?? { enabled: true };
	const state = typeof action.state === "function" ? action.state(context) : action.state;
	const descriptor: UiActionDescriptor = {
		schemaVersion: 1,
		id: action.id,
		label: action.label,
		description: action.description,
		source: "builtin",
		sourceLabel: "Built in",
		category: action.category,
		presentation: action.presentation,
		args: [...(action.args ?? [])],
		enabled: availability.enabled,
		disabledReason: availability.enabled ? null : availability.disabledReason,
		destructive: action.destructive ?? false,
		requiresConfirmation: action.requiresConfirmation ?? false,
		streamingBehavior: action.streamingBehavior ?? "disabled",
		remoteSafe: action.remoteSafe,
		slash: action.slashAliases?.[0] ?? action.slash,
	};
	if (state) {
		descriptor.state = state;
	}
	return descriptor;
}

function createThinkingFastModeState(context: HostActionDescriptorContext): UiActionStateDescriptor {
	const enabled = isThinkingFastModeEnabled(context.session);
	return {
		type: "boolean",
		value: enabled,
		label: enabled ? "Fast mode enabled" : "Fast mode disabled",
	};
}

function createAgentModeState(context: HostActionDescriptorContext): UiActionStateDescriptor {
	const mode = context.session.planningState?.mode ?? "build";
	return {
		type: "enum",
		value: mode,
		label: mode === "plan" ? "Plan" : "Build",
		options: [
			{ value: "build", label: "Build" },
			{ value: "plan", label: "Plan" },
		],
	};
}

function planReadyAvailability(context: HostActionDescriptorContext): HostActionAvailability {
	return context.session.planningState?.plan?.phase === "ready"
		? { enabled: true }
		: { enabled: false, disabledReason: "No plan is ready for approval" };
}

function planPresentAvailability(context: HostActionDescriptorContext): HostActionAvailability {
	return context.session.planningState?.plan
		? { enabled: true }
		: { enabled: false, disabledReason: "No plan is available" };
}

function isHostSessionBusy(session: HostActionSessionState): boolean {
	return session.isBusy ?? session.isStreaming;
}

function isThinkingFastModeEnabled(session: HostActionSessionState): boolean {
	return session.fastModeEnabled === true;
}

function normalizeSlashAlias(alias: string): string {
	const normalized = alias.startsWith("/") ? alias.slice(1) : alias;
	if (normalized.length === 0) {
		throw new Error("Host action slash alias must be a non-empty string");
	}
	return normalized;
}

function assertNoActionArgs(args: unknown): void {
	if (args === undefined) {
		return;
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("UI action args must be an object");
	}
	const unknownKeys = Object.keys(args);
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}
}

function getArgsRecord(args: unknown): Record<string, unknown> {
	if (args === undefined) {
		return {};
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("UI action args must be an object");
	}
	return args as Record<string, unknown>;
}

function getOptionalStringArg(args: unknown, name: string): string | undefined {
	const record = getArgsRecord(args);
	const unknownKeys = Object.keys(record).filter((key) => key !== name);
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}
	const value = record[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`UI action argument "${name}" must be a string`);
	}
	return value;
}

function getRequiredStringArg(args: unknown, name: string): string {
	const value = getOptionalStringArg(args, name);
	if (value === undefined) {
		throw new Error(`Missing required UI action argument: ${name}`);
	}
	return value;
}

function getOptionalBooleanArg(args: unknown, name: string): boolean | undefined {
	const record = getArgsRecord(args);
	const unknownKeys = Object.keys(record).filter((key) => key !== name);
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}
	const value = record[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`UI action argument "${name}" must be a boolean`);
	}
	return value;
}

function getRequiredBooleanArg(args: unknown, name: string): boolean {
	const value = getOptionalBooleanArg(args, name);
	if (value === undefined) {
		throw new Error(`UI action argument "${name}" is required`);
	}
	return value;
}

function getPlanActionArgs(
	args: unknown,
	requireStrategy: true,
): { planId: string; expectedRevision: number; strategy: PlanExecutionStrategy };
function getPlanActionArgs(args: unknown, requireStrategy: false): { planId: string; expectedRevision: number };
function getPlanActionArgs(
	args: unknown,
	requireStrategy: boolean,
): { planId: string; expectedRevision: number; strategy?: PlanExecutionStrategy } {
	const record = getArgsRecord(args);
	const allowedKeys = new Set(["planId", "expectedRevision", ...(requireStrategy ? ["strategy"] : [])]);
	const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
	if (unknownKey) {
		throw new Error(`Unsupported UI action argument: ${unknownKey}`);
	}
	const planId = record.planId;
	if (typeof planId !== "string" || !planId) {
		throw new Error('UI action argument "planId" must be a non-empty string');
	}
	const expectedRevision = record.expectedRevision;
	if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
		throw new Error('UI action argument "expectedRevision" must be a non-negative integer');
	}
	if (!requireStrategy) {
		return { planId, expectedRevision: expectedRevision as number };
	}
	const strategy = record.strategy;
	if (strategy !== "retain_context" && strategy !== "new_session") {
		throw new Error('UI action argument "strategy" must select an execution context');
	}
	return { planId, expectedRevision: expectedRevision as number, strategy };
}
