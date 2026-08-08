const { createHash, timingSafeEqual } = require("node:crypto");

const DEFAULT_ALLOWED_FIREBASE_APP_ID = "1:546623825529:ios:9f5a707e3f4ef89154d6a8";
const DEFAULT_PUBLIC_RELAY_URL = "https://push-relay-us-central.volt-cli.dev";
const DEFAULT_PUSH_TARGET_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_OBJECT_DEPTH = 8;
const MAX_TOTAL_ARRAY_ENTRIES = 32;
const MAX_TOTAL_KEYS = 80;
const MAX_TOTAL_VALUES = 160;
const MAX_GENERIC_STRING_LENGTH = 4096;
const MAX_NOTIFICATION_TITLE_UTF8_BYTES = 128;
const MAX_NOTIFICATION_BODY_UTF8_BYTES = 512;
const MAX_NOTIFICATION_WORKSPACE_UTF8_BYTES = 128;
const MAX_NOTIFICATION_METADATA_UTF8_BYTES = 128;
const MAX_NOTIFICATION_EVENT_ID_UTF8_BYTES = 512;
const MAX_NOTIFICATION_KIND_UTF8_BYTES = 64;
const NOTIFICATION_UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const NOTIFICATION_PATH_SEPARATOR = /[/\\]/u;
const SERVICE_ACCOUNT_EMAIL_PATTERN =
	/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const NOTIFICATION_KINDS = new Set([
	"conversation_completed",
	"plan_ready",
	"review_completed",
	"action_completed",
	"host_notice",
]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class RequestError extends Error {
	constructor(status, publicMessage) {
		super(publicMessage);
		this.name = "RequestError";
		this.publicMessage = publicMessage;
		this.status = status;
	}
}

function assertRequestEnvelope(request) {
	const contentType = getHeader(request, "content-type");
	if (contentType === undefined || contentType.toLowerCase() !== "application/json") {
		throw new RequestError(415, "content_type_must_be_json");
	}
	if (getHeader(request, "content-encoding") !== undefined) {
		throw new RequestError(400, "content_encoding_not_allowed");
	}
	const contentLength = getHeader(request, "content-length");
	if (contentLength === undefined || !/^[1-9][0-9]{0,4}$/.test(contentLength)) {
		throw new RequestError(400, "invalid_content_length");
	}
	if (Number(contentLength) > MAX_REQUEST_BYTES) {
		throw new RequestError(413, "request_body_too_large");
	}
	const rawBody = request.rawBody;
	if (Buffer.isBuffer(rawBody) && rawBody.byteLength > MAX_REQUEST_BYTES) {
		throw new RequestError(413, "request_body_too_large");
	}
}

function assertEmptyRequestEnvelope(request) {
	if (getHeader(request, "content-encoding") !== undefined) {
		throw new RequestError(400, "content_encoding_not_allowed");
	}
	if (getHeader(request, "content-length") !== "0") {
		throw new RequestError(400, "callback_body_must_be_empty");
	}
	const rawBody = request.rawBody;
	if (Buffer.isBuffer(rawBody) || typeof rawBody === "string") {
		if (rawBody.length !== 0) {
			throw new RequestError(400, "callback_body_must_be_empty");
		}
		return;
	}
	const body = request.body;
	if (body === undefined) return;
	if ((Buffer.isBuffer(body) || typeof body === "string") && body.length === 0) return;
	if (isRecord(body) && Object.keys(body).length === 0) return;
	throw new RequestError(400, "callback_body_must_be_empty");
}

function readJsonBody(request) {
	assertRequestEnvelope(request);
	const body = request.body;
	let parsed;
	if (Buffer.isBuffer(body)) {
		if (body.byteLength > MAX_REQUEST_BYTES) {
			throw new RequestError(413, "request_body_too_large");
		}
		parsed = parseJson(body.toString("utf8"));
	} else if (typeof body === "string") {
		if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
			throw new RequestError(413, "request_body_too_large");
		}
		parsed = parseJson(body);
	} else if (isRecord(body)) {
		const encoded = JSON.stringify(body);
		if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
			throw new RequestError(413, "request_body_too_large");
		}
		parsed = body;
	} else {
		throw new RequestError(400, "request_body_must_be_json");
	}
	assertBoundedJsonValue(parsed);
	return parsed;
}

function parseJson(value) {
	try {
		const parsed = JSON.parse(value);
		if (!isRecord(parsed)) {
			throw new RequestError(400, "request_body_must_be_json_object");
		}
		return parsed;
	} catch (error) {
		if (error instanceof RequestError) {
			throw error;
		}
		throw new RequestError(400, "request_body_must_be_json");
	}
}

function assertBoundedJsonValue(root) {
	let totalArrayEntries = 0;
	let totalKeys = 0;
	let totalValues = 0;
	const pending = [{ depth: 0, value: root }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		totalValues += 1;
		if (totalValues > MAX_TOTAL_VALUES) {
			throw new RequestError(400, "request_body_too_complex");
		}
		if (current.depth > MAX_OBJECT_DEPTH) {
			throw new RequestError(400, "request_body_too_deep");
		}
		if (typeof current.value === "string" && current.value.length > MAX_GENERIC_STRING_LENGTH) {
			throw new RequestError(400, "request_string_too_large");
		}
		if (Array.isArray(current.value)) {
			totalArrayEntries += current.value.length;
			if (totalArrayEntries > MAX_TOTAL_ARRAY_ENTRIES) {
				throw new RequestError(400, "request_arrays_too_large");
			}
			for (const entry of current.value) {
				pending.push({ depth: current.depth + 1, value: entry });
			}
			continue;
		}
		if (!isRecord(current.value)) continue;
		const entries = Object.entries(current.value);
		totalKeys += entries.length;
		if (totalKeys > MAX_TOTAL_KEYS) {
			throw new RequestError(400, "request_has_too_many_keys");
		}
		for (const [key, value] of entries) {
			assertSafeObjectKey(key, "request");
			pending.push({ depth: current.depth + 1, value });
		}
	}
}

function parsePushTargetRegistration(body) {
	expectAllowedKeys(body, ["provider", "platform", "token", "enabled"], "registration");
	return {
		provider: expectLiteral(body.provider, "fcm", "provider"),
		platform: expectLiteral(body.platform, "ios", "platform"),
		token: expectString(body.token, "token", 16, 4096),
		enabled: expectBoolean(body.enabled, "enabled"),
	};
}

function parsePushTargetRevocation(body) {
	expectAllowedKeys(body, ["pushTargetId", "pushTargetAuthToken"], "revocation");
	return {
		pushTargetId: expectString(body.pushTargetId, "pushTargetId", 16, 96),
		pushTargetAuthToken: expectString(body.pushTargetAuthToken, "pushTargetAuthToken", 32, 128),
	};
}

function parseNotification(body) {
	expectAllowedKeys(
		body,
		[
			"pushTargetId",
			"pushTargetAuthToken",
			"eventId",
			"kind",
			"title",
			"body",
			"workspaceName",
			"planId",
			"workflowId",
			"data",
		],
		"notification",
	);
	const eventId = expectNotificationMetadata(body.eventId, "eventId", MAX_NOTIFICATION_EVENT_ID_UTF8_BYTES);
	const kind = expectNotificationMetadata(body.kind, "kind", MAX_NOTIFICATION_KIND_UTF8_BYTES);
	if (!NOTIFICATION_KINDS.has(kind)) {
		throw new RequestError(400, "kind_is_unsupported");
	}
	const workspaceName = expectOptionalNotificationText(
		body.workspaceName,
		"workspaceName",
		MAX_NOTIFICATION_WORKSPACE_UTF8_BYTES,
	);
	const planId = expectOptionalNotificationMetadata(body.planId, "planId", MAX_NOTIFICATION_METADATA_UTF8_BYTES);
	const workflowId = expectOptionalNotificationMetadata(
		body.workflowId,
		"workflowId",
		MAX_NOTIFICATION_METADATA_UTF8_BYTES,
	);
	if (
		(kind === "plan_ready" && (planId === undefined || workflowId !== undefined)) ||
		(kind === "review_completed" && (workflowId === undefined || planId !== undefined)) ||
		(kind !== "plan_ready" && kind !== "review_completed" && (planId !== undefined || workflowId !== undefined))
	) {
		throw new RequestError(400, "notification_navigation_metadata_mismatch");
	}
	const data = expectStringRecord(body.data, "data", { maxEntries: 8, maxKeyLength: 64, maxValueLength: 512 });
	expectAllowedKeys(data, ["eventId", "kind", "sessionId", "workspaceName", "planId", "workflowId"], "data");
	const sessionId = expectOptionalNotificationMetadata(
		data.sessionId,
		"sessionId",
		MAX_NOTIFICATION_METADATA_UTF8_BYTES,
	);
	const dataWorkspaceName = expectOptionalNotificationText(
		data.workspaceName,
		"data_workspaceName",
		MAX_NOTIFICATION_WORKSPACE_UTF8_BYTES,
	);
	const dataPlanId = expectOptionalNotificationMetadata(
		data.planId,
		"data_planId",
		MAX_NOTIFICATION_METADATA_UTF8_BYTES,
	);
	const dataWorkflowId = expectOptionalNotificationMetadata(
		data.workflowId,
		"data_workflowId",
		MAX_NOTIFICATION_METADATA_UTF8_BYTES,
	);
	if (
		data.eventId !== eventId ||
		data.kind !== kind ||
		dataWorkspaceName !== workspaceName ||
		dataPlanId !== planId ||
		dataWorkflowId !== workflowId
	) {
		throw new RequestError(400, "notification_data_mismatch");
	}
	return {
		body: expectNotificationText(body.body, "body", MAX_NOTIFICATION_BODY_UTF8_BYTES),
		data: {
			eventId,
			kind,
			...(sessionId === undefined ? {} : { sessionId }),
			...(workspaceName === undefined ? {} : { workspaceName }),
			...(planId === undefined ? {} : { planId }),
			...(workflowId === undefined ? {} : { workflowId }),
		},
		eventId,
		kind,
		pushTargetAuthToken: expectString(body.pushTargetAuthToken, "pushTargetAuthToken", 32, 128),
		pushTargetId: expectString(body.pushTargetId, "pushTargetId", 16, 96),
		title: expectNotificationText(body.title, "title", MAX_NOTIFICATION_TITLE_UTF8_BYTES),
		...(workspaceName === undefined ? {} : { workspaceName }),
		...(planId === undefined ? {} : { planId }),
		...(workflowId === undefined ? {} : { workflowId }),
	};
}

function assertVerifiedAppCheck(verification, allowedAppIds) {
	if (!isRecord(verification) || typeof verification.appId !== "string") {
		throw new RequestError(401, "app_check_invalid");
	}
	if (verification.alreadyConsumed !== false) {
		throw new RequestError(401, "app_check_token_replayed");
	}
	if (!allowedAppIds.has(verification.appId)) {
		throw new RequestError(403, "app_check_app_not_allowed");
	}
	const token = verification.token;
	if (!isRecord(token) || typeof token.jti !== "string" || token.jti.length < 8 || token.jti.length > 256) {
		throw new RequestError(401, "app_check_limited_use_token_required");
	}
	return verification.appId;
}

function getRequiredServiceAccount(environmentVariable, env = process.env) {
	const value = env[environmentVariable]?.trim();
	if (
		value === undefined ||
		!SERVICE_ACCOUNT_EMAIL_PATTERN.test(value)
	) {
		throw new Error(`${environmentVariable} must be a dedicated service account email`);
	}
	return value;
}

function getRuntimeServiceAccounts(env = process.env) {
	const irohEnrollmentServiceAccount = getRequiredServiceAccount("IROH_ENROLLMENT_SERVICE_ACCOUNT", env);
	const irohRelayAccessServiceAccount = getRequiredServiceAccount("IROH_RELAY_ACCESS_SERVICE_ACCOUNT", env);
	const pushRelayServiceAccount = getRequiredServiceAccount("PUSH_RELAY_SERVICE_ACCOUNT", env);
	const serviceAccounts = [
		irohEnrollmentServiceAccount,
		irohRelayAccessServiceAccount,
		pushRelayServiceAccount,
	];
	if (new Set(serviceAccounts).size !== serviceAccounts.length) {
		throw new Error("push relay, Iroh enrollment, and relay access require distinct runtime service accounts");
	}
	return {
		irohEnrollmentServiceAccount,
		irohRelayAccessServiceAccount,
		pushRelayServiceAccount,
	};
}

function getAllowedFirebaseAppIds(env = process.env) {
	const configured = env.ALLOWED_FIREBASE_APP_IDS;
	const values = (configured === undefined ? DEFAULT_ALLOWED_FIREBASE_APP_ID : configured)
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (values.length === 0 || values.length > 8 || values.some((value) => value.length > 128)) {
		throw new Error("ALLOWED_FIREBASE_APP_IDS must contain 1-8 comma-separated Firebase app IDs");
	}
	return new Set(values);
}

function getConfiguredRelayUrl(env = process.env) {
	const configured = env.PUSH_RELAY_URL?.trim() || DEFAULT_PUBLIC_RELAY_URL;
	let url;
	try {
		url = new URL(configured);
	} catch {
		throw new Error("PUSH_RELAY_URL must be a valid absolute HTTPS URL");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("PUSH_RELAY_URL must be an HTTPS URL without credentials, query, or fragment");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function getPushTargetTtlMs(env = process.env) {
	return getBoundedPositiveInteger(env.PUSH_TARGET_TTL_DAYS, 1, 90, DEFAULT_PUSH_TARGET_TTL_MS / 86_400_000) * 86_400_000;
}

function getPushTargetId(token) {
	return `fcm_${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

function hashToken(token) {
	return `sha256:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

function timingSafeTokenHashMatches(token, expectedHash) {
	if (typeof expectedHash !== "string") return false;
	const actual = Buffer.from(hashToken(token), "utf8");
	const expected = Buffer.from(expectedHash, "utf8");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function revokePushTargetTransaction(firestore, pushTargetRef, authToken) {
	return firestore.runTransaction(async (transaction) => {
		const snapshot = await transaction.get(pushTargetRef);
		if (!snapshot.exists) return "already_revoked";
		const pushTarget = snapshot.data();
		if (!isRecord(pushTarget) || !timingSafeTokenHashMatches(authToken, pushTarget.pushTargetAuthTokenHash)) {
			throw new RequestError(401, "unauthorized");
		}
		transaction.delete(pushTargetRef);
		return "revoked";
	});
}

function getTimestampMillis(value) {
	if (isRecord(value) && typeof value.toMillis === "function") {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : undefined;
	}
	if (isRecord(value) && Number.isFinite(value.seconds)) {
		return Number(value.seconds) * 1000;
	}
	if (value instanceof Date) return value.getTime();
	return undefined;
}

function isPushTargetExpired(pushTarget, nowMs = Date.now()) {
	const expiresAtMs = isRecord(pushTarget) ? getTimestampMillis(pushTarget.expiresAt) : undefined;
	return expiresAtMs === undefined || expiresAtMs <= nowMs;
}

function getBoundedPositiveInteger(value, minimum, maximum, fallback) {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`configuration value must be an integer from ${minimum} through ${maximum}`);
	}
	return parsed;
}

function expectAllowedKeys(value, allowedKeys, label) {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		assertSafeObjectKey(key, label);
		if (!allowed.has(key)) {
			throw new RequestError(400, `${label}_has_unknown_field`);
		}
	}
}

function assertSafeObjectKey(key, label) {
	if (key.length === 0 || key.length > 64 || FORBIDDEN_OBJECT_KEYS.has(key)) {
		throw new RequestError(400, `${label}_has_invalid_key`);
	}
}

function expectLiteral(value, expected, label) {
	if (value !== expected) {
		throw new RequestError(400, `${label}_must_be_${expected}`);
	}
	return expected;
}

function expectString(value, label, minimumLength, maximumLength) {
	if (typeof value !== "string" || value.length < minimumLength || value.length > maximumLength) {
		throw new RequestError(400, `${label}_has_invalid_length`);
	}
	if (/^[\s]*$/.test(value)) {
		throw new RequestError(400, `${label}_must_not_be_blank`);
	}
	return value;
}

function expectOptionalString(value, label, minimumLength, maximumLength) {
	if (value === undefined) return undefined;
	return expectString(value, label, minimumLength, maximumLength);
}

function expectNotificationText(value, label, maximumByteLength) {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		/\s{2,}/u.test(value) ||
		NOTIFICATION_UNSAFE_CHARACTER.test(value) ||
		NOTIFICATION_PATH_SEPARATOR.test(value) ||
		Buffer.byteLength(value, "utf8") > maximumByteLength ||
		value.length === 0
	) {
		throw new RequestError(400, `${label}_has_invalid_notification_text`);
	}
	return value;
}

function expectOptionalNotificationText(value, label, maximumByteLength) {
	if (value === undefined) return undefined;
	return expectNotificationText(value, label, maximumByteLength);
}

function expectNotificationMetadata(value, label, maximumByteLength) {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		/\s/u.test(value) ||
		NOTIFICATION_UNSAFE_CHARACTER.test(value) ||
		NOTIFICATION_PATH_SEPARATOR.test(value) ||
		Buffer.byteLength(value, "utf8") > maximumByteLength ||
		value.length === 0
	) {
		throw new RequestError(400, `${label}_has_invalid_notification_metadata`);
	}
	return value;
}

function expectOptionalNotificationMetadata(value, label, maximumByteLength) {
	if (value === undefined) return undefined;
	return expectNotificationMetadata(value, label, maximumByteLength);
}

function expectBoolean(value, label) {
	if (typeof value !== "boolean") {
		throw new RequestError(400, `${label}_must_be_boolean`);
	}
	return value;
}

function expectStringRecord(value, label, options) {
	if (!isRecord(value)) {
		throw new RequestError(400, `${label}_must_be_object`);
	}
	const entries = Object.entries(value);
	if (entries.length > options.maxEntries) {
		throw new RequestError(400, `${label}_has_too_many_entries`);
	}
	const parsed = Object.create(null);
	let encodedLength = 0;
	for (const [key, entry] of entries) {
		assertSafeObjectKey(key, label);
		if (key.length > options.maxKeyLength || typeof entry !== "string" || entry.length > options.maxValueLength) {
			throw new RequestError(400, `${label}_has_invalid_entry`);
		}
		encodedLength += key.length + entry.length;
		if (encodedLength > 4096) {
			throw new RequestError(400, `${label}_too_large`);
		}
		parsed[key] = entry;
	}
	return parsed;
}

function getHeader(request, name) {
	const direct = request.get?.(name);
	if (typeof direct === "string" && direct.length > 0) return direct;
	const value = request.headers?.[name.toLowerCase()];
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
	return undefined;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
	DEFAULT_ALLOWED_FIREBASE_APP_ID,
	DEFAULT_PUBLIC_RELAY_URL,
	DEFAULT_PUSH_TARGET_TTL_MS,
	MAX_NOTIFICATION_BODY_UTF8_BYTES,
	MAX_NOTIFICATION_EVENT_ID_UTF8_BYTES,
	MAX_NOTIFICATION_METADATA_UTF8_BYTES,
	MAX_NOTIFICATION_TITLE_UTF8_BYTES,
	MAX_NOTIFICATION_WORKSPACE_UTF8_BYTES,
	MAX_REQUEST_BYTES,
	RequestError,
	SERVICE_ACCOUNT_EMAIL_PATTERN,
	assertEmptyRequestEnvelope,
	assertRequestEnvelope,
	assertVerifiedAppCheck,
	getAllowedFirebaseAppIds,
	getBoundedPositiveInteger,
	getConfiguredRelayUrl,
	getHeader,
	getPushTargetId,
	getRequiredServiceAccount,
	getRuntimeServiceAccounts,
	getPushTargetTtlMs,
	hashToken,
	isPushTargetExpired,
	parseNotification,
	parsePushTargetRegistration,
	parsePushTargetRevocation,
	readJsonBody,
	revokePushTargetTransaction,
	timingSafeTokenHashMatches,
};
