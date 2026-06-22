import { Buffer } from "node:buffer";
import {
	IROH_REMOTE_ALPN,
	IROH_REMOTE_TICKET_PREFIX,
	IrohRemoteOutcomeError,
	type IrohRemoteRelayMode,
	isIrohRemoteRelayMode,
} from "./protocol.ts";

export interface IrohRemoteTicketPayload {
	alpn: typeof IROH_REMOTE_ALPN;
	expiresAt?: number;
	irohTicket: string;
	nodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	secret?: string;
	workspace: string;
}

export interface IrohRemoteSanitizedReconnectTicketPayload extends IrohRemoteTicketPayload {
	nodeId: string;
	relayMode: IrohRemoteRelayMode;
}

export function encodeIrohRemoteTicketPayload(payload: IrohRemoteTicketPayload): string {
	return `${IROH_REMOTE_TICKET_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeIrohRemoteTicketPayload(ticket: string): IrohRemoteTicketPayload {
	if (!ticket.startsWith(IROH_REMOTE_TICKET_PREFIX)) {
		throw new Error(`Expected ticket prefix ${IROH_REMOTE_TICKET_PREFIX}`);
	}

	const encoded = ticket.slice(IROH_REMOTE_TICKET_PREFIX.length);
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch (error: unknown) {
		throw new Error(`Failed to decode Iroh remote ticket: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseIrohRemoteTicketPayload(parsed);
}

export function parseIrohRemoteTicketPayload(value: unknown): IrohRemoteTicketPayload {
	const payload = expectRecord(value, "Iroh remote ticket payload");
	const alpn = expectString(payload.alpn, "ticket alpn");
	if (alpn !== IROH_REMOTE_ALPN) {
		throw new Error(`Unsupported ticket ALPN: ${alpn}`);
	}

	const expiresAt = expectOptionalNumber(payload.expiresAt, "ticket expiresAt");
	const irohTicket = expectString(payload.irohTicket, "ticket irohTicket");
	const nodeId = expectOptionalString(payload.nodeId, "ticket nodeId");
	const relayModeValue = payload.relayMode;
	if (relayModeValue !== undefined && !isIrohRemoteRelayMode(relayModeValue)) {
		throw new Error("ticket relayMode must be disabled or default");
	}
	const secret = expectOptionalString(payload.secret, "ticket secret");
	const workspace = expectString(payload.workspace, "ticket workspace");

	return {
		alpn,
		expiresAt,
		irohTicket,
		nodeId,
		relayMode: relayModeValue,
		secret,
		workspace,
	};
}

export function assertIrohRemoteTicketNotExpired(payload: IrohRemoteTicketPayload, now = Date.now()): void {
	if (payload.expiresAt !== undefined && now > payload.expiresAt) {
		throw new Error("Pairing ticket has expired");
	}
}

export function createIrohRemoteSanitizedReconnectTicketPayload(
	payload: IrohRemoteTicketPayload,
): IrohRemoteSanitizedReconnectTicketPayload {
	if (payload.nodeId === undefined) {
		throw new IrohRemoteOutcomeError("saved_host_invalid", "ticket nodeId is required for saved-host reconnect");
	}
	if (payload.relayMode === undefined) {
		throw new IrohRemoteOutcomeError("saved_host_invalid", "ticket relayMode is required for saved-host reconnect");
	}
	return {
		alpn: payload.alpn,
		irohTicket: payload.irohTicket,
		nodeId: payload.nodeId,
		relayMode: payload.relayMode,
		workspace: payload.workspace,
	};
}

export function createIrohRemoteSanitizedReconnectTicket(ticket: string): string {
	return encodeIrohRemoteTicketPayload(
		createIrohRemoteSanitizedReconnectTicketPayload(decodeIrohRemoteTicketPayload(ticket)),
	);
}

export function assertIrohRemoteTicketPayloadHostIdentity(
	payload: IrohRemoteTicketPayload,
	expectedHostNodeId: string,
): void {
	if (payload.nodeId === undefined) {
		throw new IrohRemoteOutcomeError(
			"saved_host_invalid",
			"ticket nodeId is required for host identity verification",
		);
	}
	if (payload.nodeId !== expectedHostNodeId) {
		throw new IrohRemoteOutcomeError(
			"host_identity_mismatch",
			`expected ${expectedHostNodeId}, got ${payload.nodeId}`,
		);
	}
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
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}
