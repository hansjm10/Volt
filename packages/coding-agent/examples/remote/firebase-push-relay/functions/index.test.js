const assert = require("node:assert/strict");
const Module = require("node:module");
const { after, test } = require("node:test");
const { getPushTargetId, hashToken } = require("./core.js");

const appId = "1:546623825529:ios:9f5a707e3f4ef89154d6a8";
const collectionNames = [];
const firestoreDatabaseIds = [];
const writes = [];
const requestFunctionOptions = [];
const moduleStubs = new Map([
	[
		"./enrollment-handler.js",
		{
			createIrohEnrollmentApiHandler: (options) => async () => {
				options.getFirestore();
			},
			createIrohRelayAccessHandler: (options) => async () => {
				options.getFirestore();
			},
		},
	],
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
			getFirestore: (databaseId) => {
				firestoreDatabaseIds.push(databaseId);
				return {
					collection(name) {
						collectionNames.push(name);
						return {
							doc: (id) => ({
								set: async (value) => writes.push({ id, value }),
							}),
						};
					},
				};
			},
		},
	],
	["firebase-admin/messaging", { getMessaging: () => ({ send: async () => "unused" }) }],
	["firebase-functions/logger", { error: () => {} }],
	[
		"firebase-functions/params",
		{
			defineSecret: (name) => ({
				name,
				value: () => `${name.toLowerCase()}-${"s".repeat(32)}`,
			}),
			defineString: (name, options) => ({ name, options, value: () => process.env[name] }),
		},
	],
	[
		"firebase-functions/v2/https",
		{
			onRequest: (options, handler) => {
				requestFunctionOptions.push(options);
				return handler;
			},
		},
	],
]);
const originalLoad = Module._load;
const originalEnrollmentServiceAccount = process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT;
const originalRelayAccessServiceAccount = process.env.IROH_RELAY_ACCESS_SERVICE_ACCOUNT;
const originalPushRelayServiceAccount = process.env.PUSH_RELAY_SERVICE_ACCOUNT;
process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT = "volt-enrollment@volt-3fae7.iam.gserviceaccount.com";
process.env.IROH_RELAY_ACCESS_SERVICE_ACCOUNT = "volt-relay-access@volt-3fae7.iam.gserviceaccount.com";
process.env.PUSH_RELAY_SERVICE_ACCOUNT = "volt-push@volt-3fae7.iam.gserviceaccount.com";
Module._load = function load(request, parent, isMain) {
	return moduleStubs.has(request)
		? moduleStubs.get(request)
		: Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
let irohEnrollment;
let irohEnrollmentApi;
let irohRelayAccess;
let pushRelay;
let pushRelayApi;
try {
	({ irohEnrollment, irohEnrollmentApi, irohRelayAccess, pushRelay, pushRelayApi } = require("./index.js"));
} finally {
	Module._load = originalLoad;
}

after(() => {
	if (originalEnrollmentServiceAccount === undefined) {
		delete process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT;
	} else {
		process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT = originalEnrollmentServiceAccount;
	}
	if (originalRelayAccessServiceAccount === undefined) {
		delete process.env.IROH_RELAY_ACCESS_SERVICE_ACCOUNT;
	} else {
		process.env.IROH_RELAY_ACCESS_SERVICE_ACCOUNT = originalRelayAccessServiceAccount;
	}
	if (originalPushRelayServiceAccount === undefined) {
		delete process.env.PUSH_RELAY_SERVICE_ACCOUNT;
	} else {
		process.env.PUSH_RELAY_SERVICE_ACCOUNT = originalPushRelayServiceAccount;
	}
});

test("exports isolated enrollment and callback v2 HTTPS functions", () => {
	assert.equal(typeof irohEnrollmentApi, "function");
	assert.equal(typeof irohRelayAccess, "function");
	assert.equal(typeof irohEnrollment, "function");
	assert.notEqual(irohEnrollmentApi, irohRelayAccess);
	assert.notEqual(irohEnrollmentApi, pushRelayApi);
	assert.equal(requestFunctionOptions.length, 5);
	for (const index of [0, 1, 2, 3]) {
		assert.equal(requestFunctionOptions[index].ingressSettings, "ALLOW_INTERNAL_AND_GCLB");
		assert.equal(requestFunctionOptions[index].invoker, "public");
	}
	assert.deepEqual(
		requestFunctionOptions.slice(0, 2).map((options) => ({
			concurrency: options.concurrency,
			secrets: options.secrets.map((secret) => secret.name),
			serviceAccountParameter: options.serviceAccount.name,
		})),
		[
			{
				concurrency: 40,
				secrets: ["IROH_ENROLLMENT_IP_SALT"],
				serviceAccountParameter: "IROH_ENROLLMENT_SERVICE_ACCOUNT",
			},
			{
				concurrency: 1,
				secrets: ["IROH_RELAY_ACCESS_SECRET_CURRENT", "IROH_RELAY_ACCESS_SECRET_NEXT"],
				serviceAccountParameter: "IROH_RELAY_ACCESS_SERVICE_ACCOUNT",
			},
		],
	);
	assert.notEqual(requestFunctionOptions[0].serviceAccount.name, requestFunctionOptions[1].serviceAccount.name);
	assert.deepEqual(
		{
			concurrency: requestFunctionOptions[3].concurrency,
			secrets: requestFunctionOptions[3].secrets ?? [],
			serviceAccountParameter: requestFunctionOptions[3].serviceAccount.name,
		},
		{
			concurrency: 20,
			secrets: [],
			serviceAccountParameter: "PUSH_RELAY_SERVICE_ACCOUNT",
		},
	);
});

test("split enrollment functions connect only to their shared named Firestore database", async () => {
	firestoreDatabaseIds.length = 0;
	await irohEnrollmentApi();
	await irohRelayAccess();
	assert.deepEqual(firestoreDatabaseIds, ["volt-iroh-enrollment", "volt-iroh-enrollment"]);
});

test("production registration route writes through its named Firestore database", async () => {
	firestoreDatabaseIds.length = 0;
	const fcmToken = "fcm-token-value-0001";
	let responseStatus;
	let responseBody;

	const body = { provider: "fcm", platform: "ios", token: fcmToken, enabled: true };
	const rawBody = Buffer.from(JSON.stringify(body), "utf8");
	await pushRelayApi(
		{
			body,
			headers: {
				"content-length": String(rawBody.byteLength),
				"content-type": "application/json",
				"x-firebase-appcheck": "limited-use-token",
			},
			method: "POST",
			path: "/v1/push-targets",
			rawBody,
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
	assert.deepEqual(firestoreDatabaseIds, ["volt-push-relay"]);
	assert.deepEqual(collectionNames, ["voltPushTargets"]);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].id, pushTargetId);
	assert.equal(writes[0].value.appId, appId);
	assert.equal(writes[0].value.token, fcmToken);
	assert.equal(writes[0].value.tokenHash, hashToken(fcmToken));
	assert.equal(responseStatus, 201);
	assert.equal(responseBody.pushTargetId, pushTargetId);
	assert.equal(responseBody.tokenHash, hashToken(fcmToken));
	assert.equal(responseBody.relayUrl, "https://push-relay-us-central.volt-cli.dev");
	assert.match(responseBody.pushTargetAuthToken, /^[A-Za-z0-9_-]{43}$/);
});

test("push API rejects query, trailing, prefixed, unknown, and wrong-method routes", async () => {
	const body = { provider: "fcm", platform: "ios", token: "fcm-token-value-0001", enabled: true };
	const rawBody = Buffer.from(JSON.stringify(body), "utf8");
	for (const [requestOverrides, expectedStatus, expectedError] of [
		[{ originalUrl: "/v1/push-targets?source=test", path: "/v1/push-targets" }, 400, "query_not_allowed"],
		[{ path: "/v1/push-targets/" }, 404, "not_found"],
		[{ path: "/pushRelay/v1/push-targets" }, 404, "not_found"],
		[{ path: "/v1/unknown" }, 404, "not_found"],
		[{ method: "GET", path: "/v1/push-targets" }, 405, "method_not_allowed"],
	]) {
		let responseStatus;
		let responseBody;
		await pushRelayApi(
			{
				body,
				headers: {
					"content-length": String(rawBody.byteLength),
					"content-type": "application/json",
				},
				method: "POST",
				path: "/v1/push-targets",
				rawBody,
				...requestOverrides,
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
		assert.equal(responseStatus, expectedStatus);
		assert.deepEqual(responseBody, { error: expectedError });
	}
});
