import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
	IROH_REMOTE_ALPN,
	IROH_REMOTE_TICKET_PREFIX,
	IrohRemoteOutcomeError,
	type IrohRemoteRelayMode,
	isIrohRemoteRelayMode,
	isIrohRemoteRelayUrls,
} from "./protocol.ts";

export interface IrohRemoteRelayCredentialClaim {
	claimId: string;
	serviceUrl: string;
}

export interface IrohRemoteTicketPayload {
	alpn: typeof IROH_REMOTE_ALPN;
	expiresAt?: number;
	irohTicket: string;
	nodeId?: string;
	/** One-time broker claim. Sanitized reconnect tickets always remove it. */
	relayCredentialClaim?: IrohRemoteRelayCredentialClaim;
	relayMode?: IrohRemoteRelayMode;
	/** Relay server URLs the client should use; required when relayMode is "production". */
	relayUrls?: string[];
	/**
	 * Bearer token for relays behind access.shared_token. Secret-like: carried
	 * in pairing tickets (clients keychain it) and stripped from sanitized
	 * reconnect tickets.
	 */
	relayAuthToken?: string;
	secret?: string;
	workspace: string;
}

export interface IrohRemoteSanitizedReconnectTicketPayload extends IrohRemoteTicketPayload {
	nodeId: string;
	relayMode: IrohRemoteRelayMode;
}

/** Non-secret values a user can compare before accepting a pairing ticket. */
export interface IrohRemotePairingVerificationDetails {
	expiresAt?: number;
	hostFingerprint: string;
	hostNodeId: string;
	relayMode: IrohRemoteRelayMode;
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
	if (payload.nodeId === undefined) {
		throw new Error("ticket nodeId is required for pairing verification");
	}
	const hostNodeId = payload.nodeId.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(hostNodeId)) {
		throw new Error("ticket nodeId must be a 32-byte hexadecimal Iroh endpoint identity");
	}
	const workspace = payload.workspace.trim();
	if (workspace.length === 0) {
		throw new Error("ticket workspace is required for pairing verification");
	}
	const relayMode = payload.relayMode ?? "disabled";
	return {
		...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
		hostFingerprint: formatIrohRemoteHostFingerprint(Buffer.from(hostNodeId, "hex")),
		hostNodeId,
		relayMode,
		relayOrigins: normalizePairingRelayOrigins(payload.relayUrls ?? [], relayMode),
		workspace,
	};
}

function normalizePairingRelayOrigins(values: string[], relayMode: IrohRemoteRelayMode): string[] {
	const nonEmptyValues = values.filter((value) => value.trim().length > 0);
	if (relayMode !== "production") {
		if (nonEmptyValues.length > 0) {
			throw new Error("ticket relay URLs are only valid in production relay mode");
		}
		return [];
	}
	if (nonEmptyValues.length === 0) {
		throw new Error("ticket production relay mode requires HTTPS relay origins");
	}
	return [...new Set(nonEmptyValues.map(normalizeHttpsRelayOrigin))].sort();
}

function normalizeHttpsRelayOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("ticket relay URL must be a valid HTTPS origin");
	}
	if (
		url.protocol !== "https:" ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.search.length > 0 ||
		url.hash.length > 0 ||
		(url.pathname !== "" && url.pathname !== "/")
	) {
		throw new Error("ticket relay URL must be an HTTPS origin without credentials, path, query, or fragment");
	}

	const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
	const rawHostname = bracketed ? url.hostname.slice(1, -1) : url.hostname;
	const hostname = rawHostname.toLowerCase().replace(/\.+$/, "");
	if (hostname.length === 0 || isUnsafeLocalRelayHost(hostname)) {
		throw new Error("ticket relay URL must not target a local or private host");
	}
	const formattedHostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	return `https://${formattedHostname}${url.port.length === 0 || url.port === "443" ? "" : `:${url.port}`}`;
}

function isUnsafeLocalRelayHost(hostname: string): boolean {
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "local" ||
		hostname.endsWith(".local") ||
		hostname.includes("%")
	) {
		return true;
	}
	if (isIP(hostname) === 4) {
		return isUnsafeIpv4(hostname.split(".").map(Number));
	}
	if (isIP(hostname) !== 6) {
		return false;
	}
	const bytes = parseIpv6Bytes(hostname);
	if (bytes === undefined) return true;
	const unspecified = bytes.every((byte) => byte === 0);
	const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
	const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
	const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
	const multicast = bytes[0] === 0xff;
	if (unspecified || loopback || linkLocal || uniqueLocal || multicast) return true;
	const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
	return ipv4Mapped && isUnsafeIpv4(bytes.slice(12));
}

function isUnsafeIpv4(bytes: number[]): boolean {
	if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) return true;
	return (
		bytes[0] === 0 ||
		bytes[0] === 10 ||
		bytes[0] === 127 ||
		(bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127) ||
		(bytes[0] === 169 && bytes[1] === 254) ||
		(bytes[0] === 172 && bytes[1]! >= 16 && bytes[1]! <= 31) ||
		(bytes[0] === 192 && bytes[1] === 168) ||
		(bytes[0] === 198 && (bytes[1] === 18 || bytes[1] === 19)) ||
		bytes[0]! >= 224
	);
}

function parseIpv6Bytes(address: string): number[] | undefined {
	const halves = address.split("::");
	if (halves.length > 2) return undefined;
	const parseHalf = (value: string): number[] | undefined => {
		if (value.length === 0) return [];
		const words: number[] = [];
		for (const part of value.split(":")) {
			if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
			words.push(Number.parseInt(part, 16));
		}
		return words;
	};
	const head = parseHalf(halves[0]!);
	const tail = parseHalf(halves[1] ?? "");
	if (head === undefined || tail === undefined) return undefined;
	const omitted = 8 - head.length - tail.length;
	if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return undefined;
	const words = [...head, ...Array.from({ length: omitted }, () => 0), ...tail];
	if (words.length !== 8) return undefined;
	return words.flatMap((word) => [word >> 8, word & 0xff]);
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
		throw new Error("ticket relayMode must be disabled, development, or production");
	}
	const relayUrlsValue = payload.relayUrls;
	if (relayUrlsValue !== undefined && !isIrohRemoteRelayUrls(relayUrlsValue)) {
		throw new Error("ticket relayUrls must be a non-empty array of relay URLs");
	}
	if (relayModeValue === "production" && relayUrlsValue === undefined) {
		throw new Error("ticket relayMode production requires relayUrls");
	}
	const relayAuthToken = expectOptionalString(payload.relayAuthToken, "ticket relayAuthToken");
	const relayCredentialClaim = parseOptionalRelayCredentialClaim(payload.relayCredentialClaim);
	if (relayCredentialClaim !== undefined && relayModeValue !== "production") {
		throw new Error("ticket relay credential claim requires production relay mode");
	}
	if (relayCredentialClaim !== undefined && relayAuthToken !== undefined) {
		throw new Error("ticket relay credential claim cannot include a host relay token");
	}
	const secret = expectOptionalString(payload.secret, "ticket secret");
	const workspace = expectString(payload.workspace, "ticket workspace");

	return {
		alpn,
		expiresAt,
		irohTicket,
		nodeId,
		...(relayCredentialClaim === undefined ? {} : { relayCredentialClaim }),
		relayMode: relayModeValue,
		relayUrls: relayUrlsValue,
		relayAuthToken,
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
	if (payload.relayMode === "production" && payload.relayUrls === undefined) {
		throw new IrohRemoteOutcomeError("saved_host_invalid", "ticket relayUrls are required for production relayMode");
	}
	return {
		alpn: payload.alpn,
		irohTicket: payload.irohTicket,
		nodeId: payload.nodeId,
		relayMode: payload.relayMode,
		...(payload.relayUrls === undefined ? {} : { relayUrls: payload.relayUrls }),
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

function parseOptionalRelayCredentialClaim(value: unknown): IrohRemoteRelayCredentialClaim | undefined {
	if (value === undefined) return undefined;
	const record = expectRecord(value, "ticket relayCredentialClaim");
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "claimId" || keys[1] !== "serviceUrl") {
		throw new Error("ticket relayCredentialClaim has unexpected fields");
	}
	const claimId = expectString(record.claimId, "ticket relayCredentialClaim claimId");
	if (!/^[A-Za-z0-9_-]{24}$/.test(claimId)) {
		throw new Error("ticket relayCredentialClaim claimId is invalid");
	}
	return {
		claimId,
		serviceUrl: expectString(record.serviceUrl, "ticket relayCredentialClaim serviceUrl"),
	};
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
