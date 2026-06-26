import { Buffer } from "node:buffer";
import {
	IROH_REMOTE_ALPN,
	IROH_REMOTE_CONVERSATION_STREAMS_FEATURE,
	IROH_REMOTE_HANDSHAKE_TYPE,
	IROH_REMOTE_HELLO_TYPE,
	IROH_REMOTE_MULTI_STREAMS_FEATURE,
	type IrohRemoteHostHandshakeFailureOutcome,
	type IrohRemoteOutcome,
	IrohRemoteOutcomeError,
	isIrohRemoteOutcome,
} from "./protocol.ts";

export type IrohRemoteConversationTarget =
	| {
			target: "last";
	  }
	| {
			target: "new";
	  }
	| {
			target: "session";
			sessionId: string;
	  };

export type IrohRemoteConversationSelection = "resumed" | "created" | "created_missing_last";

export interface IrohRemoteConversationHandshakeMetadata {
	target: IrohRemoteConversationTarget["target"];
	sessionId: string;
	selection: IrohRemoteConversationSelection;
}

export interface IrohRemoteWorkspaceDiscoveryTarget {
	purpose: "list_sessions";
}

export interface IrohRemoteWorkspaceManagementTarget {
	purpose: "unregister_workspace";
}

export type IrohRemoteHelloMode =
	| {
			mode: "conversation";
			conversation: IrohRemoteConversationTarget;
	  }
	| {
			mode: "workspaceDiscovery";
			workspaceDiscovery: IrohRemoteWorkspaceDiscoveryTarget;
	  }
	| {
			mode: "workspaceManagement";
			workspaceManagement: IrohRemoteWorkspaceManagementTarget;
	  }
	| {
			mode: "legacyWorkspace";
	  };

interface IrohRemoteHelloBase {
	type: typeof IROH_REMOTE_HELLO_TYPE;
	protocol: typeof IROH_REMOTE_ALPN;
	workspace: string;
	secret?: string;
	clientLabel?: string;
	clientNodeId?: string;
}

export type IrohRemoteHello = IrohRemoteHelloBase & IrohRemoteHelloMode;

export interface IrohRemoteHelloParseOptions {
	allowLegacyWorkspaceMode?: boolean;
}

export const IROH_REMOTE_SESSION_ID_PATTERN = /^[a-z0-9_-]{1,128}$/;

export interface IrohRemoteHandshakeSuccess {
	type: typeof IROH_REMOTE_HANDSHAKE_TYPE;
	success: true;
	workspace: string;
	hostNodeId?: string;
	clientNodeId: string;
	features?: string[];
	sessionId?: string;
	conversation?: IrohRemoteConversationHandshakeMetadata;
	workspaceDiscovery?: IrohRemoteWorkspaceDiscoveryTarget;
	workspaceManagement?: IrohRemoteWorkspaceManagementTarget;
	child?: string;
}

export interface IrohRemoteHandshakeFailure {
	type: typeof IROH_REMOTE_HANDSHAKE_TYPE;
	success: false;
	outcome?: IrohRemoteOutcome;
	hostNodeId?: string;
	workspace?: string;
	sessionId?: string;
	retryAfterMs?: number;
	error: string;
}

export type IrohRemoteHandshakeResponse = IrohRemoteHandshakeSuccess | IrohRemoteHandshakeFailure;

export class IrohRemoteHandshakeError extends Error {
	readonly outcome: IrohRemoteHostHandshakeFailureOutcome;

	constructor(outcome: IrohRemoteHostHandshakeFailureOutcome, message: string) {
		super(message);
		this.name = "IrohRemoteHandshakeError";
		this.outcome = outcome;
	}
}

export function parseIrohRemoteHelloLine(line: string, options: IrohRemoteHelloParseOptions = {}): IrohRemoteHello {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		throw new IrohRemoteHandshakeError(
			"invalid_conversation_target",
			`Failed to parse Iroh remote handshake: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseIrohRemoteHello(parsed, options);
}

export function parseIrohRemoteHandshakeResponseLine(line: string): IrohRemoteHandshakeResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		throw new Error(
			`Failed to parse Iroh remote handshake response: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseIrohRemoteHandshakeResponse(parsed);
}

export function parseIrohRemoteHello(value: unknown, options: IrohRemoteHelloParseOptions = {}): IrohRemoteHello {
	const hello = expectRecord(value, "Iroh remote handshake");
	if (hello.type !== IROH_REMOTE_HELLO_TYPE) {
		throw new Error("unexpected handshake type");
	}
	if (hello.protocol !== IROH_REMOTE_ALPN) {
		throw new Error(`unsupported protocol: ${typeof hello.protocol === "string" ? hello.protocol : "<missing>"}`);
	}

	const workspace = expectWorkspaceName(hello.workspace, "handshake workspace");
	const mode = parseIrohRemoteHelloMode(hello, options);
	return {
		type: IROH_REMOTE_HELLO_TYPE,
		protocol: IROH_REMOTE_ALPN,
		workspace,
		secret: expectOptionalString(hello.secret, "handshake secret"),
		clientLabel: expectOptionalString(hello.clientLabel, "handshake clientLabel"),
		clientNodeId: expectOptionalString(hello.clientNodeId, "handshake clientNodeId"),
		...mode,
	};
}

export function parseIrohRemoteHandshakeResponse(value: unknown): IrohRemoteHandshakeResponse {
	const response = expectRecord(value, "Iroh remote handshake response");
	if (response.type !== IROH_REMOTE_HANDSHAKE_TYPE) {
		throw new Error("unexpected handshake response type");
	}
	if (response.success === true) {
		const hostNodeId = expectOptionalString(response.hostNodeId, "handshake response hostNodeId");
		const features = parseOptionalFeatures(response.features);
		const modeMetadata = parseOptionalHandshakeSuccessMode(response);
		if (hasHandshakeSuccessModeMetadata(modeMetadata) && hostNodeId === undefined) {
			throw new Error("handshake response hostNodeId is required for stream mode success");
		}
		const success: IrohRemoteHandshakeSuccess = {
			type: IROH_REMOTE_HANDSHAKE_TYPE,
			success: true,
			workspace: expectString(response.workspace, "handshake response workspace"),
			clientNodeId: expectString(response.clientNodeId, "handshake response clientNodeId"),
			...(features === undefined ? {} : { features }),
			...modeMetadata,
			child: expectOptionalString(response.child, "handshake response child"),
		};
		return hostNodeId === undefined ? success : { ...success, hostNodeId };
	}
	if (response.success === false) {
		const outcome = expectOptionalOutcome(response.outcome, "handshake response outcome");
		const hostNodeId = expectOptionalString(response.hostNodeId, "handshake response hostNodeId");
		const workspace = expectOptionalString(response.workspace, "handshake response workspace");
		const sessionId = expectOptionalRemoteSessionId(response.sessionId, "handshake response sessionId");
		const retryAfterMs = expectOptionalNumber(response.retryAfterMs, "handshake response retryAfterMs");
		const failure: IrohRemoteHandshakeFailure = {
			type: IROH_REMOTE_HANDSHAKE_TYPE,
			success: false,
			error: expectString(response.error, "handshake response error"),
		};
		return {
			...failure,
			...(outcome === undefined ? {} : { outcome }),
			...(hostNodeId === undefined ? {} : { hostNodeId }),
			...(workspace === undefined ? {} : { workspace }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		};
	}
	throw new Error("handshake response success must be a boolean");
}

export function createIrohRemoteHandshakeSuccess(options: {
	workspace: string;
	hostNodeId?: string;
	clientNodeId: string;
	features?: string[];
	sessionId?: string;
	conversation?: IrohRemoteConversationHandshakeMetadata;
	workspaceDiscovery?: IrohRemoteWorkspaceDiscoveryTarget;
	workspaceManagement?: IrohRemoteWorkspaceManagementTarget;
	child?: string;
}): IrohRemoteHandshakeSuccess {
	const response: IrohRemoteHandshakeSuccess = {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: true,
		workspace: options.workspace,
		...(options.hostNodeId === undefined ? {} : { hostNodeId: options.hostNodeId }),
		clientNodeId: options.clientNodeId,
		...(options.features === undefined ? {} : { features: [...options.features] }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		...(options.conversation === undefined ? {} : { conversation: { ...options.conversation } }),
		...(options.workspaceDiscovery === undefined ? {} : { workspaceDiscovery: { ...options.workspaceDiscovery } }),
		...(options.workspaceManagement === undefined ? {} : { workspaceManagement: { ...options.workspaceManagement } }),
		child: options.child,
	};
	return response;
}

export function createIrohRemoteHandshakeFailure(
	error: string,
	options: {
		hostNodeId?: string;
		outcome?: IrohRemoteHostHandshakeFailureOutcome;
		workspace?: string;
		sessionId?: string;
		retryAfterMs?: number;
	} = {},
): IrohRemoteHandshakeFailure {
	return {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: false,
		...(options.outcome === undefined ? {} : { outcome: options.outcome }),
		...(options.hostNodeId === undefined ? {} : { hostNodeId: options.hostNodeId }),
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
		error,
	};
}

export function assertIrohRemoteHandshakeHostIdentity(
	response: IrohRemoteHandshakeResponse,
	expectedHostNodeId: string | undefined,
): void {
	if (expectedHostNodeId === undefined) {
		return;
	}
	const actualHostNodeId = response.hostNodeId;
	if (actualHostNodeId !== expectedHostNodeId) {
		throw new IrohRemoteOutcomeError(
			"host_identity_mismatch",
			`expected ${expectedHostNodeId}, got ${actualHostNodeId ?? "<missing>"}`,
		);
	}
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectRecordForOutcome(
	value: unknown,
	label: string,
	outcome: IrohRemoteHostHandshakeFailureOutcome,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IrohRemoteHandshakeError(outcome, `${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function expectStringForOutcome(value: unknown, label: string, outcome: IrohRemoteHostHandshakeFailureOutcome): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new IrohRemoteHandshakeError(outcome, `${label} must be a non-empty string`);
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
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function expectWorkspaceName(value: unknown, label: string): string {
	const workspace = expectStringForOutcome(value, label, "invalid_workspace");
	const validationError = getIrohRemoteWorkspaceNameValidationError(workspace, label);
	if (validationError) {
		throw new IrohRemoteHandshakeError("invalid_workspace", validationError);
	}
	return workspace;
}

export function isIrohRemoteWorkspaceName(value: unknown): value is string {
	return typeof value === "string" && getIrohRemoteWorkspaceNameValidationError(value, "workspace") === undefined;
}

function getIrohRemoteWorkspaceNameValidationError(value: string, label: string): string | undefined {
	if (value.length === 0) {
		return `${label} must be a non-empty string`;
	}
	if (hasAsciiControlCharacter(value)) {
		return `${label} must not contain ASCII control characters`;
	}
	if (Array.from(value).length > 255 || Buffer.byteLength(value, "utf8") > 1024) {
		return `${label} exceeds maximum length`;
	}
	return undefined;
}

function hasAsciiControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

export function isIrohRemoteSessionId(value: unknown): value is string {
	return typeof value === "string" && IROH_REMOTE_SESSION_ID_PATTERN.test(value);
}

function parseIrohRemoteHelloMode(
	hello: Record<string, unknown>,
	options: IrohRemoteHelloParseOptions,
): IrohRemoteHelloMode {
	const modeKeys = (["conversation", "workspaceDiscovery", "workspaceManagement"] as const).filter(
		(key) => hello[key] !== undefined,
	);
	if (modeKeys.length === 0 && options.allowLegacyWorkspaceMode === true) {
		return { mode: "legacyWorkspace" };
	}
	if (modeKeys.length !== 1) {
		throw new IrohRemoteHandshakeError(
			"invalid_conversation_target",
			"Iroh remote hello must include exactly one stream mode",
		);
	}
	const modeKey = modeKeys[0];
	if (modeKey === "conversation") {
		return { mode: "conversation", conversation: parseConversationTarget(hello.conversation) };
	}
	if (modeKey === "workspaceDiscovery") {
		return {
			mode: "workspaceDiscovery",
			workspaceDiscovery: parseWorkspaceDiscoveryTarget(hello.workspaceDiscovery),
		};
	}
	return {
		mode: "workspaceManagement",
		workspaceManagement: parseWorkspaceManagementTarget(hello.workspaceManagement),
	};
}

function parseConversationTarget(value: unknown): IrohRemoteConversationTarget {
	const target = expectRecordForOutcome(value, "handshake conversation", "invalid_conversation_target");
	expectKnownFields(target, "handshake conversation", ["target", "sessionId"]);
	const targetKind = expectStringForOutcome(
		target.target,
		"handshake conversation target",
		"invalid_conversation_target",
	);
	if (targetKind === "last" || targetKind === "new") {
		if (target.sessionId !== undefined) {
			throw new IrohRemoteHandshakeError(
				"invalid_conversation_target",
				`handshake conversation ${targetKind} target must not include sessionId`,
			);
		}
		return { target: targetKind };
	}
	if (targetKind === "session") {
		return {
			target: "session",
			sessionId: expectRemoteSessionId(target.sessionId, "handshake conversation sessionId"),
		};
	}
	throw new IrohRemoteHandshakeError("invalid_conversation_target", "unsupported conversation target");
}

function parseWorkspaceDiscoveryTarget(value: unknown): IrohRemoteWorkspaceDiscoveryTarget {
	const target = expectRecordForOutcome(value, "handshake workspaceDiscovery", "invalid_conversation_target");
	expectKnownFields(target, "handshake workspaceDiscovery", ["purpose"]);
	const purpose = expectStringForOutcome(
		target.purpose,
		"handshake workspaceDiscovery purpose",
		"invalid_conversation_target",
	);
	if (purpose !== "list_sessions") {
		throw new IrohRemoteHandshakeError("invalid_conversation_target", "unsupported workspaceDiscovery purpose");
	}
	return { purpose };
}

function parseWorkspaceManagementTarget(value: unknown): IrohRemoteWorkspaceManagementTarget {
	const target = expectRecordForOutcome(value, "handshake workspaceManagement", "invalid_conversation_target");
	expectKnownFields(target, "handshake workspaceManagement", ["purpose"]);
	const purpose = expectStringForOutcome(
		target.purpose,
		"handshake workspaceManagement purpose",
		"invalid_conversation_target",
	);
	if (purpose !== "unregister_workspace") {
		throw new IrohRemoteHandshakeError("invalid_conversation_target", "unsupported workspaceManagement purpose");
	}
	return { purpose };
}

function expectKnownFields(value: Record<string, unknown>, label: string, allowedFields: readonly string[]): void {
	const allowed = new Set(allowedFields);
	for (const field of Object.keys(value)) {
		if (!allowed.has(field)) {
			throw new IrohRemoteHandshakeError("invalid_conversation_target", `${label} has unexpected field ${field}`);
		}
	}
}

function expectKnownResponseFields(
	value: Record<string, unknown>,
	label: string,
	allowedFields: readonly string[],
): void {
	const allowed = new Set(allowedFields);
	for (const field of Object.keys(value)) {
		if (!allowed.has(field)) {
			throw new Error(`${label} has unexpected field ${field}`);
		}
	}
}

function expectRemoteSessionId(value: unknown, label: string): string {
	const sessionId = expectStringForOutcome(value, label, "invalid_conversation_target");
	if (!isIrohRemoteSessionId(sessionId)) {
		throw new IrohRemoteHandshakeError(
			"invalid_conversation_target",
			`${label} must match lowercase remote session ID syntax`,
		);
	}
	return sessionId;
}

function expectOptionalRemoteSessionId(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectRemoteSessionIdForResponse(value, label);
}

function expectOptionalOutcome(value: unknown, label: string): IrohRemoteOutcome | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isIrohRemoteOutcome(value)) {
		throw new Error(`${label} must be a known Iroh remote outcome`);
	}
	return value;
}

function parseOptionalFeatures(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return [];
	}
	const features: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) {
			return [];
		}
		features.push(entry);
	}
	return features;
}

function parseOptionalHandshakeSuccessMode(
	response: Record<string, unknown>,
): Pick<IrohRemoteHandshakeSuccess, "sessionId" | "conversation" | "workspaceDiscovery" | "workspaceManagement"> {
	const modeKeys = (["conversation", "workspaceDiscovery", "workspaceManagement"] as const).filter(
		(key) => response[key] !== undefined,
	);
	if (modeKeys.length === 0) {
		return {};
	}
	if (modeKeys.length !== 1) {
		throw new Error("handshake response success must include exactly one stream mode");
	}
	assertRequiredHandshakeFeatures(parseOptionalFeatures(response.features));
	const modeKey = modeKeys[0];
	if (modeKey === "conversation") {
		const sessionId = expectString(response.sessionId, "handshake response sessionId");
		const conversation = parseConversationHandshakeMetadata(response.conversation);
		if (conversation.sessionId !== sessionId) {
			throw new Error("handshake response conversation sessionId must match top-level sessionId");
		}
		return { sessionId, conversation };
	}
	if (response.sessionId !== undefined) {
		throw new Error(`handshake response ${modeKey} must not include sessionId`);
	}
	if (modeKey === "workspaceDiscovery") {
		return { workspaceDiscovery: parseWorkspaceDiscoveryResponseMetadata(response.workspaceDiscovery) };
	}
	return { workspaceManagement: parseWorkspaceManagementResponseMetadata(response.workspaceManagement) };
}

function hasHandshakeSuccessModeMetadata(
	metadata: Pick<
		IrohRemoteHandshakeSuccess,
		"sessionId" | "conversation" | "workspaceDiscovery" | "workspaceManagement"
	>,
): boolean {
	return (
		metadata.conversation !== undefined ||
		metadata.workspaceDiscovery !== undefined ||
		metadata.workspaceManagement !== undefined
	);
}

function assertRequiredHandshakeFeatures(features: string[] | undefined): void {
	if (
		features === undefined ||
		!features.includes(IROH_REMOTE_MULTI_STREAMS_FEATURE) ||
		!features.includes(IROH_REMOTE_CONVERSATION_STREAMS_FEATURE)
	) {
		throw new Error("handshake response features must include required Iroh remote stream features");
	}
}

function parseConversationHandshakeMetadata(value: unknown): IrohRemoteConversationHandshakeMetadata {
	const metadata = expectRecord(value, "handshake response conversation");
	expectKnownResponseFields(metadata, "handshake response conversation", ["target", "sessionId", "selection"]);
	const conversation: IrohRemoteConversationHandshakeMetadata = {
		target: expectConversationTargetKind(metadata.target, "handshake response conversation target"),
		sessionId: expectRemoteSessionIdForResponse(metadata.sessionId, "handshake response conversation sessionId"),
		selection: expectConversationSelection(metadata.selection, "handshake response conversation selection"),
	};
	assertConversationTargetSelection(conversation);
	return conversation;
}

function expectConversationTargetKind(value: unknown, label: string): IrohRemoteConversationTarget["target"] {
	const target = expectString(value, label);
	if (target === "last" || target === "new" || target === "session") {
		return target;
	}
	throw new Error(`${label} must be a supported conversation target`);
}

function expectConversationSelection(value: unknown, label: string): IrohRemoteConversationSelection {
	const selection = expectString(value, label);
	if (selection === "resumed" || selection === "created" || selection === "created_missing_last") {
		return selection;
	}
	throw new Error(`${label} must be a supported conversation selection`);
}

function assertConversationTargetSelection(conversation: IrohRemoteConversationHandshakeMetadata): void {
	if (conversation.target === "new" && conversation.selection !== "created") {
		throw new Error("handshake response new target must use created selection");
	}
	if (conversation.target === "session" && conversation.selection !== "resumed") {
		throw new Error("handshake response session target must use resumed selection");
	}
}

function expectRemoteSessionIdForResponse(value: unknown, label: string): string {
	const sessionId = expectString(value, label);
	if (!isIrohRemoteSessionId(sessionId)) {
		throw new Error(`${label} must match lowercase remote session ID syntax`);
	}
	return sessionId;
}

function parseWorkspaceDiscoveryResponseMetadata(value: unknown): IrohRemoteWorkspaceDiscoveryTarget {
	const metadata = expectRecord(value, "handshake response workspaceDiscovery");
	expectKnownResponseFields(metadata, "handshake response workspaceDiscovery", ["purpose"]);
	if (metadata.purpose !== "list_sessions") {
		throw new Error("handshake response workspaceDiscovery purpose must be list_sessions");
	}
	return { purpose: "list_sessions" };
}

function parseWorkspaceManagementResponseMetadata(value: unknown): IrohRemoteWorkspaceManagementTarget {
	const metadata = expectRecord(value, "handshake response workspaceManagement");
	expectKnownResponseFields(metadata, "handshake response workspaceManagement", ["purpose"]);
	if (metadata.purpose !== "unregister_workspace") {
		throw new Error("handshake response workspaceManagement purpose must be unregister_workspace");
	}
	return { purpose: "unregister_workspace" };
}
