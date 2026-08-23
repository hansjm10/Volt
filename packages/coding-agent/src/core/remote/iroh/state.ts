import { readFile } from "node:fs/promises";
import { writeDurableAtomicFile } from "../../../utils/durable-atomic-write.ts";
import { cloneIrohRemoteRpcGrant, type IrohRemoteRpcGrant, parseIrohRemoteRpcGrant } from "./access-grant.ts";
import {
	canonicalizePersistedIrohRemoteAllowTools,
	isIrohRemoteWorkingDirectory,
	isIrohRemoteWorktreeId,
	normalizeIrohRemoteAllowTools,
} from "./protocol.ts";

export interface IrohRemoteWorkspace {
	name: string;
	path: string;
	allowedTools?: string;
}

export interface IrohRemoteWorkspaceGeneration {
	workspaceName: string;
	generation: number;
}

/** A daemon-managed git worktree, keyed under its parent workspace. */
export interface IrohRemoteWorkspaceWorktree {
	/** ^[a-z0-9][a-z0-9._-]{0,63}$ — unique per workspace. */
	id: string;
	workspaceName: string;
	/** Absolute checkout path; host-local, never sent on the wire. */
	path: string;
	/** Registered-workspace-relative git repo root this worktree was created from. Omitted for the workspace root. */
	sourceRootRelativePath?: string;
	branch: string;
	baseRef?: string;
	createdAt: number;
	/** Sessions bound to this worktree (usually exactly one). */
	sessionIds: string[];
}

export type IrohRemotePushTargetProvider = "fcm";
export type IrohRemotePushTargetPlatform = "ios";

export interface IrohRemotePushTarget {
	id: string;
	provider: IrohRemotePushTargetProvider;
	platform: IrohRemotePushTargetPlatform;
	pushTargetAuthToken: string;
	relayUrl?: string;
	tokenHash?: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface IrohRemoteClient {
	nodeId: string;
	label: string;
	allowedWorkspaces: string[];
	/** Explicitly customized tool grant. Absent means the client tracks the current default grant. */
	allowedTools?: string;
	rpcGrant?: IrohRemoteRpcGrant;
	pairedAt: number;
	lastSeenAt: number;
	lastSessionIdByWorkspace?: Record<string, string>;
	pushTargets?: IrohRemotePushTarget[];
}

export type IrohRemoteGrantedClient = IrohRemoteClient & { rpcGrant: IrohRemoteRpcGrant };

export interface IrohRemoteRevokedClient {
	nodeId: string;
	label: string;
	allowedWorkspaces: string[];
	/** Explicitly customized tool grant. Absent means the client tracked the current default grant. */
	allowedTools?: string;
	rpcGrant?: IrohRemoteRpcGrant;
	pairedAt: number;
	lastSeenAt: number;
	revokedAt: number;
	lastSessionIdByWorkspace?: Record<string, string>;
	rePairApprovedAt?: number;
}

export type IrohRemoteGrantedRevokedClient = IrohRemoteRevokedClient & { rpcGrant: IrohRemoteRpcGrant };

export interface IrohRemotePendingPairingTicket {
	secretHash: string;
	workspace: string;
	/** Explicitly customized tool grant to apply on consume. Absent means default-grant intent. */
	allowedTools?: string;
	rpcGrant?: IrohRemoteRpcGrant;
	expiresAt: number;
	createdAt: number;
	labelHint?: string;
	/** One-time managed relay claim that must approve the consuming client node. */
	relayCredentialClaimId?: string;
}

export type IrohRemoteGrantedPendingPairingTicket = IrohRemotePendingPairingTicket & {
	rpcGrant: IrohRemoteRpcGrant;
};

export type IrohRemotePairingSecretTombstoneOutcome = "pairing_secret_consumed" | "pairing_secret_expired";

export interface IrohRemotePairingSecretTombstone {
	secretHash: string;
	workspace: string;
	outcome: IrohRemotePairingSecretTombstoneOutcome;
	retainUntil: number;
	createdAt?: number;
	expiresAt?: number;
	labelHint?: string;
	consumedAt?: number;
	clientNodeId?: string;
	expiredAt?: number;
}

export interface IrohRemoteHostState {
	hostSecretKey?: number[];
	pairingSecretTombstones?: IrohRemotePairingSecretTombstone[];
	workspaceGenerationCounter?: number;
	workspaceGenerations?: IrohRemoteWorkspaceGeneration[];
	workspaces: IrohRemoteWorkspace[];
	worktrees?: IrohRemoteWorkspaceWorktree[];
	clients: IrohRemoteClient[];
	revokedClients?: IrohRemoteRevokedClient[];
	pendingPairingTickets?: IrohRemotePendingPairingTicket[];
}

export function createEmptyIrohRemoteHostState(): IrohRemoteHostState {
	return {
		hostSecretKey: undefined,
		pairingSecretTombstones: [],
		workspaceGenerationCounter: 0,
		workspaceGenerations: [],
		workspaces: [],
		worktrees: [],
		clients: [],
		revokedClients: [],
		pendingPairingTickets: [],
	};
}

export interface IrohRemoteStateParseOptions {
	/** Default grant to canonicalize against; tests inject alternate defaults. */
	defaultAllowTools?: string;
}

export async function readIrohRemoteHostState(
	path: string,
	options?: IrohRemoteStateParseOptions,
): Promise<IrohRemoteHostState> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error: unknown) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return createEmptyIrohRemoteHostState();
		}
		throw error;
	}
	return parseIrohRemoteHostState(parsed, options);
}

export async function writeIrohRemoteHostState(path: string, state: IrohRemoteHostState): Promise<void> {
	await writeDurableAtomicFile(path, `${JSON.stringify(serializeIrohRemoteHostState(state), null, 2)}\n`);
}

export function parseIrohRemoteHostState(value: unknown, options?: IrohRemoteStateParseOptions): IrohRemoteHostState {
	const state = expectRecord(value, "Iroh remote host state");
	return {
		hostSecretKey: parseOptionalByteArray(state.hostSecretKey, "hostSecretKey"),
		pairingSecretTombstones: parseOptionalArray(
			state.pairingSecretTombstones,
			"pairingSecretTombstones",
			parseIrohRemotePairingSecretTombstone,
		),
		...parseWorkspaceGenerationState(state),
		workspaces: parseArray(state.workspaces, "workspaces", parseIrohRemoteWorkspace),
		worktrees: parseOptionalArray(state.worktrees, "worktrees", parseIrohRemoteWorkspaceWorktree),
		clients: parseArray(state.clients, "clients", (entry) => parseIrohRemoteClient(entry, options)),
		revokedClients: parseOptionalArray(state.revokedClients, "revokedClients", (entry) =>
			parseIrohRemoteRevokedClient(entry, options),
		),
		pendingPairingTickets: parseOptionalArray(state.pendingPairingTickets, "pendingPairingTickets", (entry) =>
			parseIrohRemotePendingPairingTicket(entry, options),
		),
	};
}

function serializeIrohRemoteHostState(state: IrohRemoteHostState): IrohRemoteHostState {
	return {
		hostSecretKey: state.hostSecretKey ? [...state.hostSecretKey] : undefined,
		pairingSecretTombstones: (state.pairingSecretTombstones ?? []).map((tombstone) => ({ ...tombstone })),
		workspaceGenerationCounter: state.workspaceGenerationCounter ?? 0,
		workspaceGenerations: (state.workspaceGenerations ?? []).map((record) => ({ ...record })),
		workspaces: state.workspaces.map((workspace) => ({ ...workspace })),
		worktrees: (state.worktrees ?? []).map((worktree) => ({ ...worktree, sessionIds: [...worktree.sessionIds] })),
		clients: state.clients.map((client) => ({
			...client,
			allowedWorkspaces: [...client.allowedWorkspaces],
			...(client.rpcGrant === undefined ? {} : { rpcGrant: cloneIrohRemoteRpcGrant(client.rpcGrant) }),
			...(client.lastSessionIdByWorkspace
				? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } }
				: {}),
			...(client.pushTargets ? { pushTargets: client.pushTargets.map((target) => ({ ...target })) } : {}),
		})),
		revokedClients: (state.revokedClients ?? []).map((client) => ({
			...client,
			allowedWorkspaces: [...client.allowedWorkspaces],
			...(client.rpcGrant === undefined ? {} : { rpcGrant: cloneIrohRemoteRpcGrant(client.rpcGrant) }),
			...(client.lastSessionIdByWorkspace
				? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } }
				: {}),
		})),
		pendingPairingTickets: (state.pendingPairingTickets ?? []).map((ticket) => ({
			...ticket,
			...(ticket.rpcGrant === undefined ? {} : { rpcGrant: cloneIrohRemoteRpcGrant(ticket.rpcGrant) }),
		})),
	};
}

function parseWorkspaceGenerationState(state: Record<string, unknown>): {
	workspaceGenerationCounter: number;
	workspaceGenerations: IrohRemoteWorkspaceGeneration[];
} {
	const workspaceGenerationCounter =
		state.workspaceGenerationCounter === undefined
			? 0
			: expectNonNegativeSafeInteger(state.workspaceGenerationCounter, "workspaceGenerationCounter");
	const workspaceGenerations = parseOptionalArray(
		state.workspaceGenerations,
		"workspaceGenerations",
		parseIrohRemoteWorkspaceGeneration,
	);
	const workspaceNames = new Set<string>();
	const generations = new Set<number>();
	for (const record of workspaceGenerations) {
		if (workspaceNames.has(record.workspaceName)) {
			throw new Error(`workspaceGenerations contains duplicate workspace name: ${record.workspaceName}`);
		}
		if (generations.has(record.generation)) {
			throw new Error(`workspaceGenerations contains duplicate generation: ${record.generation}`);
		}
		if (record.generation > workspaceGenerationCounter) {
			throw new Error("workspace generation cannot exceed workspaceGenerationCounter");
		}
		workspaceNames.add(record.workspaceName);
		generations.add(record.generation);
	}
	return { workspaceGenerationCounter, workspaceGenerations };
}

function parseIrohRemoteWorkspaceGeneration(value: unknown): IrohRemoteWorkspaceGeneration {
	const record = expectRecord(value, "Iroh remote workspace generation");
	return {
		workspaceName: expectString(record.workspaceName, "workspace generation workspaceName"),
		generation: expectPositiveSafeInteger(record.generation, "workspace generation"),
	};
}

export function parseIrohRemoteWorkspace(value: unknown): IrohRemoteWorkspace {
	const workspace = expectRecord(value, "Iroh remote workspace");
	const allowedTools = expectOptionalAllowTools(workspace.allowedTools, "workspace allowedTools");
	return {
		name: expectString(workspace.name, "workspace name"),
		path: expectString(workspace.path, "workspace path"),
		allowedTools: allowedTools === undefined ? undefined : normalizeIrohRemoteAllowTools(allowedTools),
	};
}

export function parseIrohRemoteWorkspaceWorktree(value: unknown): IrohRemoteWorkspaceWorktree {
	const worktree = expectRecord(value, "Iroh remote worktree");
	const baseRef = expectOptionalString(worktree.baseRef, "worktree baseRef");
	const sourceRootRelativePath = expectOptionalWorkspaceRelativePath(
		worktree.sourceRootRelativePath,
		"worktree sourceRootRelativePath",
	);
	return {
		id: expectWorktreeId(worktree.id),
		workspaceName: expectString(worktree.workspaceName, "worktree workspaceName"),
		path: expectString(worktree.path, "worktree path"),
		...(sourceRootRelativePath === undefined ? {} : { sourceRootRelativePath }),
		branch: expectString(worktree.branch, "worktree branch"),
		...(baseRef === undefined ? {} : { baseRef }),
		createdAt: expectNumber(worktree.createdAt, "worktree createdAt"),
		sessionIds: parseArray(worktree.sessionIds, "worktree sessionIds", (entry) =>
			expectString(entry, "worktree session id"),
		),
	};
}

function expectWorktreeId(value: unknown): string {
	if (!isIrohRemoteWorktreeId(value)) {
		throw new Error("worktree id must match lowercase worktree id syntax");
	}
	return value;
}

function expectOptionalWorkspaceRelativePath(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isIrohRemoteWorkingDirectory(value)) {
		throw new Error(`${label} must be a relative workspace path`);
	}
	return value;
}

export function parseIrohRemoteClient(value: unknown, options?: IrohRemoteStateParseOptions): IrohRemoteClient {
	const client = expectRecord(value, "Iroh remote client");
	const allowedTools = canonicalizePersistedIrohRemoteAllowTools(
		expectOptionalAllowTools(client.allowedTools, "client allowedTools"),
		options?.defaultAllowTools,
	);
	return {
		nodeId: expectString(client.nodeId, "client nodeId"),
		label: expectString(client.label, "client label"),
		allowedWorkspaces: parseArray(client.allowedWorkspaces, "client allowedWorkspaces", (entry) =>
			expectString(entry, "client allowed workspace"),
		),
		...(allowedTools === undefined ? {} : { allowedTools }),
		rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant"),
		pairedAt: expectNumber(client.pairedAt, "client pairedAt"),
		lastSeenAt: expectNumber(client.lastSeenAt, "client lastSeenAt"),
		...parseOptionalStringRecordProperty(
			client.lastSessionIdByWorkspace,
			"client lastSessionIdByWorkspace",
			"client last session workspace",
			"client last session id",
		),
		...parseOptionalPushTargetsProperty(client.pushTargets, "client pushTargets"),
	};
}

export function parseIrohRemotePushTarget(value: unknown): IrohRemotePushTarget {
	const target = expectRecord(value, "push target");
	return {
		id: expectString(target.id, "push target id"),
		provider: expectPushTargetProvider(target.provider, "push target provider"),
		platform: expectPushTargetPlatform(target.platform, "push target platform"),
		pushTargetAuthToken: expectString(target.pushTargetAuthToken, "push target pushTargetAuthToken"),
		relayUrl: expectOptionalString(target.relayUrl, "push target relayUrl"),
		tokenHash: expectOptionalString(target.tokenHash, "push target tokenHash"),
		enabled: expectBoolean(target.enabled, "push target enabled"),
		createdAt: expectNumber(target.createdAt, "push target createdAt"),
		updatedAt: expectNumber(target.updatedAt, "push target updatedAt"),
	};
}

export function parseIrohRemoteRevokedClient(
	value: unknown,
	options?: IrohRemoteStateParseOptions,
): IrohRemoteRevokedClient {
	const client = expectRecord(value, "Iroh remote revoked client");
	const rePairApprovedAt = expectOptionalNumber(client.rePairApprovedAt, "revoked client rePairApprovedAt");
	const allowedTools = canonicalizePersistedIrohRemoteAllowTools(
		expectOptionalAllowTools(client.allowedTools, "revoked client allowedTools"),
		options?.defaultAllowTools,
	);
	return {
		nodeId: expectString(client.nodeId, "revoked client nodeId"),
		label: expectString(client.label, "revoked client label"),
		allowedWorkspaces: parseArray(client.allowedWorkspaces, "revoked client allowedWorkspaces", (entry) =>
			expectString(entry, "revoked client allowed workspace"),
		),
		...(allowedTools === undefined ? {} : { allowedTools }),
		rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "revoked client rpcGrant"),
		pairedAt: expectNumber(client.pairedAt, "revoked client pairedAt"),
		lastSeenAt: expectNumber(client.lastSeenAt, "revoked client lastSeenAt"),
		revokedAt: expectNumber(client.revokedAt, "revoked client revokedAt"),
		...parseOptionalStringRecordProperty(
			client.lastSessionIdByWorkspace,
			"revoked client lastSessionIdByWorkspace",
			"revoked client last session workspace",
			"revoked client last session id",
		),
		...(rePairApprovedAt === undefined ? {} : { rePairApprovedAt }),
	};
}

export function parseIrohRemotePairingSecretTombstone(value: unknown): IrohRemotePairingSecretTombstone {
	const tombstone = expectRecord(value, "Iroh remote pairing secret tombstone");
	const outcome = expectPairingSecretTombstoneOutcome(tombstone.outcome);
	const createdAt = expectOptionalNumber(tombstone.createdAt, "pairing secret tombstone createdAt");
	const expiresAt = expectOptionalNumber(tombstone.expiresAt, "pairing secret tombstone expiresAt");
	const labelHint = expectOptionalString(tombstone.labelHint, "pairing secret tombstone labelHint");
	const common = {
		secretHash: expectString(tombstone.secretHash, "pairing secret tombstone secretHash"),
		workspace: expectString(tombstone.workspace, "pairing secret tombstone workspace"),
		outcome,
		retainUntil: expectNumber(tombstone.retainUntil, "pairing secret tombstone retainUntil"),
		...(createdAt === undefined ? {} : { createdAt }),
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(labelHint === undefined ? {} : { labelHint }),
	};
	if (outcome === "pairing_secret_consumed") {
		return {
			...common,
			consumedAt: expectNumber(tombstone.consumedAt, "pairing secret tombstone consumedAt"),
			clientNodeId: expectString(tombstone.clientNodeId, "pairing secret tombstone clientNodeId"),
		};
	}
	return {
		...common,
		expiredAt: expectNumber(tombstone.expiredAt, "pairing secret tombstone expiredAt"),
	};
}

export function parseIrohRemotePendingPairingTicket(
	value: unknown,
	options?: IrohRemoteStateParseOptions,
): IrohRemotePendingPairingTicket {
	const ticket = expectRecord(value, "Iroh remote pending pairing ticket");
	const labelHint = expectOptionalString(ticket.labelHint, "pending pairing ticket labelHint");
	const relayCredentialClaimId = expectOptionalString(
		ticket.relayCredentialClaimId,
		"pending pairing ticket relayCredentialClaimId",
	);
	if (relayCredentialClaimId !== undefined && !/^[A-Za-z0-9_-]{24}$/.test(relayCredentialClaimId)) {
		throw new Error("pending pairing ticket relayCredentialClaimId is invalid");
	}
	const allowedTools = canonicalizePersistedIrohRemoteAllowTools(
		expectOptionalAllowTools(ticket.allowedTools, "pending pairing ticket allowedTools"),
		options?.defaultAllowTools,
	);
	return {
		secretHash: expectString(ticket.secretHash, "pending pairing ticket secretHash"),
		workspace: expectString(ticket.workspace, "pending pairing ticket workspace"),
		...(allowedTools === undefined ? {} : { allowedTools }),
		rpcGrant: parseIrohRemoteRpcGrant(ticket.rpcGrant, "pending pairing ticket rpcGrant"),
		expiresAt: expectNumber(ticket.expiresAt, "pending pairing ticket expiresAt"),
		createdAt: expectNumber(ticket.createdAt, "pending pairing ticket createdAt"),
		...(labelHint === undefined ? {} : { labelHint }),
		...(relayCredentialClaimId === undefined ? {} : { relayCredentialClaimId }),
	};
}

function parseArray<T>(value: unknown, label: string, parseEntry: (value: unknown) => T): T[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((entry) => parseEntry(entry));
}

function parseOptionalArray<T>(value: unknown, label: string, parseEntry: (value: unknown) => T): T[] {
	if (value === undefined) {
		return [];
	}
	return parseArray(value, label, parseEntry);
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

function parseOptionalStringRecordProperty(
	value: unknown,
	label: string,
	keyLabel: string,
	valueLabel: string,
): { lastSessionIdByWorkspace?: Record<string, string> } {
	if (value === undefined) {
		return {};
	}
	const record = expectRecord(value, label);
	const parsed: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (key.length === 0) {
			throw new Error(`${keyLabel} must be a non-empty string`);
		}
		parsed[key] = expectString(entry, valueLabel);
	}
	return { lastSessionIdByWorkspace: parsed };
}

function parseOptionalPushTargetsProperty(value: unknown, label: string): { pushTargets?: IrohRemotePushTarget[] } {
	if (value === undefined) {
		return {};
	}
	return { pushTargets: parseArray(value, label, parseIrohRemotePushTarget) };
}

function expectPairingSecretTombstoneOutcome(value: unknown): IrohRemotePairingSecretTombstoneOutcome {
	if (value === "pairing_secret_consumed" || value === "pairing_secret_expired") {
		return value;
	}
	throw new Error("pairing secret tombstone outcome must be pairing_secret_consumed or pairing_secret_expired");
}

function expectPushTargetProvider(value: unknown, label: string): IrohRemotePushTargetProvider {
	if (value === "fcm") {
		return value;
	}
	throw new Error(`${label} must be fcm`);
}

function expectPushTargetPlatform(value: unknown, label: string): IrohRemotePushTargetPlatform {
	if (value === "ios") {
		return value;
	}
	throw new Error(`${label} must be ios`);
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

function expectAllowTools(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a string`);
	}
	return value;
}

function expectOptionalAllowTools(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : expectAllowTools(value, label);
}

function expectOptionalNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectNumber(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

function expectNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function expectNonNegativeSafeInteger(value: unknown, label: string): number {
	const parsed = expectNumber(value, label);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return parsed;
}

function expectPositiveSafeInteger(value: unknown, label: string): number {
	const parsed = expectNumber(value, label);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return parsed;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
