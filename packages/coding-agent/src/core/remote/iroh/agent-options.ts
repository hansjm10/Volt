import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, getSupportedThinkingLevels, type Model, supportsFastInference } from "@hansjm10/volt-ai";
import { Compile } from "typebox/compile";
import type { AgentSessionServices } from "../../agent-session-services.ts";
import { DEFAULT_THINKING_LEVEL } from "../../defaults.ts";
import { findInitialModel } from "../../model-resolver.ts";
import { RPC_COMMAND_SCHEMAS } from "../../rpc/schema/commands.ts";
import type { RpcAgentMode, RpcCatalogModel } from "../../rpc/types.ts";
import { isIrohRemoteWorkspaceName } from "./handshake.ts";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export const IROH_REMOTE_GET_AGENT_OPTIONS_RPC_TYPE = "get_agent_options";
export const IROH_REMOTE_AGENT_OPTIONS_RPC_TYPES: ReadonlySet<string> = new Set([
	IROH_REMOTE_GET_AGENT_OPTIONS_RPC_TYPE,
]);

export interface IrohRemoteAgentOptionsModelSelection {
	provider: string;
	modelId: string;
}

export interface IrohRemoteAgentOptionsDefaultConfig {
	model: IrohRemoteAgentOptionsModelSelection;
	thinkingLevel: ThinkingLevel;
	fastModeEnabled: boolean;
	agentMode: RpcAgentMode;
}

export interface IrohRemoteAgentOptions {
	workspaceName: string;
	models: RpcCatalogModel[];
	defaultConfig: IrohRemoteAgentOptionsDefaultConfig;
}

export interface IrohRemoteAgentOptionsRpcBackend {
	getAgentOptions(workspaceName: string): Promise<IrohRemoteAgentOptions>;
}

export type IrohRemoteAgentOptionsRpcResponse =
	| {
			id?: string;
			type: "response";
			command: typeof IROH_REMOTE_GET_AGENT_OPTIONS_RPC_TYPE;
			success: true;
			data: IrohRemoteAgentOptions;
	  }
	| IrohRemoteRpcErrorResponse;

export type IrohRemoteAgentOptionsRpcResult =
	| { handled: false }
	| { handled: true; response: IrohRemoteAgentOptionsRpcResponse };

const GET_AGENT_OPTIONS_VALIDATOR = Compile(RPC_COMMAND_SCHEMAS.get_agent_options);

export async function createIrohRemoteAgentOptions(
	workspaceName: string,
	services: AgentSessionServices,
	signal?: AbortSignal,
): Promise<IrohRemoteAgentOptions> {
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
	services.modelRegistry.refresh();
	const models = services.modelRegistry
		.getAvailable()
		.map(toIrohRemoteAgentOptionsCatalogModel)
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
		throw new Error("No authenticated models are available for agent configuration");
	}
	const requestedThinking = services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	const thinkingLevel = selected.availableThinkingLevels.includes(requestedThinking) ? requestedThinking : "off";
	return {
		workspaceName,
		models,
		defaultConfig: {
			model: { provider: selected.provider, modelId: selected.id },
			thinkingLevel,
			fastModeEnabled: false,
			agentMode: "build",
		},
	};
}

export function toIrohRemoteAgentOptionsCatalogModel(model: Model<Api>): RpcCatalogModel {
	return {
		...model,
		availableThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
		supportsFastMode: supportsFastInference(model),
	};
}

export async function handleIrohRemoteAgentOptionsRpcCommand(
	command: Record<string, unknown>,
	options: { authorizedWorkspaceName: string; backend: IrohRemoteAgentOptionsRpcBackend },
): Promise<IrohRemoteAgentOptionsRpcResult> {
	if (command.type !== IROH_REMOTE_GET_AGENT_OPTIONS_RPC_TYPE) {
		return { handled: false };
	}
	const id = typeof command.id === "string" ? command.id : undefined;
	const fail = (error: string): IrohRemoteAgentOptionsRpcResult => ({
		handled: true,
		response: createIrohRemoteRpcErrorResponse(id, IROH_REMOTE_GET_AGENT_OPTIONS_RPC_TYPE, error),
	});
	if (!GET_AGENT_OPTIONS_VALIDATOR.Check(command) || !isIrohRemoteWorkspaceName(command.workspaceName)) {
		return fail("invalid_request");
	}
	if (command.workspaceName !== options.authorizedWorkspaceName) {
		return fail("session_mismatch");
	}
	try {
		return {
			handled: true,
			response: {
				...(id === undefined ? {} : { id }),
				type: "response",
				command: IROH_REMOTE_GET_AGENT_OPTIONS_RPC_TYPE,
				success: true,
				data: await options.backend.getAgentOptions(command.workspaceName),
			},
		};
	} catch {
		return fail("request_failed");
	}
}

function sameModel(catalog: RpcCatalogModel, model: Model<Api>): boolean {
	return catalog.provider === model.provider && catalog.id === model.id;
}
