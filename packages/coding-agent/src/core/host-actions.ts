import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationResponse,
	UiActionSlashAlias,
} from "./rpc/types.ts";

type RuntimeNewSession = AgentSessionRuntime["newSession"];

export type HostActionNewSessionOptions = Parameters<RuntimeNewSession>[0];
export type HostActionNewSessionResult = Awaited<ReturnType<RuntimeNewSession>>;

export interface HostActionSessionState {
	isStreaming: boolean;
	isCompacting: boolean;
}

export interface HostActionDescriptorContext {
	session: HostActionSessionState;
}

export interface HostActionInvocationContext extends HostActionDescriptorContext {
	newSession(options?: HostActionNewSessionOptions): Promise<HostActionNewSessionResult>;
	afterSessionSwitch?: () => Promise<void>;
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

export const SESSION_NEW_ACTION_ID = "session.new";
export const SESSION_NEW_SLASH_ALIAS = "clear";

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
		remoteSafe: false,
		slashAliases: [
			{
				name: SESSION_NEW_SLASH_ALIAS,
				example: `/${SESSION_NEW_SLASH_ALIAS}`,
			},
		],
		availability: () => ({ enabled: true }),
		handler: invokeSessionNewAction,
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
