import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { IrohBiStreamLike, IrohBytes, IrohRecvStreamLike } from "../../rpc/index.ts";
import { cloneIrohRemoteRpcGrant, createIrohRemotePresetAccess, type IrohRemoteRpcGrant } from "./access-grant.ts";
import { type IrohRemoteAuditEventInput, IrohRemoteAuditLogger } from "./audit.ts";
import {
	hashIrohRemotePairingSecret,
	type IrohRemoteClientAuthorizationResult,
	type IrohRemoteClientAuthorizationSuccess,
} from "./authorization.ts";
import {
	assertIrohRemoteHandshakeHostIdentity,
	createIrohRemoteHandshakeFailure,
	createIrohRemoteHandshakeSuccess,
	type IrohRemoteConversationHandshakeMetadata,
	type IrohRemoteConversationSelection,
	IrohRemoteHandshakeError,
	type IrohRemoteHandshakeFailure,
	type IrohRemoteHandshakeResponse,
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
	parseIrohRemoteHandshakeResponseLine,
	parseIrohRemoteHelloLine,
} from "./handshake.ts";
import {
	type IrohRemoteHandshakeLineReadOptions,
	readIrohRemoteHandshakeLine,
	writeIrohRemoteHello,
} from "./handshake-reader.ts";
import { createIrohRemoteHostMetadata } from "./metadata.ts";
import {
	canonicalizePersistedIrohRemoteAllowTools,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HOST_FEATURES,
	type IrohRemoteRelayMode,
	normalizeIrohRemoteAllowTools,
} from "./protocol.ts";
import {
	type IrohRemoteClient,
	type IrohRemoteHostState,
	type IrohRemoteWorkspace,
	parseIrohRemoteWorkspace,
} from "./state.ts";
import type {
	IrohRemoteClientAccessUpdateResult,
	IrohRemoteClientRePairApprovalResult,
	IrohRemoteClientRevocationResult,
	IrohRemoteHostStateManager,
} from "./state-manager.ts";
import {
	assertIrohRemoteTicketNotExpired,
	decodeIrohRemoteTicketPayload,
	encodeIrohRemoteTicketPayload,
	type IrohRemoteTicketPayload,
} from "./ticket.ts";
import {
	findIrohRemoteWorkspace,
	type IrohRemoteWorkspaceAvailabilityClassifier,
	type IrohRemoteWorkspaceAvailabilityStatus,
} from "./workspace.ts";

export const DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;

export interface IrohRemoteHostEngineOptions {
	allowTools?: string;
	/** Default grant to canonicalize/resolve against; tests inject alternate defaults. */
	defaultAllowTools?: string;
	rpcGrant?: IrohRemoteRpcGrant;
	auditLogger?: IrohRemoteAuditLogger;
	hostNodeId?: string;
	now?: () => number;
	pairingExpiresAt?: number;
	pairingSecret?: string;
	relayMode?: IrohRemoteRelayMode;
	relayUrls?: string[];
	stateManager: IrohRemoteHostStateManager;
	classifyWorkspaceAvailability?: IrohRemoteWorkspaceAvailabilityClassifier;
	validateWorkspace?: (workspace: IrohRemoteWorkspace) => boolean | Promise<boolean>;
	workspace: IrohRemoteWorkspace;
}

export interface IrohRemoteHostPairOptions {
	allowTools?: string;
	rpcGrant?: IrohRemoteRpcGrant;
	expiresAt?: number;
	irohTicket: string;
	labelHint?: string;
	nodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	relayUrls?: string[];
	relayAuthToken?: string;
	secret?: string;
	ttlMs?: number;
	workspace?: string;
}

export interface IrohRemotePairingTicket {
	expiresAt: number;
	payload: IrohRemoteTicketPayload;
	secret: string;
	ticket: string;
}

export type IrohRemoteHostHandshakeResult =
	| {
			ok: true;
			authorization: IrohRemoteClientAuthorizationSuccess;
			hello: IrohRemoteHello;
			initialInput: IrohBytes;
			response: IrohRemoteHandshakeSuccess;
	  }
	| {
			ok: false;
			error: string;
			initialInput: IrohBytes;
			response: IrohRemoteHandshakeFailure;
	  };

export interface IrohRemoteHostReadHandshakeOptions extends IrohRemoteHandshakeLineReadOptions {
	child?: string;
	/** Prevent authorization/audit publication after the owning physical stream is fenced. */
	isCancelled?: () => boolean;
	conversationSession?: {
		selection: IrohRemoteConversationSelection;
		sessionId: string;
		requestedSessionId?: string;
	};
}

export interface IrohRemoteClientEngineOptions {
	auditLogger?: IrohRemoteAuditLogger;
	clientLabel?: string;
	clientNodeId?: string;
	now?: () => number;
}

export interface IrohRemoteClientTicketHello {
	hello: IrohRemoteHello;
	payload: IrohRemoteTicketPayload;
}

export interface IrohRemoteClientHandshakeResponseResult {
	initialInput: IrohBytes;
	response: IrohRemoteHandshakeResponse;
}

export interface IrohRemoteClientReadHandshakeResponseOptions extends IrohRemoteHandshakeLineReadOptions {
	expectedHostNodeId?: string;
}

function createConversationHandshakeMetadata(
	hello: IrohRemoteHello,
	conversationSession: { selection: IrohRemoteConversationSelection; sessionId: string; requestedSessionId?: string },
): IrohRemoteConversationHandshakeMetadata {
	if (hello.mode !== "conversation") {
		throw new Error("conversation handshake metadata requires a conversation hello");
	}
	return {
		target: hello.conversation.target,
		sessionId: conversationSession.sessionId,
		selection: conversationSession.selection,
		...(conversationSession.requestedSessionId === undefined
			? {}
			: { requestedSessionId: conversationSession.requestedSessionId }),
	};
}

function isEmptyIrohRemoteHostStateForRuntimePairingBootstrap(state: IrohRemoteHostState): boolean {
	return (
		state.workspaces.length === 0 &&
		state.clients.length === 0 &&
		(state.revokedClients ?? []).length === 0 &&
		(state.pendingPairingTickets ?? []).length === 0 &&
		(state.pairingSecretTombstones ?? []).length === 0
	);
}

export class IrohRemoteHostEngine {
	private readonly auditLogger: IrohRemoteAuditLogger;
	private readonly classifyWorkspaceAvailability: IrohRemoteWorkspaceAvailabilityClassifier | undefined;
	private readonly hostNodeId: string | undefined;
	private readonly relayMode: IrohRemoteRelayMode | undefined;
	private readonly relayUrls: string[] | undefined;
	private readonly now: () => number;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly validateWorkspace: ((workspace: IrohRemoteWorkspace) => boolean | Promise<boolean>) | undefined;
	private readonly workspace: IrohRemoteWorkspace;
	private authorizationQueue: Promise<void> = Promise.resolve();
	private allowTools: string;
	private readonly defaultAllowTools: string | undefined;
	private rpcGrant: IrohRemoteRpcGrant;
	private pairingAllowTools: string | undefined;
	private pairingRpcGrant: IrohRemoteRpcGrant | undefined;
	private pairingExpiresAt: number | undefined;
	private pairingSecret: string | undefined;
	private pairingWorkspaceName: string | undefined;

	constructor(options: IrohRemoteHostEngineOptions) {
		const defaultAccess = createIrohRemotePresetAccess("coding");
		this.defaultAllowTools = options.defaultAllowTools;
		this.allowTools = normalizeIrohRemoteAllowTools(options.allowTools, this.defaultAllowTools);
		this.rpcGrant = cloneIrohRemoteRpcGrant(options.rpcGrant ?? defaultAccess.rpcGrant);
		this.auditLogger = options.auditLogger ?? new IrohRemoteAuditLogger();
		this.classifyWorkspaceAvailability = options.classifyWorkspaceAvailability;
		this.hostNodeId = options.hostNodeId;
		this.relayMode = options.relayMode;
		this.relayUrls = options.relayUrls;
		this.now = options.now ?? Date.now;
		this.pairingExpiresAt = options.pairingExpiresAt;
		this.pairingSecret = options.pairingSecret;
		this.pairingWorkspaceName = options.pairingSecret === undefined ? undefined : options.workspace.name;
		this.stateManager = options.stateManager;
		this.validateWorkspace = options.validateWorkspace;
		this.workspace = parseIrohRemoteWorkspace(options.workspace);
	}

	async pair(options: IrohRemoteHostPairOptions): Promise<IrohRemotePairingTicket> {
		return this.runAuthorizationExclusive(async () => {
			const requestedWorkspace = options.workspace ?? this.workspace.name;
			const workspace = await this.resolvePairWorkspace(requestedWorkspace, options.workspace === undefined);

			const secret = options.secret ?? randomBytes(24).toString("base64url");
			const createdAt = this.now();
			const expiresAt =
				options.expiresAt ?? createdAt + (options.ttlMs ?? DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS);
			const requestedAllowTools = options.allowTools ?? workspace.allowedTools ?? this.allowTools;
			// Tickets carry customization intent, not a resolved snapshot: a
			// default-grant ticket stays default even if the default changes
			// between mint and consume.
			const persistedAllowTools = canonicalizePersistedIrohRemoteAllowTools(
				requestedAllowTools,
				this.defaultAllowTools,
			);
			const allowTools = normalizeIrohRemoteAllowTools(persistedAllowTools, this.defaultAllowTools);
			const rpcGrant = cloneIrohRemoteRpcGrant(options.rpcGrant ?? this.rpcGrant);
			this.pairingAllowTools = allowTools;
			this.pairingRpcGrant = rpcGrant;
			this.pairingSecret = secret;
			this.pairingExpiresAt = expiresAt;
			this.pairingWorkspaceName = workspace.name;
			const pendingPairingTicket = await this.stateManager.addPendingPairingTicket({
				secretHash: hashIrohRemotePairingSecret(secret),
				workspace: workspace.name,
				...(persistedAllowTools === undefined ? {} : { allowedTools: persistedAllowTools }),
				rpcGrant,
				expiresAt,
				createdAt,
				...(options.labelHint === undefined ? {} : { labelHint: options.labelHint }),
			});

			const payload: IrohRemoteTicketPayload = {
				alpn: IROH_REMOTE_ALPN,
				expiresAt,
				irohTicket: options.irohTicket,
				nodeId: options.nodeId,
				relayMode: options.relayMode,
				...(options.relayUrls === undefined ? {} : { relayUrls: options.relayUrls }),
				...(options.relayAuthToken === undefined ? {} : { relayAuthToken: options.relayAuthToken }),
				secret,
				workspace: workspace.name,
			};
			const ticket = encodeIrohRemoteTicketPayload(payload);
			await this.log({
				type: "pairing_ticket_created",
				workspace: payload.workspace,
				details: {
					allowedTools: normalizeIrohRemoteAllowTools(pendingPairingTicket.allowedTools, this.defaultAllowTools),
					usesDefaultTools: pendingPairingTicket.allowedTools === undefined,
					rpcGrant: pendingPairingTicket.rpcGrant,
					createdAt: pendingPairingTicket.createdAt,
					expiresAt: pendingPairingTicket.expiresAt,
					labelHint: pendingPairingTicket.labelHint,
					nodeId: options.nodeId,
					relayMode: options.relayMode,
				},
			});
			return { expiresAt, payload, secret, ticket };
		});
	}

	async listClients(): Promise<IrohRemoteClient[]> {
		const clients = await this.stateManager.listClients();
		await this.log({ type: "clients_listed", details: { count: clients.length } });
		return clients;
	}

	async revokeClient(nodeId: string): Promise<IrohRemoteClientRevocationResult> {
		const result = await this.stateManager.revokeClient(nodeId, this.now());
		await this.log({
			type: "client_revoked",
			clientNodeId: nodeId,
			success: result.revoked,
			error: result.revoked ? undefined : "client not found",
		});
		return result;
	}

	async updateClientAccess(
		nodeId: string,
		expectedRevision: number,
		access: { allowedTools: string; rpcGrant: IrohRemoteRpcGrant },
	): Promise<IrohRemoteClientAccessUpdateResult> {
		const result = await this.stateManager.updateClientAccess(nodeId, expectedRevision, access);
		await this.log({
			type: "client_access_updated",
			clientNodeId: nodeId,
			success: result.ok,
			error: result.ok ? undefined : result.reason,
			details: result.ok
				? {
						expectedRevision,
						revision: result.client.rpcGrant.revision,
						allowedTools: normalizeIrohRemoteAllowTools(result.client.allowedTools, this.defaultAllowTools),
						usesDefaultTools: result.client.allowedTools === undefined,
						rpcCapabilities: result.client.rpcGrant.capabilities,
					}
				: { expectedRevision, currentRevision: result.currentRevision },
		});
		return result;
	}

	async approveClientRePair(nodeId: string): Promise<IrohRemoteClientRePairApprovalResult> {
		const result = await this.stateManager.approveClientRePair(nodeId, this.now());
		await this.log({
			type: "client_repair_approved",
			clientNodeId: nodeId,
			success: result.approved,
			error: result.approved ? undefined : "revoked client not found",
		});
		return result;
	}

	async setClientLastSessionId(
		nodeId: string,
		workspace: string,
		sessionId: string,
	): Promise<IrohRemoteClient | undefined> {
		return this.stateManager.setClientLastSessionId(nodeId, workspace, sessionId);
	}

	setClientLastSessionIdIfAuthorizationCurrent(
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		expectedPreviousSessionId: string | undefined,
		whileAuthorizationLocked?: () => Promise<void>,
	) {
		return this.stateManager.setClientLastSessionIdIfAuthorizationCurrent(
			authorization,
			sessionId,
			expectedPreviousSessionId,
			whileAuthorizationLocked,
		);
	}

	setClientLastSessionIdIfCurrent(
		nodeId: string,
		workspace: string,
		expectedSessionId: string | undefined,
		nextSessionId: string,
	): Promise<boolean> {
		return this.stateManager.setClientLastSessionIdIfCurrent(nodeId, workspace, expectedSessionId, nextSessionId);
	}

	restoreClientLastSessionIdIfCurrent(
		nodeId: string,
		workspace: string,
		expectedSessionId: string,
		previousSessionId: string | undefined,
	): Promise<boolean> {
		return this.stateManager.restoreClientLastSessionIdIfCurrent(
			nodeId,
			workspace,
			expectedSessionId,
			previousSessionId,
		);
	}

	async authorizeHello(hello: IrohRemoteHello, remoteNodeId: string): Promise<IrohRemoteClientAuthorizationResult> {
		return this.runAuthorizationExclusive(() => this.authorizeHelloUnlocked(hello, remoteNodeId));
	}

	private async ensurePrimaryWorkspaceRegistered(): Promise<IrohRemoteWorkspace> {
		const state = await this.stateManager.getState();
		const workspace = findIrohRemoteWorkspace(state, this.workspace.name);
		if (workspace) {
			return workspace;
		}
		return await this.stateManager.upsertWorkspace(this.workspace);
	}

	private async resolvePairWorkspace(
		workspaceName: string,
		registerPrimaryFallback: boolean,
	): Promise<IrohRemoteWorkspace> {
		const workspace =
			registerPrimaryFallback && workspaceName === this.workspace.name
				? await this.ensurePrimaryWorkspaceRegistered()
				: findIrohRemoteWorkspace(await this.stateManager.getState(), workspaceName);
		if (!workspace) {
			throw new Error(`workspace_unavailable: workspace not registered: ${workspaceName}`);
		}
		if (this.classifyWorkspaceAvailability !== undefined) {
			let status: IrohRemoteWorkspaceAvailabilityStatus;
			try {
				status = await this.classifyWorkspaceAvailability(workspace);
			} catch {
				status = "unavailable";
			}
			if (status === "missing") {
				throw new Error(`workspace_missing: workspace path is missing: ${workspaceName}`);
			}
			if (status !== "available") {
				throw new Error(`workspace_unavailable: workspace path is unavailable: ${workspaceName}`);
			}
		}
		if (this.validateWorkspace !== undefined && !(await this.validateWorkspace(workspace))) {
			throw new Error(`workspace_unavailable: workspace path is unavailable: ${workspaceName}`);
		}
		return workspace;
	}

	private async authorizeHelloUnlocked(
		hello: IrohRemoteHello,
		remoteNodeId: string,
	): Promise<IrohRemoteClientAuthorizationResult> {
		await this.ensureRuntimePairingWorkspaceRegistered();
		const allowTools = normalizeIrohRemoteAllowTools(
			this.pairingSecret !== undefined && hello.secret === this.pairingSecret
				? (this.pairingAllowTools ?? this.allowTools)
				: this.allowTools,
			this.defaultAllowTools,
		);
		const result = await this.stateManager.authorizeClient(hello, remoteNodeId, {
			allowTools,
			...(this.defaultAllowTools === undefined ? {} : { defaultAllowTools: this.defaultAllowTools }),
			rpcGrant:
				this.pairingSecret !== undefined && hello.secret === this.pairingSecret
					? (this.pairingRpcGrant ?? this.rpcGrant)
					: this.rpcGrant,
			classifyWorkspaceAvailability: this.classifyWorkspaceAvailability,
			now: this.now(),
			pairingExpiresAt: this.pairingExpiresAt,
			pairingSecret: this.pairingSecret,
			validateWorkspace: this.validateWorkspace,
		});

		if (result.ok && result.pairingSecretConsumed) {
			this.clearPairingSecret();
		} else if (!result.ok && result.pairingSecretExpired) {
			this.clearPairingSecret();
		}

		await this.logPairingTicketLifecycle(result, remoteNodeId);
		await this.logAuthorization(hello, remoteNodeId, result);
		return result;
	}

	private runAuthorizationExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.authorizationQueue.then(operation, operation);
		this.authorizationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async readHandshake(
		recv: IrohRecvStreamLike,
		remoteNodeId: string,
		options: IrohRemoteHostReadHandshakeOptions = {},
	): Promise<IrohRemoteHostHandshakeResult> {
		let initialInput: IrohBytes = Buffer.alloc(0);
		try {
			const handshake = await readIrohRemoteHandshakeLine(recv, options);
			if (options.isCancelled?.()) {
				throw new Error("Iroh handshake stream closed");
			}
			initialInput = handshake.rest;
			if (handshake.line === undefined) {
				return await this.createHandshakeFailure("missing handshake", initialInput);
			}

			const hello = parseIrohRemoteHelloLine(handshake.line);
			const authorization = await this.authorizeHello(hello, remoteNodeId);
			if (!authorization.ok) {
				return {
					ok: false,
					error: authorization.error,
					initialInput,
					response: createIrohRemoteHandshakeFailure(authorization.error, {
						hostNodeId: this.hostNodeId,
						outcome: authorization.outcome,
						workspace: authorization.workspace?.name,
						retryAfterMs: authorization.retryAfterMs,
					}),
				};
			}

			return {
				ok: true,
				authorization,
				hello,
				initialInput,
				response: this.createHandshakeSuccessResponse(hello, authorization, remoteNodeId, options),
			};
		} catch (error: unknown) {
			if (options.isCancelled?.()) {
				throw error;
			}
			return await this.createHandshakeFailure(
				error instanceof Error ? error.message : String(error),
				initialInput,
				error,
			);
		}
	}

	setAllowTools(allowTools: string): void {
		this.allowTools = normalizeIrohRemoteAllowTools(allowTools, this.defaultAllowTools);
	}

	clearPairingSecretForWorkspace(workspaceName: string): boolean {
		if (this.pairingWorkspaceName !== workspaceName) {
			return false;
		}
		this.clearPairingSecret();
		return true;
	}

	async cancelPairingSecretByHash(secretHash: string): Promise<boolean> {
		return this.runAuthorizationExclusive(async () => {
			const liveSecretMatches =
				this.pairingSecret !== undefined && hashIrohRemotePairingSecret(this.pairingSecret) === secretHash;
			if (liveSecretMatches) this.clearPairingSecret();
			const removedPendingTicket = await this.stateManager.removePendingPairingTicket(secretHash);
			return liveSecretMatches || removedPendingTicket;
		});
	}

	private async ensureRuntimePairingWorkspaceRegistered(): Promise<void> {
		if (this.pairingSecret === undefined || this.pairingWorkspaceName !== this.workspace.name) {
			return;
		}
		const state = await this.stateManager.getState();
		if (findIrohRemoteWorkspace(state, this.workspace.name)) {
			return;
		}
		if (isEmptyIrohRemoteHostStateForRuntimePairingBootstrap(state)) {
			await this.stateManager.upsertWorkspace(this.workspace);
			return;
		}
		this.clearPairingSecret();
	}

	private clearPairingSecret(): void {
		this.pairingAllowTools = undefined;
		this.pairingRpcGrant = undefined;
		this.pairingSecret = undefined;
		this.pairingExpiresAt = undefined;
		this.pairingWorkspaceName = undefined;
	}

	private async createHandshakeFailure(
		error: string,
		initialInput: IrohBytes,
		cause?: unknown,
	): Promise<IrohRemoteHostHandshakeResult> {
		const outcome = cause instanceof IrohRemoteHandshakeError ? cause.outcome : undefined;
		await this.log({
			type: "handshake_rejected",
			workspace: this.workspace.name,
			success: false,
			error,
			details: outcome === undefined ? undefined : { outcome },
		});
		return {
			ok: false,
			error,
			initialInput,
			response: createIrohRemoteHandshakeFailure(error, {
				hostNodeId: this.hostNodeId,
				...(outcome === undefined ? {} : { outcome }),
			}),
		};
	}

	private createHandshakeSuccessResponse(
		hello: IrohRemoteHello,
		authorization: IrohRemoteClientAuthorizationSuccess,
		remoteNodeId: string,
		options: IrohRemoteHostReadHandshakeOptions,
	): IrohRemoteHandshakeSuccess {
		const common = {
			child: options.child,
			clientNodeId: remoteNodeId,
			features: [...IROH_REMOTE_HOST_FEATURES],
			hostNodeId: this.hostNodeId,
			remoteHost: createIrohRemoteHostMetadata({
				authorization,
				hostNodeId: this.hostNodeId,
				relayMode: this.relayMode,
				relayUrls: this.relayUrls,
				features: [...IROH_REMOTE_HOST_FEATURES],
			}),
			workspace: authorization.workspace.name,
		};
		if (hello.mode === "workspaceDiscovery") {
			return createIrohRemoteHandshakeSuccess({
				...common,
				workspaceDiscovery: { purpose: hello.workspaceDiscovery.purpose },
			});
		}
		if (hello.mode === "workspaceManagement") {
			return createIrohRemoteHandshakeSuccess({
				...common,
				workspaceManagement: { purpose: hello.workspaceManagement.purpose },
			});
		}
		if (options.conversationSession === undefined) {
			return createIrohRemoteHandshakeSuccess(common);
		}
		return createIrohRemoteHandshakeSuccess({
			...common,
			sessionId: options.conversationSession.sessionId,
			conversation: createConversationHandshakeMetadata(hello, options.conversationSession),
		});
	}

	private async logPairingTicketLifecycle(
		result: IrohRemoteClientAuthorizationResult,
		remoteNodeId: string,
	): Promise<void> {
		for (const ticket of result.expiredPairingTickets ?? []) {
			await this.log({
				type: "pairing_ticket_expired",
				workspace: ticket.workspace,
				success: false,
				details: {
					allowedTools: normalizeIrohRemoteAllowTools(ticket.allowedTools, this.defaultAllowTools),
					usesDefaultTools: ticket.allowedTools === undefined,
					rpcGrant: ticket.rpcGrant,
					createdAt: ticket.createdAt,
					expiresAt: ticket.expiresAt,
				},
			});
		}
		if (!result.ok || !result.pairingSecretConsumed) {
			return;
		}
		await this.log({
			type: "pairing_ticket_consumed",
			clientNodeId: remoteNodeId,
			workspace: result.workspace.name,
			success: true,
			details: result.consumedPairingTicket
				? {
						allowedTools: normalizeIrohRemoteAllowTools(
							result.consumedPairingTicket.allowedTools,
							this.defaultAllowTools,
						),
						usesDefaultTools: result.consumedPairingTicket.allowedTools === undefined,
						rpcGrant: result.consumedPairingTicket.rpcGrant,
						createdAt: result.consumedPairingTicket.createdAt,
						expiresAt: result.consumedPairingTicket.expiresAt,
						labelHint: result.consumedPairingTicket.labelHint,
					}
				: undefined,
		});
	}

	private async logAuthorization(
		hello: IrohRemoteHello,
		remoteNodeId: string,
		result: IrohRemoteClientAuthorizationResult,
	): Promise<void> {
		await this.log({
			type: result.ok ? "client_authorized" : "client_rejected",
			clientNodeId: remoteNodeId,
			workspace: hello.workspace,
			success: result.ok,
			error: result.ok ? undefined : result.error,
			details: result.ok
				? { paired: result.paired }
				: { outcome: result.outcome, pairingSecretExpired: result.pairingSecretExpired },
		});
	}

	private async log(event: IrohRemoteAuditEventInput): Promise<void> {
		try {
			await this.auditLogger.log(event);
		} catch (error) {
			// A valid handshake must not be reclassified as a failure when audit I/O
			// fails, but a dropped security-relevant event must not vanish silently.
			// Surface it to the daemon log (captured stderr) so the omission is visible.
			console.error(
				`[iroh-remote] failed to write audit event ${event.type}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}

export class IrohRemoteClientEngine {
	private readonly auditLogger: IrohRemoteAuditLogger;
	private readonly clientLabel: string | undefined;
	private readonly clientNodeId: string | undefined;
	private readonly now: () => number;

	constructor(options: IrohRemoteClientEngineOptions = {}) {
		this.auditLogger = options.auditLogger ?? new IrohRemoteAuditLogger();
		this.clientLabel = options.clientLabel;
		this.clientNodeId = options.clientNodeId;
		this.now = options.now ?? Date.now;
	}

	async createHelloFromTicket(ticket: string): Promise<IrohRemoteClientTicketHello> {
		const payload = decodeIrohRemoteTicketPayload(ticket);
		assertIrohRemoteTicketNotExpired(payload, this.now());
		const hello = this.createHello(payload);
		await this.log({
			type: "ticket_loaded",
			workspace: payload.workspace,
			details: { nodeId: payload.nodeId, relayMode: payload.relayMode },
		});
		return { hello, payload };
	}

	createHello(payload: IrohRemoteTicketPayload): IrohRemoteHello {
		return {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: payload.workspace,
			secret: payload.secret,
			clientLabel: this.clientLabel,
			clientNodeId: this.clientNodeId,
			mode: "conversation",
			conversation: { target: "last" },
		};
	}

	async writeHello(stream: IrohBiStreamLike, payload: IrohRemoteTicketPayload): Promise<IrohRemoteHello> {
		const hello = this.createHello(payload);
		await writeIrohRemoteHello(stream.send, hello);
		await this.log({
			type: "hello_sent",
			workspace: payload.workspace,
			details: { nodeId: payload.nodeId },
		});
		return hello;
	}

	async readHandshakeResponse(
		recv: IrohRecvStreamLike,
		options: IrohRemoteClientReadHandshakeResponseOptions = {},
	): Promise<IrohRemoteClientHandshakeResponseResult> {
		const handshake = await readIrohRemoteHandshakeLine(recv, options);
		if (handshake.line === undefined) {
			throw new Error("missing handshake response");
		}
		const response = parseIrohRemoteHandshakeResponseLine(handshake.line);
		assertIrohRemoteHandshakeHostIdentity(response, options.expectedHostNodeId);
		await this.log({
			type: "handshake_response_received",
			workspace: response.success ? response.workspace : undefined,
			success: response.success,
			error: response.success ? undefined : response.error,
			details: response.success ? undefined : { outcome: response.outcome },
		});
		return { initialInput: handshake.rest, response };
	}

	private async log(event: IrohRemoteAuditEventInput): Promise<void> {
		try {
			await this.auditLogger.log(event);
		} catch {
			// Client-side protocol progress should not fail after audit I/O fails.
		}
	}
}
