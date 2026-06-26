import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isIrohRemoteWorkspaceName } from "./handshake.ts";
import type { IrohRemoteHostState, IrohRemoteWorkspace } from "./state.ts";

export type IrohRemoteWorkspaceAvailabilityStatus = "available" | "missing" | "unavailable";

export interface IrohRemoteWorkspaceStatus {
	name: string;
	status: IrohRemoteWorkspaceAvailabilityStatus;
}

export type IrohRemoteWorkspaceAvailabilityClassifier = (
	workspace: IrohRemoteWorkspace,
) => IrohRemoteWorkspaceAvailabilityStatus | Promise<IrohRemoteWorkspaceAvailabilityStatus>;

export function parseIrohRemoteWorkspaceSpec(value?: string, cwd = process.cwd()): IrohRemoteWorkspace {
	if (!value) {
		const name = basename(cwd) || "workspace";
		assertIrohRemoteWorkspaceName(name);
		return { name, path: cwd };
	}

	const separatorIndex = value.indexOf("=");
	if (separatorIndex === -1) {
		const path = resolve(cwd, value);
		const name = basename(path) || "workspace";
		assertIrohRemoteWorkspaceName(name);
		return { name, path };
	}

	const name = value.slice(0, separatorIndex).trim();
	const path = resolve(cwd, value.slice(separatorIndex + 1));
	if (!name) {
		throw new Error("Workspace name cannot be empty");
	}
	assertIrohRemoteWorkspaceName(name);
	return { name, path };
}

export async function getIrohRemoteWorkspaceAvailabilityStatus(
	workspace: IrohRemoteWorkspace,
): Promise<IrohRemoteWorkspaceAvailabilityStatus> {
	try {
		const workspaceStat = await stat(workspace.path);
		return workspaceStat.isDirectory() ? "available" : "unavailable";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "unavailable";
	}
}

export function upsertIrohRemoteWorkspace(
	state: IrohRemoteHostState,
	workspace: IrohRemoteWorkspace,
	allowTools?: string,
): IrohRemoteWorkspace {
	assertIrohRemoteWorkspaceName(workspace.name);
	const nameAlias = getIrohRemoteWorkspaceNameAlias(workspace.name);
	const aliasConflict = state.workspaces.find(
		(entry) => entry.name !== workspace.name && getIrohRemoteWorkspaceNameAlias(entry.name) === nameAlias,
	);
	if (aliasConflict) {
		throw new Error(`Workspace name collides with existing registered workspace: ${aliasConflict.name}`);
	}
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

export function getIrohRemoteWorkspaceNameAlias(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

function assertIrohRemoteWorkspaceName(name: string): void {
	if (!isIrohRemoteWorkspaceName(name)) {
		throw new Error("Workspace name is invalid");
	}
}

export async function getIrohRemoteWorkspaceStatuses(
	state: IrohRemoteHostState,
	classifier?: IrohRemoteWorkspaceAvailabilityClassifier,
): Promise<IrohRemoteWorkspaceStatus[]> {
	return await Promise.all(
		state.workspaces.map(async (workspace) => ({
			name: workspace.name,
			status: await getIrohRemoteWorkspaceStatus(workspace, classifier),
		})),
	);
}

export function getAvailableIrohRemoteWorkspaceNames(workspaces: readonly IrohRemoteWorkspaceStatus[]): string[] {
	return workspaces.filter((entry) => entry.status === "available").map((entry) => entry.name);
}

async function getIrohRemoteWorkspaceStatus(
	workspace: IrohRemoteWorkspace,
	classifier: IrohRemoteWorkspaceAvailabilityClassifier | undefined,
): Promise<IrohRemoteWorkspaceAvailabilityStatus> {
	if (classifier === undefined) {
		return "available";
	}
	try {
		return await classifier(workspace);
	} catch {
		return "unavailable";
	}
}

export function findIrohRemoteWorkspace(
	state: IrohRemoteHostState,
	workspaceName: string,
): IrohRemoteWorkspace | undefined {
	return state.workspaces.find((entry) => entry.name === workspaceName);
}

export function selectIrohRemoteWorkspace(
	state: IrohRemoteHostState,
	workspaceSpec: string | undefined,
	allowTools?: string,
	cwd = process.cwd(),
): IrohRemoteWorkspace {
	if (workspaceSpec) {
		return upsertIrohRemoteWorkspace(state, parseIrohRemoteWorkspaceSpec(workspaceSpec, cwd), allowTools);
	}
	const cwdWorkspace = parseIrohRemoteWorkspaceSpec(undefined, cwd);
	const workspace = state.workspaces.find((entry) => entry.path === cwdWorkspace.path);
	if (workspace) {
		if (allowTools !== undefined) {
			workspace.allowedTools = allowTools;
		}
		return workspace;
	}
	return upsertIrohRemoteWorkspace(state, cwdWorkspace, allowTools);
}
