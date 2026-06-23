import { basename, resolve } from "node:path";
import type { IrohRemoteHostState, IrohRemoteWorkspace } from "./state.ts";

export function parseIrohRemoteWorkspaceSpec(value?: string, cwd = process.cwd()): IrohRemoteWorkspace {
	if (!value) {
		return { name: basename(cwd) || "workspace", path: cwd };
	}

	const separatorIndex = value.indexOf("=");
	if (separatorIndex === -1) {
		const path = resolve(cwd, value);
		return { name: basename(path) || "workspace", path };
	}

	const name = value.slice(0, separatorIndex).trim();
	const path = resolve(cwd, value.slice(separatorIndex + 1));
	if (!name) {
		throw new Error("Workspace name cannot be empty");
	}
	return { name, path };
}

export function upsertIrohRemoteWorkspace(
	state: IrohRemoteHostState,
	workspace: IrohRemoteWorkspace,
	allowTools?: string,
): IrohRemoteWorkspace {
	const savedAllowedTools = allowTools ?? workspace.allowedTools;
	const savedWorkspace: IrohRemoteWorkspace = {
		name: workspace.name,
		path: workspace.path,
		...(savedAllowedTools === undefined ? {} : { allowedTools: savedAllowedTools }),
	};
	const existing = state.workspaces.find((entry) => entry.name === workspace.name);
	if (!existing) {
		state.workspaces.push(savedWorkspace);
		return savedWorkspace;
	}

	existing.path = savedWorkspace.path;
	if (savedAllowedTools !== undefined) {
		existing.allowedTools = savedAllowedTools;
	}
	return existing;
}

export function selectIrohRemoteWorkspace(
	state: IrohRemoteHostState,
	workspaceSpec: string | undefined,
	allowTools: string,
	cwd = process.cwd(),
): IrohRemoteWorkspace {
	if (workspaceSpec) {
		return upsertIrohRemoteWorkspace(state, parseIrohRemoteWorkspaceSpec(workspaceSpec, cwd), allowTools);
	}
	if (state.workspaces.length > 0) {
		const workspace = state.workspaces[0];
		workspace.allowedTools = allowTools;
		return workspace;
	}
	return upsertIrohRemoteWorkspace(state, parseIrohRemoteWorkspaceSpec(undefined, cwd), allowTools);
}
