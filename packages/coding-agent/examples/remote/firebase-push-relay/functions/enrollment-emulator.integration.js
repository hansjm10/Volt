const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { Timestamp, getFirestore } = require("firebase-admin/firestore");
const { createIrohEnrollmentHandler } = require("./enrollment-handler.js");
const vector = require("../../../../test/fixtures/iroh-relay-enrollment-v1-vectors.json");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
	throw new Error("enrollment-emulator.integration.js requires FIRESTORE_EMULATOR_HOST");
}

const projectId = process.env.GCLOUD_PROJECT || "demo-volt-iroh-enrollment";
const app = initializeApp({ projectId }, `iroh-enrollment-emulator-${process.pid}`);
const firestore = getFirestore(app);
const collections = [
	"voltIrohEnrollmentClaims",
	"voltIrohEnrollmentGrants",
	"voltIrohEndpointAccess",
	"voltIrohEnrollmentQuotaWindows",
];

const handler = createIrohEnrollmentHandler({
	config: {
		relayOrigins: ["https://iroh-relay-us-central.volt-cli.dev"],
		requestsPerEndpointPerWindow: 100,
		requestsPerIpPerWindow: 100,
	},
	getFirestore: () => firestore,
	getIpSalt: () => "emulator-ip-salt-0123456789abcdef",
	getRelayAccessSecrets: () => ["c".repeat(32), "n".repeat(32)],
	logError: () => {},
	logEvent: () => {},
	now: () => vector.issuedAtMs,
	timestampFromMillis: (value) => Timestamp.fromMillis(value),
	verifyLimitedUseAppCheck: async () => vector.firebaseAppId,
});

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

async function invoke(path, body, headers = {}) {
	const result = {};
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
		set() {
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
	await handler(
		{
			body,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			ip: "203.0.113.9",
			method: "POST",
			path,
		},
		response,
	);
	return result;
}

async function clearFirestore() {
	for (const name of collections) {
		const snapshot = await firestore.collection(name).get();
		if (snapshot.empty) continue;
		const batch = firestore.batch();
		for (const document of snapshot.docs) batch.delete(document.ref);
		await batch.commit();
	}
}

before(clearFirestore);
after(async () => {
	await clearFirestore();
	await deleteApp(app);
});

test("real Firestore transactions preserve generation-scoped symmetric revocation", async () => {
	let response = await invoke("/v1/claims", createBody());
	assert.equal(response.status, 201);

	const approvals = await Promise.all([
		invoke("/v1/claims/approve", approveBody(), { "x-firebase-appcheck": "limited-use-one" }),
		invoke("/v1/claims/approve", approveBody(), { "x-firebase-appcheck": "limited-use-two" }),
	]);
	assert.deepEqual(approvals.map((item) => item.status), [200, 200]);
	assert.deepEqual(approvals.map((item) => item.body.grantId), [vector.grantId, vector.grantId]);
	assert.deepEqual(
		approvals.map((item) => item.body.grantGenerationId),
		[vector.grantGenerationId, vector.grantGenerationId],
	);

	for (const endpointId of [vector.hostEndpointId, vector.clientEndpointId]) {
		const access = (await firestore.collection("voltIrohEndpointAccess").doc(endpointId).get()).data();
		assert.ok(access.activeGrants[vector.grantId]);
		assert.equal(access.expiresAt.toMillis(), access.activeGrants[vector.grantId].toMillis());
	}
	const grantRef = firestore.collection("voltIrohEnrollmentGrants").doc(vector.grantId);
	const grant = (await grantRef.get()).data();
	assert.equal(grant.status, "active");
	assert.equal(grant.grantGenerationId, vector.grantGenerationId);
	assert.equal(grant.grantSecretHash, vector.grantSecretSha256);
	const claim = (await firestore.collection("voltIrohEnrollmentClaims").doc(vector.claimId).get()).data();
	assert.equal(claim.grantGenerationId, vector.grantGenerationId);

	response = await invoke("/v1/relay-access", undefined, {
		authorization: `Bearer ${"c".repeat(32)}`,
		"x-iroh-nodeid": vector.hostEndpointId,
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "true");

	response = await invoke("/v1/grants/revoke", revokeBody("client"));
	assert.equal(response.status, 200);
	for (const endpointId of [vector.hostEndpointId, vector.clientEndpointId]) {
		const access = await firestore.collection("voltIrohEndpointAccess").doc(endpointId).get();
		assert.equal(access.exists, false);
	}
	response = await invoke("/v1/relay-access", undefined, {
		authorization: `Bearer ${"c".repeat(32)}`,
		"x-iroh-nodeid": vector.hostEndpointId,
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "false");

	const accessRefs = [vector.hostEndpointId, vector.clientEndpointId].map((endpointId) =>
		firestore.collection("voltIrohEndpointAccess").doc(endpointId),
	);
	async function restoreActiveGrant(grantGenerationId) {
		await grantRef.set({
			...grant,
			grantGenerationId,
			status: "active",
			updatedAt: Timestamp.fromMillis(vector.issuedAtMs),
		});
		await Promise.all(accessRefs.map((accessRef) => accessRef.set({
			activeGrants: { [vector.grantId]: grant.expiresAt },
			blocked: false,
			expiresAt: grant.expiresAt,
			pendingClaims: {},
			updatedAt: Timestamp.fromMillis(vector.issuedAtMs),
		})));
	}

	await restoreActiveGrant(vector.grantGenerationId);
	response = await invoke("/v1/grants/revoke", revokeBody("host"));
	assert.equal(response.status, 200);
	assert.equal((await grantRef.get()).data().status, "revoked");
	for (const accessRef of accessRefs) assert.equal((await accessRef.get()).exists, false);

	const replacementGenerationId = Buffer.alloc(32, 7).toString("base64url");
	await restoreActiveGrant(replacementGenerationId);
	response = await invoke("/v1/grants/revoke", revokeBody("host"));
	assert.equal(response.status, 200);
	const replacementGrant = (await grantRef.get()).data();
	assert.equal(replacementGrant.status, "active");
	assert.equal(replacementGrant.grantGenerationId, replacementGenerationId);
	for (const accessRef of accessRefs) {
		const access = (await accessRef.get()).data();
		assert.ok(access.activeGrants[vector.grantId]);
	}
	response = await invoke("/v1/relay-access", undefined, {
		authorization: `Bearer ${"c".repeat(32)}`,
		"x-iroh-nodeid": vector.hostEndpointId,
	});
	assert.equal(response.status, 200);
	assert.equal(response.body, "true");
});
