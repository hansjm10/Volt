const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { test } = require("node:test");
const {
	RelayAccessVerificationError,
	configuredDeployments,
	createRelayAccessVerifier,
	requireMatchingRelayGrant,
} = require("./relay-auth.js");

const issuer = "https://credentials.test";
const audience = "volt-iroh-relay-test";
const jwksUrl = "https://credentials.test/.well-known/jwks.json";
const hostNodeId = "a".repeat(64);
const grantId = "grantabcdefghijklmnopqrs";
const keyId = "keyabcdefghijklmnopqrs";

function authority() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	return {
		privateKey,
		jwks: {
			keys: [{ ...jwk, alg: "EdDSA", kid: keyId, use: "sig" }],
		},
	};
}

function token(privateKey, claims = {}) {
	const nowSeconds = 1_800_000_000;
	const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: keyId, typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iss: issuer,
			aud: audience,
			sub: hostNodeId,
			exp: nowSeconds + 900,
			iat: nowSeconds,
			jti: "jwtabcdefghijklmnopqrs",
			scope: "relay:connect",
			endpoint_kind: "host",
			grant_id: grantId,
			...claims,
		}),
	).toString("base64url");
	const signingInput = `${header}.${payload}`;
	const signature = sign(null, Buffer.from(signingInput, "ascii"), privateKey).toString("base64url");
	return `${signingInput}.${signature}`;
}

function verifierFor(jwks) {
	let fetchCount = 0;
	const verifier = createRelayAccessVerifier({
		deployments: new Map([[issuer, { audience, jwksUrl }]]),
		fetcher: async (url) => {
			fetchCount += 1;
			assert.equal(url, jwksUrl);
			return new Response(JSON.stringify(jwks), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		},
		now: () => 1_800_000_000_000,
	});
	return { fetchCount: () => fetchCount, verifier };
}

test("the shared managed push endpoint accepts only fixed production and canary issuers", () => {
	assert.deepEqual(
		Array.from(configuredDeployments(undefined).keys()),
		[
			"https://credentials.volt-cli.dev",
			"https://credentials-canary.volt-cli.dev",
		],
	);
	assert.throws(() => configuredDeployments("https://attacker.example"));
});

test("managed push authorization verifies a current host relay JWT and caches JWKS", async () => {
	const { privateKey, jwks } = authority();
	const fixture = verifierFor(jwks);
	const authorization = `Bearer ${token(privateKey)}`;

	assert.deepEqual(await fixture.verifier(authorization, hostNodeId), { grantId });
	assert.deepEqual(await fixture.verifier(authorization, hostNodeId), { grantId });
	assert.equal(fixture.fetchCount(), 1);
});

test("managed push authorization rejects wrong endpoint authority and host identity", async () => {
	const { privateKey, jwks } = authority();
	const fixture = verifierFor(jwks);

	await assert.rejects(
		fixture.verifier(`Bearer ${token(privateKey, { endpoint_kind: "app" })}`, hostNodeId),
		RelayAccessVerificationError,
	);
	await assert.rejects(
		fixture.verifier(`Bearer ${token(privateKey)}`, "b".repeat(64)),
		RelayAccessVerificationError,
	);
});

test("push targets bind once to the authorized daemon grant", () => {
	assert.equal(requireMatchingRelayGrant(undefined, grantId), grantId);
	assert.equal(requireMatchingRelayGrant(grantId, grantId), grantId);
	assert.throws(
		() => requireMatchingRelayGrant("othergrantabcdefghijkl", grantId),
		RelayAccessVerificationError,
	);
});

test("managed push authorization rejects expired and malformed JWTs", async () => {
	const { privateKey, jwks } = authority();
	const fixture = verifierFor(jwks);

	await assert.rejects(
		fixture.verifier(
			`Bearer ${token(privateKey, { exp: 1_799_999_900 })}`,
			hostNodeId,
		),
		RelayAccessVerificationError,
	);
	await assert.rejects(
		fixture.verifier("Bearer malformed", hostNodeId),
		RelayAccessVerificationError,
	);
});
