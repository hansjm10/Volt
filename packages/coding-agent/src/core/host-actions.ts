import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationResponse,
	UiActionSlashAlias,
} from "./rpc/types.ts";

type RuntimeNewSession = AgentSessionRuntime["newSession"];
type RuntimeSession = AgentSessionRuntime["session"];

export type HostActionNewSessionOptions = Parameters<RuntimeNewSession>[0];
export type HostActionNewSessionResult = Awaited<ReturnType<RuntimeNewSession>>;
export type HostActionCompactResult = Awaited<ReturnType<RuntimeSession["compact"]>>;

export interface HostActionSessionState {
	isStreaming: boolean;
	isCompacting: boolean;
}

export interface HostActionDescriptorContext {
	session: HostActionSessionState;
}

export interface HostActionInvocationContext extends HostActionDescriptorContext {
	abortRun(): Promise<void>;
	compactContext(customInstructions?: string): Promise<HostActionCompactResult>;
	newSession(options?: HostActionNewSessionOptions): Promise<HostActionNewSessionResult>;
	afterSessionSwitch?: () => Promise<void>;
	renameSession(name: string): void;
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
	slashAliases?: ReadonlyArray<UiActionSlashAlias>;
	availability?: (context: HostActionDescriptorContext) => HostActionAvailability;
	handler: (context: HostActionInvocationContext, args: unknown) => Promise<UiActionInvocationResponse>;
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
export const RUN_CANCEL_ACTION_ID = "run.cancel";
export const SESSION_NEW_ACTION_ID = "session.new";
export const SESSION_NEW_SLASH_ALIAS = "clear";
export const SESSION_RENAME_ACTION_ID = "session.rename";
export const SESSION_RENAME_SLASH_ALIAS = "name";

const REMOTE_SAFE_BUILTIN_HOST_ACTION_IDS = new Set<string>([SESSION_NEW_ACTION_ID, RUN_CANCEL_ACTION_ID]);

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
		const descriptor = createDescriptor(action, context);
		if (options.requireRemoteSafe && !descriptor.remoteSafe) {
			throw new Error(`UI action not available over remote host: ${actionId}`);
		}
		if (!descriptor.enabled) {
			throw new Error(descriptor.disabledReason ?? `UI action is disabled: ${actionId}`);
		}
		return action.handler(context, args);
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

export function registerBuiltinHostActions(registry: HostActionRegistry): HostActionRegistry {
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
			context.session.isStreaming
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

function createDescriptor(action: HostActionDefinition, context: HostActionDescriptorContext): UiActionDescriptor {
	const availability = action.availability?.(context) ?? { enabled: true };
	return {
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
		slash: action.slashAliases?.[0],
	};
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
