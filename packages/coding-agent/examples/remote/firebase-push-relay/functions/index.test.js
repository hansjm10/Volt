const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const relayAuth = require("./relay-auth.js");
const Module = require("node:module");
const { test } = require("node:test");
const { getPushTargetId, hashToken } = require("./core.js");

const appId = "1:546623825529:ios:9f5a707e3f4ef89154d6a8";
const collectionNames = [];
const writes = [];
const moduleStubs = new Map([
	[
		"firebase-admin/app-check",
		{
			getAppCheck: () => ({
				verifyToken: async () => ({ alreadyConsumed: false, appId, token: { jti: "attestation-id" } }),
			}),
		},
	],
	["firebase-admin/app", { getApps: () => [{}], initializeApp: () => {} }],
	[
		"firebase-admin/firestore",
		{
			FieldValue: { serverTimestamp: () => ({ serverTimestamp: true }) },
			Timestamp: { fromMillis: (epochMillis) => ({ epochMillis }) },
			getFirestore: () => ({
				collection(name) {
					collectionNames.push(name);
					return {
						doc: (id) => ({
							set: async (value) => writes.push({ id, value }),
						}),
					};
				},
			}),
		},
	],
	["firebase-admin/messaging", { getMessaging: () => ({ send: async () => "unused" }) }],
	["firebase-functions/v2/https", { onRequest: (_options, handler) => handler }],
]);
function loadPushRelay(stubs) {
	const originalLoad = Module._load;
	const modulePath = require.resolve("./index.js");
	const previousModule = require.cache[modulePath];
	delete require.cache[modulePath];
	Module._load = function load(request, parent, isMain) {
		return stubs.has(request)
			? stubs.get(request)
			: Reflect.apply(originalLoad, this, [request, parent, isMain]);
	};
	try {
		return require("./index.js").pushRelay;
	} finally {
		Module._load = originalLoad;
		delete require.cache[modulePath];
		if (previousModule !== undefined) require.cache[modulePath] = previousModule;
	}
}
const pushRelay = loadPushRelay(moduleStubs);

test("production registration route writes through the Firestore collection adapter", async () => {
	const fcmToken = "fcm-token-value-0001";
	let responseStatus;
	let responseBody;

	await pushRelay(
		{
			body: { provider: "fcm", platform: "ios", token: fcmToken, enabled: true },
			headers: {
				"content-type": "application/json",
				"x-firebase-appcheck": "limited-use-token",
			},
			method: "POST",
			path: "/v1/push-targets",
		},
		{
			headersSent: false,
			set() {
				return this;
			},
			status(value) {
				responseStatus = value;
				return this;
			},
			json(value) {
				responseBody = value;
				return this;
			},
		},
	);

	const pushTargetId = getPushTargetId(fcmToken);
	assert.deepEqual(collectionNames, ["voltPushTargets"]);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].id, pushTargetId);
	assert.equal(writes[0].value.appId, appId);
	assert.equal(writes[0].value.token, fcmToken);
	assert.equal(writes[0].value.tokenHash, hashToken(fcmToken));
	assert.equal(writes[0].value.grantId, undefined);
	assert.equal(responseStatus, 201);
	assert.equal(responseBody.pushTargetId, pushTargetId);
	assert.equal(responseBody.tokenHash, hashToken(fcmToken));
	assert.equal(responseBody.relayUrl, "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay");
	assert.match(responseBody.pushTargetAuthToken, /^[A-Za-z0-9_-]{43}$/);
});

function notificationFixture() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyId = "keyabcdefghijklmnopqrs";
	const hostNodeId = "a".repeat(64);
	const grantId = "grantabcdefghijklmnopqrs";
	const issuedAt = Math.floor(Date.now() / 1000);
	const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "EdDSA", kid: keyId, use: "sig" }] };
	const notification = {
		pushTargetId: "targetabcdefghijklmnop",
		pushTargetAuthToken: "s".repeat(43),
		eventId: "event-one",
		hostNodeId,
		kind: "conversation_completed",
		title: "Done",
		body: "Finished",
		data: { eventId: "event-one", hostNodeId, kind: "conversation_completed" },
	};
	const target = {
		enabled: true,
		provider: "fcm",
		platform: "ios",
		token: "fcm-token-value-0001",
		pushTargetAuthTokenHash: hashToken(notification.pushTargetAuthToken),
		expiresAt: { toMillis: () => (issuedAt + 3600) * 1000 },
	};
	const fixture = {
		now: issuedAt * 1000,
		fetchCount: 0,
		firestoreCalls: 0,
		updates: [],
		messages: [],
		jwks,
		fetchJwks: async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } }),
		authorization(claims = {}, header = {}, signingKey = privateKey) {
			const encodedHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: keyId, ...header })).toString("base64url");
			const payload = Buffer.from(JSON.stringify({
				iss: "https://credentials.volt-cli.dev",
				aud: "volt-iroh-relay",
				sub: hostNodeId,
				iat: issuedAt,
				exp: issuedAt + 900,
				scope: "relay:connect",
				endpoint_kind: "host",
				grant_id: grantId,
				...claims,
			})).toString("base64url");
			const input = `${encodedHeader}.${payload}`;
			return `Bearer ${input}.${sign(null, Buffer.from(input, "ascii"), signingKey).toString("base64url")}`;
		},
	};
	const pushTargetRef = { update: async (value) => fixture.updates.push(value) };
	const firestore = {
		collection: () => ({ doc: () => pushTargetRef }),
		runTransaction: async (callback) => callback({
			get: async () => ({ exists: true, data: () => target }),
			update: (_ref, value) => {
				fixture.updates.push(value);
				Object.assign(target, value);
			},
		}),
	};
	const stubs = new Map(moduleStubs);
	stubs.set("./relay-auth.js", {
		...relayAuth,
		createRelayAccessVerifier: () => relayAuth.createRelayAccessVerifier({
			now: () => fixture.now,
			fetcher: async () => {
				fixture.fetchCount += 1;
				return fixture.fetchJwks();
			},
		}),
	});
	stubs.set("firebase-admin/firestore", {
		FieldValue: { serverTimestamp: () => ({ serverTimestamp: true }) },
		Timestamp: { fromMillis: (value) => ({ toMillis: () => value }) },
		getFirestore: () => {
			fixture.firestoreCalls += 1;
			return firestore;
		},
	});
	stubs.set("firebase-admin/messaging", {
		getMessaging: () => ({ send: async (message) => {
			fixture.messages.push(message);
			return "message-one";
		} }),
	});
	const handler = loadPushRelay(stubs);
	fixture.send = async (authorization = fixture.authorization()) => {
		const result = {};
		await handler({
			method: "POST",
			path: "/v1/notifications",
			headers: { "content-type": "application/json", authorization },
			body: notification,
		}, {
			headersSent: false,
			set() { return this; },
			status(value) { result.status = value; return this; },
			json(value) { result.body = value; return this; },
		});
		return result;
	};
	return fixture;
}

function publishRotatedKey(fixture) {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const kid = "rotatedabcdefghijklmnop";
	fixture.jwks.keys.push({ ...publicKey.export({ format: "jwk" }), alg: "EdDSA", kid, use: "sig" });
	return fixture.authorization({}, { kid }, privateKey);
}

const jwksFailures = [
	["network error", () => { throw new TypeError("fetch failed"); }],
	["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
	["HTTP 503", () => new Response("unavailable", { status: 503 })],
	["HTTP 401 from broker", () => new Response("unauthorized", { status: 401 })],
	["wrong content type", () => new Response("{}")],
	["body read failure", () => ({
		ok: true,
		headers: new Headers({ "content-type": "application/json" }),
		arrayBuffer: async () => { throw new TypeError("connection lost"); },
	})],
	["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
	["oversized JWKS", () => new Response(" ".repeat(16 * 1024 + 1), { headers: { "content-type": "application/json" } })],
	["empty keys", () => new Response('{"keys":[]}', { headers: { "content-type": "application/json" } })],
	["malformed key material", (jwks) => new Response(JSON.stringify({
		keys: [{ ...jwks.keys[0], x: "!" }],
	}), { headers: { "content-type": "application/json" } })],
	["duplicate keys", (jwks) => new Response(JSON.stringify({
		keys: [jwks.keys[0], jwks.keys[0]],
	}), { headers: { "content-type": "application/json" } })],
];

for (const cacheState of ["empty", "expired", "unknown key in fresh cache"]) {
	for (const [failure, fail] of jwksFailures) {
		test(`notification returns retryable 503 for ${failure} (${cacheState}) and recovers`, async () => {
			const fixture = notificationFixture();
			let authorization = fixture.authorization();
			if (cacheState !== "empty") {
				assert.equal((await fixture.send(authorization)).status, 200);
				if (cacheState === "expired") {
					fixture.now += 5 * 60_000;
				} else {
					authorization = publishRotatedKey(fixture);
				}
			}
			const before = {
				fetches: fixture.fetchCount,
				firestore: fixture.firestoreCalls,
				updates: fixture.updates.length,
				messages: fixture.messages.length,
			};
			const healthyFetch = fixture.fetchJwks;
			fixture.fetchJwks = () => fail(fixture.jwks);
			assert.deepEqual(await fixture.send(authorization), {
				status: 503,
				body: { error: "managed_relay_keys_unavailable" },
			});
			assert.equal(fixture.fetchCount, before.fetches + 1);
			assert.equal(fixture.firestoreCalls, before.firestore);
			assert.equal(fixture.updates.length, before.updates);
			assert.equal(fixture.messages.length, before.messages);

			fixture.fetchJwks = healthyFetch;
			if (cacheState === "unknown key in fresh cache") {
				// A throttled retry retains 503, even if the service has recovered.
				assert.deepEqual(await fixture.send(authorization), {
					status: 503,
					body: { error: "managed_relay_keys_unavailable" },
				});
				assert.equal(fixture.fetchCount, before.fetches + 1);
				assert.equal(fixture.firestoreCalls, before.firestore);
				assert.equal(fixture.updates.length, before.updates);
				assert.equal(fixture.messages.length, before.messages);
				fixture.now += 1_000;
			}
			assert.deepEqual(await fixture.send(authorization), {
				status: 200,
				body: { status: "sent", messageId: "message-one" },
			});
			assert.equal(fixture.fetchCount, before.fetches + 2);
			assert.equal(fixture.messages.length, before.messages + 1);
		});
	}
}

test("notification refreshes a warm JWKS once to accept a newly published signing key", async () => {
	const fixture = notificationFixture();
	assert.equal((await fixture.send()).status, 200);
	const authorization = publishRotatedKey(fixture);
	assert.equal((await fixture.send(authorization)).status, 200);
	assert.equal((await fixture.send(authorization)).status, 200);
	assert.equal(fixture.fetchCount, 2);
	assert.equal(fixture.messages.length, 3);
});

test("concurrent unknown keys share one refresh while known cached keys remain usable", async () => {
	const fixture = notificationFixture();
	assert.equal((await fixture.send()).status, 200);
	const authorization = publishRotatedKey(fixture);
	const healthyFetch = fixture.fetchJwks;
	let releaseFetch;
	fixture.fetchJwks = () => new Promise((resolve) => { releaseFetch = resolve; });
	const requests = Array.from({ length: 10 }, () => fixture.send(authorization));
	assert.equal(fixture.fetchCount, 2);
	assert.equal((await fixture.send()).status, 200);
	assert.equal(fixture.fetchCount, 2);
	releaseFetch(await healthyFetch());
	const results = await Promise.all(requests);
	assert.ok(results.every((result) => result.status === 200));
	assert.equal(fixture.fetchCount, 2);
	assert.equal(fixture.messages.length, 12);
});

test("unknown key refreshes are bounded across different kids and resume after the cooldown", async () => {
	const fixture = notificationFixture();
	assert.equal((await fixture.send()).status, 200);
	const before = { firestore: fixture.firestoreCalls, updates: fixture.updates.length };
	for (let index = 0; index < 10; index += 1) {
		assert.deepEqual(await fixture.send(fixture.authorization({}, { kid: `unknownabcdefghijklmnop${index}` })), {
			status: 401,
			body: { error: "managed_relay_authorization_invalid" },
		});
	}
	assert.equal(fixture.fetchCount, 2);
	assert.equal(fixture.firestoreCalls, before.firestore);
	assert.equal(fixture.updates.length, before.updates);
	assert.equal(fixture.messages.length, 1);
	fixture.now += 1_000;
	assert.equal((await fixture.send(publishRotatedKey(fixture))).status, 200);
	assert.equal(fixture.fetchCount, 3);
});

test("an unknown-key refresh cooldown is isolated to its broker JWKS URL", async () => {
	const fixture = notificationFixture();
	const canaryClaims = { iss: "https://credentials-canary.volt-cli.dev", aud: "volt-iroh-relay-canary" };
	assert.equal((await fixture.send()).status, 200);
	assert.equal((await fixture.send(fixture.authorization(canaryClaims))).status, 200);
	assert.equal((await fixture.send(fixture.authorization({}, { kid: "unknownabcdefghijklmnop" }))).status, 401);
	assert.equal(fixture.fetchCount, 3);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const kid = "canaryabcdefghijklmnop";
	fixture.jwks.keys.push({ ...publicKey.export({ format: "jwk" }), alg: "EdDSA", kid, use: "sig" });
	assert.equal((await fixture.send(fixture.authorization(canaryClaims, { kid }, privateKey))).status, 200);
	assert.equal(fixture.fetchCount, 4);
});

for (const cacheState of ["empty", "expired"]) {
	test(`an unknown kid with an ${cacheState} cache fetches JWKS only once per request`, async () => {
		const fixture = notificationFixture();
		if (cacheState === "expired") {
			assert.equal((await fixture.send()).status, 200);
			fixture.now += 5 * 60_000;
		}
		const before = fixture.fetchCount;
		assert.equal((await fixture.send(fixture.authorization({}, { kid: "unknownabcdefghijklmnop" }))).status, 401);
		assert.equal(fixture.fetchCount, before + 1);
	});
}

test("a failed unknown-key refresh preserves known fresh keys but never permits expired keys", async () => {
	const fixture = notificationFixture();
	assert.equal((await fixture.send()).status, 200);
	fixture.fetchJwks = () => { throw new TypeError("fetch failed"); };
	assert.equal((await fixture.send(fixture.authorization({}, { kid: "unknownabcdefghijklmnop" }))).status, 503);
	assert.equal((await fixture.send()).status, 200);
	assert.equal(fixture.fetchCount, 2);
	fixture.now += 5 * 60_000;
	assert.equal((await fixture.send()).status, 503);
	assert.equal(fixture.fetchCount, 3);
	assert.equal(fixture.messages.length, 2);
});

test("notification continues verifying with a fresh cached JWKS during an outage", async () => {
	const fixture = notificationFixture();
	assert.equal((await fixture.send()).status, 200);
	fixture.fetchJwks = () => { throw new TypeError("fetch failed"); };
	assert.equal((await fixture.send()).status, 200);
	assert.equal(fixture.fetchCount, 1);
	assert.equal(fixture.messages.length, 2);
});

for (const [failure, authorization] of [
	["missing bearer", () => ""],
	["malformed bearer", () => "Bearer malformed"],
	["unknown key", (fixture) => fixture.authorization({}, { kid: "unknownabcdefghijklmnop" })],
	["invalid signature", (fixture) => fixture.authorization({}, {}, generateKeyPairSync("ed25519").privateKey)],
	["expired claims", (fixture) => fixture.authorization({ exp: Math.floor(fixture.now / 1000) - 60 })],
	["wrong host", (fixture) => fixture.authorization({ sub: "b".repeat(64) })],
	["wrong issuer", (fixture) => fixture.authorization({ iss: "https://attacker.example" })],
	["wrong audience", (fixture) => fixture.authorization({ aud: "other" })],
	["wrong endpoint", (fixture) => fixture.authorization({ endpoint_kind: "app" })],
]) {
	test(`notification keeps ${failure} as 401 without delivery side effects`, async () => {
		const fixture = notificationFixture();
		assert.deepEqual(await fixture.send(authorization(fixture)), {
			status: 401,
			body: { error: "managed_relay_authorization_invalid" },
		});
		assert.equal(fixture.firestoreCalls, 0);
		assert.deepEqual(fixture.updates, []);
		assert.deepEqual(fixture.messages, []);
	});
}
