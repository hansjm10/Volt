const { randomBytes } = require("node:crypto");
const { getAppCheck } = require("firebase-admin/app-check");
const { initializeApp, getApps } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { error: logFirebaseError, info: logFirebaseInfo } = require("firebase-functions/logger");
const { defineSecret, defineString } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const {
	createIrohEnrollmentApiHandler,
	createIrohRelayAccessHandler,
} = require("./enrollment-handler.js");
const { getEnrollmentConfig } = require("./enrollment-core.js");
const { createPushTargetRegistrationHandler } = require("./registration.js");
const {
	RequestError,
	SERVICE_ACCOUNT_EMAIL_PATTERN,
	assertRequestEnvelope,
	assertVerifiedAppCheck,
	getAllowedFirebaseAppIds,
	getBoundedPositiveInteger,
	getConfiguredRelayUrl,
	getHeader,
	getPushTargetTtlMs,
	getRuntimeServiceAccounts,
	isPushTargetExpired,
	parseNotification,
	parsePushTargetRevocation,
	readJsonBody,
	revokePushTargetTransaction,
	timingSafeTokenHashMatches,
} = require("./core.js");

const DEFAULT_COLLECTION = "voltPushTargets";
const DEFAULT_REGION = "us-central1";
const ENROLLMENT_DATABASE_ID = "volt-iroh-enrollment";
const PUSH_RELAY_DATABASE_ID = "volt-push-relay";
const DELIVERY_QUOTA_WINDOW_MS = 60_000;
const DEFAULT_DELIVERIES_PER_TARGET_PER_MINUTE = 30;
const DEFAULT_REGISTRATIONS_PER_INSTANCE_PER_MINUTE = 30;
const INVALID_TARGET_ERROR_CODES = new Set([
	"messaging/invalid-registration-token",
	"messaging/mismatched-credential",
	"messaging/registration-token-not-registered",
]);

if (getApps().length === 0) {
	initializeApp();
}

const allowedFirebaseAppIds = getAllowedFirebaseAppIds();
const publicRelayUrl = getConfiguredRelayUrl();
const pushTargetTtlMs = getPushTargetTtlMs();
const maxDeliveriesPerTargetPerMinute = getBoundedPositiveInteger(
	process.env.DELIVERIES_PER_TARGET_PER_MINUTE,
	1,
	600,
	DEFAULT_DELIVERIES_PER_TARGET_PER_MINUTE,
);
const maxRegistrationsPerInstancePerMinute = getBoundedPositiveInteger(
	process.env.REGISTRATIONS_PER_INSTANCE_PER_MINUTE,
	1,
	120,
	DEFAULT_REGISTRATIONS_PER_INSTANCE_PER_MINUTE,
);
const registrationWindows = new Map();
const enrollmentConfig = getEnrollmentConfig();
const irohEnrollmentServiceAccount = defineServiceAccountParameter("IROH_ENROLLMENT_SERVICE_ACCOUNT");
const irohRelayAccessServiceAccount = defineServiceAccountParameter("IROH_RELAY_ACCESS_SERVICE_ACCOUNT");
const pushRelayServiceAccount = defineServiceAccountParameter("PUSH_RELAY_SERVICE_ACCOUNT");
const irohEnrollmentIpSalt = defineSecret("IROH_ENROLLMENT_IP_SALT");
const irohRelayAccessSecretCurrent = defineSecret("IROH_RELAY_ACCESS_SECRET_CURRENT");
const irohRelayAccessSecretNext = defineSecret("IROH_RELAY_ACCESS_SECRET_NEXT");
const registerPushTarget = createPushTargetRegistrationHandler({
	enforceRegistrationRateLimit,
	getPushTargetsCollection,
	now: Date.now,
	publicRelayUrl,
	pushTargetTtlMs,
	randomPushTargetAuthToken: () => randomBytes(32).toString("base64url"),
	timestampFromMillis: (value) => Timestamp.fromMillis(value),
	verifyRegistrationAppCheck,
});
const handleIrohEnrollmentApi = withRuntimeServiceAccountValidation(createIrohEnrollmentApiHandler({
	config: enrollmentConfig,
	getFirestore: getEnrollmentFirestore,
	getIpSalt: () => irohEnrollmentIpSalt.value(),
	logError: (entry) => logFirebaseError("iroh enrollment request failed", entry),
	logEvent: (entry) => logFirebaseInfo("iroh enrollment request", entry),
	now: Date.now,
	timestampFromMillis: (value) => Timestamp.fromMillis(value),
	verifyLimitedUseAppCheck: verifyRegistrationAppCheck,
}));
const handleIrohRelayAccess = withRuntimeServiceAccountValidation(createIrohRelayAccessHandler({
	getFirestore: getEnrollmentFirestore,
	getRelayAccessSecrets: () => [
		irohRelayAccessSecretCurrent.value(),
		irohRelayAccessSecretNext.value(),
	],
	logError: (entry) => logFirebaseError("Iroh relay access request failed", entry),
	logEvent: (entry) => logFirebaseInfo("Iroh relay access request", entry),
	now: Date.now,
	requestsPerEndpointPerWindow: enrollmentConfig.requestsPerEndpointPerWindow,
	timestampFromMillis: (value) => Timestamp.fromMillis(value),
}));

exports.irohEnrollmentApi = onRequest(
	{
		concurrency: 40,
		cors: false,
		ingressSettings: "ALLOW_INTERNAL_AND_GCLB",
		invoker: "public",
		maxInstances: 20,
		memory: "256MiB",
		region: process.env.FUNCTION_REGION || DEFAULT_REGION,
		serviceAccount: irohEnrollmentServiceAccount,
		secrets: [irohEnrollmentIpSalt],
		timeoutSeconds: 15,
	},
	handleIrohEnrollmentApi,
);

exports.irohRelayAccess = onRequest(
	{
		concurrency: 1,
		cors: false,
		ingressSettings: "ALLOW_INTERNAL_AND_GCLB",
		invoker: "public",
		maxInstances: 20,
		memory: "256MiB",
		region: process.env.FUNCTION_REGION || DEFAULT_REGION,
		serviceAccount: irohRelayAccessServiceAccount,
		secrets: [irohRelayAccessSecretCurrent, irohRelayAccessSecretNext],
		timeoutSeconds: 15,
	},
	handleIrohRelayAccess,
);

// Retained only as the unshipped rollback target during the protected-edge
// soak. Delete this export after the recorded retirement gate passes.
exports.irohEnrollment = onRequest(
	{
		concurrency: 40,
		cors: false,
		ingressSettings: "ALLOW_INTERNAL_AND_GCLB",
		invoker: "public",
		maxInstances: 20,
		memory: "256MiB",
		region: process.env.FUNCTION_REGION || DEFAULT_REGION,
		serviceAccount: irohEnrollmentServiceAccount,
		secrets: [
			irohEnrollmentIpSalt,
			irohRelayAccessSecretCurrent,
			irohRelayAccessSecretNext,
		],
		timeoutSeconds: 15,
	},
	(request, response) => request.path === "/v1/relay-access"
		? handleIrohRelayAccess(request, response)
		: handleIrohEnrollmentApi(request, response),
);

const handlePushRelayRequest = async (request, response) => {
	assertRuntimeServiceAccountsConfigured();
	response.set("cache-control", "no-store");
	response.set("x-content-type-options", "nosniff");
	try {
		await routeRequest(request, response);
	} catch (error) {
		if (response.headersSent) return;
		if (error instanceof RequestError) {
			response.status(error.status).json({ error: error.publicMessage });
			return;
		}
		console.error("push relay request failed", getSafeErrorLog(error));
		response.status(500).json({ error: "internal_error" });
	}
};

exports.pushRelayApi = onRequest(
	{
		concurrency: 20,
		cors: false,
		ingressSettings: "ALLOW_INTERNAL_AND_GCLB",
		invoker: "public",
		maxInstances: 10,
		memory: "256MiB",
		region: process.env.FUNCTION_REGION || DEFAULT_REGION,
		serviceAccount: pushRelayServiceAccount,
		timeoutSeconds: 15,
	},
	handlePushRelayRequest,
);

// Retained only as the unshipped rollback target during the protected-edge
// soak. Delete this export after the recorded retirement gate passes.
exports.pushRelay = onRequest(
	{
		concurrency: 20,
		cors: false,
		invoker: "public",
		maxInstances: 10,
		memory: "256MiB",
		region: process.env.FUNCTION_REGION || DEFAULT_REGION,
		serviceAccount: pushRelayServiceAccount,
		timeoutSeconds: 15,
	},
	handlePushRelayRequest,
);

function defineServiceAccountParameter(name) {
	return defineString(name, {
		input: {
			text: {
				nonEmpty: true,
				validationErrorMessage: `${name} must be a dedicated service account email`,
				validationRegex: SERVICE_ACCOUNT_EMAIL_PATTERN,
			},
		},
	});
}

let runtimeServiceAccountsValidated = false;
function assertRuntimeServiceAccountsConfigured() {
	if (runtimeServiceAccountsValidated) return;
	getRuntimeServiceAccounts();
	runtimeServiceAccountsValidated = true;
}

function withRuntimeServiceAccountValidation(handler) {
	return async (request, response) => {
		assertRuntimeServiceAccountsConfigured();
		return handler(request, response);
	};
}

async function routeRequest(request, response) {
	if (request.method !== "POST") {
		response.set("allow", "POST");
		throw new RequestError(405, "method_not_allowed");
	}
	for (const target of [request.originalUrl, request.url, request.path]) {
		if (typeof target === "string" && target.includes("?")) {
			throw new RequestError(400, "query_not_allowed");
		}
	}
	assertRequestEnvelope(request);
	const routePath = typeof request.path === "string" && request.path.length > 0 ? request.path : "/";
	if (routePath === "/v1/push-targets") {
		await registerPushTarget(request, response);
		return;
	}
	if (routePath === "/v1/push-targets/revoke") {
		await revokePushTarget(request, response);
		return;
	}
	if (routePath === "/v1/push-targets/status") {
		await getPushTargetStatus(request, response);
		return;
	}
	if (routePath === "/v1/notifications") {
		await sendNotification(request, response);
		return;
	}
	throw new RequestError(404, "not_found");
}

function getPushFirestore() {
	return getFirestore(PUSH_RELAY_DATABASE_ID);
}

function getEnrollmentFirestore() {
	return getFirestore(ENROLLMENT_DATABASE_ID);
}

function getPushTargetsCollection() {
	return getPushFirestore().collection(DEFAULT_COLLECTION);
}

async function verifyRegistrationAppCheck(request) {
	const appCheckToken = getHeader(request, "x-firebase-appcheck");
	if (appCheckToken === undefined || appCheckToken.length > 8192) {
		throw new RequestError(401, "app_check_limited_use_token_required");
	}
	let verification;
	try {
		verification = await getAppCheck().verifyToken(appCheckToken, { consume: true });
	} catch {
		throw new RequestError(401, "app_check_invalid");
	}
	return assertVerifiedAppCheck(verification, allowedFirebaseAppIds);
}

function enforceRegistrationRateLimit(appId) {
	const now = Date.now();
	const existing = registrationWindows.get(appId);
	if (existing === undefined || existing.startedAtMs + DELIVERY_QUOTA_WINDOW_MS <= now) {
		registrationWindows.set(appId, { count: 1, startedAtMs: now });
		return;
	}
	if (existing.count >= maxRegistrationsPerInstancePerMinute) {
		throw new RequestError(429, "registration_rate_limited");
	}
	existing.count += 1;
}

async function revokePushTarget(request, response) {
	const revocation = parsePushTargetRevocation(readJsonBody(request));
	const pushTargetRef = getPushTargetsCollection().doc(revocation.pushTargetId);
	const status = await revokePushTargetTransaction(
		getPushFirestore(),
		pushTargetRef,
		revocation.pushTargetAuthToken,
	);
	response.status(200).json({ status });
}

async function getPushTargetStatus(request, response) {
	const credential = parsePushTargetRevocation(readJsonBody(request));
	const snapshot = await getPushTargetsCollection().doc(credential.pushTargetId).get();
	if (!snapshot.exists) {
		throw new RequestError(404, "push_target_not_found");
	}
	const pushTarget = snapshot.data();
	if (!isAuthorizedTargetCredential(pushTarget, credential.pushTargetAuthToken)) {
		throw new RequestError(401, "unauthorized");
	}
	if (!isValidEnabledPushTarget(pushTarget) || isPushTargetExpired(pushTarget)) {
		throw new RequestError(410, "push_target_invalid");
	}
	const expiresAtMs = getFirestoreTimestampMillis(pushTarget.expiresAt);
	if (expiresAtMs === undefined) {
		throw new RequestError(410, "push_target_invalid");
	}
	response.status(200).json({
		status: "active",
		expiresAtEpochSeconds: Math.floor(expiresAtMs / 1000),
	});
}

async function sendNotification(request, response) {
	const notification = parseNotification(readJsonBody(request));
	const authorizedTarget = await reserveAuthorizedPushTarget(notification);
	const { pushTarget, pushTargetRef } = authorizedTarget;

	try {
		const messageId = await getMessaging().send({
			data: notification.data,
			notification: {
				body: notification.body,
				title: notification.title,
			},
			token: pushTarget.token,
		});
		await markPushSent(pushTargetRef, notification, messageId);
		response.status(200).json({ status: "sent", messageId });
	} catch (error) {
		if (isInvalidTargetError(error)) {
			await disablePushTarget(pushTargetRef, getErrorCode(error) || "messaging/invalid-target");
			throw new RequestError(410, "push_target_invalid");
		}
		respondFcmSendFailed(response, "notification", notification, error);
	}
}

async function reserveAuthorizedPushTarget(request) {
	const pushTargetRef = getPushTargetsCollection().doc(request.pushTargetId);
	return getPushFirestore().runTransaction(async (transaction) => {
		const snapshot = await transaction.get(pushTargetRef);
		if (!snapshot.exists) {
			throw new RequestError(404, "push_target_not_found");
		}
		const pushTarget = snapshot.data();
		if (!isValidEnabledPushTarget(pushTarget)) {
			throw new RequestError(410, "push_target_invalid");
		}
		if (isPushTargetExpired(pushTarget)) {
			throw new RequestError(410, "push_target_expired");
		}
		if (!isAuthorizedTargetCredential(pushTarget, request.pushTargetAuthToken)) {
			throw new RequestError(401, "unauthorized");
		}

		const nowMs = Date.now();
		const windowStartedAtMs = getFirestoreTimestampMillis(pushTarget.deliveryWindowStartedAt);
		const inCurrentWindow =
			windowStartedAtMs !== undefined && windowStartedAtMs + DELIVERY_QUOTA_WINDOW_MS > nowMs;
		const deliveryWindowCount = inCurrentWindow && Number.isSafeInteger(pushTarget.deliveryWindowCount)
			? pushTarget.deliveryWindowCount
			: 0;
		if (deliveryWindowCount >= maxDeliveriesPerTargetPerMinute) {
			throw new RequestError(429, "push_target_rate_limited");
		}
		transaction.update(pushTargetRef, {
			deliveryWindowCount: deliveryWindowCount + 1,
			deliveryWindowStartedAt: inCurrentWindow
				? pushTarget.deliveryWindowStartedAt
				: Timestamp.fromMillis(nowMs),
			updatedAt: Timestamp.fromMillis(nowMs),
		});
		return { pushTarget, pushTargetRef };
	});
}

function isValidEnabledPushTarget(value) {
	return (
		isRecord(value) &&
		value.enabled === true &&
		value.provider === "fcm" &&
		value.platform === "ios" &&
		typeof value.token === "string" &&
		value.token.length >= 16 &&
		value.token.length <= 4096
	);
}

function isAuthorizedTargetCredential(pushTarget, authToken) {
	return (
		isRecord(pushTarget) &&
		typeof authToken === "string" &&
		timingSafeTokenHashMatches(authToken, pushTarget.pushTargetAuthTokenHash)
	);
}

function getFirestoreTimestampMillis(value) {
	if (isRecord(value) && typeof value.toMillis === "function") {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : undefined;
	}
	return undefined;
}

async function markPushSent(pushTargetRef, request, messageId) {
	await pushTargetRef.update({
		lastEventId: request.eventId,
		lastKind: request.kind,
		lastMessageId: messageId,
		lastSentAt: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	});
}

async function disablePushTarget(pushTargetRef, reason) {
	await pushTargetRef.update({
		disabledAt: FieldValue.serverTimestamp(),
		disabledReason: reason,
		enabled: false,
		updatedAt: FieldValue.serverTimestamp(),
	});
}

function respondFcmSendFailed(response, route, request, error) {
	const code = getErrorCode(error) || "unknown";
	console.error(`FCM ${route} send failed`, {
		eventId: request.eventId.slice(0, 128),
		kind: request.kind.slice(0, 64),
		...getSafeErrorLog(error),
	});
	response.status(502).json({ error: "fcm_send_failed", code });
}

function isInvalidTargetError(error) {
	const code = getErrorCode(error);
	return Boolean(code && INVALID_TARGET_ERROR_CODES.has(code));
}

function getErrorCode(error) {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function getSafeErrorLog(error) {
	const code = getErrorCode(error);
	const name = error instanceof Error ? error.name.slice(0, 64) : "UnknownError";
	return { ...(code === undefined ? {} : { code: code.slice(0, 96) }), name };
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
