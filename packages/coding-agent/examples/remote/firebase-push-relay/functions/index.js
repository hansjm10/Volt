const { createHash, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { initializeApp, getApps } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { onRequest } = require("firebase-functions/v2/https");

const DEFAULT_COLLECTION = "voltPushTargets";
const DEFAULT_PUBLIC_RELAY_URL = "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay";
const DEFAULT_REGION = "us-central1";
const INVALID_TARGET_ERROR_CODES = new Set([
	"messaging/invalid-registration-token",
	"messaging/mismatched-credential",
	"messaging/registration-token-not-registered",
]);

if (getApps().length === 0) {
	initializeApp();
}

exports.pushRelay = onRequest(
	{
		cors: false,
		invoker: "public",
		maxInstances: 10,
		region: process.env.FUNCTION_REGION || DEFAULT_REGION,
		timeoutSeconds: 30,
	},
	async (request, response) => {
		response.set("cache-control", "no-store");
		if (request.method !== "POST") {
			response.status(405).json({ error: "method_not_allowed" });
			return;
		}

		const routePath = normalizeRoutePath(request.path || request.originalUrl || request.url || "/");
		try {
			if (routePath === "/v1/push-targets") {
				await registerPushTarget(request, response);
				return;
			}
			if (routePath === "/v1/notifications") {
				await sendNotification(request, response);
				return;
			}
			response.status(404).json({ error: "not_found" });
		} catch (error) {
			if (error instanceof RequestError) {
				response.status(error.status).json({ error: error.publicMessage });
				return;
			}
			response.status(500).json({ error: "internal_error" });
		}
	},
);

class RequestError extends Error {
	constructor(status, publicMessage) {
		super(publicMessage);
		this.name = "RequestError";
		this.publicMessage = publicMessage;
		this.status = status;
	}
}

async function registerPushTarget(request, response) {
	const body = readJsonBody(request);
	const registration = parsePushTargetRegistration(body);
	const pushTargetId = randomUUID();
	const pushTargetAuthToken = randomBytes(32).toString("base64url");
	const tokenHash = hashToken(registration.token);
	const now = FieldValue.serverTimestamp();
	await getPushTargetsCollection().doc(pushTargetId).set({
		createdAt: now,
		enabled: registration.enabled,
		platform: registration.platform,
		provider: registration.provider,
		token: registration.token,
		tokenHash,
		pushTargetAuthTokenHash: hashToken(pushTargetAuthToken),
		updatedAt: now,
	});
	response.status(201).json({
		pushTargetId,
		pushTargetAuthToken,
		relayUrl: getPublicRelayUrl(request),
		tokenHash,
	});
}

async function sendNotification(request, response) {
	const body = readJsonBody(request);
	const notification = parseNotification(body);
	const pushTargetRef = getPushTargetsCollection().doc(notification.pushTargetId);
	const pushTargetSnapshot = await pushTargetRef.get();
	if (!pushTargetSnapshot.exists) {
		response.status(404).json({ error: "push_target_not_found" });
		return;
	}

	const pushTarget = pushTargetSnapshot.data();
	if (!isRecord(pushTarget) || pushTarget.enabled !== true || typeof pushTarget.token !== "string") {
		response.status(410).json({ error: "push_target_invalid" });
		return;
	}
	if (
		typeof pushTarget.pushTargetAuthTokenHash !== "string" ||
		!timingSafeStringEqual(hashToken(notification.pushTargetAuthToken), pushTarget.pushTargetAuthTokenHash)
	) {
		response.status(401).json({ error: "unauthorized" });
		return;
	}

	try {
		const messageId = await getMessaging().send({
			data: notification.data,
			notification: {
				body: notification.body,
				title: notification.title,
			},
			token: pushTarget.token,
		});
		await pushTargetRef.update({
			lastEventId: notification.eventId,
			lastKind: notification.kind,
			lastMessageId: messageId,
			lastSentAt: FieldValue.serverTimestamp(),
			updatedAt: FieldValue.serverTimestamp(),
		});
		response.status(200).json({ status: "sent", messageId });
	} catch (error) {
		if (isInvalidTargetError(error)) {
			await pushTargetRef.update({
				disabledAt: FieldValue.serverTimestamp(),
				disabledReason: getErrorCode(error) || "messaging/invalid-target",
				enabled: false,
				updatedAt: FieldValue.serverTimestamp(),
			});
			response.status(410).json({ error: "push_target_invalid" });
			return;
		}
		throw error;
	}
}

function timingSafeStringEqual(left, right) {
	const leftBuffer = Buffer.from(left, "utf8");
	const rightBuffer = Buffer.from(right, "utf8");
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getPushTargetsCollection() {
	return getFirestore().collection(process.env.PUSH_TARGETS_COLLECTION || DEFAULT_COLLECTION);
}

function readJsonBody(request) {
	const body = request.body;
	if (Buffer.isBuffer(body)) {
		return parseJson(body.toString("utf8"));
	}
	if (typeof body === "string") {
		return parseJson(body);
	}
	if (isRecord(body)) {
		return body;
	}
	throw new RequestError(400, "request_body_must_be_json");
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

function parsePushTargetRegistration(body) {
	const provider = expectLiteral(body.provider, "fcm", "provider");
	const platform = expectLiteral(body.platform, "ios", "platform");
	const token = expectString(body.token, "token");
	const enabled = expectBoolean(body.enabled, "enabled");
	return { enabled, platform, provider, token };
}

function parseNotification(body) {
	const data = expectStringRecord(body.data, "data");
	const eventId = expectString(body.eventId, "eventId");
	const kind = expectString(body.kind, "kind");
	return {
		body: expectString(body.body, "body"),
		data: {
			...data,
			eventId,
			kind,
		},
		eventId,
		kind,
		pushTargetAuthToken: expectString(body.pushTargetAuthToken, "pushTargetAuthToken"),
		pushTargetId: expectString(body.pushTargetId, "pushTargetId"),
		title: expectString(body.title, "title"),
	};
}

function getPublicRelayUrl(request) {
	if (typeof process.env.PUSH_RELAY_URL === "string" && process.env.PUSH_RELAY_URL.length > 0) {
		return process.env.PUSH_RELAY_URL;
	}
	const host = request.headers.host;
	if (typeof host !== "string" || host.length === 0) {
		return DEFAULT_PUBLIC_RELAY_URL;
	}
	const protocol = request.headers["x-forwarded-proto"];
	const scheme = typeof protocol === "string" && protocol.length > 0 ? protocol.split(",")[0].trim() : "https";
	const baseUrl = new URL(request.originalUrl || request.url || "/", `${scheme}://${host}`);
	const versionPathIndex = baseUrl.pathname.indexOf("/v1/");
	if (versionPathIndex === 0 && host.endsWith(".cloudfunctions.net")) {
		return `${scheme}://${host}/pushRelay`;
	}
	if (versionPathIndex === -1) {
		return `${scheme}://${host}${baseUrl.pathname.replace(/\/+$/, "")}`;
	}
	return `${scheme}://${host}${baseUrl.pathname.slice(0, versionPathIndex).replace(/\/+$/, "")}`;
}

function expectLiteral(value, expected, label) {
	if (value !== expected) {
		throw new RequestError(400, `${label}_must_be_${expected}`);
	}
	return expected;
}

function expectString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new RequestError(400, `${label}_must_be_non_empty_string`);
	}
	return value;
}

function expectBoolean(value, label) {
	if (typeof value !== "boolean") {
		throw new RequestError(400, `${label}_must_be_boolean`);
	}
	return value;
}

function expectStringRecord(value, label) {
	if (!isRecord(value)) {
		throw new RequestError(400, `${label}_must_be_object`);
	}
	const parsed = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new RequestError(400, `${label}_values_must_be_strings`);
		}
		parsed[key] = entry;
	}
	return parsed;
}

function normalizeRoutePath(rawPath) {
	let routePath = rawPath.split("?")[0] || "/";
	if (routePath.startsWith("/pushRelay/")) {
		routePath = routePath.slice("/pushRelay".length);
	}
	return routePath.replace(/\/+$/, "") || "/";
}

function hashToken(token) {
	return `sha256:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

function isInvalidTargetError(error) {
	const code = getErrorCode(error);
	return Boolean(code && INVALID_TARGET_ERROR_CODES.has(code));
}

function getErrorCode(error) {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
