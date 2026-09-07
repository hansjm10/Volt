const { createPublicKey, verify } = require("node:crypto");

const MAX_ACCESS_TOKEN_BYTES = 8 * 1024;
const MAX_JWKS_BYTES = 16 * 1024;
const JWKS_CACHE_MS = 5 * 60_000;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 1_000;
const CLOCK_SKEW_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 5_000;
const identifierPattern = /^[A-Za-z0-9_-]{16,128}$/;
const nodeIdPattern = /^[0-9a-f]{64}$/;
const knownDeployments = new Map([
	[
		"https://credentials.volt-cli.dev",
		{
			audience: "volt-iroh-relay",
			jwksUrl: "https://credentials.volt-cli.dev/.well-known/jwks.json",
		},
	],
	[
		"https://credentials-canary.volt-cli.dev",
		{
			audience: "volt-iroh-relay-canary",
			jwksUrl: "https://credentials-canary.volt-cli.dev/.well-known/jwks.json",
		},
	],
]);

const deployments = configuredDeployments(process.env.ALLOWED_RELAY_CREDENTIAL_ISSUERS);

class RelayAccessVerificationError extends Error {}
class RelayKeyServiceUnavailableError extends Error {}

function configuredDeployments(value) {
	const issuers = value === undefined || value.trim() === ""
		? Array.from(knownDeployments.keys())
		: value.split(",").map((entry) => entry.trim());
	if (issuers.length < 1 || issuers.length > knownDeployments.size || new Set(issuers).size !== issuers.length) {
		throw new Error("ALLOWED_RELAY_CREDENTIAL_ISSUERS is invalid");
	}
	const configured = new Map();
	for (const issuer of issuers) {
		const deployment = knownDeployments.get(issuer);
		if (deployment === undefined) {
			throw new Error("ALLOWED_RELAY_CREDENTIAL_ISSUERS contains an unknown issuer");
		}
		configured.set(issuer, deployment);
	}
	return configured;
}

function requireMatchingRelayGrant(existingGrantId, relayGrantId) {
	if (!identifierPattern.test(relayGrantId)) {
		throw new RelayAccessVerificationError("managed relay grant invalid");
	}
	if (existingGrantId !== undefined && existingGrantId !== relayGrantId) {
		throw new RelayAccessVerificationError("managed relay grant mismatch");
	}
	return relayGrantId;
}

function createRelayAccessVerifier(options = {}) {
	const fetcher = options.fetcher ?? fetch;
	const now = options.now ?? Date.now;
	const deploymentMap = options.deployments ?? deployments;
	const cache = new Map();

	return async function verifyRelayAccess(authorization, expectedHostNodeId) {
		if (
			typeof authorization !== "string" ||
			authorization.length > MAX_ACCESS_TOKEN_BYTES + 7 ||
			!authorization.startsWith("Bearer ")
		) {
			throw new RelayAccessVerificationError("managed relay bearer required");
		}
		const token = authorization.slice(7);
		if (token.length === 0 || token.length > MAX_ACCESS_TOKEN_BYTES || /[\s,]/u.test(token)) {
			throw new RelayAccessVerificationError("managed relay bearer invalid");
		}
		const segments = token.split(".");
		if (segments.length !== 3) {
			throw new RelayAccessVerificationError("managed relay bearer invalid");
		}
		const header = decodeSegment(segments[0], 2 * 1024);
		const claims = decodeSegment(segments[1], 4 * 1024);
		const signature = decodeBase64Url(segments[2], 128);
		if (
			header.alg !== "EdDSA" ||
			typeof header.kid !== "string" ||
			!identifierPattern.test(header.kid) ||
			signature.length !== 64
		) {
			throw new RelayAccessVerificationError("managed relay bearer invalid");
		}
		const deployment = deploymentMap.get(claims.iss);
		if (deployment === undefined || claims.aud !== deployment.audience) {
			throw new RelayAccessVerificationError("managed relay authority invalid");
		}
		const key = await resolveKey(cache, fetcher, now, deployment, header.kid);
		const validSignature = verify(
			null,
			Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"),
			key,
			signature,
		);
		if (!validSignature) {
			throw new RelayAccessVerificationError("managed relay signature invalid");
		}
		const nowSeconds = Math.floor(now() / 1000);
		if (
			claims.scope !== "relay:connect" ||
			claims.endpoint_kind !== "host" ||
			!nodeIdPattern.test(claims.sub) ||
			claims.sub !== expectedHostNodeId ||
			!identifierPattern.test(claims.grant_id) ||
			!Number.isSafeInteger(claims.iat) ||
			!Number.isSafeInteger(claims.exp) ||
			claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
			claims.exp < nowSeconds - CLOCK_SKEW_SECONDS ||
			claims.exp > claims.iat + 60 * 60
		) {
			throw new RelayAccessVerificationError("managed relay claims invalid");
		}
		return { grantId: claims.grant_id };
	};
}

async function resolveKey(cache, fetcher, now, deployment, keyId) {
	let cached = cache.get(deployment.jwksUrl);
	if (cached === undefined) {
		cached = {
			expiresAtMs: 0,
			keys: new Map(),
			refreshPromise: undefined,
			refreshError: undefined,
			unknownKeyRefreshAfterMs: 0,
		};
		cache.set(deployment.jwksUrl, cached);
	}
	const expired = cached.expiresAtMs <= now();
	if (!expired && cached.keys.has(keyId)) {
		return cached.keys.get(keyId);
	}
	if (cached.refreshPromise === undefined && (expired || cached.unknownKeyRefreshAfterMs <= now())) {
		// Bound misses per JWKS URL, not per attacker-controlled kid. Initial/expiry
		// fetches still get one immediate rotation refresh on a later cached miss.
		if (!expired) cached.unknownKeyRefreshAfterMs = now() + UNKNOWN_KEY_REFRESH_COOLDOWN_MS;
		cached.refreshPromise = refreshKeys(cached, fetcher, now, deployment).finally(() => {
			cached.refreshPromise = undefined;
		});
	}
	if (cached.refreshPromise !== undefined) {
		await cached.refreshPromise;
	} else if (cached.refreshError !== undefined) {
		// Throttling a failed refresh must not reclassify the bearer as invalid.
		throw cached.refreshError;
	}
	const key = cached.keys.get(keyId);
	if (key === undefined) {
		throw new RelayAccessVerificationError("managed relay key unknown");
	}
	return key;
}

async function refreshKeys(cached, fetcher, now, deployment) {
	try {
		const response = await fetcher(deployment.jwksUrl, {
			headers: { accept: "application/json" },
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
			throw new Error("managed relay keys unavailable");
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > MAX_JWKS_BYTES) {
			throw new Error("managed relay keys invalid");
		}
		const decoded = JSON.parse(bytes.toString("utf8"));
		if (!isRecord(decoded) || !Array.isArray(decoded.keys) || decoded.keys.length < 1 || decoded.keys.length > 8) {
			throw new Error("managed relay keys invalid");
		}
		const keys = new Map();
		for (const key of decoded.keys) {
			if (
				!isRecord(key) ||
				key.kty !== "OKP" ||
				key.crv !== "Ed25519" ||
				key.alg !== "EdDSA" ||
				key.use !== "sig" ||
				typeof key.kid !== "string" ||
				!identifierPattern.test(key.kid) ||
				typeof key.x !== "string" ||
				decodeBase64Url(key.x, 64).length !== 32 ||
				keys.has(key.kid)
			) {
				throw new Error("managed relay keys invalid");
			}
			keys.set(key.kid, createPublicKey({ format: "jwk", key }));
		}
		cached.keys = keys;
		cached.expiresAtMs = now() + JWKS_CACHE_MS;
		cached.refreshError = undefined;
	} catch (cause) {
		// A failed refresh says nothing about the bearer. Never use expired keys.
		cached.refreshError = new RelayKeyServiceUnavailableError("managed relay keys unavailable", { cause });
		throw cached.refreshError;
	}
}

function decodeSegment(value, maximumBytes) {
	const decoded = decodeBase64Url(value, maximumBytes);
	let parsed;
	try {
		parsed = JSON.parse(decoded.toString("utf8"));
	} catch {
		throw new RelayAccessVerificationError("managed relay bearer invalid");
	}
	if (!isRecord(parsed)) {
		throw new RelayAccessVerificationError("managed relay bearer invalid");
	}
	return parsed;
}

function decodeBase64Url(value, maximumBytes) {
	if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes * 2 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new RelayAccessVerificationError("base64url value invalid");
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length > maximumBytes || decoded.toString("base64url") !== value) {
		throw new RelayAccessVerificationError("base64url value invalid");
	}
	return decoded;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
	RelayAccessVerificationError,
	RelayKeyServiceUnavailableError,
	configuredDeployments,
	createRelayAccessVerifier,
	requireMatchingRelayGrant,
};
