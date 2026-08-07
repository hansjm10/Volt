const { RequestError } = require("./core.js");
const {
	CLAIM_TTL_MS,
	GRANT_TTL_MS,
	MAX_ACTIVE_GRANTS_PER_ENDPOINT,
	MAX_NEW_HOST_GRANTS_PER_CLIENT_PER_DAY,
	MAX_PENDING_CLAIMS_PER_HOST,
	MAX_RENEWALS_PER_GRANT_PER_HOUR,
	REQUEST_QUOTA_WINDOW_MS,
	assertFreshSignature,
	getGrantId,
	getRelayEndpointId,
	getRequestIp,
	getSaltedIpId,
	getTimestampMillis,
	hashDecodedSecret,
	isRecord,
	parseApproveClaimRequest,
	parseClaimSecretRequest,
	parseCreateClaimRequest,
	parseGrantRequest,
	parseRelayAuthorization,
	timingSafeBase64urlEqual,
} = require("./enrollment-core.js");

const CLAIMS_COLLECTION = "voltIrohEnrollmentClaims";
const GRANTS_COLLECTION = "voltIrohEnrollmentGrants";
const ENDPOINT_ACCESS_COLLECTION = "voltIrohEndpointAccess";
const QUOTA_WINDOWS_COLLECTION = "voltIrohEnrollmentQuotaWindows";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CLAIM_STATUSES = new Set(["pending", "approved", "cancelled", "expired"]);
const GRANT_STATUSES = new Set(["active", "revoked"]);
const KNOWN_ROUTE_PATHS = new Set([
	"/v1/claims",
	"/v1/claims/approve",
	"/v1/claims/cancel",
	"/v1/claims/status",
	"/v1/grants/renew",
	"/v1/grants/revoke",
	"/v1/relay-access",
]);

function createIrohEnrollmentHandler(options) {
	const {
		config,
		getFirestore,
		getIpSalt,
		getRelayAccessSecrets,
		logError,
		logEvent,
		now,
		timestampFromMillis,
		verifyLimitedUseAppCheck,
	} = options;

	function writeEndpointAccess(transaction, reference, endpointAccess, nowMs) {
		writeEndpointAccessDocument(
			transaction,
			reference,
			endpointAccess,
			timestampFromMillis(nowMs),
		);
	}

	return async function irohEnrollmentHandler(request, response) {
		response.set("cache-control", "no-store");
		response.set("x-content-type-options", "nosniff");
		const routePath = normalizeRoutePath(request.path || request.originalUrl || request.url || "/");
		const loggedRoute = KNOWN_ROUTE_PATHS.has(routePath) ? routePath : "unknown";
		const isRelayRoute = routePath === "/v1/relay-access";
		const startedAtMs = now();
		let outcome = "allowed";
		try {
			if (request.method !== "POST") {
				response.set("allow", "POST");
				throw new RequestError(405, "method_not_allowed");
			}
			if (isRelayRoute) {
				outcome = (await handleRelayAccess(request, response)) ? "allowed" : "denied";
				return;
			}
			await routeJsonRequest(routePath, request, response);
		} catch (error) {
			outcome = error instanceof RequestError ? error.publicMessage : "internal_error";
			if (response.headersSent) return;
			if (isRelayRoute) {
				if (!(error instanceof RequestError)) {
					logError({ name: getSafeErrorName(error), route: loggedRoute });
				}
				response.status(error instanceof RequestError ? error.status : 500).type("text/plain").send("false");
				return;
			}
			if (error instanceof RequestError) {
				response.status(error.status).json({ error: error.publicMessage });
				return;
			}
			logError({ name: getSafeErrorName(error), route: loggedRoute });
			response.status(500).json({ error: "internal_error" });
		} finally {
			logEvent({
				durationMs: Math.max(0, now() - startedAtMs),
				outcome,
				route: loggedRoute,
			});
		}
	};

	async function routeJsonRequest(routePath, request, response) {
		if (routePath === "/v1/claims") {
			await createClaim(request, response);
			return;
		}
		if (routePath === "/v1/claims/status") {
			await getClaimStatus(request, response);
			return;
		}
		if (routePath === "/v1/claims/cancel") {
			await cancelClaim(request, response);
			return;
		}
		if (routePath === "/v1/claims/approve") {
			await approveClaim(request, response);
			return;
		}
		if (routePath === "/v1/grants/renew") {
			await renewGrant(request, response);
			return;
		}
		if (routePath === "/v1/grants/revoke") {
			await revokeGrant(request, response);
			return;
		}
		throw new RequestError(404, "not_found");
	}

	async function createClaim(request, response) {
		const enrollmentRequest = parseCreateClaimRequest(request);
		const nowMs = now();
		assertFreshSignature(enrollmentRequest, "create_claim", nowMs);
		await reserveRequestQuota(request, enrollmentRequest.hostEndpointId, nowMs);
		const firestore = getFirestore();
		const claimRef = firestore.collection(CLAIMS_COLLECTION).doc(enrollmentRequest.claimId);
		const hostAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.hostEndpointId);
		const result = await firestore.runTransaction(async (transaction) => {
			const claimSnapshot = await transaction.get(claimRef);
			const hostAccessSnapshot = await transaction.get(hostAccessRef);
			const hostAccess = readEndpointAccess(hostAccessSnapshot, nowMs);
			if (claimSnapshot.exists) {
				const claim = readClaim(claimSnapshot);
				if (
					claim.hostEndpointId !== enrollmentRequest.hostEndpointId ||
					!timingSafeBase64urlEqual(claim.claimSecretHash, enrollmentRequest.claimSecretHash)
				) {
					throw new RequestError(409, "claim_conflict");
				}
				if (claim.status !== "pending") {
					throw new RequestError(claim.status === "expired" ? 410 : 409, `claim_${claim.status}`);
				}
				const expiresAtMs = requireTimestampMillis(claim.expiresAt);
				if (expiresAtMs <= nowMs) {
					delete hostAccess.pendingClaims[enrollmentRequest.claimId];
					transaction.update(claimRef, {
						status: "expired",
						updatedAt: timestampFromMillis(nowMs),
					});
					writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
					return { error: new RequestError(410, "claim_expired") };
				}
				hostAccess.pendingClaims[enrollmentRequest.claimId] = claim.expiresAt;
				writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
				return { created: false, expiresAtMs };
			}

			if (Object.keys(hostAccess.pendingClaims).length >= MAX_PENDING_CLAIMS_PER_HOST) {
				throw new RequestError(429, "pending_claim_limit_reached");
			}
			const expiresAtMs = nowMs + CLAIM_TTL_MS;
			const nowTimestamp = timestampFromMillis(nowMs);
			const expiresAt = timestampFromMillis(expiresAtMs);
			transaction.create(claimRef, {
				claimId: enrollmentRequest.claimId,
				claimSecretHash: enrollmentRequest.claimSecretHash,
				createdAt: nowTimestamp,
				expiresAt,
				hostEndpointId: enrollmentRequest.hostEndpointId,
				status: "pending",
				updatedAt: nowTimestamp,
				version: 1,
			});
			hostAccess.pendingClaims[enrollmentRequest.claimId] = expiresAt;
			writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
			return { created: true, expiresAtMs };
		});
		if (result.error !== undefined) throw result.error;
		response.status(result.created ? 201 : 200).json({
			status: "pending",
			expiresAtEpochSeconds: Math.floor(result.expiresAtMs / 1000),
			relayOrigins: config.relayOrigins,
		});
	}

	async function getClaimStatus(request, response) {
		const enrollmentRequest = parseClaimSecretRequest(request, "claim_status");
		const nowMs = now();
		assertFreshSignature(enrollmentRequest, "claim_status", nowMs);
		await reserveRequestQuota(request, enrollmentRequest.hostEndpointId, nowMs);
		const firestore = getFirestore();
		const claimRef = firestore.collection(CLAIMS_COLLECTION).doc(enrollmentRequest.claimId);
		const hostAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.hostEndpointId);
		const result = await firestore.runTransaction(async (transaction) => {
			const claimSnapshot = await transaction.get(claimRef);
			const hostAccessSnapshot = await transaction.get(hostAccessRef);
			if (!claimSnapshot.exists) throw new RequestError(404, "claim_not_found");
			const claim = readClaim(claimSnapshot);
			assertClaimCredential(claim, enrollmentRequest);
			const hostAccess = readEndpointAccess(hostAccessSnapshot, nowMs);
			const expiresAtMs = requireTimestampMillis(claim.expiresAt);
			if (claim.status === "pending" && expiresAtMs <= nowMs) {
				delete hostAccess.pendingClaims[enrollmentRequest.claimId];
				transaction.update(claimRef, {
					status: "expired",
					updatedAt: timestampFromMillis(nowMs),
				});
				writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
				return { status: "expired" };
			}
			if (claim.status === "pending" || claim.status === "cancelled" || claim.status === "expired") {
				return { status: claim.status };
			}
			if (claim.status !== "approved" || !isEndpointId(claim.clientEndpointId)) {
				throw new Error("claim document has an invalid approval state");
			}
			const grantExpiresAtMs = requireTimestampMillis(claim.grantExpiresAt);
			return {
				clientEndpointId: claim.clientEndpointId,
				grantExpiresAtEpochSeconds: Math.floor(grantExpiresAtMs / 1000),
				status: "approved",
			};
		});
		response.status(200).json(result);
	}

	async function cancelClaim(request, response) {
		const enrollmentRequest = parseClaimSecretRequest(request, "cancel_claim");
		const nowMs = now();
		assertFreshSignature(enrollmentRequest, "cancel_claim", nowMs);
		await reserveRequestQuota(request, enrollmentRequest.hostEndpointId, nowMs);
		const firestore = getFirestore();
		const claimRef = firestore.collection(CLAIMS_COLLECTION).doc(enrollmentRequest.claimId);
		const hostAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.hostEndpointId);
		const result = await firestore.runTransaction(async (transaction) => {
			const claimSnapshot = await transaction.get(claimRef);
			const hostAccessSnapshot = await transaction.get(hostAccessRef);
			const hostAccess = readEndpointAccess(hostAccessSnapshot, nowMs);
			delete hostAccess.pendingClaims[enrollmentRequest.claimId];
			if (!claimSnapshot.exists) {
				// Firestore TTL may delete an expired claim before a daemon recovers
				// its durable cancellation obligation. The host signature still
				// authenticates this idempotent pending-marker cleanup.
				writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
				return { status: "expired" };
			}
			const claim = readClaim(claimSnapshot);
			assertClaimCredential(claim, enrollmentRequest);
			if (claim.status === "approved") {
				throw new RequestError(409, "claim_approved");
			}
			if (claim.status === "cancelled" || claim.status === "expired") {
				writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
				return { status: claim.status };
			}
			if (claim.status !== "pending") throw new Error("claim document has an invalid status");
			const status = requireTimestampMillis(claim.expiresAt) <= nowMs ? "expired" : "cancelled";
			transaction.update(claimRef, {
				status,
				updatedAt: timestampFromMillis(nowMs),
			});
			writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
			return { status };
		});
		response.status(200).json(result);
	}

	async function approveClaim(request, response) {
		const enrollmentRequest = parseApproveClaimRequest(request);
		const nowMs = now();
		assertFreshSignature(enrollmentRequest, "approve_claim", nowMs);
		await verifyLimitedUseAppCheck(request);
		await reserveRequestQuota(request, enrollmentRequest.clientEndpointId, nowMs);
		const firestore = getFirestore();
		const grantId = getGrantId(enrollmentRequest.hostEndpointId, enrollmentRequest.clientEndpointId);
		const claimRef = firestore.collection(CLAIMS_COLLECTION).doc(enrollmentRequest.claimId);
		const grantRef = firestore.collection(GRANTS_COLLECTION).doc(grantId);
		const hostAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.hostEndpointId);
		const clientAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.clientEndpointId);
		const dayNumber = Math.floor(nowMs / DAY_MS);
		const newGrantQuotaRef = firestore
			.collection(QUOTA_WINDOWS_COLLECTION)
			.doc(`new-host-grants_${enrollmentRequest.clientEndpointId}_${dayNumber}`);
		const claimSecretHash = hashDecodedSecret(enrollmentRequest.claimSecret);
		const grantSecretHash = hashDecodedSecret(enrollmentRequest.grantSecret);
		const result = await firestore.runTransaction(async (transaction) => {
			const claimSnapshot = await transaction.get(claimRef);
			const grantSnapshot = await transaction.get(grantRef);
			const hostAccessSnapshot = await transaction.get(hostAccessRef);
			const clientAccessSnapshot = await transaction.get(clientAccessRef);
			const newGrantQuotaSnapshot = await transaction.get(newGrantQuotaRef);
			if (!claimSnapshot.exists) throw new RequestError(404, "claim_not_found");
			const claim = readClaim(claimSnapshot);
			if (
				claim.hostEndpointId !== enrollmentRequest.hostEndpointId ||
				!timingSafeBase64urlEqual(claim.claimSecretHash, claimSecretHash)
			) {
				throw new RequestError(401, "claim_unauthorized");
			}
			const hostAccess = readEndpointAccess(hostAccessSnapshot, nowMs);
			const clientAccess = readEndpointAccess(clientAccessSnapshot, nowMs);
			if (hostAccess.blocked || clientAccess.blocked) {
				throw new RequestError(403, "endpoint_blocked");
			}

			if (claim.status === "approved") {
				if (
					claim.clientEndpointId !== enrollmentRequest.clientEndpointId ||
					claim.grantId !== grantId
				) {
					throw new RequestError(409, "claim_approval_conflict");
				}
				const grant = readGrant(grantSnapshot);
				if (
					grant.hostEndpointId !== enrollmentRequest.hostEndpointId ||
					grant.clientEndpointId !== enrollmentRequest.clientEndpointId ||
					grant.status !== "active" ||
					!timingSafeBase64urlEqual(grant.grantSecretHash, grantSecretHash)
				) {
					throw new RequestError(409, "claim_approval_conflict");
				}
				return { expiresAtMs: requireTimestampMillis(grant.expiresAt) };
			}
			if (claim.status !== "pending") {
				throw new RequestError(claim.status === "expired" ? 410 : 409, `claim_${claim.status}`);
			}
			if (requireTimestampMillis(claim.expiresAt) <= nowMs) {
				delete hostAccess.pendingClaims[enrollmentRequest.claimId];
				transaction.update(claimRef, {
					status: "expired",
					updatedAt: timestampFromMillis(nowMs),
				});
				writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
				return { error: new RequestError(410, "claim_expired") };
			}

			let existingGrant;
			let reusesActiveGrant = false;
			if (grantSnapshot.exists) {
				existingGrant = readGrant(grantSnapshot);
				const existingExpiryMs = requireTimestampMillis(existingGrant.expiresAt);
				reusesActiveGrant = existingGrant.status === "active" && existingExpiryMs > nowMs;
				if (
					reusesActiveGrant &&
					!timingSafeBase64urlEqual(existingGrant.grantSecretHash, grantSecretHash)
				) {
					throw new RequestError(409, "grant_already_active");
				}
			}
			delete hostAccess.activeGrants[grantId];
			delete clientAccess.activeGrants[grantId];
			if (
				Object.keys(hostAccess.activeGrants).length >= MAX_ACTIVE_GRANTS_PER_ENDPOINT ||
				Object.keys(clientAccess.activeGrants).length >= MAX_ACTIVE_GRANTS_PER_ENDPOINT
			) {
				throw new RequestError(429, "active_grant_limit_reached");
			}
			const newGrantCount = readFixedWindowCount(newGrantQuotaSnapshot, dayNumber * DAY_MS, DAY_MS);
			if (!reusesActiveGrant && newGrantCount >= MAX_NEW_HOST_GRANTS_PER_CLIENT_PER_DAY) {
				throw new RequestError(429, "new_host_grant_limit_reached");
			}

			const expiresAtMs = reusesActiveGrant
				? requireTimestampMillis(existingGrant.expiresAt)
				: nowMs + GRANT_TTL_MS;
			const nowTimestamp = timestampFromMillis(nowMs);
			const expiresAt = timestampFromMillis(expiresAtMs);
			transaction.set(grantRef, {
				clientEndpointId: enrollmentRequest.clientEndpointId,
				createdAt: reusesActiveGrant
					? timestampFromMillis(requireTimestampMillis(existingGrant.createdAt))
					: nowTimestamp,
				expiresAt,
				grantId,
				grantSecretHash,
				hostEndpointId: enrollmentRequest.hostEndpointId,
				status: "active",
				updatedAt: nowTimestamp,
				version: 1,
			});
			transaction.update(claimRef, {
				approvedAt: nowTimestamp,
				clientEndpointId: enrollmentRequest.clientEndpointId,
				grantExpiresAt: expiresAt,
				grantId,
				status: "approved",
				updatedAt: nowTimestamp,
			});
			delete hostAccess.pendingClaims[enrollmentRequest.claimId];
			hostAccess.activeGrants[grantId] = expiresAt;
			clientAccess.activeGrants[grantId] = expiresAt;
			writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
			writeEndpointAccess(transaction, clientAccessRef, clientAccess, nowMs);
			if (!reusesActiveGrant) {
				transaction.set(newGrantQuotaRef, {
					count: newGrantCount + 1,
					expiresAt: timestampFromMillis((dayNumber + 2) * DAY_MS),
					updatedAt: nowTimestamp,
					windowStartedAt: timestampFromMillis(dayNumber * DAY_MS),
				});
			}
			return { expiresAtMs };
		});
		if (result.error !== undefined) throw result.error;
		response.status(200).json({
			status: "approved",
			grantId,
			expiresAtEpochSeconds: Math.floor(result.expiresAtMs / 1000),
			relayOrigins: config.relayOrigins,
		});
	}

	async function renewGrant(request, response) {
		const enrollmentRequest = parseGrantRequest(request, "renew_grant");
		const nowMs = now();
		assertFreshSignature(enrollmentRequest, "renew_grant", nowMs);
		assertDeterministicGrantId(enrollmentRequest);
		await verifyLimitedUseAppCheck(request);
		await reserveRequestQuota(request, enrollmentRequest.clientEndpointId, nowMs);
		const firestore = getFirestore();
		const grantRef = firestore.collection(GRANTS_COLLECTION).doc(enrollmentRequest.grantId);
		const hostAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.hostEndpointId);
		const clientAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.clientEndpointId);
		const renewalQuotaRef = firestore
			.collection(QUOTA_WINDOWS_COLLECTION)
			.doc(`grant-renewals_${enrollmentRequest.grantId}`);
		const grantSecretHash = hashDecodedSecret(enrollmentRequest.grantSecret);
		const result = await firestore.runTransaction(async (transaction) => {
			const grantSnapshot = await transaction.get(grantRef);
			const hostAccessSnapshot = await transaction.get(hostAccessRef);
			const clientAccessSnapshot = await transaction.get(clientAccessRef);
			const renewalQuotaSnapshot = await transaction.get(renewalQuotaRef);
			const grant = readGrant(grantSnapshot);
			assertGrantCredential(grant, enrollmentRequest, grantSecretHash);
			if (grant.status !== "active") throw new RequestError(410, "grant_revoked");
			if (requireTimestampMillis(grant.expiresAt) <= nowMs) {
				throw new RequestError(410, "grant_expired");
			}
			const hostAccess = readEndpointAccess(hostAccessSnapshot, nowMs);
			const clientAccess = readEndpointAccess(clientAccessSnapshot, nowMs);
			if (hostAccess.blocked || clientAccess.blocked) {
				throw new RequestError(403, "endpoint_blocked");
			}
			const renewalWindowStartMs = getCurrentWindowStart(renewalQuotaSnapshot, nowMs, HOUR_MS);
			const renewalCount = readFixedWindowCount(renewalQuotaSnapshot, renewalWindowStartMs, HOUR_MS);
			if (renewalCount >= MAX_RENEWALS_PER_GRANT_PER_HOUR) {
				throw new RequestError(429, "grant_renewal_rate_limited");
			}
			const expiresAtMs = nowMs + GRANT_TTL_MS;
			const nowTimestamp = timestampFromMillis(nowMs);
			const expiresAt = timestampFromMillis(expiresAtMs);
			transaction.update(grantRef, {
				expiresAt,
				updatedAt: nowTimestamp,
			});
			hostAccess.activeGrants[enrollmentRequest.grantId] = expiresAt;
			clientAccess.activeGrants[enrollmentRequest.grantId] = expiresAt;
			writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
			writeEndpointAccess(transaction, clientAccessRef, clientAccess, nowMs);
			transaction.set(renewalQuotaRef, {
				count: renewalCount + 1,
				expiresAt: timestampFromMillis(renewalWindowStartMs + 2 * HOUR_MS),
				updatedAt: nowTimestamp,
				windowStartedAt: timestampFromMillis(renewalWindowStartMs),
			});
			return { expiresAtMs };
		});
		response.status(200).json({
			status: "active",
			grantId: enrollmentRequest.grantId,
			expiresAtEpochSeconds: Math.floor(result.expiresAtMs / 1000),
			relayOrigins: config.relayOrigins,
		});
	}

	async function revokeGrant(request, response) {
		const enrollmentRequest = parseGrantRequest(request, "revoke_grant");
		const nowMs = now();
		assertFreshSignature(enrollmentRequest, "revoke_grant", nowMs);
		assertDeterministicGrantId(enrollmentRequest);
		await reserveRequestQuota(request, enrollmentRequest.clientEndpointId, nowMs);
		const firestore = getFirestore();
		const grantRef = firestore.collection(GRANTS_COLLECTION).doc(enrollmentRequest.grantId);
		const hostAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.hostEndpointId);
		const clientAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(enrollmentRequest.clientEndpointId);
		const grantSecretHash = hashDecodedSecret(enrollmentRequest.grantSecret);
		await firestore.runTransaction(async (transaction) => {
			const grantSnapshot = await transaction.get(grantRef);
			const hostAccessSnapshot = await transaction.get(hostAccessRef);
			const clientAccessSnapshot = await transaction.get(clientAccessRef);
			const hostAccess = readEndpointAccess(hostAccessSnapshot, nowMs);
			const clientAccess = readEndpointAccess(clientAccessSnapshot, nowMs);
			delete hostAccess.activeGrants[enrollmentRequest.grantId];
			delete clientAccess.activeGrants[enrollmentRequest.grantId];
			writeEndpointAccess(transaction, hostAccessRef, hostAccess, nowMs);
			writeEndpointAccess(transaction, clientAccessRef, clientAccess, nowMs);
			if (!grantSnapshot.exists) return;

			const grant = readGrant(grantSnapshot);
			assertGrantCredential(grant, enrollmentRequest, grantSecretHash);
			if (grant.status === "active") {
				transaction.update(grantRef, {
					revokedAt: timestampFromMillis(nowMs),
					status: "revoked",
					updatedAt: timestampFromMillis(nowMs),
				});
			} else if (grant.status !== "revoked") {
				throw new Error("grant document has an invalid status");
			}
		});
		response.status(200).json({ status: "revoked", grantId: enrollmentRequest.grantId });
	}

	async function handleRelayAccess(request, response) {
		const [currentSecret, nextSecret] = getRelayAccessSecrets();
		parseRelayAuthorization(request, currentSecret, nextSecret);
		const endpointId = getRelayEndpointId(request);
		const nowMs = now();
		const firestore = getFirestore();
		const endpointAccessRef = firestore.collection(ENDPOINT_ACCESS_COLLECTION).doc(endpointId);
		const access = await firestore.runTransaction(async (transaction) => {
			const endpointAccessSnapshot = await transaction.get(endpointAccessRef);
			if (!endpointAccessSnapshot.exists) return { allowed: false, exists: false };
			const endpointAccess = readEndpointAccess(endpointAccessSnapshot, nowMs);
			if (endpointAccess.changed) {
				writeEndpointAccess(transaction, endpointAccessRef, endpointAccess, nowMs);
			}
			return {
				allowed: !endpointAccess.blocked && Object.keys(endpointAccess.activeGrants).length > 0,
				exists: true,
			};
		});
		if (access.exists) await reserveRelayEndpointQuota(endpointId, nowMs);
		response.status(200).type("text/plain").send(access.allowed ? "true" : "false");
		return access.allowed;
	}

	async function reserveRelayEndpointQuota(endpointId, nowMs) {
		const firestore = getFirestore();
		const quotaRef = firestore.collection(QUOTA_WINDOWS_COLLECTION).doc(`relay-endpoint_${endpointId}`);
		await firestore.runTransaction(async (transaction) => {
			const snapshot = await transaction.get(quotaRef);
			const window = readRequestWindow(snapshot, nowMs);
			if (window.count >= config.requestsPerEndpointPerWindow) {
				throw new RequestError(429, "endpoint_rate_limited");
			}
			transaction.set(quotaRef, {
				count: window.count + 1,
				expiresAt: timestampFromMillis(window.startedAtMs + 2 * REQUEST_QUOTA_WINDOW_MS),
				updatedAt: timestampFromMillis(nowMs),
				windowStartedAt: timestampFromMillis(window.startedAtMs),
			});
		});
	}

	async function reserveRequestQuota(request, endpointId, nowMs) {
		const firestore = getFirestore();
		const ipId = getSaltedIpId(getRequestIp(request), getIpSalt());
		const endpointQuotaRef = firestore.collection(QUOTA_WINDOWS_COLLECTION).doc(`request-endpoint_${endpointId}`);
		const ipQuotaRef = firestore.collection(QUOTA_WINDOWS_COLLECTION).doc(`request-ip_${ipId}`);
		await firestore.runTransaction(async (transaction) => {
			const endpointSnapshot = await transaction.get(endpointQuotaRef);
			const ipSnapshot = await transaction.get(ipQuotaRef);
			const endpointWindow = readRequestWindow(endpointSnapshot, nowMs);
			const ipWindow = readRequestWindow(ipSnapshot, nowMs);
			if (endpointWindow.count >= config.requestsPerEndpointPerWindow) {
				throw new RequestError(429, "endpoint_rate_limited");
			}
			if (ipWindow.count >= config.requestsPerIpPerWindow) {
				throw new RequestError(429, "ip_rate_limited");
			}
			const updatedAt = timestampFromMillis(nowMs);
			for (const [reference, window] of [
				[endpointQuotaRef, endpointWindow],
				[ipQuotaRef, ipWindow],
			]) {
				transaction.set(reference, {
					count: window.count + 1,
					expiresAt: timestampFromMillis(window.startedAtMs + 2 * REQUEST_QUOTA_WINDOW_MS),
					updatedAt,
					windowStartedAt: timestampFromMillis(window.startedAtMs),
				});
			}
		});
	}
}

function readClaim(snapshot) {
	if (!snapshot.exists) throw new RequestError(404, "claim_not_found");
	const claim = snapshot.data();
	if (
		!isRecord(claim) ||
		claim.version !== 1 ||
		!isEndpointId(claim.hostEndpointId) ||
		!isBase64urlBytes(claim.claimId, 16) ||
		!isBase64urlBytes(claim.claimSecretHash, 32) ||
		!CLAIM_STATUSES.has(claim.status)
	) {
		throw new Error("claim document is malformed");
	}
	return claim;
}

function readGrant(snapshot) {
	if (!snapshot.exists) throw new RequestError(404, "grant_not_found");
	const grant = snapshot.data();
	if (
		!isRecord(grant) ||
		grant.version !== 1 ||
		!isEndpointId(grant.hostEndpointId) ||
		!isEndpointId(grant.clientEndpointId) ||
		!isBase64urlBytes(grant.grantId, 32) ||
		!isBase64urlBytes(grant.grantSecretHash, 32) ||
		!GRANT_STATUSES.has(grant.status)
	) {
		throw new Error("grant document is malformed");
	}
	return grant;
}

function assertClaimCredential(claim, request) {
	if (
		claim.hostEndpointId !== request.hostEndpointId ||
		!timingSafeBase64urlEqual(claim.claimSecretHash, hashDecodedSecret(request.claimSecret))
	) {
		throw new RequestError(401, "claim_unauthorized");
	}
}

function assertGrantCredential(grant, request, grantSecretHash) {
	if (
		grant.grantId !== request.grantId ||
		grant.hostEndpointId !== request.hostEndpointId ||
		grant.clientEndpointId !== request.clientEndpointId ||
		!timingSafeBase64urlEqual(grant.grantSecretHash, grantSecretHash)
	) {
		throw new RequestError(401, "grant_unauthorized");
	}
}

function assertDeterministicGrantId(request) {
	if (getGrantId(request.hostEndpointId, request.clientEndpointId) !== request.grantId) {
		throw new RequestError(400, "grant_id_invalid");
	}
}

function readEndpointAccess(snapshot, nowMs) {
	if (!snapshot.exists) {
		return { activeGrants: {}, blocked: false, changed: false, pendingClaims: {} };
	}
	const data = snapshot.data();
	if (!isRecord(data) || (data.blocked !== undefined && typeof data.blocked !== "boolean")) {
		throw new Error("endpoint access document is malformed");
	}
	const active = cleanTimestampMap(data.activeGrants, nowMs, /^[A-Za-z0-9_-]{43}$/);
	const pending = cleanTimestampMap(data.pendingClaims, nowMs, /^[A-Za-z0-9_-]{22}$/);
	return {
		activeGrants: active.values,
		blocked: data.blocked === true,
		changed: active.changed || pending.changed,
		pendingClaims: pending.values,
	};
}

function cleanTimestampMap(value, nowMs, idPattern) {
	if (value === undefined) return { changed: false, values: {} };
	if (!isRecord(value)) throw new Error("endpoint access timestamp map is malformed");
	const entries = Object.entries(value);
	if (entries.length > 100) throw new Error("endpoint access timestamp map is too large");
	const values = {};
	let changed = false;
	for (const [id, expiresAt] of entries) {
		if (!idPattern.test(id)) throw new Error("endpoint access map id is malformed");
		const expiresAtMs = requireTimestampMillis(expiresAt);
		if (expiresAtMs > nowMs) values[id] = expiresAt;
		else changed = true;
	}
	return { changed, values };
}

function writeEndpointAccessDocument(transaction, reference, endpointAccess, updatedAt) {
	const expiries = [
		...Object.values(endpointAccess.activeGrants),
		...Object.values(endpointAccess.pendingClaims),
	];
	if (!endpointAccess.blocked && expiries.length === 0) {
		transaction.delete(reference);
		return;
	}
	let expiresAt;
	for (const candidate of expiries) {
		if (expiresAt === undefined || requireTimestampMillis(candidate) > requireTimestampMillis(expiresAt)) {
			expiresAt = candidate;
		}
	}
	transaction.set(reference, {
		activeGrants: endpointAccess.activeGrants,
		blocked: endpointAccess.blocked,
		...(!endpointAccess.blocked && expiresAt !== undefined ? { expiresAt } : {}),
		pendingClaims: endpointAccess.pendingClaims,
		updatedAt,
	});
}

function readRequestWindow(snapshot, nowMs) {
	if (!snapshot.exists) return { count: 0, startedAtMs: nowMs };
	const value = snapshot.data();
	if (!isRecord(value) || !Number.isSafeInteger(value.count) || value.count < 0) {
		throw new Error("request quota document is malformed");
	}
	const startedAtMs = requireTimestampMillis(value.windowStartedAt);
	if (startedAtMs > nowMs) throw new Error("request quota document starts in the future");
	if (startedAtMs + REQUEST_QUOTA_WINDOW_MS <= nowMs) return { count: 0, startedAtMs: nowMs };
	return { count: value.count, startedAtMs };
}

function getCurrentWindowStart(snapshot, nowMs, windowMs) {
	if (!snapshot.exists) return nowMs;
	const value = snapshot.data();
	if (!isRecord(value)) throw new Error("quota document is malformed");
	const startedAtMs = requireTimestampMillis(value.windowStartedAt);
	if (startedAtMs > nowMs) throw new Error("quota document starts in the future");
	return startedAtMs + windowMs <= nowMs ? nowMs : startedAtMs;
}

function readFixedWindowCount(snapshot, expectedStartedAtMs, windowMs) {
	if (!snapshot.exists) return 0;
	const value = snapshot.data();
	if (!isRecord(value) || !Number.isSafeInteger(value.count) || value.count < 0) {
		throw new Error("quota document is malformed");
	}
	const startedAtMs = requireTimestampMillis(value.windowStartedAt);
	if (startedAtMs === expectedStartedAtMs) return value.count;
	if (startedAtMs + windowMs <= expectedStartedAtMs) return 0;
	throw new Error("quota document has an unexpected window");
}

function requireTimestampMillis(value) {
	const millis = getTimestampMillis(value);
	if (!Number.isFinite(millis) || millis < 0) throw new Error("Firestore timestamp is malformed");
	return millis;
}

function normalizeRoutePath(rawPath) {
	let routePath = rawPath.split("?", 1)[0] || "/";
	if (routePath.startsWith("/irohEnrollment/")) {
		routePath = routePath.slice("/irohEnrollment".length);
	}
	return routePath.replace(/\/+$/, "") || "/";
}

function isEndpointId(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isBase64urlBytes(value, byteLength) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
	const decoded = Buffer.from(value, "base64url");
	return decoded.length === byteLength && decoded.toString("base64url") === value;
}

function getSafeErrorName(error) {
	return error instanceof Error ? error.name.slice(0, 64) : "UnknownError";
}

module.exports = {
	CLAIMS_COLLECTION,
	ENDPOINT_ACCESS_COLLECTION,
	GRANTS_COLLECTION,
	QUOTA_WINDOWS_COLLECTION,
	createIrohEnrollmentHandler,
	normalizeRoutePath,
};
