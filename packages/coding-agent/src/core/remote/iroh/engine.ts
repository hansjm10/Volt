import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { IrohBiStreamLike, IrohBytes, IrohRecvStreamLike } from "../../rpc/index.ts";
import { type IrohRemoteAuditEventInput, IrohRemoteAuditLogger } from "./audit.ts";
import type { IrohRemoteClientAuthorizationResult, IrohRemoteClientAuthorizationSuccess } from "./authorization.ts";
import {
	createIrohRemoteHandshakeFailure,
	createIrohRemoteHandshakeSuccess,
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
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS, IROH_REMOTE_ALPN, type IrohRemoteRelayMode } from "./protocol.ts";
import { type IrohRemoteClient, type IrohRemoteWorkspace, parseIrohRemoteWorkspace } from "./state.ts";
import type { IrohRemoteClientRevocationResult, IrohRemoteHostStateManager } from "./state-manager.ts";
import {
	assertIrohRemoteTicketNotExpired,
	decodeIrohRemoteTicketPayload,
	encodeIrohRemoteTicketPayload,
	type IrohRemoteTicketPayload,
} from "./ticket.ts";

export const DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;

export interface IrohRemoteHostEngineOptions {
	allowTools?: string;
	auditLogger?: IrohRemoteAuditLogger;
	now?: () => number;
	pairingExpiresAt?: number;
	pairingSecret?: string;
	stateManager: IrohRemoteHostStateManager;
	workspace: IrohRemoteWorkspace;
}

export interface IrohRemoteHostPairOptions {
	expiresAt?: number;
	irohTicket: string;
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

export class IrohRemoteHostEngine {
	private readonly auditLogger: IrohRemoteAuditLogger;
	private readonly now: () => number;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly workspace: IrohRemoteWorkspace;
	private authorizationQueue: Promise<void> = Promise.resolve();
	private allowTools: string;
	private pairingAllowTools: string | undefined;
	private pairingExpiresAt: number | undefined;
	private pairingSecret: string | undefined;

	constructor(options: IrohRemoteHostEngineOptions) {
		this.allowTools = options.allowTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS;
		this.auditLogger = options.auditLogger ?? new IrohRemoteAuditLogger();
		this.now = options.now ?? Date.now;
		this.pairingExpiresAt = options.pairingExpiresAt;
		this.pairingSecret = options.pairingSecret;
		this.stateManager = options.stateManager;
		this.workspace = parseIrohRemoteWorkspace(options.workspace);
	}

	async pair(options: IrohRemoteHostPairOptions): Promise<IrohRemotePairingTicket> {
		return this.runAuthorizationExclusive(async () => {
			const workspace = options.workspace ?? this.workspace.name;
			if (workspace !== this.workspace.name) {
				throw new Error(`pairing workspace does not match host workspace: ${workspace}`);
			}

			const secret = options.secret ?? randomBytes(24).toString("base64url");
			const expiresAt =
				options.expiresAt ?? this.now() + (options.ttlMs ?? DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS);
			this.pairingAllowTools = this.allowTools;
			this.pairingSecret = secret;
			this.pairingExpiresAt = expiresAt;

			const payload: IrohRemoteTicketPayload = {
				alpn: IROH_REMOTE_ALPN,
				expiresAt,
				irohTicket: options.irohTicket,
				nodeId: options.nodeId,
				relayMode: options.relayMode,
				secret,
				workspace,
			};
			const ticket = encodeIrohRemoteTicketPayload(payload);
			await this.log({
				type: "pairing_ticket_created",
				workspace: payload.workspace,
				details: {
					expiresAt,
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
		const result = await this.stateManager.revokeClient(nodeId);
		await this.log({
			type: "client_revoked",
			clientNodeId: nodeId,
			success: result.revoked,
			error: result.revoked ? undefined : "client not found",
		});
		return result;
	}

	async authorizeHello(hello: IrohRemoteHello, remoteNodeId: string): Promise<IrohRemoteClientAuthorizationResult> {
		return this.runAuthorizationExclusive(() => this.authorizeHelloUnlocked(hello, remoteNodeId));
	}

	private async authorizeHelloUnlocked(
		hello: IrohRemoteHello,
		remoteNodeId: string,
	): Promise<IrohRemoteClientAuthorizationResult> {
		const allowTools =
			this.pairingSecret !== undefined && hello.secret === this.pairingSecret
				? (this.pairingAllowTools ?? this.allowTools)
				: this.allowTools;
		const result = await this.stateManager.authorizeClient(hello, remoteNodeId, {
			allowTools,
			now: this.now(),
			pairingExpiresAt: this.pairingExpiresAt,
			pairingSecret: this.pairingSecret,
			workspace: this.workspace,
		});

		if (result.ok && result.pairingSecretConsumed) {
			this.clearPairingSecret();
		} else if (!result.ok && result.pairingSecretExpired) {
			this.clearPairingSecret();
		}

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
					response: createIrohRemoteHandshakeFailure(authorization.error),
					responseWritten: false,
				});
			}

			const successResult: IrohRemoteHostHandshakeResult = {
				ok: true,
				authorization,
				hello,
				initialInput,
				response: createIrohRemoteHandshakeSuccess({
					child: options.child,
					clientNodeId: remoteNodeId,
					workspace: authorization.workspace.name,
				}),
				responseWritten: false,
			};
			if (options.writeSuccessResponse === false) {
				return successResult;
			}
			return await this.writeHandshakeResult(stream, successResult);
		} catch (error: unknown) {
			return await this.writeHandshakeResult(
				stream,
				await this.createHandshakeFailure(error instanceof Error ? error.message : String(error), initialInput),
			);
		}
	}

	setAllowTools(allowTools: string): void {
		this.allowTools = allowTools;
	}

	private clearPairingSecret(): void {
		this.pairingAllowTools = undefined;
		this.pairingSecret = undefined;
		this.pairingExpiresAt = undefined;
	}

	private async createHandshakeFailure(
		error: string,
		initialInput: IrohBytes,
	): Promise<IrohRemoteHostHandshakeResult> {
		await this.log({
			type: "handshake_rejected",
			workspace: this.workspace.name,
			success: false,
			error,
		});
		return {
			ok: false,
			error,
			initialInput,
			response: createIrohRemoteHandshakeFailure(error),
			responseWritten: false,
		};
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
			details: result.ok ? { paired: result.paired } : { pairingSecretExpired: result.pairingSecretExpired },
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
		options: IrohRemoteHandshakeLineReadOptions = {},
	): Promise<IrohRemoteClientHandshakeResponseResult> {
		const handshake = await readIrohRemoteHandshakeLine(recv, options);
		if (handshake.line === undefined) {
			throw new Error("missing handshake response");
		}
		const response = parseIrohRemoteHandshakeResponseLine(handshake.line);
		await this.log({
			type: "handshake_response_received",
			workspace: response.success ? response.workspace : undefined,
			success: response.success,
			error: response.success ? undefined : response.error,
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
