import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

const ENDPOINT_ID_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type IrohRemoteEnrollmentHostOperation = "create_claim" | "claim_status" | "cancel_claim";

export interface IrohRemoteEnrollmentClaim {
	version: 1;
	claimId: string;
	claimSecret: string;
}

export interface IrohRemoteEnrollmentSigner {
	sign(message: number[]): { toBytes(): number[] };
}

export function createIrohRemoteEnrollmentClaim(
	random: (size: number) => Uint8Array = randomBytes,
): IrohRemoteEnrollmentClaim {
	const claimId = Buffer.from(random(16));
	const claimSecret = Buffer.from(random(32));
	if (claimId.length !== 16 || claimSecret.length !== 32) {
		throw new Error("Iroh enrollment randomness returned an invalid byte length");
	}
	return {
		version: 1,
		claimId: claimId.toString("base64url"),
		claimSecret: claimSecret.toString("base64url"),
	};
}

export function parseIrohRemoteEnrollmentClaim(value: unknown): IrohRemoteEnrollmentClaim {
	const claim = expectRecord(value, "ticket enrollment");
	expectExactKeys(claim, ["version", "claimId", "claimSecret"], "ticket enrollment");
	if (claim.version !== 1) {
		throw new Error("ticket enrollment version must be 1");
	}
	return {
		version: 1,
		claimId: expectBase64urlBytes(claim.claimId, 16, "ticket enrollment claimId"),
		claimSecret: expectBase64urlBytes(claim.claimSecret, 32, "ticket enrollment claimSecret"),
	};
}

export function isIrohRemoteEndpointId(value: unknown): value is string {
	return typeof value === "string" && ENDPOINT_ID_PATTERN.test(value);
}

export function expectIrohRemoteEndpointId(value: unknown, label: string): string {
	if (!isIrohRemoteEndpointId(value)) {
		throw new Error(`${label} must be exactly 64 lowercase hexadecimal characters`);
	}
	return value;
}

export function expectIrohRemoteBase64urlBytes(value: unknown, byteLength: number, label: string): string {
	return expectBase64urlBytes(value, byteLength, label);
}

export function hashIrohRemoteEnrollmentSecret(secret: string): string {
	const rawSecret = Buffer.from(expectBase64urlBytes(secret, 32, "enrollment secret"), "base64url");
	return createHash("sha256").update(rawSecret).digest("base64url");
}

export function createIrohRemoteEnrollmentHostCanonicalMessage(options: {
	operation: IrohRemoteEnrollmentHostOperation;
	hostEndpointId: string;
	claimId: string;
	claimSecretHash: string;
	issuedAtMs: number;
	nonce: string;
}): Buffer {
	const hostEndpointId = expectIrohRemoteEndpointId(options.hostEndpointId, "host endpoint id");
	const claimId = expectBase64urlBytes(options.claimId, 16, "claim id");
	const claimSecretHash = expectBase64urlBytes(options.claimSecretHash, 32, "claim secret hash");
	const nonce = expectBase64urlBytes(options.nonce, 16, "nonce");
	if (!Number.isSafeInteger(options.issuedAtMs) || options.issuedAtMs < 0) {
		throw new Error("issuedAtMs must be a non-negative safe integer");
	}
	return Buffer.from(
		[
			"volt-iroh-enrollment-signature-v1",
			`operation:${options.operation}`,
			`host_endpoint_id:${hostEndpointId}`,
			`claim_id:${claimId}`,
			`claim_secret_sha256:${claimSecretHash}`,
			`issued_at_ms:${options.issuedAtMs}`,
			`nonce:${nonce}`,
			"",
		].join("\n"),
		"utf8",
	);
}

export function signIrohRemoteEnrollmentMessage(signer: IrohRemoteEnrollmentSigner, message: Uint8Array): string {
	const signature = signer.sign(Array.from(message)).toBytes();
	if (signature.length !== 64 || signature.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
		throw new Error("Iroh enrollment signer returned an invalid Ed25519 signature");
	}
	return Buffer.from(signature).toString("base64url");
}

export function normalizeIrohRemoteRelayOrigins(values: readonly string[], label = "relay origins"): string[] {
	if (values.length === 0) {
		throw new Error(`${label} must contain at least one HTTPS origin`);
	}
	if (values.length > 8) {
		throw new Error(`${label} must contain at most 8 HTTPS origins`);
	}
	const normalized = values.map((value) => normalizeIrohRemoteRelayOrigin(value, label));
	const unique = [...new Set(normalized)].sort();
	if (unique.length !== normalized.length) {
		throw new Error(`${label} must not contain duplicate origins`);
	}
	return unique;
}

export function normalizeIrohRemoteRelayOrigin(value: string, label = "relay origin"): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must contain valid HTTPS origins`);
	}
	if (
		url.protocol !== "https:" ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.search.length > 0 ||
		url.hash.length > 0 ||
		(url.pathname !== "" && url.pathname !== "/")
	) {
		throw new Error(`${label} must contain HTTPS origins without credentials, path, query, or fragment`);
	}

	const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
	const rawHostname = bracketed ? url.hostname.slice(1, -1) : url.hostname;
	const hostname = rawHostname.toLowerCase().replace(/\.+$/, "");
	if (hostname.length === 0 || isUnsafeLocalRelayHost(hostname)) {
		throw new Error(`${label} must not target a local or private host`);
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

function expectBase64urlBytes(value: unknown, byteLength: number, label: string): string {
	if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
		throw new Error(`${label} must be unpadded base64url`);
	}
	const bytes = Buffer.from(value, "base64url");
	if (bytes.length !== byteLength || bytes.toString("base64url") !== value) {
		throw new Error(`${label} must decode to exactly ${byteLength} bytes`);
	}
	return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
	const expected = new Set(expectedKeys);
	const actualKeys = Object.keys(record);
	if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key))) {
		throw new Error(`${label} contains unknown or missing fields`);
	}
}
