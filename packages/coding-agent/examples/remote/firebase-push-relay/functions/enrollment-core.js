const {
	createHash,
	createHmac,
	createPublicKey,
	timingSafeEqual,
	verify,
} = require("node:crypto");
const { RequestError, getBoundedPositiveInteger, getHeader, readJsonBody } = require("./core.js");

const DEFAULT_RELAY_ORIGIN = "https://iroh-relay-us-central.volt-cli.dev";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const MAX_PENDING_CLAIMS_PER_HOST = 3;
const MAX_ACTIVE_GRANTS_PER_ENDPOINT = 20;
const MAX_NEW_HOST_GRANTS_PER_CLIENT_PER_DAY = 10;
const MAX_RENEWALS_PER_GRANT_PER_HOUR = 6;
const REQUEST_QUOTA_WINDOW_MS = 60 * 1000;
const DEFAULT_REQUESTS_PER_ENDPOINT_PER_WINDOW = 60;
const DEFAULT_REQUESTS_PER_IP_PER_WINDOW = 300;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ENDPOINT_ID_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const AUTHORIZATION_PATTERN = /^Bearer ([\x21-\x7e]{32,512})$/;
const GRANT_DOMAIN = Buffer.from("volt-iroh-enrollment-grant-v1\0", "utf8");

function getEnrollmentConfig(env = process.env) {
	return {
		relayOrigins: parseRelayOrigins(env.IROH_RELAY_ORIGINS),
		requestsPerEndpointPerWindow: getBoundedPositiveInteger(
			env.IROH_ENROLLMENT_REQUESTS_PER_ENDPOINT_PER_MINUTE,
			1,
			600,
			DEFAULT_REQUESTS_PER_ENDPOINT_PER_WINDOW,
		),
		requestsPerIpPerWindow: getBoundedPositiveInteger(
			env.IROH_ENROLLMENT_REQUESTS_PER_IP_PER_MINUTE,
			1,
			3000,
			DEFAULT_REQUESTS_PER_IP_PER_WINDOW,
		),
	};
}

function parseRelayOrigins(configured) {
	const values = (configured === undefined ? DEFAULT_RELAY_ORIGIN : configured)
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (values.length === 0 || values.length > 8) {
		throw new Error("IROH_RELAY_ORIGINS must contain 1-8 comma-separated HTTPS origins");
	}
	const normalized = values.map((value) => {
		let url;
		try {
			url = new URL(value);
		} catch {
			throw new Error("IROH_RELAY_ORIGINS must contain valid absolute HTTPS origins");
		}
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			throw new Error("IROH_RELAY_ORIGINS must contain HTTPS origins without paths, credentials, query, or fragment");
		}
		return url.origin;
	});
	const unique = [...new Set(normalized)].sort();
	if (unique.length !== normalized.length) {
		throw new Error("IROH_RELAY_ORIGINS must not contain duplicate origins");
	}
	return unique;
}

function parseCreateClaimRequest(request) {
	const body = readJsonBody(request);
	expectExactKeys(
		body,
		["version", "hostEndpointId", "claimId", "claimSecretHash", "issuedAtMs", "nonce", "signature"],
		"create_claim",
	);
	return {
		version: expectVersion(body.version),
		hostEndpointId: expectEndpointId(body.hostEndpointId),
		claimId: expectBase64url(body.claimId, 16, "claim_id"),
		claimSecretHash: expectBase64url(body.claimSecretHash, 32, "claim_secret_hash"),
		issuedAtMs: expectIssuedAtMs(body.issuedAtMs),
		nonce: expectBase64url(body.nonce, 16, "nonce"),
		signature: expectBase64url(body.signature, 64, "signature"),
	};
}

function parseClaimSecretRequest(request, operation) {
	const body = readJsonBody(request);
	expectExactKeys(
		body,
		["version", "hostEndpointId", "claimId", "claimSecret", "issuedAtMs", "nonce", "signature"],
		operation,
	);
	return {
		version: expectVersion(body.version),
		hostEndpointId: expectEndpointId(body.hostEndpointId),
		claimId: expectBase64url(body.claimId, 16, "claim_id"),
		claimSecret: expectBase64url(body.claimSecret, 32, "claim_secret"),
		issuedAtMs: expectIssuedAtMs(body.issuedAtMs),
		nonce: expectBase64url(body.nonce, 16, "nonce"),
		signature: expectBase64url(body.signature, 64, "signature"),
	};
}

function parseApproveClaimRequest(request) {
	const body = readJsonBody(request);
	expectExactKeys(
		body,
		[
			"version",
			"hostEndpointId",
			"clientEndpointId",
			"claimId",
			"claimSecret",
			"grantSecret",
			"issuedAtMs",
			"nonce",
			"signature",
		],
		"approve_claim",
	);
	return {
		version: expectVersion(body.version),
		hostEndpointId: expectEndpointId(body.hostEndpointId),
		clientEndpointId: expectEndpointId(body.clientEndpointId),
		claimId: expectBase64url(body.claimId, 16, "claim_id"),
		claimSecret: expectBase64url(body.claimSecret, 32, "claim_secret"),
		grantSecret: expectBase64url(body.grantSecret, 32, "grant_secret"),
		issuedAtMs: expectIssuedAtMs(body.issuedAtMs),
		nonce: expectBase64url(body.nonce, 16, "nonce"),
		signature: expectBase64url(body.signature, 64, "signature"),
	};
}

function parseGrantRequest(request, operation) {
	const body = readJsonBody(request);
	expectExactKeys(
		body,
		[
			"version",
			"hostEndpointId",
			"clientEndpointId",
			"grantId",
			"grantSecret",
			"issuedAtMs",
			"nonce",
			"signature",
		],
		operation,
	);
	return {
		version: expectVersion(body.version),
		hostEndpointId: expectEndpointId(body.hostEndpointId),
		clientEndpointId: expectEndpointId(body.clientEndpointId),
		grantId: expectBase64url(body.grantId, 32, "grant_id"),
		grantSecret: expectBase64url(body.grantSecret, 32, "grant_secret"),
		issuedAtMs: expectIssuedAtMs(body.issuedAtMs),
		nonce: expectBase64url(body.nonce, 16, "nonce"),
		signature: expectBase64url(body.signature, 64, "signature"),
	};
}

function assertFreshSignature(request, operation, nowMs) {
	if (Math.abs(nowMs - request.issuedAtMs) > MAX_CLOCK_SKEW_MS) {
		throw new RequestError(401, "signature_timestamp_invalid");
	}
	let canonicalMessage;
	let signerEndpointId;
	if (operation === "create_claim") {
		canonicalMessage = canonicalClaimMessage(operation, request, request.claimSecretHash);
		signerEndpointId = request.hostEndpointId;
	} else if (operation === "claim_status" || operation === "cancel_claim") {
		canonicalMessage = canonicalClaimMessage(operation, request, hashDecodedSecret(request.claimSecret));
		signerEndpointId = request.hostEndpointId;
	} else if (operation === "approve_claim") {
		canonicalMessage = canonicalApproveMessage(
			request,
			hashDecodedSecret(request.claimSecret),
			hashDecodedSecret(request.grantSecret),
		);
		signerEndpointId = request.clientEndpointId;
	} else if (operation === "renew_grant" || operation === "revoke_grant") {
		canonicalMessage = canonicalGrantMessage(operation, request, hashDecodedSecret(request.grantSecret));
		signerEndpointId = request.clientEndpointId;
	} else {
		throw new Error("unsupported enrollment signature operation");
	}
	if (!verifyEd25519Signature(signerEndpointId, canonicalMessage, request.signature)) {
		throw new RequestError(401, "signature_invalid");
	}
	return canonicalMessage;
}

function canonicalClaimMessage(operation, request, claimSecretHash) {
	return Buffer.from(
		[
			"volt-iroh-enrollment-signature-v1",
			`operation:${operation}`,
			`host_endpoint_id:${request.hostEndpointId}`,
			`claim_id:${request.claimId}`,
			`claim_secret_sha256:${claimSecretHash}`,
			`issued_at_ms:${request.issuedAtMs}`,
			`nonce:${request.nonce}`,
			"",
		].join("\n"),
		"utf8",
	);
}

function canonicalApproveMessage(request, claimSecretHash, grantSecretHash) {
	return Buffer.from(
		[
			"volt-iroh-enrollment-signature-v1",
			"operation:approve_claim",
			`host_endpoint_id:${request.hostEndpointId}`,
			`client_endpoint_id:${request.clientEndpointId}`,
			`claim_id:${request.claimId}`,
			`claim_secret_sha256:${claimSecretHash}`,
			`grant_secret_sha256:${grantSecretHash}`,
			`issued_at_ms:${request.issuedAtMs}`,
			`nonce:${request.nonce}`,
			"",
		].join("\n"),
		"utf8",
	);
}

function canonicalGrantMessage(operation, request, grantSecretHash) {
	return Buffer.from(
		[
			"volt-iroh-enrollment-signature-v1",
			`operation:${operation}`,
			`host_endpoint_id:${request.hostEndpointId}`,
			`client_endpoint_id:${request.clientEndpointId}`,
			`grant_id:${request.grantId}`,
			`grant_secret_sha256:${grantSecretHash}`,
			`issued_at_ms:${request.issuedAtMs}`,
			`nonce:${request.nonce}`,
			"",
		].join("\n"),
		"utf8",
	);
}

function verifyEd25519Signature(endpointId, message, signature) {
	try {
		const publicKey = createPublicKey({
			format: "der",
			key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(endpointId, "hex")]),
			type: "spki",
		});
		return verify(null, message, publicKey, decodeBase64url(signature));
	} catch {
		return false;
	}
}

function getGrantId(hostEndpointId, clientEndpointId) {
	return createHash("sha256")
		.update(GRANT_DOMAIN)
		.update(Buffer.from(hostEndpointId, "hex"))
		.update(Buffer.from(clientEndpointId, "hex"))
		.digest("base64url");
}

function hashDecodedSecret(secret) {
	return createHash("sha256").update(decodeBase64url(secret)).digest("base64url");
}

function timingSafeBase64urlEqual(actual, expected) {
	if (typeof actual !== "string" || typeof expected !== "string") return false;
	const actualBuffer = Buffer.from(actual, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseRelayAuthorization(request, currentSecret, nextSecret) {
	const authorization = getHeader(request, "authorization");
	const match = typeof authorization === "string" ? AUTHORIZATION_PATTERN.exec(authorization) : null;
	if (match === null || !isValidServerSecret(currentSecret)) {
		throw new RequestError(401, "relay_unauthorized");
	}
	const suppliedDigest = createHash("sha256").update(match[1], "utf8").digest();
	let accepted = false;
	for (const secret of [currentSecret, nextSecret]) {
		if (!isValidServerSecret(secret)) continue;
		const candidateDigest = createHash("sha256").update(secret, "utf8").digest();
		accepted = timingSafeEqual(suppliedDigest, candidateDigest) || accepted;
	}
	if (!accepted) {
		throw new RequestError(401, "relay_unauthorized");
	}
}

function getRelayEndpointId(request) {
	const endpointId = getHeader(request, "x-iroh-nodeid");
	return expectEndpointId(endpointId);
}

function getRequestIp(request) {
	if (typeof request.ip !== "string" || !/^[\x21-\x7e]{1,128}$/.test(request.ip)) {
		throw new RequestError(400, "request_ip_unavailable");
	}
	return request.ip;
}

function getSaltedIpId(ip, salt) {
	if (typeof salt !== "string" || salt.length < 32 || salt.length > 512) {
		throw new Error("IROH_ENROLLMENT_IP_SALT must be a 32-512 character secret");
	}
	return createHmac("sha256", salt).update(ip, "utf8").digest("base64url");
}

function expectVersion(value) {
	if (value !== 1) throw new RequestError(400, "version_unsupported");
	return value;
}

function expectEndpointId(value) {
	if (typeof value !== "string" || !ENDPOINT_ID_PATTERN.test(value)) {
		throw new RequestError(400, "endpoint_id_invalid");
	}
	return value;
}

function expectIssuedAtMs(value) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RequestError(400, "issued_at_ms_invalid");
	}
	return value;
}

function expectBase64url(value, decodedBytes, label) {
	if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
		throw new RequestError(400, `${label}_invalid`);
	}
	const decoded = decodeBase64url(value);
	if (decoded.length !== decodedBytes || decoded.toString("base64url") !== value) {
		throw new RequestError(400, `${label}_invalid`);
	}
	return value;
}

function decodeBase64url(value) {
	return Buffer.from(value, "base64url");
}

function expectExactKeys(value, expectedKeys, operation) {
	const actualKeys = Object.keys(value);
	const expected = new Set(expectedKeys);
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key) => !expected.has(key))) {
		throw new RequestError(400, `${operation}_schema_invalid`);
	}
}

function isValidServerSecret(value) {
	return typeof value === "string" && /^[\x21-\x7e]{32,512}$/.test(value);
}

function getTimestampMillis(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "object" && value !== null && typeof value.toMillis === "function") {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : undefined;
	}
	if (typeof value === "object" && value !== null && Number.isFinite(value.seconds)) {
		return Number(value.seconds) * 1000;
	}
	return undefined;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
	CLAIM_TTL_MS,
	DEFAULT_RELAY_ORIGIN,
	DEFAULT_REQUESTS_PER_ENDPOINT_PER_WINDOW,
	DEFAULT_REQUESTS_PER_IP_PER_WINDOW,
	GRANT_TTL_MS,
	MAX_ACTIVE_GRANTS_PER_ENDPOINT,
	MAX_CLOCK_SKEW_MS,
	MAX_NEW_HOST_GRANTS_PER_CLIENT_PER_DAY,
	MAX_PENDING_CLAIMS_PER_HOST,
	MAX_RENEWALS_PER_GRANT_PER_HOUR,
	REQUEST_QUOTA_WINDOW_MS,
	assertFreshSignature,
	canonicalApproveMessage,
	canonicalClaimMessage,
	canonicalGrantMessage,
	getEnrollmentConfig,
	getGrantId,
	getRelayEndpointId,
	getRequestIp,
	getSaltedIpId,
	getTimestampMillis,
	hashDecodedSecret,
	isRecord,
	parseApproveClaimRequest,
	parseClaimSecretRequest,
	parseCreateClaimRequest,
	parseGrantRequest,
	parseRelayAuthorization,
	parseRelayOrigins,
	timingSafeBase64urlEqual,
	verifyEd25519Signature,
};
