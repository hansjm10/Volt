import { readFileSync, statSync } from "node:fs";

const RELAY_CREDENTIAL_SCHEMA_VERSION = 1;
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ACCESS_TOKEN_LIFETIME_MS = 60 * 60_000;
const LOCAL_CANARY_PORT = "18085";

export interface IrohManagedRelayCredential {
	schemaVersion: 1;
	serviceUrl: string;
	relayUrls: string[];
	endpointNodeId: string;
	grantId: string;
	accessToken: string;
	accessTokenExpiresAt: number;
	refreshToken: string;
	refreshTokenExpiresAt: number;
}

export interface IrohRelayCredentialExchangeResponse {
	grantId: string;
	hostNodeId: string;
	credential: {
		accessToken: string;
		accessTokenExpiresAt: string;
		refreshToken: string;
		refreshTokenExpiresAt: string;
		tokenType: "Bearer";
	};
}

export function loadIrohRelayCredentialExchangeFile(
	path: string,
	serviceUrl: string,
	relayUrls: string[],
): IrohManagedRelayCredential {
	const stat = statSync(path);
	if (!stat.isFile() || stat.size <= 0 || stat.size > 32 * 1024 || (stat.mode & 0o077) !== 0) {
		throw new Error("relay credential file must be a non-empty mode-0600 regular file under 32 KiB");
	}
	return parseIrohRelayCredentialExchange(JSON.parse(readFileSync(path, "utf8")), serviceUrl, relayUrls);
}

export function parseIrohRelayCredentialExchange(
	value: unknown,
	serviceUrl: string,
	relayUrls: string[],
): IrohManagedRelayCredential {
	const response = expectExactRecord(value, ["grantId", "hostNodeId", "credential"], "relay credential exchange");
	const credential = expectExactRecord(
		response.credential,
		["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "tokenType"],
		"relay credential",
	);
	if (credential.tokenType !== "Bearer") {
		throw new Error("relay credential tokenType must be Bearer");
	}
	return parseIrohManagedRelayCredential({
		schemaVersion: RELAY_CREDENTIAL_SCHEMA_VERSION,
		serviceUrl,
		relayUrls,
		endpointNodeId: response.hostNodeId,
		grantId: response.grantId,
		accessToken: credential.accessToken,
		accessTokenExpiresAt: parseTimestamp(credential.accessTokenExpiresAt, "accessTokenExpiresAt"),
		refreshToken: credential.refreshToken,
		refreshTokenExpiresAt: parseTimestamp(credential.refreshTokenExpiresAt, "refreshTokenExpiresAt"),
	});
}

export function parseIrohManagedRelayCredential(value: unknown): IrohManagedRelayCredential {
	const record = expectExactRecord(
		value,
		[
			"schemaVersion",
			"serviceUrl",
			"relayUrls",
			"endpointNodeId",
			"grantId",
			"accessToken",
			"accessTokenExpiresAt",
			"refreshToken",
			"refreshTokenExpiresAt",
		],
		"managed relay credential",
	);
	if (record.schemaVersion !== RELAY_CREDENTIAL_SCHEMA_VERSION) {
		throw new Error("unsupported managed relay credential schema");
	}
	const serviceUrl = normalizeCredentialServiceUrl(expectString(record.serviceUrl, "serviceUrl"));
	const relayUrls = normalizeRelayUrls(record.relayUrls);
	const endpointNodeId = expectString(record.endpointNodeId, "endpointNodeId");
	if (!/^[0-9a-f]{64}$/.test(endpointNodeId)) {
		throw new Error("managed relay credential endpointNodeId is invalid");
	}
	const grantId = expectBoundedToken(record.grantId, "grantId", 16, 128);
	const accessToken = expectAccessToken(record.accessToken);
	const refreshToken = expectBoundedToken(record.refreshToken, "refreshToken", 32, 256);
	if (!refreshToken.startsWith("vrr_")) {
		throw new Error("managed relay refreshToken is invalid");
	}
	const accessTokenExpiresAt = expectTimestamp(record.accessTokenExpiresAt, "accessTokenExpiresAt");
	const refreshTokenExpiresAt = expectTimestamp(record.refreshTokenExpiresAt, "refreshTokenExpiresAt");
	if (refreshTokenExpiresAt <= accessTokenExpiresAt) {
		throw new Error("managed relay refresh credential must outlive the access token");
	}
	return {
		schemaVersion: RELAY_CREDENTIAL_SCHEMA_VERSION,
		serviceUrl,
		relayUrls,
		endpointNodeId,
		grantId,
		accessToken,
		accessTokenExpiresAt,
		refreshToken,
		refreshTokenExpiresAt,
	};
}

export async function refreshIrohManagedRelayCredential(
	credential: IrohManagedRelayCredential,
): Promise<IrohManagedRelayCredential> {
	const validated = parseIrohManagedRelayCredential(credential);
	const now = Date.now();
	if (!Number.isFinite(now) || now >= validated.refreshTokenExpiresAt) {
		throw new Error("managed relay refresh credential has expired");
	}
	const response = await requestCredentialService(validated, "/v1/tokens/refresh");
	if (response.status !== 200 || !isJSONContentType(response.headers.get("content-type"))) {
		await cancelResponseBody(response);
		throw new Error(`relay credential refresh failed with status ${response.status}`);
	}
	const body = expectExactRecord(
		JSON.parse(await readBoundedResponse(response)),
		["accessToken", "accessTokenExpiresAt", "tokenType"],
		"relay credential refresh response",
	);
	if (body.tokenType !== "Bearer") {
		throw new Error("relay credential refresh tokenType must be Bearer");
	}
	const refreshed = parseIrohManagedRelayCredential({
		...validated,
		accessToken: body.accessToken,
		accessTokenExpiresAt: parseTimestamp(body.accessTokenExpiresAt, "accessTokenExpiresAt"),
	});
	if (refreshed.accessTokenExpiresAt <= now || refreshed.accessTokenExpiresAt > now + MAX_ACCESS_TOKEN_LIFETIME_MS) {
		throw new Error("relay credential refresh returned an invalid access-token lifetime");
	}
	return refreshed;
}

export async function revokeIrohManagedRelayCredential(credential: IrohManagedRelayCredential): Promise<void> {
	const validated = parseIrohManagedRelayCredential(credential);
	const now = Date.now();
	if (!Number.isFinite(now) || now >= validated.refreshTokenExpiresAt) {
		return;
	}
	const response = await requestCredentialService(validated, "/v1/tokens/revoke");
	if (response.status === 401 || response.status === 410) {
		await cancelResponseBody(response);
		return;
	}
	if (response.status !== 204) {
		await cancelResponseBody(response);
		throw new Error(`relay credential revocation failed with status ${response.status}`);
	}
	const body = await readBoundedResponse(response);
	if (body.length !== 0) {
		throw new Error("relay credential revocation response must be empty");
	}
}

export function managedRelayCredentialRefreshAt(credential: IrohManagedRelayCredential, now = Date.now()): number {
	const validated = parseIrohManagedRelayCredential(credential);
	const remaining = validated.accessTokenExpiresAt - now;
	const lead = Math.min(2 * 60_000, Math.max(30_000, Math.floor(remaining / 5)));
	return validated.accessTokenExpiresAt - lead;
}

function normalizeRelayUrls(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
		throw new Error("managed relay credential relayUrls must contain between one and eight origins");
	}
	const origins = value.map((candidate) => {
		if (typeof candidate !== "string") {
			throw new Error("managed relay credential relayUrl is invalid");
		}
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			throw new Error("managed relay credential relayUrl is invalid");
		}
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			(url.pathname !== "" && url.pathname !== "/")
		) {
			throw new Error("managed relay credential relayUrl must be an HTTPS origin");
		}
		return url.origin;
	});
	if (new Set(origins).size !== origins.length) {
		throw new Error("managed relay credential relayUrls contain duplicates");
	}
	return origins;
}

function normalizeCredentialServiceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("managed relay credential serviceUrl is invalid");
	}
	const isLocalCanary =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost") &&
		url.port === LOCAL_CANARY_PORT;
	if (
		(url.protocol !== "https:" && !isLocalCanary) ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		(url.pathname !== "" && url.pathname !== "/")
	) {
		throw new Error("managed relay credential serviceUrl must be an HTTPS origin or the local canary");
	}
	return `${url.protocol}//${url.host}`;
}

async function requestCredentialService(credential: IrohManagedRelayCredential, path: string): Promise<Response> {
	return fetch(`${credential.serviceUrl}${path}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${credential.refreshToken}`,
		},
		body: null,
		redirect: "error",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

async function readBoundedResponse(response: Response): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
			await cancelResponseBody(response);
			throw new Error("relay credential response is too large");
		}
	}
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			length += result.value.byteLength;
			if (length > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("relay credential response is too large");
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {}
}

function isJSONContentType(value: string | null): boolean {
	return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseTimestamp(value: unknown, label: string): number {
	if (typeof value !== "string") {
		throw new Error(`relay credential ${label} must be an RFC 3339 string`);
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`relay credential ${label} is invalid`);
	}
	return parsed;
}

function expectTimestamp(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`managed relay credential ${label} is invalid`);
	}
	return value;
}

function expectAccessToken(value: unknown): string {
	const token = expectBoundedToken(value, "accessToken", 16, 8 * 1024);
	const segments = token.split(".");
	if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
		throw new Error("managed relay credential accessToken is not a JWT");
	}
	return token;
}

function expectBoundedToken(value: unknown, label: string, minimum: number, maximum: number): string {
	const token = expectString(value, label);
	if (token.length < minimum || token.length > maximum || /[\s\0]/.test(token)) {
		throw new Error(`managed relay credential ${label} is invalid`);
	}
	return token;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`managed relay credential ${label} must be a non-empty string`);
	}
	return value;
}

function expectExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label} has unexpected fields`);
	}
	return record;
}
