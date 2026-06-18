import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface IrohRemoteWorkspace {
	name: string;
	path: string;
	allowedTools?: string;
}

export interface IrohRemoteClient {
	nodeId: string;
	label: string;
	allowedWorkspaces: string[];
	allowedTools?: string;
	pairedAt: number;
	lastSeenAt: number;
}

export interface IrohRemoteHostState {
	hostSecretKey?: number[];
	workspaces: IrohRemoteWorkspace[];
	clients: IrohRemoteClient[];
}

export function createEmptyIrohRemoteHostState(): IrohRemoteHostState {
	return { hostSecretKey: undefined, workspaces: [], clients: [] };
}

export async function readIrohRemoteHostState(path: string): Promise<IrohRemoteHostState> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error: unknown) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return createEmptyIrohRemoteHostState();
		}
		throw error;
	}
	return parseIrohRemoteHostState(parsed);
}

export async function writeIrohRemoteHostState(path: string, state: IrohRemoteHostState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(tempPath, path);
}

export function parseIrohRemoteHostState(value: unknown): IrohRemoteHostState {
	const state = expectRecord(value, "Iroh remote host state");
	return {
		hostSecretKey: parseOptionalByteArray(state.hostSecretKey, "hostSecretKey"),
		workspaces: parseArray(state.workspaces, "workspaces", parseIrohRemoteWorkspace),
		clients: parseArray(state.clients, "clients", parseIrohRemoteClient),
	};
}

export function parseIrohRemoteWorkspace(value: unknown): IrohRemoteWorkspace {
	const workspace = expectRecord(value, "Iroh remote workspace");
	return {
		name: expectString(workspace.name, "workspace name"),
		path: expectString(workspace.path, "workspace path"),
		allowedTools: expectOptionalString(workspace.allowedTools, "workspace allowedTools"),
	};
}

export function parseIrohRemoteClient(value: unknown): IrohRemoteClient {
	const client = expectRecord(value, "Iroh remote client");
	return {
		nodeId: expectString(client.nodeId, "client nodeId"),
		label: expectString(client.label, "client label"),
		allowedWorkspaces: parseArray(client.allowedWorkspaces, "client allowedWorkspaces", (entry) =>
			expectString(entry, "client allowed workspace"),
		),
		allowedTools: expectOptionalString(client.allowedTools, "client allowedTools"),
		pairedAt: expectNumber(client.pairedAt, "client pairedAt"),
		lastSeenAt: expectNumber(client.lastSeenAt, "client lastSeenAt"),
	};
}

function parseArray<T>(value: unknown, label: string, parseEntry: (value: unknown) => T): T[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((entry) => parseEntry(entry));
}

function parseOptionalByteArray(value: unknown, label: string): number[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return parseArray(value, label, (entry) => {
		if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
			throw new Error(`${label} must contain byte values`);
		}
		return entry;
	});
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectString(value, label);
}

function expectNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
