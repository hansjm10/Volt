import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
	createIrohRemoteEnrollmentHostCanonicalMessage,
	expectIrohRemoteBase64urlBytes,
	expectIrohRemoteEndpointId,
	hashIrohRemoteEnrollmentSecret,
	type IrohRemoteEnrollmentClaim,
	type IrohRemoteEnrollmentHostOperation,
	type IrohRemoteEnrollmentSigner,
	normalizeIrohRemoteRelayOrigins,
	signIrohRemoteEnrollmentMessage,
} from "../core/remote/iroh/enrollment.ts";

export const IROH_ENROLLMENT_BROKER_URL = "https://iroh-enrollment-us-central.volt-cli.dev";
export const DEFAULT_IROH_ENROLLMENT_BROKER_TIMEOUT_MS = 5_000;
export const DEFAULT_IROH_ENROLLMENT_BROKER_MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_IROH_ENROLLMENT_BROKER_REQUEST_BYTES = 16 * 1024;

export interface IrohEnrollmentBrokerCreateClaimResult {
	status: "pending";
	expiresAtEpochSeconds: number;
	relayOrigins: string[];
}

export type IrohEnrollmentBrokerClaimStatus =
	| { status: "pending" }
	| { status: "cancelled" }
	| { status: "expired" }
	| {
			status: "approved";
			clientEndpointId: string;
			grantExpiresAtEpochSeconds: number;
			grantGenerationId: string;
	  };

export type IrohEnrollmentBrokerCancelClaimResult = { status: "cancelled" } | { status: "expired" };

export interface IrohEnrollmentBroker {
	createClaim(claim: IrohRemoteEnrollmentClaim): Promise<IrohEnrollmentBrokerCreateClaimResult>;
	getClaimStatus(claim: IrohRemoteEnrollmentClaim): Promise<IrohEnrollmentBrokerClaimStatus>;
	cancelClaim(claim: IrohRemoteEnrollmentClaim): Promise<IrohEnrollmentBrokerCancelClaimResult>;
}

export interface IrohEnrollmentBrokerClientOptions {
	hostEndpointId: string;
	signer: IrohRemoteEnrollmentSigner;
	expectedRelayOrigins: readonly string[];
	fetch?: typeof fetch;
	maxResponseBytes?: number;
	now?: () => number;
	random?: (size: number) => Uint8Array;
	timeoutMs?: number;
}

export class IrohEnrollmentBrokerError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly status: number | undefined;

	constructor(code: string, message: string, options: { retryable: boolean; status?: number }) {
		super(message);
		this.name = "IrohEnrollmentBrokerError";
		this.code = code;
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

export class IrohEnrollmentBrokerClient implements IrohEnrollmentBroker {
	private readonly expectedRelayOrigins: string[];
	private readonly fetchImplementation: typeof fetch;
	private readonly hostEndpointId: string;
	private readonly maxResponseBytes: number;
	private readonly now: () => number;
	private readonly random: (size: number) => Uint8Array;
	private readonly signer: IrohRemoteEnrollmentSigner;
	private readonly timeoutMs: number;

	constructor(options: IrohEnrollmentBrokerClientOptions) {
		this.hostEndpointId = expectIrohRemoteEndpointId(options.hostEndpointId, "broker host endpoint id");
		this.signer = options.signer;
		this.expectedRelayOrigins = normalizeIrohRemoteRelayOrigins(
			options.expectedRelayOrigins,
			"expected broker relay origins",
		);
		this.fetchImplementation = options.fetch ?? fetch;
		this.maxResponseBytes = expectPositiveInteger(
			options.maxResponseBytes ?? DEFAULT_IROH_ENROLLMENT_BROKER_MAX_RESPONSE_BYTES,
			"broker max response bytes",
		);
		this.now = options.now ?? Date.now;
		this.random = options.random ?? randomBytes;
		this.timeoutMs = expectPositiveInteger(
			options.timeoutMs ?? DEFAULT_IROH_ENROLLMENT_BROKER_TIMEOUT_MS,
			"broker timeout",
		);
	}

	async createClaim(claim: IrohRemoteEnrollmentClaim): Promise<IrohEnrollmentBrokerCreateClaimResult> {
		const signed = this.createSignedClaimFields("create_claim", claim);
		const result = await this.post(
			"/v1/claims",
			{
				version: 1,
				hostEndpointId: this.hostEndpointId,
				claimId: claim.claimId,
				claimSecretHash: hashIrohRemoteEnrollmentSecret(claim.claimSecret),
				issuedAtMs: signed.issuedAtMs,
				nonce: signed.nonce,
				signature: signed.signature,
			},
			[200, 201],
		);
		const response = expectRecord(result, "broker create response");
		expectExactKeys(response, ["status", "expiresAtEpochSeconds", "relayOrigins"], "broker create response");
		if (response.status !== "pending") {
			throw invalidBrokerResponse("broker create response status must be pending");
		}
		return {
			status: "pending",
			expiresAtEpochSeconds: expectEpochSeconds(
				response.expiresAtEpochSeconds,
				"broker create expiresAtEpochSeconds",
			),
			relayOrigins: this.verifyRelayOrigins(response.relayOrigins),
		};
	}

	async getClaimStatus(claim: IrohRemoteEnrollmentClaim): Promise<IrohEnrollmentBrokerClaimStatus> {
		const result = await this.postClaimSecret("/v1/claims/status", "claim_status", claim);
		const response = expectRecord(result, "broker status response");
		if (response.status === "pending" || response.status === "cancelled" || response.status === "expired") {
			expectExactKeys(response, ["status"], "broker status response");
			return { status: response.status };
		}
		if (response.status === "approved") {
			expectExactKeys(
				response,
				["status", "clientEndpointId", "grantExpiresAtEpochSeconds", "grantGenerationId"],
				"broker status response",
			);
			return {
				status: "approved",
				clientEndpointId: expectIrohRemoteEndpointId(response.clientEndpointId, "broker status clientEndpointId"),
				grantExpiresAtEpochSeconds: expectEpochSeconds(
					response.grantExpiresAtEpochSeconds,
					"broker status grantExpiresAtEpochSeconds",
				),
				grantGenerationId: expectIrohRemoteBase64urlBytes(
					response.grantGenerationId,
					32,
					"broker status grantGenerationId",
				),
			};
		}
		throw invalidBrokerResponse("broker status response contains an invalid status");
	}

	async cancelClaim(claim: IrohRemoteEnrollmentClaim): Promise<IrohEnrollmentBrokerCancelClaimResult> {
		const result = await this.postClaimSecret("/v1/claims/cancel", "cancel_claim", claim);
		const response = expectRecord(result, "broker cancel response");
		expectExactKeys(response, ["status"], "broker cancel response");
		if (response.status !== "cancelled" && response.status !== "expired") {
			throw invalidBrokerResponse("broker cancel response contains an invalid status");
		}
		return { status: response.status };
	}

	private postClaimSecret(
		path: string,
		operation: "claim_status" | "cancel_claim",
		claim: IrohRemoteEnrollmentClaim,
	): Promise<unknown> {
		const signed = this.createSignedClaimFields(operation, claim);
		return this.post(
			path,
			{
				version: 1,
				hostEndpointId: this.hostEndpointId,
				claimId: claim.claimId,
				claimSecret: claim.claimSecret,
				issuedAtMs: signed.issuedAtMs,
				nonce: signed.nonce,
				signature: signed.signature,
			},
			[200],
		);
	}

	private createSignedClaimFields(
		operation: IrohRemoteEnrollmentHostOperation,
		claim: IrohRemoteEnrollmentClaim,
	): { issuedAtMs: number; nonce: string; signature: string } {
		expectIrohRemoteBase64urlBytes(claim.claimId, 16, "broker claim id");
		expectIrohRemoteBase64urlBytes(claim.claimSecret, 32, "broker claim secret");
		const issuedAtMs = this.now();
		if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
			throw new Error("broker clock returned an invalid timestamp");
		}
		const nonceBytes = Buffer.from(this.random(16));
		if (nonceBytes.length !== 16) {
			throw new Error("broker randomness returned an invalid nonce length");
		}
		const nonce = nonceBytes.toString("base64url");
		const message = createIrohRemoteEnrollmentHostCanonicalMessage({
			operation,
			hostEndpointId: this.hostEndpointId,
			claimId: claim.claimId,
			claimSecretHash: hashIrohRemoteEnrollmentSecret(claim.claimSecret),
			issuedAtMs,
			nonce,
		});
		return { issuedAtMs, nonce, signature: signIrohRemoteEnrollmentMessage(this.signer, message) };
	}

	private async post(
		path: string,
		body: Record<string, unknown>,
		acceptedStatuses: readonly number[],
	): Promise<unknown> {
		const serializedBody = JSON.stringify(body);
		const requestBodyBytes = Buffer.byteLength(serializedBody, "utf8");
		if (requestBodyBytes === 0 || requestBodyBytes > MAX_IROH_ENROLLMENT_BROKER_REQUEST_BYTES) {
			throw new Error("broker request body exceeds maximum size");
		}
		const abortController = new AbortController();
		let timeoutId: NodeJS.Timeout | undefined;
		let timedOut = false;
		const operation = (async () => {
			const response = await this.fetchImplementation(`${IROH_ENROLLMENT_BROKER_URL}${path}`, {
				method: "POST",
				headers: {
					"content-length": String(requestBodyBytes),
					"content-type": "application/json",
				},
				body: serializedBody,
				redirect: "manual",
				signal: abortController.signal,
			});
			if (response.redirected || (response.status >= 300 && response.status < 400)) {
				throw new IrohEnrollmentBrokerError("redirect_rejected", "broker redirect rejected", {
					retryable: false,
					status: response.status,
				});
			}
			const responseText = await readBoundedResponseText(response, this.maxResponseBytes);
			if (!acceptedStatuses.includes(response.status)) {
				const errorCode = parseBrokerErrorCode(responseText);
				throw new IrohEnrollmentBrokerError(
					errorCode,
					`broker request failed with HTTP ${response.status}: ${errorCode}`,
					{
						retryable: response.status === 408 || response.status === 429 || response.status >= 500,
						status: response.status,
					},
				);
			}
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			if (!contentType.startsWith("application/json")) {
				throw invalidBrokerResponse("broker response content type must be application/json");
			}
			try {
				return JSON.parse(responseText) as unknown;
			} catch {
				throw invalidBrokerResponse("broker response must contain valid JSON");
			}
		})();
		operation.catch(() => {});
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				timedOut = true;
				abortController.abort();
				reject(
					new IrohEnrollmentBrokerError("timeout", "broker request timed out", {
						retryable: true,
					}),
				);
			}, this.timeoutMs);
			timeoutId.unref?.();
		});
		try {
			return await Promise.race([operation, timeout]);
		} catch (error) {
			if (error instanceof IrohEnrollmentBrokerError) {
				throw error;
			}
			if (timedOut || (error instanceof Error && error.name === "AbortError")) {
				throw new IrohEnrollmentBrokerError("timeout", "broker request timed out", { retryable: true });
			}
			throw new IrohEnrollmentBrokerError("network_error", "broker network request failed", {
				retryable: true,
			});
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private verifyRelayOrigins(value: unknown): string[] {
		if (!Array.isArray(value) || value.some((origin) => typeof origin !== "string")) {
			throw invalidBrokerResponse("broker relayOrigins must be an array of strings");
		}
		let normalized: string[];
		try {
			normalized = normalizeIrohRemoteRelayOrigins(value as string[], "broker relay origins");
		} catch (error) {
			throw invalidBrokerResponse(error instanceof Error ? error.message : "broker relay origins are invalid");
		}
		if (
			normalized.length !== this.expectedRelayOrigins.length ||
			normalized.some((origin, index) => origin !== this.expectedRelayOrigins[index])
		) {
			throw invalidBrokerResponse("broker relay origins do not match the built-in Volt managed fleet");
		}
		return normalized;
	}
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			throw invalidBrokerResponse("broker response exceeds maximum size");
		}
	}
	if (response.body === null) return "";
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = Buffer.from(next.value);
			totalBytes += chunk.length;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw invalidBrokerResponse("broker response exceeds maximum size");
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseBrokerErrorCode(responseText: string): string {
	try {
		const parsed = JSON.parse(responseText) as unknown;
		const response = expectRecord(parsed, "broker error response");
		expectExactKeys(response, ["error"], "broker error response");
		if (typeof response.error === "string" && /^[a-z0-9_]{1,64}$/.test(response.error)) {
			return response.error;
		}
	} catch {}
	return "http_error";
}

function expectEpochSeconds(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw invalidBrokerResponse(`${label} must be a non-negative safe integer`);
	}
	return value as number;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidBrokerResponse(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
	const expected = new Set(keys);
	const actual = Object.keys(record);
	if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
		throw invalidBrokerResponse(`${label} contains unknown or missing fields`);
	}
}

function expectPositiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value;
}

function invalidBrokerResponse(message: string): IrohEnrollmentBrokerError {
	return new IrohEnrollmentBrokerError("invalid_response", message, { retryable: false });
}
