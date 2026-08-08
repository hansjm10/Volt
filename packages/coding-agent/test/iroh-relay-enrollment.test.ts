import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	createIrohRemoteEnrollmentClaim,
	createIrohRemoteEnrollmentHostCanonicalMessage,
	hashIrohRemoteEnrollmentSecret,
	normalizeIrohRemoteRelayOrigins,
	parseIrohRemoteEnrollmentClaim,
} from "../src/core/remote/iroh/enrollment.ts";
import {
	IROH_ENROLLMENT_BROKER_URL,
	IrohEnrollmentBrokerClient,
	type IrohEnrollmentBrokerError,
} from "../src/daemon/iroh-enrollment-broker.ts";

interface EnrollmentVectors {
	issuedAtMs: number;
	hostEndpointId: string;
	claimId: string;
	claimSecret: string;
	claimSecretSha256: string;
	grantGenerationId: string;
	operations: Record<"create_claim" | "claim_status" | "cancel_claim", { nonce: string; canonicalMessage: string }>;
}

async function loadVectors(): Promise<EnrollmentVectors> {
	return JSON.parse(
		await readFile(new URL("./fixtures/iroh-relay-enrollment-v1-vectors.json", import.meta.url), "utf8"),
	) as EnrollmentVectors;
}

const RELAY_ORIGINS = ["https://iroh-relay-us-central.volt-cli.dev"];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Iroh relay enrollment", () => {
	it("matches the normative secret hash and host canonical-message vectors", async () => {
		const vectors = await loadVectors();
		expect(hashIrohRemoteEnrollmentSecret(vectors.claimSecret)).toBe(vectors.claimSecretSha256);
		for (const operation of ["create_claim", "claim_status", "cancel_claim"] as const) {
			const expected = vectors.operations[operation];
			const message = createIrohRemoteEnrollmentHostCanonicalMessage({
				operation,
				hostEndpointId: vectors.hostEndpointId,
				claimId: vectors.claimId,
				claimSecretHash: vectors.claimSecretSha256,
				issuedAtMs: vectors.issuedAtMs,
				nonce: expected.nonce,
			});
			expect(message.toString("utf8")).toBe(expected.canonicalMessage);
		}
	});

	it("generates and strictly validates claims and HTTPS relay origins", () => {
		const claim = createIrohRemoteEnrollmentClaim((size) => Uint8Array.from({ length: size }, (_, index) => index));
		expect(parseIrohRemoteEnrollmentClaim(claim)).toEqual(claim);
		expect(() => parseIrohRemoteEnrollmentClaim({ ...claim, future: true })).toThrow("unknown or missing fields");
		expect(
			normalizeIrohRemoteRelayOrigins(["https://Relay-B.Example.:443/", "https://relay-a.example:8443"]),
		).toEqual(["https://relay-a.example:8443", "https://relay-b.example"]);
		expect(() => normalizeIrohRemoteRelayOrigins(["https://127.0.0.1"])).toThrow("local or private host");
	});

	it("uses the fixed broker, signs every operation, and never sends the raw claim secret when creating", async () => {
		const vectors = await loadVectors();
		const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
		const responses = [
			jsonResponse({ status: "pending", expiresAtEpochSeconds: 1_893_456_300, relayOrigins: RELAY_ORIGINS }, 201),
			jsonResponse({
				status: "approved",
				clientEndpointId: "29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7",
				grantExpiresAtEpochSeconds: 1_896_048_000,
				grantGenerationId: vectors.grantGenerationId,
			}),
			jsonResponse({ status: "cancelled" }),
		];
		const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url: String(input), init: init ?? {}, body });
			return responses.shift()!;
		};
		const client = new IrohEnrollmentBrokerClient({
			hostEndpointId: vectors.hostEndpointId,
			signer: { sign: () => ({ toBytes: () => Array.from({ length: 64 }, (_, index) => index) }) },
			expectedRelayOrigins: RELAY_ORIGINS,
			fetch: fetch as typeof globalThis.fetch,
			now: () => vectors.issuedAtMs,
			random: () => new Uint8Array(16),
		});
		const claim = { version: 1 as const, claimId: vectors.claimId, claimSecret: vectors.claimSecret };

		await expect(client.createClaim(claim)).resolves.toMatchObject({
			status: "pending",
			relayOrigins: RELAY_ORIGINS,
		});
		await expect(client.getClaimStatus(claim)).resolves.toMatchObject({
			status: "approved",
			grantGenerationId: vectors.grantGenerationId,
		});
		await expect(client.cancelClaim(claim)).resolves.toEqual({ status: "cancelled" });
		expect(IROH_ENROLLMENT_BROKER_URL).toBe("https://iroh-enrollment-us-central.volt-cli.dev");
		expect(requests.map((request) => request.url)).toEqual([
			"https://iroh-enrollment-us-central.volt-cli.dev/v1/claims",
			"https://iroh-enrollment-us-central.volt-cli.dev/v1/claims/status",
			"https://iroh-enrollment-us-central.volt-cli.dev/v1/claims/cancel",
		]);
		expect(requests.every((request) => request.init.redirect === "manual")).toBe(true);
		for (const request of requests) {
			const serializedBody = String(request.init.body);
			const requestBytes = Buffer.byteLength(serializedBody, "utf8");
			expect(new Headers(request.init.headers).get("content-length")).toBe(String(requestBytes));
			expect(new Headers(request.init.headers).get("content-type")).toBe("application/json");
			expect(requestBytes).toBeGreaterThanOrEqual(1);
			expect(requestBytes).toBeLessThanOrEqual(16 * 1024);
		}
		expect(requests[0]!.body).not.toHaveProperty("claimSecret");
		expect(requests[0]!.body.claimSecretHash).toBe(vectors.claimSecretSha256);
		expect(requests[1]!.body.claimSecret).toBe(vectors.claimSecret);
		expect(requests.every((request) => typeof request.body.signature === "string")).toBe(true);
	});

	it("rejects broker redirects and relay-fleet mismatches", async () => {
		const vectors = await loadVectors();
		const claim = { version: 1 as const, claimId: vectors.claimId, claimSecret: vectors.claimSecret };
		const createClient = (response: Response) =>
			new IrohEnrollmentBrokerClient({
				hostEndpointId: vectors.hostEndpointId,
				signer: { sign: () => ({ toBytes: () => new Array<number>(64).fill(0) }) },
				expectedRelayOrigins: RELAY_ORIGINS,
				fetch: (async () => response) as typeof globalThis.fetch,
				now: () => vectors.issuedAtMs,
				random: () => new Uint8Array(16),
			});

		await expect(createClient(new Response(null, { status: 302 })).createClaim(claim)).rejects.toMatchObject({
			code: "redirect_rejected",
			retryable: false,
		} satisfies Partial<IrohEnrollmentBrokerError>);
		await expect(
			createClient(
				jsonResponse(
					{ status: "pending", expiresAtEpochSeconds: 1_893_456_300, relayOrigins: ["https://other.example"] },
					201,
				),
			).createClaim(claim),
		).rejects.toMatchObject({ code: "invalid_response", retryable: false });
	});

	it("bounds broker latency and response bytes", async () => {
		const vectors = await loadVectors();
		const claim = { version: 1 as const, claimId: vectors.claimId, claimSecret: vectors.claimSecret };
		const clientOptions = {
			hostEndpointId: vectors.hostEndpointId,
			signer: { sign: () => ({ toBytes: () => new Array<number>(64).fill(0) }) },
			expectedRelayOrigins: RELAY_ORIGINS,
			now: () => vectors.issuedAtMs,
			random: () => new Uint8Array(16),
		};
		const timeoutClient = new IrohEnrollmentBrokerClient({
			...clientOptions,
			fetch: (() => new Promise<Response>(() => {})) as typeof globalThis.fetch,
			timeoutMs: 5,
		});
		await expect(timeoutClient.createClaim(claim)).rejects.toMatchObject({
			code: "timeout",
			retryable: true,
		} satisfies Partial<IrohEnrollmentBrokerError>);

		const oversizedClient = new IrohEnrollmentBrokerClient({
			...clientOptions,
			fetch: (async () =>
				jsonResponse({ status: "pending", padding: "x".repeat(256) }, 201)) as typeof globalThis.fetch,
			maxResponseBytes: 64,
		});
		await expect(oversizedClient.createClaim(claim)).rejects.toMatchObject({
			code: "invalid_response",
			retryable: false,
		} satisfies Partial<IrohEnrollmentBrokerError>);
	});
});
