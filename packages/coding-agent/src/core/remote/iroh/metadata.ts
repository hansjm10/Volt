import type { IrohRemoteClientAuthorizationSuccess } from "./authorization.ts";
import type { IrohRemoteRelayMode } from "./protocol.ts";
import type { IrohRemoteWorkspaceStatus } from "./workspace.ts";

export interface IrohRemoteHostMetadata {
	workspace: string;
	workspaceNames: string[];
	workspaces: IrohRemoteWorkspaceStatus[];
	hostNodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	hostName?: string;
	userName?: string;
	cwd: string;
}

export interface CreateIrohRemoteHostMetadataOptions {
	authorization: IrohRemoteClientAuthorizationSuccess;
	hostNodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	hostName?: string;
	userName?: string;
	cwd?: string;
}

export function createIrohRemoteHostMetadata(options: CreateIrohRemoteHostMetadataOptions): IrohRemoteHostMetadata {
	return {
		workspace: options.authorization.workspace.name,
		workspaceNames: [...options.authorization.workspaceNames],
		workspaces: options.authorization.workspaces.map((workspace) => ({ ...workspace })),
		hostNodeId: options.hostNodeId,
		relayMode: options.relayMode,
		hostName: options.hostName,
		userName: options.userName,
		cwd: options.cwd ?? "/workspace",
	};
}
