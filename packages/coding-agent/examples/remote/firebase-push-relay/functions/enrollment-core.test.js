const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RequestError } = require("./core.js");
const {
	assertFreshSignature,
	getGrantGenerationId,
	getGrantId,
	getRelayEndpointId,
	getSaltedIpId,
	parseApproveClaimRequest,
	parseClaimSecretRequest,
	parseCreateClaimRequest,
	parseRenewGrantRequest,
	parseRevokeGrantRequest,
	parseRelayAuthorization,
	parseRelayOrigins,
	verifyEd25519Signature,
} = require("./enrollment-core.js");
const vector = require("../../../../test/fixtures/iroh-relay-enrollment-v1-vectors.json");

function jsonRequest(body, headers = {}) {
	return {
		body,
		headers: { "content-type": "application/json", ...headers },
	};
}

function createBody() {
	return {
		version: 1,
		hostEndpointId: vector.hostEndpointId,
		claimId: vector.claimId,
		claimSecretHash: vector.claimSecretSha256,
		issuedAtMs: vector.issuedAtMs,
		nonce: vector.operations.create_claim.nonce,
		signature: vector.operations.create_claim.signatureBase64url,
	};
}

function claimSecretBody(operation) {
	return {
		version: 1,
		hostEndpointId: vector.hostEndpointId,
		claimId: vector.claimId,
		claimSecret: vector.claimSecret,
		issuedAtMs: vector.issuedAtMs,
		nonce: vector.operations[operation].nonce,
		signature: vector.operations[operation].signatureBase64url,
	};
}

function approveBody() {
	return {
		version: 1,
		hostEndpointId: vector.hostEndpointId,
		clientEndpointId: vector.clientEndpointId,
		claimId: vector.claimId,
		claimSecret: vector.claimSecret,
		grantSecret: vector.grantSecret,
		issuedAtMs: vector.issuedAtMs,
		nonce: vector.operations.approve_claim.nonce,
		signature: vector.operations.approve_claim.signatureBase64url,
	};
}

function renewBody() {
	return {
		version: 1,
		hostEndpointId: vector.hostEndpointId,
		clientEndpointId: vector.clientEndpointId,
		grantId: vector.grantId,
		grantSecret: vector.grantSecret,
		issuedAtMs: vector.issuedAtMs,
		nonce: vector.operations.renew_grant.nonce,
		signature: vector.operations.renew_grant.signatureBase64url,
	};
}

function revokeBody(revoker) {
	const fixture = vector.operations[`revoke_grant_${revoker}`];
	return {
		version: 1,
		hostEndpointId: vector.hostEndpointId,
		clientEndpointId: vector.clientEndpointId,
		grantId: vector.grantId,
		grantGenerationId: vector.grantGenerationId,
		revokerEndpointId: revoker === "host" ? vector.hostEndpointId : vector.clientEndpointId,
		issuedAtMs: vector.issuedAtMs,
		nonce: fixture.nonce,
		signature: fixture.signatureBase64url,
	};
}

function expectRequestError(operation, status, code) {
	assert.throws(operation, (error) => {
		assert.ok(error instanceof RequestError);
		assert.equal(error.status, status);
		assert.equal(error.publicMessage, code);
		return true;
	});
}

test("matches every normative Ed25519 canonical signature and deterministic grant vector", () => {
	for (const [operation, fixture] of Object.entries(vector.operations)) {
		const signerEndpointId = operation === "approve_claim" || operation === "renew_grant" || operation === "revoke_grant_client"
			? vector.clientEndpointId
			: vector.hostEndpointId;
		assert.equal(
			verifyEd25519Signature(signerEndpointId, Buffer.from(fixture.canonicalMessage, "utf8"), fixture.signatureBase64url),
			true,
			operation,
		);
		assert.equal(Buffer.from(fixture.canonicalMessage, "utf8").toString("base64url"), fixture.canonicalMessageBase64url);
	}
	assert.equal(getGrantId(vector.hostEndpointId, vector.clientEndpointId), vector.grantId);
	assert.equal(
		getGrantGenerationId(vector.hostEndpointId, vector.clientEndpointId, vector.grantSecret),
		vector.grantGenerationId,
	);

	assert.equal(
		assertFreshSignature(parseCreateClaimRequest(jsonRequest(createBody())), "create_claim", vector.issuedAtMs).toString(),
		vector.operations.create_claim.canonicalMessage,
	);
	assert.equal(
		assertFreshSignature(
			parseClaimSecretRequest(jsonRequest(claimSecretBody("claim_status")), "claim_status"),
			"claim_status",
			vector.issuedAtMs,
		).toString(),
		vector.operations.claim_status.canonicalMessage,
	);
	assert.equal(
		assertFreshSignature(parseApproveClaimRequest(jsonRequest(approveBody())), "approve_claim", vector.issuedAtMs).toString(),
		vector.operations.approve_claim.canonicalMessage,
	);
	assert.equal(
		assertFreshSignature(
			parseRenewGrantRequest(jsonRequest(renewBody())),
			"renew_grant",
			vector.issuedAtMs,
		).toString(),
		vector.operations.renew_grant.canonicalMessage,
	);
	for (const revoker of ["client", "host"]) {
		assert.equal(
			assertFreshSignature(
				parseRevokeGrantRequest(jsonRequest(revokeBody(revoker))),
				"revoke_grant",
				vector.issuedAtMs,
			).toString(),
			vector.operations[`revoke_grant_${revoker}`].canonicalMessage,
		);
	}
});

test("strict schemas reject unknown keys, uppercase endpoint IDs, non-canonical base64url, and oversized bodies", () => {
	expectRequestError(
		() => parseCreateClaimRequest(jsonRequest({ ...createBody(), redirect: "https://attacker.example" })),
		400,
		"create_claim_schema_invalid",
	);
	expectRequestError(
		() => parseCreateClaimRequest(jsonRequest({ ...createBody(), hostEndpointId: vector.hostEndpointId.toUpperCase() })),
		400,
		"endpoint_id_invalid",
	);
	expectRequestError(
		() => parseApproveClaimRequest(jsonRequest({ ...approveBody(), clientEndpointId: vector.hostEndpointId })),
		400,
		"endpoint_pair_invalid",
	);
	expectRequestError(
		() => parseRenewGrantRequest(
			jsonRequest({ ...renewBody(), clientEndpointId: vector.hostEndpointId }),
		),
		400,
		"endpoint_pair_invalid",
	);
	expectRequestError(
		() => parseRevokeGrantRequest(jsonRequest({ ...revokeBody("client"), grantSecret: vector.grantSecret })),
		400,
		"revoke_grant_schema_invalid",
	);
	expectRequestError(
		() => parseRevokeGrantRequest(jsonRequest({ ...revokeBody("client"), revokerEndpointId: "1".repeat(64) })),
		400,
		"revoker_endpoint_id_invalid",
	);
	expectRequestError(
		() => parseRevokeGrantRequest(jsonRequest({ ...revokeBody("client"), grantGenerationId: vector.claimId })),
		400,
		"grant_generation_id_invalid",
	);
	expectRequestError(
		() => parseCreateClaimRequest(jsonRequest({ ...createBody(), claimId: `${vector.claimId}=` })),
		400,
		"claim_id_invalid",
	);
	expectRequestError(
		() =>
			parseCreateClaimRequest({
				body: createBody(),
				headers: { "content-length": String(16 * 1024 + 1), "content-type": "application/json" },
			}),
		413,
		"request_body_too_large",
	);
});

test("signature validation rejects stale timestamps, altered fields, and the wrong endpoint key", () => {
	const parsed = parseCreateClaimRequest(jsonRequest(createBody()));
	expectRequestError(
		() => assertFreshSignature(parsed, "create_claim", vector.issuedAtMs + 2 * 60 * 1000 + 1),
		401,
		"signature_timestamp_invalid",
	);
	expectRequestError(
		() => assertFreshSignature({ ...parsed, claimSecretHash: vector.grantSecretSha256 }, "create_claim", vector.issuedAtMs),
		401,
		"signature_invalid",
	);
	expectRequestError(
		() => assertFreshSignature({ ...parsed, hostEndpointId: vector.clientEndpointId }, "create_claim", vector.issuedAtMs),
		401,
		"signature_invalid",
	);
});

test("relay origins normalize and sort while rejecting non-origin or duplicate configuration", () => {
	assert.deepEqual(
		parseRelayOrigins("https://z.example,https://a.example:443"),
		["https://a.example", "https://z.example"],
	);
	assert.throws(() => parseRelayOrigins("http://relay.example"), /HTTPS origins/);
	assert.throws(() => parseRelayOrigins("https://relay.example/path"), /without paths/);
	assert.throws(() => parseRelayOrigins("https://relay.example,https://relay.example:443"), /duplicate/);
});

test("relay bearer rotation uses current or next secrets and endpoint headers stay strict", () => {
	const current = "c".repeat(32);
	const next = "n".repeat(32);
	for (const secret of [current, next]) {
		assert.doesNotThrow(() =>
			parseRelayAuthorization({ headers: { authorization: `Bearer ${secret}` } }, current, next),
		);
	}
	expectRequestError(
		() => parseRelayAuthorization({ headers: { authorization: `Bearer ${"x".repeat(32)}` } }, current, next),
		401,
		"relay_unauthorized",
	);
	for (const invalidNext of [undefined, "", "too-short"]) {
		assert.doesNotThrow(() =>
			parseRelayAuthorization({ headers: { authorization: `Bearer ${current}` } }, current, invalidNext),
		);
		expectRequestError(
			() => parseRelayAuthorization(
				{ headers: { authorization: "Bearer invalid-server-secret-placeholder" } },
				current,
				invalidNext,
			),
			401,
			"relay_unauthorized",
		);
	}
	assert.equal(getRelayEndpointId({ headers: { "x-iroh-nodeid": vector.hostEndpointId } }), vector.hostEndpointId);
	expectRequestError(
		() => getRelayEndpointId({ headers: { "x-iroh-nodeid": vector.hostEndpointId.toUpperCase() } }),
		400,
		"endpoint_id_invalid",
	);
	assert.equal(getSaltedIpId("203.0.113.7", "s".repeat(32)), getSaltedIpId("203.0.113.7", "s".repeat(32)));
	assert.notEqual(getSaltedIpId("203.0.113.7", "s".repeat(32)), getSaltedIpId("203.0.113.7", "t".repeat(32)));
});
