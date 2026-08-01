import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, getSupportedThinkingLevels, type Model, supportsFastInference } from "@hansjm10/volt-ai";
import { Compile } from "typebox/compile";
import type { AgentSessionServices } from "../../agent-session-services.ts";
import { DEFAULT_THINKING_LEVEL } from "../../defaults.ts";
import { findInitialModel } from "../../model-resolver.ts";
import { RPC_COMMAND_SCHEMAS } from "../../rpc/schema/commands.ts";
import type { RpcAgentMode, RpcCatalogModel } from "../../rpc/types.ts";
import { isIrohRemoteSessionId, isIrohRemoteWorkspaceName } from "./handshake.ts";
import { isIrohRemoteWorkingDirectory, isIrohRemoteWorktreeId } from "./protocol.ts";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export const IROH_REMOTE_GET_AGENT_LAUNCH_OPTIONS_RPC_TYPE = "get_agent_launch_options";
export const IROH_REMOTE_CREATE_AGENT_RPC_TYPE = "create_agent";
export const IROH_REMOTE_AGENT_LAUNCH_RPC_TYPES: ReadonlySet<string> = new Set([
	IROH_REMOTE_GET_AGENT_LAUNCH_OPTIONS_RPC_TYPE,
	IROH_REMOTE_CREATE_AGENT_RPC_TYPE,
]);

export interface IrohRemoteAgentLaunchModelSelection {
	provider: string;
	modelId: string;
}

export interface IrohRemoteAgentLaunchConfig {
	model?: IrohRemoteAgentLaunchModelSelection;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled: boolean;
	agentMode: RpcAgentMode;
}

export interface IrohRemoteAgentLaunchConfiguredConfig {
	kind: "configured";
	model: IrohRemoteAgentLaunchModelSelection;
	thinkingLevel: ThinkingLevel;
	fastModeEnabled: boolean;
	agentMode: RpcAgentMode;
}

export type IrohRemoteAgentLaunchPlacement =
	| { kind: "workspace"; workingDirectory?: string }
	| { kind: "existing_worktree"; worktreeId: string; workingDirectory?: string }
	| {
			kind: "new_worktree";
			worktreeName?: string;
			branch?: string;
			baseRef?: string;
			workingDirectory?: string;
	  };

export type IrohRemoteAgentLaunchResolvedPlacement =
	| { kind: "workspace"; workingDirectory?: string }
	| {
			kind: "worktree";
			worktreeId: string;
			branch: string;
			created: boolean;
			workingDirectory?: string;
	  };

export type IrohRemoteAgentLaunchError =
	| { kind: "invalid_request"; message: string }
	| { kind: "stale_catalog"; message: string; currentRevision: string }
	| { kind: "model_unavailable"; message: string }
	| { kind: "thinking_level_unsupported"; message: string }
	| { kind: "fast_mode_unsupported"; message: string }
	| { kind: "placement_unavailable"; message: string }
	| { kind: "cleanup_required"; message: string; worktreeId: string }
	| { kind: "launch_conflict"; message: string }
	| { kind: "authorization_changed"; message: string }
	| { kind: "host_shutdown"; message: string }
	| { kind: "internal_error"; message: string };

export type IrohRemoteAgentLaunchResult =
	| {
			kind: "created" | "existing";
			launchId: string;
			sessionId: string;
			placement: IrohRemoteAgentLaunchResolvedPlacement;
			config: IrohRemoteAgentLaunchConfiguredConfig;
	  }
	| { kind: "error"; error: IrohRemoteAgentLaunchError };

export interface IrohRemoteAgentLaunchOptions {
	workspaceName: string;
	revision: string;
	models: RpcCatalogModel[];
	defaultConfig: IrohRemoteAgentLaunchConfiguredConfig;
}

export interface IrohRemoteCreateAgentRequest {
	launchId: string;
	catalogRevision: string;
	placement: IrohRemoteAgentLaunchPlacement;
	config: IrohRemoteAgentLaunchConfig;
}

export interface IrohRemoteAgentLaunchRpcBackend {
	getAgentLaunchOptions(workspaceName: string): Promise<IrohRemoteAgentLaunchOptions>;
	createAgent(workspaceName: string, request: IrohRemoteCreateAgentRequest): Promise<IrohRemoteAgentLaunchResult>;
}

export type IrohRemoteAgentLaunchRpcResponse =
	| {
			id?: string;
			type: "response";
			command: typeof IROH_REMOTE_GET_AGENT_LAUNCH_OPTIONS_RPC_TYPE;
			success: true;
			data: IrohRemoteAgentLaunchOptions;
	  }
	| {
			id?: string;
			type: "response";
			command: typeof IROH_REMOTE_CREATE_AGENT_RPC_TYPE;
			success: true;
			data: IrohRemoteAgentLaunchResult;
	  }
	| IrohRemoteRpcErrorResponse;

export type IrohRemoteAgentLaunchRpcResult =
	| { handled: false }
	| { handled: true; response: IrohRemoteAgentLaunchRpcResponse };

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const GET_AGENT_LAUNCH_OPTIONS_VALIDATOR = Compile(RPC_COMMAND_SCHEMAS.get_agent_launch_options);
const CREATE_AGENT_VALIDATOR = Compile(RPC_COMMAND_SCHEMAS.create_agent);

export async function createIrohRemoteAgentLaunchOptions(
	workspaceName: string,
	services: AgentSessionServices,
	signal?: AbortSignal,
): Promise<IrohRemoteAgentLaunchOptions> {
	services.modelRegistry.refreshFromDisk();
	const providers = new Set(services.modelRegistry.getAll().map((model) => model.provider));
	signal?.throwIfAborted();
	const providerRefresh = Promise.all(
		Array.from(providers, (provider) => services.modelRegistry.getApiKeyForProvider(provider)),
	);
	if (signal) {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(signal.reason);
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			providerRefresh.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	} else {
		await providerRefresh;
	}
	// OAuth refresh can alter provider model metadata (for example a subscription
	// endpoint). Rebuild once after every provider refresh before serializing.
	services.modelRegistry.refresh();
	const models = services.modelRegistry
		.getAvailable()
		.map(toIrohRemoteAgentLaunchCatalogModel)
		.sort((left, right) =>
			left.provider === right.provider
				? left.id.localeCompare(right.id)
				: left.provider.localeCompare(right.provider),
		);
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: services.settingsManager.getDefaultProvider(),
		defaultModelId: services.settingsManager.getDefaultModel(),
		defaultThinkingLevel: services.settingsManager.getDefaultThinkingLevel(),
		modelRegistry: services.modelRegistry,
	});
	const selected = initial.model ? models.find((model) => sameModel(model, initial.model!)) : models[0];
	if (!selected) {
		throw new Error("No authenticated models are available for agent launch");
	}
	const requestedThinking = services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	const thinkingLevel = selected.availableThinkingLevels.includes(requestedThinking) ? requestedThinking : "off";
	const defaultConfig: IrohRemoteAgentLaunchConfiguredConfig = {
		kind: "configured",
		model: { provider: selected.provider, modelId: selected.id },
		thinkingLevel,
		fastModeEnabled: false,
		agentMode: "build",
	};
	const revisionSource = stableJson({ models, defaultConfig });
	return {
		workspaceName,
		revision: createHash("sha256").update(revisionSource).digest("hex"),
		models,
		defaultConfig,
	};
}

export function resolveIrohRemoteAgentLaunchConfig(
	options: IrohRemoteAgentLaunchOptions,
	request: IrohRemoteAgentLaunchConfig,
): { ok: true; config: IrohRemoteAgentLaunchConfiguredConfig } | { ok: false; error: IrohRemoteAgentLaunchError } {
	const modelSelection = request.model ?? options.defaultConfig.model;
	const selectedModel = options.models.find(
		(model) => model.provider === modelSelection.provider && model.id === modelSelection.modelId,
	);
	if (!selectedModel) {
		return { ok: false, error: { kind: "model_unavailable", message: "requested model is unavailable" } };
	}
	const thinkingLevel = request.thinkingLevel ?? options.defaultConfig.thinkingLevel;
	if (!selectedModel.availableThinkingLevels.includes(thinkingLevel)) {
		return {
			ok: false,
			error: { kind: "thinking_level_unsupported", message: "requested thinking level is unavailable" },
		};
	}
	if (request.fastModeEnabled && !selectedModel.supportsFastMode) {
		return { ok: false, error: { kind: "fast_mode_unsupported", message: "Fast mode is unavailable" } };
	}
	return {
		ok: true,
		config: {
			kind: "configured",
			model: modelSelection,
			thinkingLevel,
			fastModeEnabled: request.fastModeEnabled,
			agentMode: request.agentMode,
		},
	};
}

export function toIrohRemoteAgentLaunchCatalogModel(model: Model<Api>): RpcCatalogModel {
	return {
		...model,
		availableThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
		supportsFastMode: supportsFastInference(model),
	};
}

export function createIrohRemoteAgentLaunchSessionId(
	clientNodeId: string,
	workspaceName: string,
	launchId: string,
): string {
	const digest = createHash("sha256")
		.update(stableJson({ clientNodeId, workspaceName, launchId }))
		.digest("hex")
		.slice(0, 32);
	return `agent-${digest}`;
}

export function digestIrohRemoteAgentLaunchRequest(
	workspaceName: string,
	request: IrohRemoteCreateAgentRequest,
): string {
	return createHash("sha256").update(stableJson({ workspaceName, request })).digest("hex");
}

export async function handleIrohRemoteAgentLaunchRpcCommand(
	command: Record<string, unknown>,
	options: { authorizedWorkspaceName: string; backend: IrohRemoteAgentLaunchRpcBackend },
): Promise<IrohRemoteAgentLaunchRpcResult> {
	if (typeof command.type !== "string" || !IROH_REMOTE_AGENT_LAUNCH_RPC_TYPES.has(command.type)) {
		return { handled: false };
	}
	const commandType = command.type;
	const id = typeof command.id === "string" ? command.id : undefined;
	const fail = (error: string): IrohRemoteAgentLaunchRpcResult => ({
		handled: true,
		response: createIrohRemoteRpcErrorResponse(id, commandType, error),
	});
	const validator =
		commandType === IROH_REMOTE_GET_AGENT_LAUNCH_OPTIONS_RPC_TYPE
			? GET_AGENT_LAUNCH_OPTIONS_VALIDATOR
			: CREATE_AGENT_VALIDATOR;
	if (!validator.Check(command)) {
		return fail("invalid_request");
	}
	if (!isIrohRemoteWorkspaceName(command.workspaceName)) {
		return fail("invalid_request");
	}
	if (command.workspaceName !== options.authorizedWorkspaceName) {
		return fail("session_mismatch");
	}
	if (commandType === IROH_REMOTE_GET_AGENT_LAUNCH_OPTIONS_RPC_TYPE) {
		try {
			return {
				handled: true,
				response: {
					...(id === undefined ? {} : { id }),
					type: "response",
					command: IROH_REMOTE_GET_AGENT_LAUNCH_OPTIONS_RPC_TYPE,
					success: true,
					data: await options.backend.getAgentLaunchOptions(command.workspaceName),
				},
			};
		} catch {
			return fail("agent_launch_catalog_unavailable");
		}
	}
	const request = parseCreateAgentRequest(command);
	if (!request.ok) {
		return fail(request.error);
	}
	try {
		return {
			handled: true,
			response: {
				...(id === undefined ? {} : { id }),
				type: "response",
				command: IROH_REMOTE_CREATE_AGENT_RPC_TYPE,
				success: true,
				data: await options.backend.createAgent(command.workspaceName, request.value),
			},
		};
	} catch {
		return fail("agent_launch_unavailable");
	}
}

function parseCreateAgentRequest(
	command: Record<string, unknown>,
): { ok: true; value: IrohRemoteCreateAgentRequest } | { ok: false; error: string } {
	if (
		!isIrohRemoteSessionId(command.launchId) ||
		typeof command.catalogRevision !== "string" ||
		command.catalogRevision.length === 0
	) {
		return { ok: false, error: "invalid_request" };
	}
	const placement = parsePlacement(command.placement);
	const config = parseConfig(command.config);
	if (!placement || !config) {
		return { ok: false, error: "invalid_request" };
	}
	return {
		ok: true,
		value: {
			launchId: command.launchId,
			catalogRevision: command.catalogRevision,
			placement,
			config,
		},
	};
}

function parsePlacement(value: unknown): IrohRemoteAgentLaunchPlacement | undefined {
	if (!isRecord(value) || typeof value.kind !== "string") return undefined;
	const commonWorkingDirectory =
		value.workingDirectory === undefined
			? undefined
			: isIrohRemoteWorkingDirectory(value.workingDirectory)
				? value.workingDirectory
				: null;
	if (commonWorkingDirectory === null) return undefined;
	if (value.kind === "workspace") {
		if (!hasOnlyFields(value, ["kind", "workingDirectory"])) return undefined;
		return {
			kind: "workspace",
			...(commonWorkingDirectory === undefined ? {} : { workingDirectory: commonWorkingDirectory }),
		};
	}
	if (value.kind === "existing_worktree") {
		if (
			!hasOnlyFields(value, ["kind", "worktreeId", "workingDirectory"]) ||
			!isIrohRemoteWorktreeId(value.worktreeId)
		) {
			return undefined;
		}
		return {
			kind: "existing_worktree",
			worktreeId: value.worktreeId,
			...(commonWorkingDirectory === undefined ? {} : { workingDirectory: commonWorkingDirectory }),
		};
	}
	if (
		value.kind !== "new_worktree" ||
		!hasOnlyFields(value, ["kind", "worktreeName", "branch", "baseRef", "workingDirectory"])
	) {
		return undefined;
	}
	if (value.worktreeName !== undefined && !isIrohRemoteWorktreeId(value.worktreeName)) return undefined;
	if (value.branch !== undefined && (typeof value.branch !== "string" || value.branch.length === 0)) return undefined;
	if (value.baseRef !== undefined && (typeof value.baseRef !== "string" || value.baseRef.length === 0))
		return undefined;
	return {
		kind: "new_worktree",
		...(value.worktreeName === undefined ? {} : { worktreeName: value.worktreeName }),
		...(value.branch === undefined ? {} : { branch: value.branch }),
		...(value.baseRef === undefined ? {} : { baseRef: value.baseRef }),
		...(commonWorkingDirectory === undefined ? {} : { workingDirectory: commonWorkingDirectory }),
	};
}

function parseConfig(value: unknown): IrohRemoteAgentLaunchConfig | undefined {
	if (!isRecord(value) || !hasOnlyFields(value, ["model", "thinkingLevel", "fastModeEnabled", "agentMode"])) {
		return undefined;
	}
	let model: IrohRemoteAgentLaunchModelSelection | undefined;
	if (value.model !== undefined) {
		if (!isRecord(value.model) || !hasOnlyFields(value.model, ["provider", "modelId"])) return undefined;
		if (typeof value.model.provider !== "string" || value.model.provider.length === 0) return undefined;
		if (typeof value.model.modelId !== "string" || value.model.modelId.length === 0) return undefined;
		model = { provider: value.model.provider, modelId: value.model.modelId };
	}
	if (value.thinkingLevel !== undefined && !THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel)) {
		return undefined;
	}
	if (typeof value.fastModeEnabled !== "boolean") return undefined;
	if (value.agentMode !== "build" && value.agentMode !== "plan") return undefined;
	return {
		...(model === undefined ? {} : { model }),
		...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel as ThinkingLevel }),
		fastModeEnabled: value.fastModeEnabled,
		agentMode: value.agentMode,
	};
}

function sameModel(catalog: RpcCatalogModel, model: Model<Api>): boolean {
	return catalog.provider === model.provider && catalog.id === model.id;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
	return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const allowed = new Set(fields);
	return Object.keys(value).every((field) => allowed.has(field));
}
