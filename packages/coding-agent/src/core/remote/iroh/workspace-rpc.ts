import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";
import type { IrohRemoteHostStateManager } from "./state-manager.ts";
import {
	getAvailableIrohRemoteWorkspaceNames,
	type IrohRemoteWorkspaceAvailabilityClassifier,
	type IrohRemoteWorkspaceStatus,
} from "./workspace.ts";

export const IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE = "unregister_workspace";

export interface IrohRemoteWorkspaceMetadataSnapshot {
	workspaceNames: string[];
	workspaces: IrohRemoteWorkspaceStatus[];
}

export interface IrohRemoteWorkspaceUnregisterRpcData extends IrohRemoteWorkspaceMetadataSnapshot {
	removedWorkspace: string;
}

export type IrohRemoteWorkspaceUnregisterRpcResponse =
	| {
			id?: string;
			type: "response";
			command: typeof IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE;
			success: true;
			data: IrohRemoteWorkspaceUnregisterRpcData;
	  }
	| IrohRemoteRpcErrorResponse;

export type IrohRemoteWorkspaceUnregisterRpcResult =
	| { handled: false }
	| {
			handled: true;
			metadata?: IrohRemoteWorkspaceMetadataSnapshot;
			response: IrohRemoteWorkspaceUnregisterRpcResponse;
	  };

export interface HandleIrohRemoteWorkspaceUnregisterRpcCommandOptions {
	classifyWorkspaceAvailability?: IrohRemoteWorkspaceAvailabilityClassifier;
	stateManager: IrohRemoteHostStateManager;
}

export async function handleIrohRemoteWorkspaceUnregisterRpcCommand(
	command: Record<string, unknown>,
	options: HandleIrohRemoteWorkspaceUnregisterRpcCommandOptions,
): Promise<IrohRemoteWorkspaceUnregisterRpcResult> {
	if (command.type !== IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE) {
		return { handled: false };
	}

	const id = typeof command.id === "string" ? command.id : undefined;
	const name = parseIrohRemoteWorkspaceUnregisterName(command);
	if (!name.ok) {
		return {
			handled: true,
			response: createIrohRemoteRpcErrorResponse(id, IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE, name.error),
		};
	}

	const removedWorkspace = await options.stateManager.unregisterWorkspace(name.value);
	if (!removedWorkspace) {
		return {
			handled: true,
			response: createIrohRemoteRpcErrorResponse(
				id,
				IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE,
				`No registered Iroh remote workspace named ${name.value}`,
			),
		};
	}

	const workspaces = await options.stateManager.listWorkspaceStatuses({
		classifyWorkspaceAvailability: options.classifyWorkspaceAvailability,
	});
	const metadata: IrohRemoteWorkspaceMetadataSnapshot = {
		workspaceNames: getAvailableIrohRemoteWorkspaceNames(workspaces),
		workspaces,
	};
	return {
		handled: true,
		metadata,
		response: {
			id,
			type: "response",
			command: IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE,
			success: true,
			data: {
				removedWorkspace: removedWorkspace.name,
				...metadata,
			},
		},
	};
}

function parseIrohRemoteWorkspaceUnregisterName(
	command: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; error: string } {
	if (command.path !== undefined || command.workspacePath !== undefined) {
		return { ok: false, error: "Workspace unregister accepts a workspace name only, not a path" };
	}
	if (typeof command.name !== "string") {
		return { ok: false, error: 'Invalid RPC command payload: "name" must be a non-empty workspace name' };
	}
	const name = command.name.trim();
	if (name.length === 0) {
		return { ok: false, error: 'Invalid RPC command payload: "name" must be a non-empty workspace name' };
	}
	return { ok: true, value: name };
}
