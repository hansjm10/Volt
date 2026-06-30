import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { IrohBiStreamLike, IrohBytes, IrohRecvStreamLike } from "../../rpc/index.ts";
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
	writeIrohRemoteHandshakeResponse,
	writeIrohRemoteHello,
} from "./handshake-reader.ts";
import { createIrohRemoteHostMetadata } from "./metadata.ts";
import {
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
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
import { findIrohRemoteWorkspace, type IrohRemoteWorkspaceAvailabilityClassifier } from "./workspace.ts";

export const DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;

export interface IrohRemoteHostEngineOptions {
	allowTools?: string;
	auditLogger?: IrohRemoteAuditLogger;
	hostNodeId?: string;
	now?: () => number;
	pairingExpiresAt?: number;
	pairingSecret?: string;
	stateManager: IrohRemoteHostStateManager;
	classifyWorkspaceAvailability?: IrohRemoteWorkspaceAvailabilityClassifier;
	validateWorkspace?: (workspace: IrohRemoteWorkspace) => boolean | Promise<boolean>;
	workspace: IrohRemoteWorkspace;
}

export interface IrohRemoteHostPairOptions {
	allowTools?: string;
	expiresAt?: number;
	irohTicket: string;
	labelHint?: string;
	nodeId?: string;
	relayMode?: IrohRemoteRelayMode;
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
			responseWritten: boolean;
			responseWriteError?: string;
	  }
	| {
			ok: false;
			error: string;
			initialInput: IrohBytes;
			response: IrohRemoteHandshakeFailure;
			responseWritten: boolean;
			responseWriteError?: string;
	  };

export interface IrohRemoteHostReadHandshakeOptions extends IrohRemoteHandshakeLineReadOptions {
	child?: string;
	conversationSession?: {
		selection: IrohRemoteConversationSelection;
		sessionId: string;
		requestedSessionId?: string;
	};
	writeSuccessResponse?: boolean;
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
	private readonly now: () => number;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly validateWorkspace: ((workspace: IrohRemoteWorkspace) => boolean | Promise<boolean>) | undefined;
	private readonly workspace: IrohRemoteWorkspace;
	private authorizationQueue: Promise<void> = Promise.resolve();
	private allowTools: string;
	private pairingAllowTools: string | undefined;
	private pairingExpiresAt: number | undefined;
	private pairingSecret: string | undefined;
	private pairingWorkspaceName: string | undefined;

	constructor(options: IrohRemoteHostEngineOptions) {
		this.allowTools = normalizeIrohRemoteAllowTools(options.allowTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		this.auditLogger = options.auditLogger ?? new IrohRemoteAuditLogger();
		this.classifyWorkspaceAvailability = options.classifyWorkspaceAvailability;
		this.hostNodeId = options.hostNodeId;
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
			const allowTools = normalizeIrohRemoteAllowTools(
				options.allowTools ?? workspace.allowedTools ?? this.allowTools,
			);
			this.pairingAllowTools = allowTools;
			this.pairingSecret = secret;
			this.pairingExpiresAt = expiresAt;
			this.pairingWorkspaceName = workspace.name;
			const pendingPairingTicket = await this.stateManager.addPendingPairingTicket({
				secretHash: hashIrohRemotePairingSecret(secret),
				workspace: workspace.name,
				allowedTools: allowTools,
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
				secret,
				workspace: workspace.name,
			};
			const ticket = encodeIrohRemoteTicketPayload(payload);
			await this.log({
				type: "pairing_ticket_created",
				workspace: payload.workspace,
				details: {
					allowedTools: pendingPairingTicket.allowedTools,
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
		);
		const result = await this.stateManager.authorizeClient(hello, remoteNodeId, {
			allowTools,
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
		stream: IrohBiStreamLike,
		remoteNodeId: string,
		options: IrohRemoteHostReadHandshakeOptions = {},
	): Promise<IrohRemoteHostHandshakeResult> {
		let initialInput: IrohBytes = Buffer.alloc(0);
		try {
			const handshake = await readIrohRemoteHandshakeLine(stream.recv, options);
			initialInput = handshake.rest;
			if (handshake.line === undefined) {
				return await this.writeHandshakeResult(
					stream,
					await this.createHandshakeFailure("missing handshake", initialInput),
				);
			}

			const hello = parseIrohRemoteHelloLine(handshake.line);
			const authorization = await this.authorizeHello(hello, remoteNodeId);
			if (!authorization.ok) {
				return await this.writeHandshakeResult(stream, {
					ok: false,
					error: authorization.error,
					initialInput,
					response: createIrohRemoteHandshakeFailure(authorization.error, {
						hostNodeId: this.hostNodeId,
						outcome: authorization.outcome,
						workspace: authorization.workspace?.name,
					}),
					responseWritten: false,
				});
			}

			const successResult: IrohRemoteHostHandshakeResult = {
				ok: true,
				authorization,
				hello,
				initialInput,
				response: this.createHandshakeSuccessResponse(hello, authorization, remoteNodeId, options),
				responseWritten: false,
			};
			if (options.writeSuccessResponse === false) {
				return successResult;
			}
			return await this.writeHandshakeResult(stream, successResult);
		} catch (error: unknown) {
			return await this.writeHandshakeResult(
				stream,
				await this.createHandshakeFailure(
					error instanceof Error ? error.message : String(error),
					initialInput,
					error,
				),
			);
		}
	}

	setAllowTools(allowTools: string): void {
		this.allowTools = normalizeIrohRemoteAllowTools(allowTools);
	}

	clearPairingSecretForWorkspace(workspaceName: string): boolean {
		if (this.pairingWorkspaceName !== workspaceName) {
			return false;
		}
		this.clearPairingSecret();
		return true;
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
			responseWritten: false,
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
			if (options.writeSuccessResponse === false) {
				return createIrohRemoteHandshakeSuccess(common);
			}
			throw new IrohRemoteHandshakeError(
				"conversation_streams_unsupported",
				"conversation stream requires resolved session metadata",
			);
		}
		return createIrohRemoteHandshakeSuccess({
			...common,
			sessionId: options.conversationSession.sessionId,
			conversation: createConversationHandshakeMetadata(hello, options.conversationSession),
		});
	}

	private async writeHandshakeResult(
		stream: IrohBiStreamLike,
		result: IrohRemoteHostHandshakeResult,
	): Promise<IrohRemoteHostHandshakeResult> {
		try {
			await writeIrohRemoteHandshakeResponse(stream.send, result.response);
			return { ...result, responseWritten: true };
		} catch (error) {
			// Authorization may already be committed; response write failures should not reclassify the result.
			return {
				...result,
				responseWritten: false,
				responseWriteError: error instanceof Error ? error.message : String(error),
			};
		}
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
					allowedTools: ticket.allowedTools,
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
						allowedTools: result.consumedPairingTicket.allowedTools,
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
		} catch {
			// Remote authorization side effects should not be reinterpreted as handshake failures if audit I/O fails.
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
