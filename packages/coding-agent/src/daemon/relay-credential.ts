import { createHash } from "node:crypto";

const RELAY_CREDENTIAL_SCHEMA_VERSION = 2;
const RELAY_CREDENTIAL_CLAIM_SCHEMA_VERSION = 1;
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ACCESS_TOKEN_LIFETIME_MS = 60 * 60_000;
const LOCAL_CANARY_PORT = "8085";
const FAST_PENDING_RESPONSE_COUNT = 3;
const STEADY_PENDING_RETRY_MS = 2_000;
const MAX_EXCHANGE_FAILURE_RETRY_MS = 30_000;
const RETRY_JITTER_RATIO = 0.2;
const MAX_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const MAX_SUBSCRIPTION_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export class IrohRelayCredentialSubscriptionInactiveError extends Error {
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		super("Volt Pro subscription is inactive");
		this.name = "IrohRelayCredentialSubscriptionInactiveError";
		this.retryAfterMs = retryAfterMs;
	}
}

export interface IrohManagedRelayCredential {
	schemaVersion: 2;
	serviceUrl: string;
	relayUrls: string[];
	endpointNodeId: string;
	endpointId: string;
	grantId: string;
	accessToken: string;
	accessTokenExpiresAt: number;
	refreshToken: string;
}

/** Durable daemon-owned authority for one broker claim. */
export interface IrohManagedRelayCredentialClaim {
	schemaVersion: 1;
	serviceUrl: string;
	relayUrls: string[];
	hostNodeId: string;
	claimSecret: string;
	/** Present only for the bootstrap claim that will create the host endpoint. */
	bootstrapRefreshToken?: string;
	/** Added only after the broker has acknowledged claim creation. */
	claimId?: string;
	expiresAt?: number;
}

export interface IrohManagedRelayAppEndpoint {
	schemaVersion: 1;
	claimId: string;
	nodeId: string;
	endpointId: string;
	revocationPending: boolean;
}

export interface IrohRelayCredentialClaimResponse {
	claimId: string;
	expiresAt: number;
}

export interface IrohRelayCredentialExchangeResponse {
	grantId: string;
	endpointId: string;
	hostNodeId: string;
	appEndpointId: string;
	appNodeId: string;
	credential: {
		accessToken: string;
		accessTokenExpiresAt: number;
		tokenType: "Bearer";
	};
}

export type IrohRelayCredentialExchangeResult =
	| { status: "pending"; retryAfterMs: number }
	| { status: "rate_limited"; retryAfterMs: number }
	| { status: "approved"; exchange: IrohRelayCredentialExchangeResponse };

export function managedRelayCredentialPendingRetryMs(
	serverRetryAfterMs: number,
	pendingResponseCount: number,
	randomFraction = Math.random(),
): number {
	expectRetryDelay(serverRetryAfterMs, "pending retry delay");
	expectRetryCount(pendingResponseCount, "pending response count");
	expectRandomFraction(randomFraction);
	if (pendingResponseCount <= FAST_PENDING_RESPONSE_COUNT) return serverRetryAfterMs;
	return jitterRetryDelay(
		Math.max(serverRetryAfterMs, STEADY_PENDING_RETRY_MS),
		serverRetryAfterMs,
		Number.MAX_SAFE_INTEGER,
		randomFraction,
	);
}

export function managedRelayCredentialFailureRetryMs(
	consecutiveFailureCount: number,
	randomFraction = Math.random(),
): number {
	expectRetryCount(consecutiveFailureCount, "exchange failure count");
	expectRandomFraction(randomFraction);
	const exponentialDelay = 1_000 * 2 ** Math.min(consecutiveFailureCount - 1, 5);
	return jitterRetryDelay(
		Math.min(exponentialDelay, MAX_EXCHANGE_FAILURE_RETRY_MS),
		1_000,
		MAX_EXCHANGE_FAILURE_RETRY_MS,
		randomFraction,
	);
}

export function managedRelayCredentialRateLimitRetryMs(
	serverRetryAfterMs: number,
	randomFraction = Math.random(),
): number {
	expectRetryDelay(serverRetryAfterMs, "rate-limit retry delay");
	expectRandomFraction(randomFraction);
	return Math.round(serverRetryAfterMs * (1 + RETRY_JITTER_RATIO * randomFraction));
}

export function parseIrohManagedRelayCredential(value: unknown): IrohManagedRelayCredential {
	const record = expectExactRecord(
		value,
		[
			"schemaVersion",
			"serviceUrl",
			"relayUrls",
			"endpointNodeId",
			"endpointId",
			"grantId",
			"accessToken",
			"accessTokenExpiresAt",
			"refreshToken",
		],
		"managed relay credential",
	);
	if (record.schemaVersion !== RELAY_CREDENTIAL_SCHEMA_VERSION) {
		throw new Error("unsupported managed relay credential schema");
	}
	const serviceUrl = normalizeIrohCredentialServiceUrl(expectString(record.serviceUrl, "serviceUrl"));
	const relayUrls = normalizeRelayUrls(record.relayUrls);
	const endpointNodeId = expectNodeId(record.endpointNodeId, "endpointNodeId");
	const endpointId = expectBoundedToken(record.endpointId, "endpointId", 16, 128);
	const grantId = expectBoundedToken(record.grantId, "grantId", 16, 128);
	const accessToken = expectAccessToken(record.accessToken);
	const accessTokenExpiresAt = expectTimestamp(record.accessTokenExpiresAt, "accessTokenExpiresAt");
	const refreshToken = expectRefreshToken(record.refreshToken);
	return {
		schemaVersion: RELAY_CREDENTIAL_SCHEMA_VERSION,
		serviceUrl,
		relayUrls,
		endpointNodeId,
		endpointId,
		grantId,
		accessToken,
		accessTokenExpiresAt,
		refreshToken,
	};
}

export function parseIrohManagedRelayAppEndpoint(value: unknown): IrohManagedRelayAppEndpoint {
	const record = expectExactRecord(
		value,
		["schemaVersion", "claimId", "nodeId", "endpointId", "revocationPending"],
		"managed relay app endpoint",
	);
	if (record.schemaVersion !== 1 || typeof record.revocationPending !== "boolean") {
		throw new Error("managed relay app endpoint is invalid");
	}
	return {
		schemaVersion: 1,
		claimId: expectClaimId(record.claimId),
		nodeId: expectNodeId(record.nodeId, "app endpoint nodeId"),
		endpointId: expectBoundedToken(record.endpointId, "app endpointId", 16, 128),
		revocationPending: record.revocationPending,
	};
}

export function parseIrohManagedRelayCredentialClaim(value: unknown): IrohManagedRelayCredentialClaim {
	const record = expectAllowedRecord(
		value,
		[
			"schemaVersion",
			"serviceUrl",
			"relayUrls",
			"hostNodeId",
			"claimSecret",
			"bootstrapRefreshToken",
			"claimId",
			"expiresAt",
		],
		"managed relay credential claim",
	);
	if (record.schemaVersion !== RELAY_CREDENTIAL_CLAIM_SCHEMA_VERSION) {
		throw new Error("unsupported managed relay credential claim schema");
	}
	const claimId = expectOptionalClaimId(record.claimId);
	const expiresAt = record.expiresAt === undefined ? undefined : expectTimestamp(record.expiresAt, "claim expiresAt");
	if ((claimId === undefined) !== (expiresAt === undefined)) {
		throw new Error("managed relay credential claim id and expiry must be persisted together");
	}
	const bootstrapRefreshToken =
		record.bootstrapRefreshToken === undefined ? undefined : expectRefreshToken(record.bootstrapRefreshToken);
	return {
		schemaVersion: RELAY_CREDENTIAL_CLAIM_SCHEMA_VERSION,
		serviceUrl: normalizeIrohCredentialServiceUrl(expectString(record.serviceUrl, "claim serviceUrl")),
		relayUrls: normalizeRelayUrls(record.relayUrls),
		hostNodeId: expectNodeId(record.hostNodeId, "claim hostNodeId"),
		claimSecret: expectPrefixedSecret(record.claimSecret, "claimSecret", "vpc_"),
		...(bootstrapRefreshToken === undefined ? {} : { bootstrapRefreshToken }),
		...(claimId === undefined ? {} : { claimId, expiresAt }),
	};
}

export async function createIrohManagedRelayCredentialClaim(
	candidate: IrohManagedRelayCredentialClaim,
	activeCredential?: IrohManagedRelayCredential,
): Promise<IrohManagedRelayCredentialClaim> {
	const claim = parseIrohManagedRelayCredentialClaim(candidate);
	if (claim.claimId !== undefined) {
		throw new Error("managed relay credential claim is already created");
	}
	const claimSecretHash = hashSecret(claim.claimSecret);
	let authorization: string | undefined;
	let body: Record<string, string>;
	if (activeCredential === undefined) {
		if (claim.bootstrapRefreshToken === undefined) {
			throw new Error("bootstrap relay credential claim requires a host refresh token");
		}
		body = {
			hostNodeId: claim.hostNodeId,
			claimSecretHash,
			hostRefreshTokenHash: hashSecret(claim.bootstrapRefreshToken),
		};
	} else {
		const active = parseIrohManagedRelayCredential(activeCredential);
		if (
			active.endpointNodeId !== claim.hostNodeId ||
			active.serviceUrl !== claim.serviceUrl ||
			!sameOrigins(active.relayUrls, claim.relayUrls) ||
			claim.bootstrapRefreshToken !== undefined
		) {
			throw new Error("later relay credential claim does not match the active daemon grant");
		}
		authorization = active.refreshToken;
		body = { claimSecretHash };
	}
	const response = await requestCredentialService(claim.serviceUrl, "/v1/pairing-claims", {
		authorization,
		jsonBody: body,
	});
	if (response.status !== 201 || !isJSONContentType(response.headers.get("content-type"))) {
		await cancelResponseBody(response);
		throw new Error(`relay credential claim creation failed with status ${response.status}`);
	}
	const decoded = expectExactRecord(
		JSON.parse(await readBoundedResponse(response)),
		["claimId", "expiresAt"],
		"relay credential claim response",
	);
	return parseIrohManagedRelayCredentialClaim({
		...claim,
		claimId: expectClaimId(decoded.claimId),
		expiresAt: parseTimestamp(decoded.expiresAt, "claim expiresAt"),
	});
}

export async function exchangeIrohManagedRelayCredentialClaim(
	claimValue: IrohManagedRelayCredentialClaim,
): Promise<IrohRelayCredentialExchangeResult> {
	const claim = parseIrohManagedRelayCredentialClaim(claimValue);
	if (claim.claimId === undefined || claim.expiresAt === undefined) {
		throw new Error("managed relay credential claim has not been created");
	}
	const response = await requestCredentialService(claim.serviceUrl, `/v1/pairing-claims/${claim.claimId}/exchange`, {
		authorization: claim.claimSecret,
	});
	if (response.status === 429) {
		const retryAfter = response.headers.get("retry-after");
		await cancelResponseBody(response);
		const retryAfterSeconds = Number(retryAfter);
		if (
			retryAfter === null ||
			!Number.isInteger(retryAfterSeconds) ||
			retryAfterSeconds < 1 ||
			retryAfterSeconds > MAX_RATE_LIMIT_RETRY_AFTER_SECONDS
		) {
			throw new Error("relay credential exchange rate-limit response is invalid");
		}
		return { status: "rate_limited", retryAfterMs: retryAfterSeconds * 1000 };
	}
	if (response.status === 202 && isJSONContentType(response.headers.get("content-type"))) {
		const body = expectExactRecord(
			JSON.parse(await readBoundedResponse(response)),
			["status", "retryAfterSeconds"],
			"relay credential pending exchange response",
		);
		if (
			body.status !== "pending" ||
			typeof body.retryAfterSeconds !== "number" ||
			!Number.isInteger(body.retryAfterSeconds) ||
			body.retryAfterSeconds < 1 ||
			body.retryAfterSeconds > 30
		) {
			throw new Error("relay credential pending exchange response is invalid");
		}
		return { status: "pending", retryAfterMs: body.retryAfterSeconds * 1000 };
	}
	if (response.status !== 200 || !isJSONContentType(response.headers.get("content-type"))) {
		await cancelResponseBody(response);
		throw new Error(`relay credential claim exchange failed with status ${response.status}`);
	}
	return {
		status: "approved",
		exchange: parseExchangeResponse(JSON.parse(await readBoundedResponse(response))),
	};
}

export function activateIrohManagedRelayCredential(
	claimValue: IrohManagedRelayCredentialClaim,
	exchangeValue: IrohRelayCredentialExchangeResponse,
	activeCredential?: IrohManagedRelayCredential,
): IrohManagedRelayCredential {
	const claim = parseIrohManagedRelayCredentialClaim(claimValue);
	const exchange = parseExchangeResponse(exchangeValue);
	if (exchange.hostNodeId !== claim.hostNodeId) {
		throw new Error("relay credential exchange returned another host identity");
	}
	const active = activeCredential === undefined ? undefined : parseIrohManagedRelayCredential(activeCredential);
	const refreshToken = claim.bootstrapRefreshToken ?? active?.refreshToken;
	if (refreshToken === undefined) {
		throw new Error("relay credential exchange has no local host refresh authority");
	}
	if (
		active !== undefined &&
		(active.endpointNodeId !== exchange.hostNodeId ||
			active.endpointId !== exchange.endpointId ||
			active.grantId !== exchange.grantId ||
			active.serviceUrl !== claim.serviceUrl ||
			!sameOrigins(active.relayUrls, claim.relayUrls))
	) {
		throw new Error("relay credential exchange changed the active daemon grant");
	}
	return parseIrohManagedRelayCredential({
		schemaVersion: RELAY_CREDENTIAL_SCHEMA_VERSION,
		serviceUrl: claim.serviceUrl,
		relayUrls: claim.relayUrls,
		endpointNodeId: exchange.hostNodeId,
		endpointId: exchange.endpointId,
		grantId: exchange.grantId,
		accessToken: exchange.credential.accessToken,
		accessTokenExpiresAt: exchange.credential.accessTokenExpiresAt,
		refreshToken,
	});
}

export async function refreshIrohManagedRelayCredential(
	credential: IrohManagedRelayCredential,
): Promise<IrohManagedRelayCredential> {
	const validated = parseIrohManagedRelayCredential(credential);
	const now = Date.now();
	const response = await requestCredentialService(validated.serviceUrl, "/v1/tokens/refresh", {
		authorization: validated.refreshToken,
	});
	if (response.status === 402 && isJSONContentType(response.headers.get("content-type"))) {
		const retryAfter = response.headers.get("retry-after");
		const retryAfterSeconds = Number(retryAfter);
		const body = expectExactRecord(
			JSON.parse(await readBoundedResponse(response)),
			["error"],
			"relay credential subscription response",
		);
		if (
			body.error !== "subscription_inactive" ||
			retryAfter === null ||
			!Number.isInteger(retryAfterSeconds) ||
			retryAfterSeconds < 1 ||
			retryAfterSeconds > MAX_SUBSCRIPTION_RETRY_AFTER_SECONDS
		) {
			throw new Error("relay credential subscription response is invalid");
		}
		throw new IrohRelayCredentialSubscriptionInactiveError(retryAfterSeconds * 1000);
	}
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

export async function revokeIrohManagedRelayAppEndpoint(
	credential: IrohManagedRelayCredential,
	endpointId: string,
): Promise<void> {
	const validated = parseIrohManagedRelayCredential(credential);
	const validatedEndpointId = expectBoundedToken(endpointId, "app endpointId", 16, 128);
	const response = await requestCredentialService(validated.serviceUrl, "/v1/grant/endpoints/revoke", {
		authorization: validated.refreshToken,
		jsonBody: { endpointId: validatedEndpointId },
	});
	if (response.status === 401 || response.status === 410) {
		await cancelResponseBody(response);
		return;
	}
	if (response.status !== 204) {
		await cancelResponseBody(response);
		throw new Error(`relay app endpoint revocation failed with status ${response.status}`);
	}
	const body = await readBoundedResponse(response);
	if (body.length !== 0) {
		throw new Error("relay app endpoint revocation response must be empty");
	}
}

export async function revokeIrohManagedRelayCredential(credential: IrohManagedRelayCredential): Promise<void> {
	const validated = parseIrohManagedRelayCredential(credential);
	const response = await requestCredentialService(validated.serviceUrl, "/v1/grant/revoke", {
		authorization: validated.refreshToken,
	});
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

export function normalizeIrohCredentialServiceUrl(value: string): string {
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

function parseExchangeResponse(value: unknown): IrohRelayCredentialExchangeResponse {
	const record = expectExactRecord(
		value,
		["grantId", "endpointId", "hostNodeId", "appEndpointId", "appNodeId", "credential"],
		"relay credential exchange response",
	);
	const credential = expectExactRecord(
		record.credential,
		["accessToken", "accessTokenExpiresAt", "tokenType"],
		"relay credential exchange access token",
	);
	if (credential.tokenType !== "Bearer") {
		throw new Error("relay credential exchange tokenType must be Bearer");
	}
	const now = Date.now();
	const accessTokenExpiresAt =
		typeof credential.accessTokenExpiresAt === "number"
			? expectTimestamp(credential.accessTokenExpiresAt, "accessTokenExpiresAt")
			: parseTimestamp(credential.accessTokenExpiresAt, "accessTokenExpiresAt");
	if (accessTokenExpiresAt <= now || accessTokenExpiresAt > now + MAX_ACCESS_TOKEN_LIFETIME_MS) {
		throw new Error("relay credential exchange returned an invalid access-token lifetime");
	}
	return {
		grantId: expectBoundedToken(record.grantId, "grantId", 16, 128),
		endpointId: expectBoundedToken(record.endpointId, "endpointId", 16, 128),
		hostNodeId: expectNodeId(record.hostNodeId, "hostNodeId"),
		appEndpointId: expectBoundedToken(record.appEndpointId, "appEndpointId", 16, 128),
		appNodeId: expectNodeId(record.appNodeId, "appNodeId"),
		credential: {
			accessToken: expectAccessToken(credential.accessToken),
			accessTokenExpiresAt,
			tokenType: "Bearer",
		},
	};
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

function sameOrigins(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function requestCredentialService(
	serviceUrlValue: string,
	path: string,
	options: { authorization?: string; jsonBody?: Record<string, string> },
): Promise<Response> {
	const serviceUrl = normalizeIrohCredentialServiceUrl(serviceUrlValue);
	const body = options.jsonBody === undefined ? null : JSON.stringify(options.jsonBody);
	return fetch(`${serviceUrl}${path}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			...(options.authorization === undefined ? {} : { Authorization: `Bearer ${options.authorization}` }),
			...(body === null ? {} : { "Content-Type": "application/json" }),
		},
		body,
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

function hashSecret(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("base64url");
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

function expectNodeId(value: unknown, label: string): string {
	const nodeId = expectString(value, label);
	if (!/^[0-9a-f]{64}$/.test(nodeId)) {
		throw new Error(`managed relay credential ${label} is invalid`);
	}
	return nodeId;
}

function expectAccessToken(value: unknown): string {
	const token = expectBoundedToken(value, "accessToken", 16, 8 * 1024);
	const segments = token.split(".");
	if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
		throw new Error("managed relay credential accessToken is not a JWT");
	}
	return token;
}

function expectRefreshToken(value: unknown): string {
	return expectPrefixedSecret(value, "refreshToken", "vrr_");
}

function expectPrefixedSecret(value: unknown, label: string, prefix: "vpc_" | "vrr_"): string {
	const token = expectString(value, label);
	const encoded = token.slice(prefix.length);
	if (!token.startsWith(prefix) || encoded.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
		throw new Error(`managed relay credential ${label} is invalid`);
	}
	return token;
}

function expectClaimId(value: unknown): string {
	const claimId = expectString(value, "claimId");
	if (!/^[A-Za-z0-9_-]{24}$/.test(claimId)) {
		throw new Error("managed relay credential claimId is invalid");
	}
	return claimId;
}

function expectOptionalClaimId(value: unknown): string | undefined {
	return value === undefined ? undefined : expectClaimId(value);
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

function expectRetryDelay(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`managed relay credential ${label} is invalid`);
	}
}

function expectRetryCount(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`managed relay credential ${label} is invalid`);
	}
}

function expectRandomFraction(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("managed relay credential retry jitter is invalid");
	}
}

function jitterRetryDelay(baseMs: number, minimumMs: number, maximumMs: number, randomFraction: number): number {
	const factor = 1 - RETRY_JITTER_RATIO + 2 * RETRY_JITTER_RATIO * randomFraction;
	return Math.min(maximumMs, Math.max(minimumMs, Math.round(baseMs * factor)));
}

function expectAllowedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(keys);
	if (Object.keys(record).some((key) => !allowed.has(key))) {
		throw new Error(`${label} has unexpected fields`);
	}
	return record;
}

function expectExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	const record = expectAllowedRecord(value, keys, label);
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label} has unexpected fields`);
	}
	return record;
}
