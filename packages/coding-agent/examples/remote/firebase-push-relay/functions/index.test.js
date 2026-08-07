const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");
const { getPushTargetId, hashToken } = require("./core.js");

const appId = "1:546623825529:ios:9f5a707e3f4ef89154d6a8";
const collectionNames = [];
const writes = [];
const requestFunctionOptions = [];
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
	["firebase-functions/logger", { error: () => {} }],
	[
		"firebase-functions/params",
		{
			defineSecret: (name) => ({
				name,
				value: () => `${name.toLowerCase()}-${"s".repeat(32)}`,
			}),
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
process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT = "volt-enrollment@volt-3fae7.iam.gserviceaccount.com";
Module._load = function load(request, parent, isMain) {
	return moduleStubs.has(request)
		? moduleStubs.get(request)
		: Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
let irohEnrollment;
let pushRelay;
try {
	({ irohEnrollment, pushRelay } = require("./index.js"));
} finally {
	Module._load = originalLoad;
	if (originalEnrollmentServiceAccount === undefined) {
		delete process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT;
	} else {
		process.env.IROH_ENROLLMENT_SERVICE_ACCOUNT = originalEnrollmentServiceAccount;
	}
}

test("exports enrollment as a separate secret-backed v2 HTTPS function", () => {
	assert.equal(typeof irohEnrollment, "function");
	assert.notEqual(irohEnrollment, pushRelay);
	assert.equal(requestFunctionOptions.length, 2);
	assert.equal(requestFunctionOptions[0].ingressSettings, "ALLOW_INTERNAL_AND_GCLB");
	assert.equal(
		requestFunctionOptions[0].serviceAccount,
		"volt-enrollment@volt-3fae7.iam.gserviceaccount.com",
	);
	assert.deepEqual(
		requestFunctionOptions[0].secrets.map((secret) => secret.name),
		[
			"IROH_ENROLLMENT_IP_SALT",
			"IROH_RELAY_ACCESS_SECRET_CURRENT",
			"IROH_RELAY_ACCESS_SECRET_NEXT",
		],
	);
});

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
	assert.equal(responseStatus, 201);
	assert.equal(responseBody.pushTargetId, pushTargetId);
	assert.equal(responseBody.tokenHash, hashToken(fcmToken));
	assert.equal(responseBody.relayUrl, "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay");
	assert.match(responseBody.pushTargetAuthToken, /^[A-Za-z0-9_-]{43}$/);
});
