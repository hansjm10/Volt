import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	expectIrohRemoteEndpointId,
	type IrohRemoteEnrollmentClaim,
	normalizeIrohRemoteRelayOrigins,
	parseIrohRemoteEnrollmentClaim,
} from "./enrollment.ts";
import { IROH_REMOTE_ALPN, IROH_REMOTE_TICKET_PREFIX, IrohRemoteOutcomeError } from "./protocol.ts";

export type IrohRemoteRelayDescriptor =
	| { kind: "volt-managed"; origins: string[] }
	| { kind: "custom-uncredentialed"; origins: string[] }
	| { kind: "n0-public" }
	| { kind: "disabled" };

export interface IrohRemoteTicketPayload {
	alpn: typeof IROH_REMOTE_ALPN;
	expiresAt?: number;
	irohTicket: string;
	nodeId: string;
	relay: IrohRemoteRelayDescriptor;
	enrollment?: IrohRemoteEnrollmentClaim;
	secret?: string;
	workspace: string;
}

export interface IrohRemoteSanitizedReconnectTicketPayload extends IrohRemoteTicketPayload {
	expiresAt?: never;
	enrollment?: never;
	secret?: never;
}

/** Non-secret values a user can compare before accepting a pairing ticket. */
export interface IrohRemotePairingVerificationDetails {
	expiresAt?: number;
	hostFingerprint: string;
	hostNodeId: string;
	relayMode: "disabled" | "development" | "production";
	relayOrigins: string[];
	workspace: string;
}

/**
 * Match the iOS pairing confirmation fingerprint: the first 128 bits of the
 * SHA-256 digest, rendered as four uppercase 32-bit groups.
 */
export function formatIrohRemoteHostFingerprint(endpointIdBytes: ArrayLike<number>): string {
	if (endpointIdBytes.length !== 32) {
		throw new Error("Iroh endpoint identity must be exactly 32 bytes");
	}
	const bytes = new Uint8Array(endpointIdBytes.length);
	for (let index = 0; index < endpointIdBytes.length; index++) {
		const value = endpointIdBytes[index];
		if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0xff) {
			throw new Error("Iroh endpoint identity contains an invalid byte");
		}
		bytes[index] = value;
	}
	const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32).toUpperCase();
	return digest.match(/.{8}/g)!.join("-");
}

/** Decode a ticket into only the values that are safe to display for comparison. */
export function getIrohRemotePairingVerificationDetails(ticket: string): IrohRemotePairingVerificationDetails {
	const payload = decodeIrohRemoteTicketPayload(ticket);
	if (payload.expiresAt === undefined || payload.secret === undefined) {
		throw new Error("pairing ticket requires expiry and one-time pairing secret");
	}
	if (payload.relay.kind === "volt-managed" && payload.enrollment === undefined) {
		throw new Error("managed pairing ticket requires an enrollment claim");
	}
	const workspace = payload.workspace.trim();
	if (workspace.length === 0) {
		throw new Error("pairing ticket workspace must not be blank");
	}
	const relayMode =
		payload.relay.kind === "n0-public"
			? "development"
			: payload.relay.kind === "disabled"
				? "disabled"
				: "production";
	return {
		...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
		hostFingerprint: formatIrohRemoteHostFingerprint(Buffer.from(payload.nodeId, "hex")),
		hostNodeId: payload.nodeId,
		relayMode,
		relayOrigins:
			payload.relay.kind === "volt-managed" || payload.relay.kind === "custom-uncredentialed"
				? [...payload.relay.origins]
				: [],
		workspace,
	};
}

export function encodeIrohRemoteTicketPayload(payload: IrohRemoteTicketPayload): string {
	const parsed = parseIrohRemoteTicketPayload(payload);
	return `${IROH_REMOTE_TICKET_PREFIX}${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")}`;
}

export function decodeIrohRemoteTicketPayload(ticket: string): IrohRemoteTicketPayload {
	if (!ticket.startsWith(IROH_REMOTE_TICKET_PREFIX)) {
		throw new Error(`Expected ticket prefix ${IROH_REMOTE_TICKET_PREFIX}`);
	}

	const encoded = ticket.slice(IROH_REMOTE_TICKET_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
		throw new Error("Failed to decode Iroh remote ticket: payload must be unpadded base64url");
	}
	const bytes = Buffer.from(encoded, "base64url");
	if (bytes.toString("base64url") !== encoded) {
		throw new Error("Failed to decode Iroh remote ticket: payload must be canonical unpadded base64url");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error: unknown) {
		throw new Error(`Failed to decode Iroh remote ticket: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseIrohRemoteTicketPayload(parsed);
}

export function parseIrohRemoteTicketPayload(value: unknown): IrohRemoteTicketPayload {
	const payload = expectRecord(value, "Iroh remote ticket payload");
	expectAllowedKeys(
		payload,
		["alpn", "expiresAt", "irohTicket", "nodeId", "relay", "enrollment", "secret", "workspace"],
		["alpn", "irohTicket", "nodeId", "relay", "workspace"],
		"Iroh remote ticket payload",
	);
	const alpn = expectString(payload.alpn, "ticket alpn");
	if (alpn !== IROH_REMOTE_ALPN) {
		throw new Error(`Unsupported ticket ALPN: ${alpn}`);
	}

	const expiresAt = expectOptionalSafeInteger(payload.expiresAt, "ticket expiresAt");
	const irohTicket = expectString(payload.irohTicket, "ticket irohTicket");
	const nodeId = expectIrohRemoteEndpointId(payload.nodeId, "ticket nodeId");
	const relay = parseIrohRemoteRelayDescriptor(payload.relay);
	const enrollment = payload.enrollment === undefined ? undefined : parseIrohRemoteEnrollmentClaim(payload.enrollment);
	const secret = expectOptionalString(payload.secret, "ticket secret");
	const workspace = expectString(payload.workspace, "ticket workspace");

	if (relay.kind === "volt-managed") {
		// A sanitized reconnect payload is the one intentionally permitted
		// exception: all ephemeral pairing fields are absent together.
		const sanitizedReconnect = expiresAt === undefined && secret === undefined && enrollment === undefined;
		if (enrollment === undefined && !sanitizedReconnect) {
			throw new Error("ticket volt-managed relay requires an enrollment claim");
		}
	} else if (enrollment !== undefined) {
		throw new Error(`ticket ${relay.kind} relay must not contain an enrollment claim`);
	}

	return {
		alpn,
		...(expiresAt === undefined ? {} : { expiresAt }),
		irohTicket,
		nodeId,
		relay,
		...(enrollment === undefined ? {} : { enrollment }),
		...(secret === undefined ? {} : { secret }),
		workspace,
	};
}

export function parseIrohRemoteRelayDescriptor(value: unknown): IrohRemoteRelayDescriptor {
	const relay = expectRecord(value, "ticket relay");
	const kind = expectString(relay.kind, "ticket relay kind");
	if (kind === "volt-managed" || kind === "custom-uncredentialed") {
		expectAllowedKeys(relay, ["kind", "origins"], ["kind", "origins"], "ticket relay");
		if (!Array.isArray(relay.origins) || relay.origins.some((origin) => typeof origin !== "string")) {
			throw new Error("ticket relay origins must be an array of strings");
		}
		const origins = relay.origins as string[];
		const normalized = normalizeIrohRemoteRelayOrigins(origins, "ticket relay origins");
		if (origins.length !== normalized.length || origins.some((origin, index) => origin !== normalized[index])) {
			throw new Error("ticket relay origins must be normalized, unique, and sorted");
		}
		return { kind, origins: [...origins] };
	}
	if (kind === "n0-public" || kind === "disabled") {
		expectAllowedKeys(relay, ["kind"], ["kind"], "ticket relay");
		return { kind };
	}
	throw new Error("ticket relay kind must be volt-managed, custom-uncredentialed, n0-public, or disabled");
}

export function assertIrohRemoteTicketNotExpired(payload: IrohRemoteTicketPayload, now = Date.now()): void {
	if (payload.expiresAt !== undefined && now > payload.expiresAt) {
		throw new Error("Pairing ticket has expired");
	}
}

export function createIrohRemoteSanitizedReconnectTicketPayload(
	payload: IrohRemoteTicketPayload,
): IrohRemoteSanitizedReconnectTicketPayload {
	const parsed = parseIrohRemoteTicketPayload(payload);
	return {
		alpn: parsed.alpn,
		irohTicket: parsed.irohTicket,
		nodeId: parsed.nodeId,
		relay: cloneIrohRemoteRelayDescriptor(parsed.relay),
		workspace: parsed.workspace,
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
	const expected = expectIrohRemoteEndpointId(expectedHostNodeId, "expected host node id");
	if (payload.nodeId !== expected) {
		throw new IrohRemoteOutcomeError(
			"host_identity_mismatch",
			`expected ${expectedHostNodeId}, got ${payload.nodeId}`,
		);
	}
}

function cloneIrohRemoteRelayDescriptor(relay: IrohRemoteRelayDescriptor): IrohRemoteRelayDescriptor {
	return relay.kind === "volt-managed" || relay.kind === "custom-uncredentialed"
		? { kind: relay.kind, origins: [...relay.origins] }
		: { kind: relay.kind };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectAllowedKeys(
	record: Record<string, unknown>,
	allowedKeys: readonly string[],
	requiredKeys: readonly string[],
	label: string,
): void {
	const allowed = new Set(allowedKeys);
	const unknown = Object.keys(record).find((key) => !allowed.has(key));
	if (unknown !== undefined) {
		throw new Error(`${label} contains unknown field: ${unknown}`);
	}
	const missing = requiredKeys.find((key) => !Object.hasOwn(record, key));
	if (missing !== undefined) {
		throw new Error(`${label} is missing required field: ${missing}`);
	}
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

function expectOptionalSafeInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value as number;
}
