const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
	DEFAULT_ALLOWED_FIREBASE_APP_ID,
	MAX_LIVE_ACTIVITY_SUBJECT_UTF8_BYTES,
	MAX_REQUEST_BYTES,
	RequestError,
	assertVerifiedAppCheck,
	getAllowedFirebaseAppIds,
	getConfiguredRelayUrl,
	getPushTargetId,
	hashToken,
	isPushTargetExpired,
	parseLiveActivityUpdate,
	parseNotification,
	parsePushTargetRegistration,
	parsePushTargetRevocation,
	readJsonBody,
	revokePushTargetTransaction,
} = require("./core.js");

function expectRequestError(operation, status, message) {
	assert.throws(operation, (error) => {
		assert.ok(error instanceof RequestError);
		assert.equal(error.status, status);
		assert.equal(error.publicMessage, message);
		return true;
	});
}

test("accepts a fresh limited-use App Check token for the production app", () => {
	const appId = assertVerifiedAppCheck(
		{
			alreadyConsumed: false,
			appId: DEFAULT_ALLOWED_FIREBASE_APP_ID,
			token: { jti: "one-time-attestation-id" },
		},
		getAllowedFirebaseAppIds({}),
	);
	assert.equal(appId, DEFAULT_ALLOWED_FIREBASE_APP_ID);
});

test("rejects replayed, ordinary, and wrong-app App Check tokens", () => {
	const allowed = getAllowedFirebaseAppIds({});
	expectRequestError(
		() =>
			assertVerifiedAppCheck(
				{ alreadyConsumed: true, appId: DEFAULT_ALLOWED_FIREBASE_APP_ID, token: { jti: "replayed-token-id" } },
				allowed,
			),
		401,
		"app_check_token_replayed",
	);
	expectRequestError(
		() =>
			assertVerifiedAppCheck(
				{ alreadyConsumed: false, appId: DEFAULT_ALLOWED_FIREBASE_APP_ID, token: {} },
				allowed,
			),
		401,
		"app_check_limited_use_token_required",
	);
	expectRequestError(
		() =>
			assertVerifiedAppCheck(
				{ alreadyConsumed: false, appId: "other-app", token: { jti: "wrong-application-token" } },
				allowed,
			),
		403,
		"app_check_app_not_allowed",
	);
});

test("uses a deterministic bounded document id for each FCM token", () => {
	const first = getPushTargetId("fcm-token-value-0001");
	assert.equal(first, getPushTargetId("fcm-token-value-0001"));
	assert.notEqual(first, getPushTargetId("fcm-token-value-0002"));
	assert.match(first, /^fcm_[A-Za-z0-9_-]{43}$/);
});

test("never derives the public relay URL from request headers", () => {
	assert.equal(getConfiguredRelayUrl({}), "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay");
	assert.equal(
		getConfiguredRelayUrl({ PUSH_RELAY_URL: "https://push.volt.example/relay/" }),
		"https://push.volt.example/relay",
	);
	assert.throws(() => getConfiguredRelayUrl({ PUSH_RELAY_URL: "http://attacker.example/relay" }), /HTTPS/);
	assert.throws(
		() => getConfiguredRelayUrl({ PUSH_RELAY_URL: "https://push.volt.example/relay?redirect=evil" }),
		/query/,
	);
});

test("rejects oversized and structurally abusive JSON before route parsing", () => {
	expectRequestError(
		() => readJsonBody({ body: { value: "ok" }, headers: {} }),
		415,
		"content_type_must_be_json",
	);
	expectRequestError(
		() =>
			readJsonBody({
				body: { value: "ok" },
				headers: { "content-length": String(MAX_REQUEST_BYTES + 1), "content-type": "application/json" },
			}),
		413,
		"request_body_too_large",
	);
	expectRequestError(
		() =>
			readJsonBody({
				body: { values: Array.from({ length: 33 }, () => 1) },
				headers: { "content-type": "application/json" },
			}),
		400,
		"request_arrays_too_large",
	);
	let nested = { value: true };
	for (let index = 0; index < 9; index += 1) nested = { nested };
	expectRequestError(
		() => readJsonBody({ body: nested, headers: { "content-type": "application/json" } }),
		400,
		"request_body_too_deep",
	);
});

test("registration and notification schemas reject unknown and oversized values", () => {
	assert.deepEqual(
		parsePushTargetRegistration({ provider: "fcm", platform: "ios", token: "fcm-token-value-0001", enabled: true }),
		{ provider: "fcm", platform: "ios", token: "fcm-token-value-0001", enabled: true },
	);
	expectRequestError(
		() =>
			parsePushTargetRegistration({
				provider: "fcm",
				platform: "ios",
				token: "fcm-token-value-0001",
				enabled: true,
				redirect: "https://attacker.example",
			}),
		400,
		"registration_has_unknown_field",
	);
	expectRequestError(
		() =>
			parseNotification({
				pushTargetId: "fcm_12345678901234567890",
				pushTargetAuthToken: "a".repeat(32),
				eventId: "event-1",
				kind: "completed",
				title: "Volt",
				body: "x".repeat(1025),
				data: {},
			}),
		400,
		"body_has_invalid_length",
	);
});

test("status and revoke credentials use the same strict target schema", () => {
	assert.deepEqual(
		parsePushTargetRevocation({
			pushTargetId: "fcm_12345678901234567890",
			pushTargetAuthToken: "a".repeat(43),
		}),
		{
			pushTargetId: "fcm_12345678901234567890",
			pushTargetAuthToken: "a".repeat(43),
		},
	);
	expectRequestError(
		() =>
			parsePushTargetRevocation({
				pushTargetId: "fcm_12345678901234567890",
				pushTargetAuthToken: "short",
				redirect: "https://attacker.example",
			}),
		400,
		"revocation_has_unknown_field",
	);
});

test("revocation rechecks credentials inside the delete transaction", async () => {
	const oldCredential = "a".repeat(43);
	const newCredential = "b".repeat(43);
	const pushTargetRef = { path: "voltPushTargets/fcm_target" };
	let attempt = 0;
	let committedDeleteCount = 0;
	const firestore = {
		async runTransaction(operation) {
			const firstAttemptDeletes = [];
			await operation({
				delete: (ref) => firstAttemptDeletes.push(ref),
				get: async () => ({
					data: () => ({ pushTargetAuthTokenHash: hashToken(oldCredential) }),
					exists: true,
				}),
			});
			attempt += 1;
			assert.equal(firstAttemptDeletes.length, 1);

			// Simulate Firestore retrying after a concurrent registration replaced
			// this deterministic document ID with a new credential. The stale
			// delete from the conflicted attempt is not committed.
			const secondAttemptDeletes = [];
			const result = await operation({
				delete: (ref) => secondAttemptDeletes.push(ref),
				get: async () => ({
					data: () => ({ pushTargetAuthTokenHash: hashToken(newCredential) }),
					exists: true,
				}),
			});
			committedDeleteCount += secondAttemptDeletes.length;
			return result;
		},
	};

	await assert.rejects(
		revokePushTargetTransaction(firestore, pushTargetRef, oldCredential),
		(error) => error instanceof RequestError && error.status === 401,
	);
	assert.equal(attempt, 1);
	assert.equal(committedDeleteCount, 0);
});

test("Live Activity input accepts and forwards the bounded semantic content state", () => {
	const now = 2_000_000_000;
	const subject = "🚀".repeat(MAX_LIVE_ACTIVITY_SUBJECT_UTF8_BYTES / 4);
	const parsed = parseLiveActivityUpdate(
		{
			pushTargetId: "fcm_12345678901234567890",
			pushTargetAuthToken: "a".repeat(32),
			activityId: "activity-1",
			activityPushToken: "activity-token-value",
			eventId: "event-1",
			kind: "live_activity_update",
			contentState: {
				operationKind: "planCreation",
				operationID: "session-one",
				status: "running",
				subject,
				sessionID: "session-one",
				workspaceName: "volt-app",
				operationStartedAtEpochSeconds: now - 60,
				updatedAtEpochSeconds: now,
			},
			staleDateEpochSeconds: now + 90,
		},
		now,
	);
	assert.deepEqual(parsed.contentState, {
		operationKind: "planCreation",
		operationID: "session-one",
		status: "running",
		subject,
		sessionID: "session-one",
		workspaceName: "volt-app",
		operationStartedAtEpochSeconds: now - 60,
		updatedAtEpochSeconds: now,
	});
	assert.equal(parsed.staleDateEpochSeconds, now + 90);
	assert.ok(Buffer.byteLength(JSON.stringify(parsed.contentState), "utf8") < 4 * 1024);
});

test("Live Activity input rejects old tool payloads and malformed semantic state", () => {
	const now = 2_000_000_000;
	const base = {
		pushTargetId: "fcm_12345678901234567890",
		pushTargetAuthToken: "a".repeat(32),
		activityId: "activity-1",
		activityPushToken: "activity-token-value",
		eventId: "event-1",
		kind: "live_activity_update",
	};
	const contentState = {
		operationKind: "conversation",
		operationID: "session-one",
		status: "running",
		sessionID: "session-one",
		workspaceName: "volt-app",
		operationStartedAtEpochSeconds: now - 60,
		updatedAtEpochSeconds: now,
	};
	expectRequestError(
		() =>
			parseLiveActivityUpdate(
				{
					...base,
					contentState: {
						status: "running",
						statusText: "Running",
						recentTools: [],
						updatedAtEpochSeconds: now,
					},
				},
				now,
			),
		400,
		"contentState_has_unknown_field",
	);
	expectRequestError(
		() => parseLiveActivityUpdate({ ...base, contentState: { ...contentState, operationID: "" } }, now),
		400,
		"operationID_has_invalid_length",
	);
	expectRequestError(
		() => parseLiveActivityUpdate({ ...base, contentState: { ...contentState, status: "waiting" } }, now),
		400,
		"status_must_be_running_or_completed_or_failed_or_cancelled",
	);
	expectRequestError(
		() =>
			parseLiveActivityUpdate(
				{ ...base, contentState: { ...contentState, operationKind: "review", subject: "private target" } },
				now,
			),
		400,
		"subject_requires_plan_creation",
	);
	expectRequestError(
		() =>
			parseLiveActivityUpdate(
				{
					...base,
					contentState: {
						...contentState,
						operationKind: "planCreation",
						subject: "🚀".repeat(MAX_LIVE_ACTIVITY_SUBJECT_UTF8_BYTES / 4 + 1),
					},
				},
				now,
			),
		400,
		"subject_has_invalid_utf8_length",
	);
	expectRequestError(
		() =>
			parseLiveActivityUpdate(
				{
					...base,
					contentState: { ...contentState, operationStartedAtEpochSeconds: now + 1 },
				},
				now,
			),
		400,
		"operationStartedAtEpochSeconds_after_updatedAtEpochSeconds",
	);
});

test("Live Activity input rejects stale and future semantic updates", () => {
	const now = 2_000_000_000;
	const base = {
		pushTargetId: "fcm_12345678901234567890",
		pushTargetAuthToken: "a".repeat(32),
		activityId: "activity-1",
		activityPushToken: "activity-token-value",
		eventId: "event-1",
		kind: "live_activity_update",
	};
	const contentState = {
		operationKind: "conversation",
		operationID: "session-one",
		status: "running",
		sessionID: "session-one",
		workspaceName: "volt-app",
		operationStartedAtEpochSeconds: now - 86_500,
		updatedAtEpochSeconds: now,
	};
	for (const updatedAtEpochSeconds of [now - 86_401, now + 301]) {
		expectRequestError(
			() =>
				parseLiveActivityUpdate(
					{ ...base, contentState: { ...contentState, updatedAtEpochSeconds } },
					now,
				),
			400,
			"updatedAtEpochSeconds_out_of_range",
		);
	}
});

test("missing and elapsed expiry timestamps are invalid", () => {
	assert.equal(isPushTargetExpired({}, 10_000), true);
	assert.equal(isPushTargetExpired({ expiresAt: { seconds: 9 } }, 10_000), true);
	assert.equal(isPushTargetExpired({ expiresAt: { seconds: 11 } }, 10_000), false);
});
