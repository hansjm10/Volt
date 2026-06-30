import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS, normalizeIrohRemoteAllowTools } from "./protocol.ts";

export interface IrohRemoteWorkspace {
	name: string;
	path: string;
	allowedTools?: string;
}

export type IrohRemotePushTargetProvider = "fcm";
export type IrohRemotePushTargetPlatform = "ios";
export type IrohRemotePushTokenEnvironment = "development" | "production";

export interface IrohRemoteLiveActivityTarget {
	activityId: string;
	pushToken: string;
	tokenHash?: string;
	tokenEnvironment?: IrohRemotePushTokenEnvironment;
	updatedAt: number;
}

export interface IrohRemotePushTarget {
	id: string;
	provider: IrohRemotePushTargetProvider;
	platform: IrohRemotePushTargetPlatform;
	pushTargetAuthToken: string;
	relayUrl?: string;
	tokenHash?: string;
	liveActivity?: IrohRemoteLiveActivityTarget;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface IrohRemoteLiveActivityRegistration {
	workspaceName: string;
	sessionId: string;
	activityId: string;
	tokenHash: string;
	tokenEnvironment: IrohRemotePushTokenEnvironment;
	platform: IrohRemotePushTargetPlatform;
	pushTargetId: string;
	createdAt: number;
	updatedAt: number;
}

export interface IrohRemoteClient {
	nodeId: string;
	label: string;
	allowedWorkspaces: string[];
	allowedTools: string;
	pairedAt: number;
	lastSeenAt: number;
	lastSessionIdByWorkspace?: Record<string, string>;
	pushTargets?: IrohRemotePushTarget[];
	liveActivities?: IrohRemoteLiveActivityRegistration[];
}

export interface IrohRemoteRevokedClient {
	nodeId: string;
	label: string;
	allowedWorkspaces: string[];
	allowedTools: string;
	pairedAt: number;
	lastSeenAt: number;
	revokedAt: number;
	lastSessionIdByWorkspace?: Record<string, string>;
	rePairApprovedAt?: number;
}

export interface IrohRemotePendingPairingTicket {
	secretHash: string;
	workspace: string;
	allowedTools: string;
	expiresAt: number;
	createdAt: number;
	labelHint?: string;
}

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
	workspaces: IrohRemoteWorkspace[];
	clients: IrohRemoteClient[];
	revokedClients?: IrohRemoteRevokedClient[];
	pendingPairingTickets?: IrohRemotePendingPairingTicket[];
}

export function createEmptyIrohRemoteHostState(): IrohRemoteHostState {
	return {
		hostSecretKey: undefined,
		pairingSecretTombstones: [],
		workspaces: [],
		clients: [],
		revokedClients: [],
		pendingPairingTickets: [],
	};
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
	await writeFile(tempPath, `${JSON.stringify(serializeIrohRemoteHostState(state), null, 2)}\n`, { mode: 0o600 });
	await rename(tempPath, path);
}

export function parseIrohRemoteHostState(value: unknown): IrohRemoteHostState {
	const state = expectRecord(value, "Iroh remote host state");
	return {
		hostSecretKey: parseOptionalByteArray(state.hostSecretKey, "hostSecretKey"),
		pairingSecretTombstones: parseOptionalArray(
			state.pairingSecretTombstones,
			"pairingSecretTombstones",
			parseIrohRemotePairingSecretTombstone,
		),
		workspaces: parseArray(state.workspaces, "workspaces", parseIrohRemoteWorkspace),
		clients: parseArray(state.clients, "clients", parseIrohRemoteClient),
		revokedClients: parseOptionalArray(state.revokedClients, "revokedClients", parseIrohRemoteRevokedClient),
		pendingPairingTickets: parseOptionalArray(
			state.pendingPairingTickets,
			"pendingPairingTickets",
			parseIrohRemotePendingPairingTicket,
		),
	};
}

function serializeIrohRemoteHostState(state: IrohRemoteHostState): IrohRemoteHostState {
	return {
		hostSecretKey: state.hostSecretKey ? [...state.hostSecretKey] : undefined,
		pairingSecretTombstones: (state.pairingSecretTombstones ?? []).map((tombstone) => ({ ...tombstone })),
		workspaces: state.workspaces.map((workspace) => ({ ...workspace })),
		clients: state.clients.map((client) => ({
			...client,
			allowedWorkspaces: [...client.allowedWorkspaces],
			...(client.lastSessionIdByWorkspace
				? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } }
				: {}),
			...(client.pushTargets
				? {
						pushTargets: client.pushTargets.map((target) => ({
							...target,
							...(target.liveActivity ? { liveActivity: { ...target.liveActivity } } : {}),
						})),
					}
				: {}),
			...(client.liveActivities
				? { liveActivities: client.liveActivities.map((registration) => ({ ...registration })) }
				: {}),
		})),
		revokedClients: (state.revokedClients ?? []).map((client) => ({
			...client,
			allowedWorkspaces: [...client.allowedWorkspaces],
			...(client.lastSessionIdByWorkspace
				? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } }
				: {}),
		})),
		pendingPairingTickets: (state.pendingPairingTickets ?? []).map((ticket) => ({ ...ticket })),
	};
}

export function parseIrohRemoteWorkspace(value: unknown): IrohRemoteWorkspace {
	const workspace = expectRecord(value, "Iroh remote workspace");
	const allowedTools = expectOptionalString(workspace.allowedTools, "workspace allowedTools");
	return {
		name: expectString(workspace.name, "workspace name"),
		path: expectString(workspace.path, "workspace path"),
		allowedTools: allowedTools === undefined ? undefined : normalizeIrohRemoteAllowTools(allowedTools),
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
		allowedTools: normalizeIrohRemoteAllowTools(
			expectOptionalString(client.allowedTools, "client allowedTools") ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
		),
		pairedAt: expectNumber(client.pairedAt, "client pairedAt"),
		lastSeenAt: expectNumber(client.lastSeenAt, "client lastSeenAt"),
		...parseOptionalStringRecordProperty(
			client.lastSessionIdByWorkspace,
			"client lastSessionIdByWorkspace",
			"client last session workspace",
			"client last session id",
		),
		...parseOptionalPushTargetsProperty(client.pushTargets, "client pushTargets"),
		...parseOptionalLiveActivityRegistrationsProperty(client.liveActivities, "client liveActivities"),
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
		liveActivity: parseOptionalIrohRemoteLiveActivityTarget(target.liveActivity, "push target liveActivity"),
		enabled: expectBoolean(target.enabled, "push target enabled"),
		createdAt: expectNumber(target.createdAt, "push target createdAt"),
		updatedAt: expectNumber(target.updatedAt, "push target updatedAt"),
	};
}

function parseOptionalIrohRemoteLiveActivityTarget(
	value: unknown,
	label: string,
): IrohRemoteLiveActivityTarget | undefined {
	if (value === undefined) {
		return undefined;
	}
	const target = expectRecord(value, label);
	return {
		activityId: expectString(target.activityId, `${label} activityId`),
		pushToken: expectString(target.pushToken, `${label} pushToken`),
		tokenHash: expectOptionalString(target.tokenHash, `${label} tokenHash`),
		tokenEnvironment: expectOptionalPushTokenEnvironment(target.tokenEnvironment, `${label} tokenEnvironment`),
		updatedAt: expectNumber(target.updatedAt, `${label} updatedAt`),
	};
}

export function parseIrohRemoteLiveActivityRegistration(value: unknown): IrohRemoteLiveActivityRegistration {
	const registration = expectRecord(value, "live activity registration");
	return {
		workspaceName: expectString(registration.workspaceName, "live activity workspaceName"),
		sessionId: expectString(registration.sessionId, "live activity sessionId"),
		activityId: expectString(registration.activityId, "live activity activityId"),
		tokenHash: expectString(registration.tokenHash, "live activity tokenHash"),
		tokenEnvironment: expectPushTokenEnvironment(registration.tokenEnvironment, "live activity tokenEnvironment"),
		platform: expectPushTargetPlatform(registration.platform, "live activity platform"),
		pushTargetId: expectString(registration.pushTargetId, "live activity pushTargetId"),
		createdAt: expectNumber(registration.createdAt, "live activity createdAt"),
		updatedAt: expectNumber(registration.updatedAt, "live activity updatedAt"),
	};
}

export function parseIrohRemoteRevokedClient(value: unknown): IrohRemoteRevokedClient {
	const client = expectRecord(value, "Iroh remote revoked client");
	const rePairApprovedAt = expectOptionalNumber(client.rePairApprovedAt, "revoked client rePairApprovedAt");
	return {
		nodeId: expectString(client.nodeId, "revoked client nodeId"),
		label: expectString(client.label, "revoked client label"),
		allowedWorkspaces: parseArray(client.allowedWorkspaces, "revoked client allowedWorkspaces", (entry) =>
			expectString(entry, "revoked client allowed workspace"),
		),
		allowedTools: normalizeIrohRemoteAllowTools(
			expectOptionalString(client.allowedTools, "revoked client allowedTools") ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
		),
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

export function parseIrohRemotePendingPairingTicket(value: unknown): IrohRemotePendingPairingTicket {
	const ticket = expectRecord(value, "Iroh remote pending pairing ticket");
	const labelHint = expectOptionalString(ticket.labelHint, "pending pairing ticket labelHint");
	return {
		secretHash: expectString(ticket.secretHash, "pending pairing ticket secretHash"),
		workspace: expectString(ticket.workspace, "pending pairing ticket workspace"),
		allowedTools: normalizeIrohRemoteAllowTools(
			expectString(ticket.allowedTools, "pending pairing ticket allowedTools"),
		),
		expiresAt: expectNumber(ticket.expiresAt, "pending pairing ticket expiresAt"),
		createdAt: expectNumber(ticket.createdAt, "pending pairing ticket createdAt"),
		...(labelHint === undefined ? {} : { labelHint }),
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

function parseOptionalLiveActivityRegistrationsProperty(
	value: unknown,
	label: string,
): { liveActivities?: IrohRemoteLiveActivityRegistration[] } {
	if (value === undefined) {
		return {};
	}
	return { liveActivities: parseArray(value, label, parseIrohRemoteLiveActivityRegistration) };
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

function expectPushTokenEnvironment(value: unknown, label: string): IrohRemotePushTokenEnvironment {
	if (value === "development" || value === "production") {
		return value;
	}
	throw new Error(`${label} must be development or production`);
}

function expectOptionalPushTokenEnvironment(value: unknown, label: string): IrohRemotePushTokenEnvironment | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectPushTokenEnvironment(value, label);
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

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
