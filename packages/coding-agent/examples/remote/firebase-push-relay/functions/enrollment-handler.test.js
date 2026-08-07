const assert = require("node:assert/strict");
const {
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
} = require("node:crypto");
const { test } = require("node:test");
const { RequestError } = require("./core.js");
const {
	canonicalApproveMessage,
	canonicalClaimMessage,
	canonicalGrantMessage,
	getGrantId,
	hashDecodedSecret,
} = require("./enrollment-core.js");
const {
	CLAIMS_COLLECTION,
	ENDPOINT_ACCESS_COLLECTION,
	GRANTS_COLLECTION,
	QUOTA_WINDOWS_COLLECTION,
	createIrohEnrollmentHandler,
} = require("./enrollment-handler.js");
const vector = require("../../../../test/fixtures/iroh-relay-enrollment-v1-vectors.json");

const PKCS8_ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

class FakeFirestore {
	constructor() {
		this.documents = new Map();
	}

	collection(name) {
		return {
			doc: (id) => ({ id, path: `${name}/${id}` }),
		};
	}

	async runTransaction(operation) {
		const mutations = [];
		const transaction = {
			create: (reference, value) => mutations.push({ kind: "create", reference, value }),
			delete: (reference) => mutations.push({ kind: "delete", reference }),
			get: async (reference) => this.snapshot(reference),
			set: (reference, value, options) => mutations.push({ kind: "set", options, reference, value }),
			update: (reference, value) => mutations.push({ kind: "update", reference, value }),
		};
		const result = await operation(transaction);
		for (const mutation of mutations) this.applyMutation(mutation);
		return result;
	}

	snapshot(reference) {
		const exists = this.documents.has(reference.path);
		return {
			data: () => this.documents.get(reference.path),
			exists,
			id: reference.id,
			ref: reference,
		};
	}

	applyMutation(mutation) {
		const existing = this.documents.get(mutation.reference.path);
		if (mutation.kind === "create") {
			if (existing !== undefined) throw new Error("document already exists");
			this.documents.set(mutation.reference.path, mutation.value);
			return;
		}
		if (mutation.kind === "delete") {
			this.documents.delete(mutation.reference.path);
			return;
		}
		if (mutation.kind === "update") {
			if (existing === undefined) throw new Error("document does not exist");
			this.documents.set(mutation.reference.path, { ...existing, ...mutation.value });
			return;
		}
		this.documents.set(
			mutation.reference.path,
			mutation.options?.merge === true && existing !== undefined
				? { ...existing, ...mutation.value }
				: mutation.value,
		);
	}
}

function timestampFromMillis(millis) {
	return { millis, toMillis: () => millis };
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

function claimBody(operation) {
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

function grantBody(operation) {
	return {
		version: 1,
		hostEndpointId: vector.hostEndpointId,
		clientEndpointId: vector.clientEndpointId,
		grantId: vector.grantId,
		grantSecret: vector.grantSecret,
		issuedAtMs: vector.issuedAtMs,
		nonce: vector.operations[operation].nonce,
		signature: vector.operations[operation].signatureBase64url,
	};
}

function createHarness(overrides = {}) {
	const firestore = overrides.firestore || new FakeFirestore();
	const events = [];
	const logs = [];
	let nowMs = vector.issuedAtMs;
	let appCheckCount = 0;
	let rejectAppCheck = false;
	const handler = createIrohEnrollmentHandler({
		config: {
			relayOrigins: ["https://iroh-relay-us-central.volt-cli.dev"],
			requestsPerEndpointPerWindow: overrides.requestsPerEndpointPerWindow || 100,
			requestsPerIpPerWindow: overrides.requestsPerIpPerWindow || 100,
		},
		getFirestore: () => firestore,
		getIpSalt: () => "i".repeat(32),
		getRelayAccessSecrets: () => ["c".repeat(32), "n".repeat(32)],
		logError: (entry) => logs.push(entry),
		logEvent: (entry) => events.push(entry),
		now: () => nowMs,
		timestampFromMillis,
		verifyLimitedUseAppCheck: async () => {
			appCheckCount += 1;
			if (rejectAppCheck) throw new RequestError(401, "app_check_token_replayed");
			return "production-app-id";
		},
	});
	return {
		events,
		firestore,
		get appCheckCount() {
			return appCheckCount;
		},
		handler,
		logs,
		setNow: (value) => {
			nowMs = value;
		},
		setRejectAppCheck: (value) => {
			rejectAppCheck = value;
		},
	};
}

async function invoke(handler, path, body, options = {}) {
	const result = { headers: Object.create(null) };
	const request = {
		body,
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...options.headers,
		},
		ip: options.ip || "203.0.113.9",
		method: options.method || "POST",
		path,
	};
	const response = {
		headersSent: false,
		json(value) {
			result.body = value;
			this.headersSent = true;
			return this;
		},
		send(value) {
			result.body = value;
			this.headersSent = true;
			return this;
		},
		set(name, value) {
			result.headers[name.toLowerCase()] = value;
			return this;
		},
		status(value) {
			result.status = value;
			return this;
		},
		type(value) {
			result.contentType = value;
			return this;
		},
	};
	await handler(request, response);
	return result;
}

function endpointAccessPath(endpointId) {
	return `${ENDPOINT_ACCESS_COLLECTION}/${endpointId}`;
}

function signWithSeed(seedHex, message) {
	const privateKey = createPrivateKey({
		format: "der",
		key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, Buffer.from(seedHex, "hex")]),
		type: "pkcs8",
	});
	return sign(null, message, privateKey).toString("base64url");
}

function signedCreateBody(
	claimId,
	claimSecretHash,
	issuedAtMs = vector.issuedAtMs,
) {
	const body = {
		...createBody(),
		claimId,
		claimSecretHash,
		issuedAtMs,
		nonce: randomBytes(16).toString("base64url"),
	};
	body.signature = signWithSeed(
		vector.hostSecretKeyHex,
		canonicalClaimMessage("create_claim", body, claimSecretHash),
	);
	return body;
}

function signedApproveBody(
	claimId,
	claimSecret,
	grantSecret = vector.grantSecret,
	issuedAtMs = vector.issuedAtMs,
) {
	const body = {
		...approveBody(),
		claimId,
		claimSecret,
		grantSecret,
		issuedAtMs,
		nonce: randomBytes(16).toString("base64url"),
	};
	body.signature = signWithSeed(
		vector.clientSecretKeyHex,
		canonicalApproveMessage(
			body,
			hashDecodedSecret(claimSecret),
			hashDecodedSecret(grantSecret),
		),
	);
	return body;
}

test("claim approval is idempotent, updates both endpoint maps transactionally, and relay access revokes closed", async () => {
	const harness = createHarness();
	let response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: {
			authorization: `Bearer ${"c".repeat(32)}`,
			"x-iroh-nodeid": vector.hostEndpointId,
		},
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "false");

	response = await invoke(harness.handler, "/v1/claims", createBody());
	assert.equal(response.status, 201);
	assert.deepEqual(response.body, {
		status: "pending",
		expiresAtEpochSeconds: Math.floor((vector.issuedAtMs + 10 * 60 * 1000) / 1000),
		relayOrigins: ["https://iroh-relay-us-central.volt-cli.dev"],
	});

	response = await invoke(harness.handler, "/v1/claims", createBody());
	assert.equal(response.status, 200);
	assert.equal(response.body.status, "pending");

	response = await invoke(harness.handler, "/v1/claims/status", claimBody("claim_status"));
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { status: "pending" });

	response = await invoke(
		harness.handler,
		"/v1/claims/approve",
		approveBody(),
		{ headers: { "x-firebase-appcheck": "limited-use-token" } },
	);
	assert.equal(response.status, 200);
	assert.equal(response.body.status, "approved");
	assert.equal(response.body.grantId, vector.grantId);
	assert.equal(harness.appCheckCount, 1);

	const grant = harness.firestore.documents.get(`${GRANTS_COLLECTION}/${vector.grantId}`);
	assert.equal(grant.grantSecretHash, vector.grantSecretSha256);
	assert.equal(grant.approvedClaimId, undefined);
	for (const endpointId of [vector.hostEndpointId, vector.clientEndpointId]) {
		const access = harness.firestore.documents.get(endpointAccessPath(endpointId));
		assert.equal(access.activeGrants[vector.grantId].toMillis(), vector.issuedAtMs + 30 * 24 * 60 * 60 * 1000);
		assert.equal(access.expiresAt.toMillis(), vector.issuedAtMs + 30 * 24 * 60 * 60 * 1000);
	}

	response = await invoke(
		harness.handler,
		"/v1/claims/approve",
		approveBody(),
		{ headers: { "x-firebase-appcheck": "second-limited-use-token" } },
	);
	assert.equal(response.status, 200);
	assert.equal(response.body.grantId, vector.grantId);

	response = await invoke(harness.handler, "/v1/claims/status", claimBody("claim_status"));
	assert.deepEqual(response.body, {
		clientEndpointId: vector.clientEndpointId,
		grantExpiresAtEpochSeconds: Math.floor((vector.issuedAtMs + 30 * 24 * 60 * 60 * 1000) / 1000),
		status: "approved",
	});

	for (const [endpointId, secret] of [
		[vector.hostEndpointId, "c".repeat(32)],
		[vector.clientEndpointId, "n".repeat(32)],
	]) {
		response = await invoke(harness.handler, "/v1/relay-access", undefined, {
			headers: { authorization: `Bearer ${secret}`, "x-iroh-nodeid": endpointId },
		});
		assert.equal(response.status, 200);
		assert.equal(response.contentType, "text/plain");
		assert.equal(response.body, "true");
		assert.equal(response.headers["cache-control"], "no-store");
	}

	response = await invoke(harness.handler, "/v1/grants/revoke", grantBody("revoke_grant"));
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { status: "revoked", grantId: vector.grantId });
	response = await invoke(harness.handler, "/v1/grants/revoke", grantBody("revoke_grant"));
	assert.equal(response.status, 200);
	assert.equal(harness.appCheckCount, 2);

	// Firestore TTL may remove an expired/revoked grant before an offline
	// client retries its durable revocation. Missing is idempotently closed.
	harness.firestore.documents.delete(`${GRANTS_COLLECTION}/${vector.grantId}`);
	response = await invoke(harness.handler, "/v1/grants/revoke", grantBody("revoke_grant"));
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { status: "revoked", grantId: vector.grantId });

	response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: { authorization: `Bearer ${"c".repeat(32)}`, "x-iroh-nodeid": vector.hostEndpointId },
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "false");
	assert.equal(harness.logs.length, 0);
});

test("an expired claim cannot be approved or authorize either endpoint", async () => {
	const harness = createHarness();
	let response = await invoke(harness.handler, "/v1/claims", createBody());
	assert.equal(response.status, 201);

	const afterExpiry = vector.issuedAtMs + 10 * 60 * 1000 + 1;
	harness.setNow(afterExpiry);
	response = await invoke(
		harness.handler,
		"/v1/claims/approve",
		signedApproveBody(
			vector.claimId,
			vector.claimSecret,
			vector.grantSecret,
			afterExpiry,
		),
		{ headers: { "x-firebase-appcheck": "limited-use-token" } },
	);
	assert.equal(response.status, 410);
	assert.deepEqual(response.body, { error: "claim_expired" });
	assert.equal(
		harness.firestore.documents.has(`${GRANTS_COLLECTION}/${vector.grantId}`),
		false,
	);
	assert.equal(
		harness.firestore.documents.has(endpointAccessPath(vector.hostEndpointId)),
		false,
	);
	assert.equal(
		harness.firestore.documents.has(endpointAccessPath(vector.clientEndpointId)),
		false,
	);

	response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: {
			authorization: `Bearer ${"c".repeat(32)}`,
			"x-iroh-nodeid": vector.hostEndpointId,
		},
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "false");
});

test("a new claim for the same endpoint pair reuses its active grant without consuming a new-host quota", async () => {
	const harness = createHarness();
	await invoke(harness.handler, "/v1/claims", createBody());
	await invoke(harness.handler, "/v1/claims/approve", approveBody());
	const dayNumber = Math.floor(vector.issuedAtMs / (24 * 60 * 60 * 1000));
	const quotaPath = `${QUOTA_WINDOWS_COLLECTION}/new-host-grants_${vector.clientEndpointId}_${dayNumber}`;
	assert.equal(harness.firestore.documents.get(quotaPath).count, 1);

	const originalExpiry = harness.firestore.documents
		.get(`${GRANTS_COLLECTION}/${vector.grantId}`)
		.expiresAt.toMillis();
	const secondIssuedAt = vector.issuedAtMs + 60 * 1000;
	harness.setNow(secondIssuedAt);
	const secondClaimId = randomBytes(16).toString("base64url");
	const secondClaimSecret = randomBytes(32).toString("base64url");
	let response = await invoke(
		harness.handler,
		"/v1/claims",
		signedCreateBody(
			secondClaimId,
			hashDecodedSecret(secondClaimSecret),
			secondIssuedAt,
		),
	);
	assert.equal(response.status, 201);
	response = await invoke(
		harness.handler,
		"/v1/claims/approve",
		signedApproveBody(
			secondClaimId,
			secondClaimSecret,
			vector.grantSecret,
			secondIssuedAt,
		),
	);
	assert.equal(response.status, 200);
	assert.equal(response.body.grantId, vector.grantId);
	assert.equal(
		harness.firestore.documents
			.get(`${GRANTS_COLLECTION}/${vector.grantId}`)
			.expiresAt.toMillis(),
		originalExpiry,
	);
	assert.equal(harness.firestore.documents.get(quotaPath).count, 1);

	// Either approved claim remains independently retryable after the shared
	// pair grant is reused by the other claim.
	response = await invoke(harness.handler, "/v1/claims/approve", approveBody());
	assert.equal(response.status, 200);
	assert.equal(response.body.grantId, vector.grantId);
	response = await invoke(
		harness.handler,
		"/v1/claims/approve",
		signedApproveBody(
			secondClaimId,
			secondClaimSecret,
			vector.grantSecret,
			secondIssuedAt,
		),
	);
	assert.equal(response.status, 200);
	assert.equal(response.body.grantId, vector.grantId);
});

test("only the first client and matching phone-generated grant secret can retry approval", async () => {
	const harness = createHarness();
	await invoke(harness.handler, "/v1/claims", createBody());
	await invoke(harness.handler, "/v1/claims/approve", approveBody());

	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const clientEndpointId = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
	const conflicting = {
		...approveBody(),
		clientEndpointId,
		grantSecret: randomBytes(32).toString("base64url"),
		nonce: randomBytes(16).toString("base64url"),
	};
	conflicting.signature = sign(
		null,
		canonicalApproveMessage(
			conflicting,
			hashDecodedSecret(conflicting.claimSecret),
			hashDecodedSecret(conflicting.grantSecret),
		),
		privateKey,
	).toString("base64url");
	let response = await invoke(harness.handler, "/v1/claims/approve", conflicting);
	assert.equal(response.status, 409);
	assert.deepEqual(response.body, { error: "claim_approval_conflict" });

	const wrongSecretRequest = {
		...grantBody("revoke_grant"),
		grantSecret: randomBytes(32).toString("base64url"),
		nonce: randomBytes(16).toString("base64url"),
	};
	wrongSecretRequest.signature = signWithSeed(
		vector.clientSecretKeyHex,
		canonicalGrantMessage(
			"revoke_grant",
			wrongSecretRequest,
			hashDecodedSecret(wrongSecretRequest.grantSecret),
		),
	);
	response = await invoke(harness.handler, "/v1/grants/revoke", wrongSecretRequest);
	assert.equal(response.status, 401);
	assert.deepEqual(response.body, { error: "grant_unauthorized" });
	assert.equal(harness.firestore.documents.get(`${GRANTS_COLLECTION}/${vector.grantId}`).status, "active");
});

test("approve and renew consume App Check, and renewal enforces six durable attempts per hour", async () => {
	const harness = createHarness();
	await invoke(harness.handler, "/v1/claims", createBody());
	harness.setRejectAppCheck(true);
	let response = await invoke(harness.handler, "/v1/claims/approve", approveBody());
	assert.equal(response.status, 401);
	assert.deepEqual(response.body, { error: "app_check_token_replayed" });
	assert.equal(harness.firestore.documents.get(`${CLAIMS_COLLECTION}/${vector.claimId}`).status, "pending");

	harness.setRejectAppCheck(false);
	response = await invoke(harness.handler, "/v1/claims/approve", approveBody());
	assert.equal(response.status, 200);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		response = await invoke(harness.handler, "/v1/grants/renew", grantBody("renew_grant"));
		assert.equal(response.status, 200, `renewal ${attempt + 1}`);
		assert.equal(response.body.status, "active");
	}
	response = await invoke(harness.handler, "/v1/grants/renew", grantBody("renew_grant"));
	assert.equal(response.status, 429);
	assert.deepEqual(response.body, { error: "grant_renewal_rate_limited" });
	assert.equal(harness.appCheckCount, 9);
});

test("claim cancellation is idempotent and removes the host pending marker", async () => {
	const harness = createHarness();
	await invoke(harness.handler, "/v1/claims", createBody());
	let response = await invoke(harness.handler, "/v1/claims/cancel", claimBody("cancel_claim"));
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { status: "cancelled" });
	response = await invoke(harness.handler, "/v1/claims/cancel", claimBody("cancel_claim"));
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { status: "cancelled" });
	assert.equal(
		harness.firestore.documents.has(endpointAccessPath(vector.hostEndpointId)),
		false,
	);

	const ttlHarness = createHarness();
	await invoke(ttlHarness.handler, "/v1/claims", createBody());
	ttlHarness.firestore.documents.delete(`${CLAIMS_COLLECTION}/${vector.claimId}`);
	response = await invoke(ttlHarness.handler, "/v1/claims/cancel", claimBody("cancel_claim"));
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { status: "expired" });
	assert.equal(
		ttlHarness.firestore.documents.has(endpointAccessPath(vector.hostEndpointId)),
		false,
	);
});

test("pending, active-grant, and client daily grant defaults are durably capped", async () => {
	const pendingHarness = createHarness();
	const pendingClaims = {};
	for (let index = 0; index < 3; index += 1) {
		pendingClaims[randomBytes(16).toString("base64url")] = timestampFromMillis(vector.issuedAtMs + 60_000);
	}
	pendingHarness.firestore.documents.set(endpointAccessPath(vector.hostEndpointId), {
		activeGrants: {},
		blocked: false,
		pendingClaims,
	});
	const extraClaimSecret = randomBytes(32).toString("base64url");
	let response = await invoke(
		pendingHarness.handler,
		"/v1/claims",
		signedCreateBody(randomBytes(16).toString("base64url"), hashDecodedSecret(extraClaimSecret)),
	);
	assert.equal(response.status, 429);
	assert.deepEqual(response.body, { error: "pending_claim_limit_reached" });

	const activeHarness = createHarness();
	const activeGrants = {};
	for (let index = 0; index < 20; index += 1) {
		activeGrants[randomBytes(32).toString("base64url")] = timestampFromMillis(vector.issuedAtMs + 60_000);
	}
	activeHarness.firestore.documents.set(endpointAccessPath(vector.hostEndpointId), {
		activeGrants,
		blocked: false,
		pendingClaims: {},
	});
	await invoke(activeHarness.handler, "/v1/claims", createBody());
	response = await invoke(activeHarness.handler, "/v1/claims/approve", approveBody());
	assert.equal(response.status, 429);
	assert.deepEqual(response.body, { error: "active_grant_limit_reached" });

	const dailyHarness = createHarness();
	await invoke(dailyHarness.handler, "/v1/claims", createBody());
	const dayNumber = Math.floor(vector.issuedAtMs / (24 * 60 * 60 * 1000));
	dailyHarness.firestore.documents.set(
		`${QUOTA_WINDOWS_COLLECTION}/new-host-grants_${vector.clientEndpointId}_${dayNumber}`,
		{
			count: 10,
			expiresAt: timestampFromMillis((dayNumber + 2) * 24 * 60 * 60 * 1000),
			windowStartedAt: timestampFromMillis(dayNumber * 24 * 60 * 60 * 1000),
		},
	);
	response = await invoke(dailyHarness.handler, "/v1/claims/approve", approveBody());
	assert.equal(response.status, 429);
	assert.deepEqual(response.body, { error: "new_host_grant_limit_reached" });
});

test("durable endpoint-plus-salted-IP windows rate limit without storing the raw IP", async () => {
	const harness = createHarness({ requestsPerEndpointPerWindow: 10, requestsPerIpPerWindow: 1 });
	let response = await invoke(harness.handler, "/v1/claims", createBody(), { ip: "198.51.100.44" });
	assert.equal(response.status, 201);
	response = await invoke(harness.handler, "/v1/claims/status", claimBody("claim_status"), {
		ip: "198.51.100.44",
	});
	assert.equal(response.status, 429);
	assert.deepEqual(response.body, { error: "ip_rate_limited" });
	const quotaDocuments = [...harness.firestore.documents.entries()].filter(([path]) =>
		path.startsWith(`${QUOTA_WINDOWS_COLLECTION}/`),
	);
	assert.ok(quotaDocuments.length >= 2);
	assert.equal(JSON.stringify(quotaDocuments).includes("198.51.100.44"), false);
});

test("relay callback returns false on bad server auth and fails closed on malformed access state with safe logs", async () => {
	const harness = createHarness();
	let response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: { authorization: `Bearer ${"x".repeat(32)}`, "x-iroh-nodeid": vector.hostEndpointId },
	});
	assert.equal(response.status, 401);
	assert.equal(response.body, "false");

	harness.firestore.documents.set(endpointAccessPath(vector.hostEndpointId), {
		activeGrants: { [vector.grantId]: "not-a-timestamp" },
		blocked: false,
	});
	response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: { authorization: `Bearer ${"c".repeat(32)}`, "x-iroh-nodeid": vector.hostEndpointId },
	});
	assert.equal(response.status, 500);
	assert.equal(response.body, "false");
	assert.deepEqual(harness.logs, [{ name: "Error", route: "/v1/relay-access" }]);
	assert.equal(JSON.stringify(harness.logs).includes(vector.hostEndpointId), false);
});

test("blocked endpoint records survive expired-entry cleanup without a TTL", async () => {
	const harness = createHarness();
	harness.firestore.documents.set(endpointAccessPath(vector.hostEndpointId), {
		activeGrants: { [vector.grantId]: timestampFromMillis(vector.issuedAtMs) },
		blocked: true,
		expiresAt: timestampFromMillis(vector.issuedAtMs),
		pendingClaims: {},
	});
	const response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: {
			authorization: `Bearer ${"c".repeat(32)}`,
			"x-iroh-nodeid": vector.hostEndpointId,
		},
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "false");
	const access = harness.firestore.documents.get(endpointAccessPath(vector.hostEndpointId));
	assert.deepEqual(access.activeGrants, {});
	assert.equal(access.blocked, true);
	assert.equal(access.expiresAt, undefined);
});

test("known relay endpoints retain a durable callback quota", async () => {
	const harness = createHarness({ requestsPerEndpointPerWindow: 1 });
	harness.firestore.documents.set(endpointAccessPath(vector.hostEndpointId), {
		activeGrants: {
			[vector.grantId]: timestampFromMillis(vector.issuedAtMs + 60_000),
		},
		blocked: false,
		pendingClaims: {},
	});
	let response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: {
			authorization: `Bearer ${"c".repeat(32)}`,
			"x-iroh-nodeid": vector.hostEndpointId,
		},
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "true");
	response = await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: {
			authorization: `Bearer ${"c".repeat(32)}`,
			"x-iroh-nodeid": vector.hostEndpointId,
		},
	});
	assert.equal(response.status, 429);
	assert.equal(response.body, "false");
});

test("unknown relay endpoints fail closed without creating attacker-keyed quota documents", async () => {
	const harness = createHarness({ requestsPerIpPerWindow: 1 });
	for (const endpointId of ["1".repeat(64), "2".repeat(64)]) {
		const response = await invoke(
			harness.handler,
			"/v1/relay-access",
			undefined,
			{
				headers: {
					authorization: `Bearer ${"c".repeat(32)}`,
					"x-iroh-nodeid": endpointId,
				},
			},
		);
		assert.equal(response.status, 200);
		assert.equal(response.body, "false");
	}
	assert.equal(
		[...harness.firestore.documents.keys()].some((path) => path.includes("relay-endpoint_")),
		false,
	);
});

test("invalid endpoint signatures cannot consume another endpoint's durable quota", async () => {
	const harness = createHarness();
	const invalid = { ...createBody(), signature: "A".repeat(86) };
	const response = await invoke(harness.handler, "/v1/claims", invalid);
	assert.equal(response.status, 401);
	assert.deepEqual(response.body, { error: "signature_invalid" });
	assert.equal(
		[...harness.firestore.documents.keys()].some((path) => path.includes(`request-endpoint_${vector.hostEndpointId}`)),
		false,
	);
});

test("request events contain bounded outcome and route metadata without endpoint identities", async () => {
	const harness = createHarness();
	await invoke(harness.handler, "/v1/claims", createBody());
	await invoke(harness.handler, "/v1/relay-access", undefined, {
		headers: { authorization: `Bearer ${"c".repeat(32)}`, "x-iroh-nodeid": vector.hostEndpointId },
	});
	await invoke(harness.handler, `/unknown/${vector.claimSecret}`, {});
	assert.deepEqual(harness.events.map((event) => event.outcome), ["allowed", "denied", "not_found"]);
	assert.deepEqual(harness.events.map((event) => event.route), ["/v1/claims", "/v1/relay-access", "unknown"]);
	assert.equal(harness.events.every((event) => event.durationMs === 0), true);
	assert.equal(JSON.stringify(harness.events).includes(vector.hostEndpointId), false);
	assert.equal(JSON.stringify(harness.events).includes(vector.claimSecret), false);
});

test("wrong methods and stale signed requests use stable secret-free errors", async () => {
	const harness = createHarness();
	let response = await invoke(harness.handler, "/v1/claims", createBody(), { method: "GET" });
	assert.equal(response.status, 405);
	assert.deepEqual(response.body, { error: "method_not_allowed" });
	assert.equal(response.headers.allow, "POST");

	harness.setNow(vector.issuedAtMs + 2 * 60 * 1000 + 1);
	response = await invoke(harness.handler, "/v1/claims", createBody());
	assert.equal(response.status, 401);
	assert.deepEqual(response.body, { error: "signature_timestamp_invalid" });
});
