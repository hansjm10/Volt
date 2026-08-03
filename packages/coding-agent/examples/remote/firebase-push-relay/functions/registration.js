const {
	getPushTargetId,
	hashToken,
	parsePushTargetRegistration,
	readJsonBody,
} = require("./core.js");

function createPushTargetRegistrationHandler(options) {
	const {
		enforceRegistrationRateLimit,
		getPushTargetsCollection,
		now,
		publicRelayUrl,
		pushTargetTtlMs,
		randomPushTargetAuthToken,
		timestampFromMillis,
		verifyRegistrationAppCheck,
	} = options;

	return async function registerPushTarget(request, response) {
		const appId = await verifyRegistrationAppCheck(request);
		enforceRegistrationRateLimit(appId);
		const registration = parsePushTargetRegistration(readJsonBody(request));
		const pushTargetId = getPushTargetId(registration.token);
		const pushTargetAuthToken = randomPushTargetAuthToken();
		const tokenHash = hashToken(registration.token);
		const nowMs = now();
		const nowTimestamp = timestampFromMillis(nowMs);
		await getPushTargetsCollection().doc(pushTargetId).set({
			appId,
			createdAt: nowTimestamp,
			enabled: registration.enabled,
			expiresAt: timestampFromMillis(nowMs + pushTargetTtlMs),
			platform: registration.platform,
			provider: registration.provider,
			token: registration.token,
			tokenHash,
			pushTargetAuthTokenHash: hashToken(pushTargetAuthToken),
			updatedAt: nowTimestamp,
		});
		response.status(201).json({
			pushTargetId,
			pushTargetAuthToken,
			relayUrl: publicRelayUrl,
			tokenHash,
			expiresAtEpochSeconds: Math.floor((nowMs + pushTargetTtlMs) / 1000),
		});
	};
}

module.exports = { createPushTargetRegistrationHandler };
