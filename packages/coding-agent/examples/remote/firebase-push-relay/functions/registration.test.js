const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getPushTargetId, hashToken } = require("./core.js");
const { createPushTargetRegistrationHandler } = require("./registration.js");

test("registration writes the relay target and returns the complete client contract", async () => {
	const appId = "1:546623825529:ios:9f5a707e3f4ef89154d6a8";
	const fcmToken = "fcm-token-value-0001";
	const nowMs = 2_000_000_000_000;
	const pushTargetAuthToken = "a".repeat(43);
	const pushTargetTtlMs = 30 * 24 * 60 * 60 * 1000;
	const publicRelayUrl = "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay";
	const writes = [];
	const rateLimitedAppIds = [];
	let responseStatus;
	let responseBody;

	const registerPushTarget = createPushTargetRegistrationHandler({
		enforceRegistrationRateLimit: (value) => rateLimitedAppIds.push(value),
		getPushTargetsCollection: () => ({
			doc: (id) => ({
				set: async (value) => writes.push({ id, value }),
			}),
		}),
		now: () => nowMs,
		publicRelayUrl,
		pushTargetTtlMs,
		randomPushTargetAuthToken: () => pushTargetAuthToken,
		timestampFromMillis: (epochMillis) => ({ epochMillis }),
		verifyRegistrationAppCheck: async () => appId,
	});

	await registerPushTarget(
		{
			body: { provider: "fcm", platform: "ios", token: fcmToken, enabled: true },
			headers: { "content-type": "application/json" },
		},
		{
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
	const tokenHash = hashToken(fcmToken);
	assert.deepEqual(rateLimitedAppIds, [appId]);
	assert.deepEqual(writes, [
		{
			id: pushTargetId,
			value: {
				appId,
				createdAt: { epochMillis: nowMs },
				enabled: true,
				expiresAt: { epochMillis: nowMs + pushTargetTtlMs },
				platform: "ios",
				provider: "fcm",
				token: fcmToken,
				tokenHash,
				pushTargetAuthTokenHash: hashToken(pushTargetAuthToken),
				updatedAt: { epochMillis: nowMs },
			},
		},
	]);
	assert.equal(responseStatus, 201);
	assert.deepEqual(responseBody, {
		pushTargetId,
		pushTargetAuthToken,
		relayUrl: publicRelayUrl,
		tokenHash,
		expiresAtEpochSeconds: Math.floor((nowMs + pushTargetTtlMs) / 1000),
	});
});
