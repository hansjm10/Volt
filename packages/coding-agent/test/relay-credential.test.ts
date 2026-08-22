import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	activateIrohManagedRelayCredential,
	createIrohManagedRelayCredentialClaim,
	exchangeIrohManagedRelayCredentialClaim,
	type IrohManagedRelayCredential,
	type IrohManagedRelayCredentialClaim,
	managedRelayCredentialFailureRetryMs,
	managedRelayCredentialPendingRetryMs,
	managedRelayCredentialRateLimitRetryMs,
	managedRelayCredentialRefreshAt,
	parseIrohManagedRelayCredential,
	parseIrohManagedRelayCredentialClaim,
	refreshIrohManagedRelayCredential,
	revokeIrohManagedRelayAppEndpoint,
	revokeIrohManagedRelayCredential,
} from "../src/daemon/relay-credential.ts";

const serviceUrl = "http://[::1]:8085";
const relayUrls = ["https://iroh-relay-us-central-canary.volt-cli.dev"];
const claimId = "abcdefghijklmnopqrstuvwx";
const hostNodeId = "a".repeat(64);
const appNodeId = "b".repeat(64);
let server: Server;
let responseMode: "normal" | "pending" | "rate-limited" | "oversized" | "redirect" | "revoke" = "normal";
let observedRequest: { url?: string; method?: string; authorization?: string; body: string } | undefined;
let redirectedRequestCount = 0;

function credential(overrides: Partial<IrohManagedRelayCredential> = {}): IrohManagedRelayCredential {
	const now = Date.now();
	return {
		schemaVersion: 2,
		serviceUrl,
		relayUrls,
		endpointNodeId: hostNodeId,
		endpointId: "hostendpointabcdefghijkl",
		grantId: "grantabcdefghijklmnopqrs",
		accessToken: "aaaaaa.bbbbbb.cccccc",
		accessTokenExpiresAt: now + 15 * 60_000,
		refreshToken: `vrr_${"d".repeat(43)}`,
		...overrides,
	};
}

function claim(overrides: Partial<IrohManagedRelayCredentialClaim> = {}): IrohManagedRelayCredentialClaim {
	return {
		schemaVersion: 1,
		serviceUrl,
		relayUrls,
		hostNodeId,
		claimSecret: `vpc_${"c".repeat(43)}`,
		bootstrapRefreshToken: `vrr_${"e".repeat(43)}`,
		...overrides,
	};
}

function accessTokenResponse() {
	return {
		accessToken: "newtoken.payload.signature",
		accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
		tokenType: "Bearer",
	};
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			observedRequest = {
				url: request.url,
				method: request.method,
				authorization: request.headers.authorization,
				body: Buffer.concat(chunks).toString("utf8"),
			};
			if (request.url === "/redirected") {
				redirectedRequestCount += 1;
				response.writeHead(200, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			if (responseMode === "oversized") {
				response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
				response.write(Buffer.alloc(16 * 1024, 0x20));
				response.end(Buffer.from("x"));
				return;
			}
			if (responseMode === "redirect") {
				response.writeHead(302, { location: `${serviceUrl}/redirected` });
				response.end();
				return;
			}
			if (responseMode === "revoke") {
				response.writeHead(204);
				response.end();
				return;
			}
			if (request.url === "/v1/pairing-claims") {
				response.writeHead(201, { "content-type": "application/json" });
				response.end(JSON.stringify({ claimId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }));
				return;
			}
			if (request.url === `/v1/pairing-claims/${claimId}/exchange`) {
				const status = responseMode === "pending" ? 202 : responseMode === "rate-limited" ? 429 : 200;
				response.writeHead(status, {
					"content-type": "application/json",
					...(responseMode === "rate-limited" ? { "retry-after": "7" } : {}),
				});
				response.end(
					JSON.stringify(
						responseMode === "pending"
							? { status: "pending", retryAfterSeconds: 1 }
							: responseMode === "rate-limited"
								? { error: "request_rate_limited" }
								: {
										grantId: "grantabcdefghijklmnopqrs",
										endpointId: "hostendpointabcdefghijkl",
										hostNodeId,
										appEndpointId: "appendpointabcdefghijklm",
										appNodeId,
										credential: accessTokenResponse(),
									},
					),
				);
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(accessTokenResponse()));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8085, "::1", () => {
			server.off("error", reject);
			resolve();
		});
	});
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

describe("managed relay credential parsing", () => {
	it("round-trips active credentials and durable claims", () => {
		const active = credential();
		const pending = claim();
		expect(parseIrohManagedRelayCredential(active)).toEqual(active);
		expect(parseIrohManagedRelayCredentialClaim(pending)).toEqual(pending);
		expect(() => parseIrohManagedRelayCredential({ ...credential(), extra: true })).toThrow(/unexpected fields/);
		expect(() =>
			parseIrohManagedRelayCredential({
				...credential(),
				serviceUrl: "http://credentials.example.com",
			}),
		).toThrow(/HTTPS origin or the local canary/);
	});
});

describe("managed relay credential enrollment", () => {
	it("creates a bootstrap claim with hashes only", async () => {
		responseMode = "normal";
		const candidate = claim();
		const created = await createIrohManagedRelayCredentialClaim(candidate);
		const expectedHash = (value: string) => createHash("sha256").update(value).digest("base64url");

		expect(created.claimId).toBe(claimId);
		expect(observedRequest).toEqual({
			url: "/v1/pairing-claims",
			method: "POST",
			authorization: undefined,
			body: JSON.stringify({
				hostNodeId,
				claimSecretHash: expectedHash(candidate.claimSecret),
				hostRefreshTokenHash: expectedHash(candidate.bootstrapRefreshToken!),
			}),
		});
		const request = observedRequest;
		if (request === undefined) throw new Error("claim request was not observed");
		expect(request.body).not.toContain(candidate.claimSecret);
		expect(request.body).not.toContain(candidate.bootstrapRefreshToken!);
	});

	it("creates a later claim under the existing host refresh authority", async () => {
		responseMode = "normal";
		const candidate = claim({ bootstrapRefreshToken: undefined });
		await createIrohManagedRelayCredentialClaim(candidate, credential());
		expect(observedRequest?.authorization).toBe(`Bearer ${credential().refreshToken}`);
		expect(JSON.parse(observedRequest?.body ?? "{}")).toEqual({
			claimSecretHash: createHash("sha256").update(candidate.claimSecret).digest("base64url"),
		});
	});

	it("observes pending approval then activates the local stable refresh secret", async () => {
		const created = claim({
			claimId,
			expiresAt: Date.now() + 10 * 60_000,
		});
		responseMode = "pending";
		expect(await exchangeIrohManagedRelayCredentialClaim(created)).toEqual({
			status: "pending",
			retryAfterMs: 1000,
		});

		responseMode = "rate-limited";
		expect(await exchangeIrohManagedRelayCredentialClaim(created)).toEqual({
			status: "rate_limited",
			retryAfterMs: 7000,
		});

		responseMode = "normal";
		const result = await exchangeIrohManagedRelayCredentialClaim(created);
		if (result.status !== "approved") throw new Error("expected approved exchange");
		const active = activateIrohManagedRelayCredential(created, result.exchange);
		expect(active.refreshToken).toBe(created.bootstrapRefreshToken);
		expect(active.endpointNodeId).toBe(hostNodeId);
		expect(active.endpointId).toBe("hostendpointabcdefghijkl");
		expect(active.grantId).toBe("grantabcdefghijklmnopqrs");
		expect(observedRequest?.authorization).toBe(`Bearer ${created.claimSecret}`);
	});
});

describe("managed relay credential retry timing", () => {
	it("keeps a fast pending burst before adding bounded jitter", () => {
		expect(managedRelayCredentialPendingRetryMs(1000, 1, 0)).toBe(1000);
		expect(managedRelayCredentialPendingRetryMs(1000, 3, 1)).toBe(1000);
		expect(managedRelayCredentialPendingRetryMs(1000, 4, 0)).toBe(1600);
		expect(managedRelayCredentialPendingRetryMs(1000, 4, 0.5)).toBe(2000);
		expect(managedRelayCredentialPendingRetryMs(1000, 4, 1)).toBe(2400);
		expect(managedRelayCredentialPendingRetryMs(3000, 4, 0)).toBe(3000);
	});

	it("exponentially backs off failures and honors rate-limit floors", () => {
		expect(managedRelayCredentialFailureRetryMs(1, 0)).toBe(1000);
		expect(managedRelayCredentialFailureRetryMs(2, 0)).toBe(1600);
		expect(managedRelayCredentialFailureRetryMs(3, 0.5)).toBe(4000);
		expect(managedRelayCredentialFailureRetryMs(6, 1)).toBe(30_000);
		expect(managedRelayCredentialRateLimitRetryMs(10_000, 0)).toBe(10_000);
		expect(managedRelayCredentialRateLimitRetryMs(10_000, 1)).toBe(12_000);
	});
});

describe("managed relay credential lifecycle", () => {
	it("refreshes through the real no-body loopback request without rotating refresh authority", async () => {
		responseMode = "normal";
		const original = credential();
		const refreshed = await refreshIrohManagedRelayCredential(original);

		expect(refreshed.accessToken).toBe("newtoken.payload.signature");
		expect(refreshed.refreshToken).toBe(original.refreshToken);
		expect(observedRequest).toEqual({
			url: "/v1/tokens/refresh",
			method: "POST",
			authorization: `Bearer ${original.refreshToken}`,
			body: "",
		});
	});

	it("rejects an oversized chunked refresh response", async () => {
		responseMode = "oversized";
		await expect(refreshIrohManagedRelayCredential(credential())).rejects.toThrow(/too large/);
	});

	it("does not follow credential-service redirects", async () => {
		responseMode = "redirect";
		redirectedRequestCount = 0;
		await expect(refreshIrohManagedRelayCredential(credential())).rejects.toThrow();
		expect(redirectedRequestCount).toBe(0);
	});

	it("host-revokes an app endpoint through the grant route", async () => {
		responseMode = "revoke";
		const original = credential();
		await revokeIrohManagedRelayAppEndpoint(original, "appendpointabcdefghijklm");
		expect(observedRequest).toEqual({
			url: "/v1/grant/endpoints/revoke",
			method: "POST",
			authorization: `Bearer ${original.refreshToken}`,
			body: JSON.stringify({ endpointId: "appendpointabcdefghijklm" }),
		});
	});

	it("revokes the daemon grant through the real bounded no-redirect request", async () => {
		responseMode = "revoke";
		const original = credential();
		await revokeIrohManagedRelayCredential(original);
		expect(observedRequest).toEqual({
			url: "/v1/grant/revoke",
			method: "POST",
			authorization: `Bearer ${original.refreshToken}`,
			body: "",
		});
	});

	it("schedules refresh before access expiry", () => {
		const base = Date.now();
		const original = credential({ accessTokenExpiresAt: base + 15 * 60_000 });
		expect(managedRelayCredentialRefreshAt(original, base)).toBe(base + 13 * 60_000);
	});
});
