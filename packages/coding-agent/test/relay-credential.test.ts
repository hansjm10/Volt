import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type IrohManagedRelayCredential,
	managedRelayCredentialRefreshAt,
	parseIrohManagedRelayCredential,
	parseIrohRelayCredentialExchange,
	refreshIrohManagedRelayCredential,
	revokeIrohManagedRelayCredential,
} from "../src/daemon/relay-credential.ts";

const serviceUrl = "http://[::1]:18085";
const relayUrls = ["https://iroh-relay-us-central-canary.volt-cli.dev"];
let server: Server;
let responseMode: "refresh" | "oversized" | "redirect" | "revoke" = "refresh";
let observedRequest: { url?: string; method?: string; authorization?: string; body: string } | undefined;
let redirectedRequestCount = 0;

function credential(overrides: Partial<IrohManagedRelayCredential> = {}): IrohManagedRelayCredential {
	const now = Date.now();
	return {
		schemaVersion: 1,
		serviceUrl,
		relayUrls,
		endpointNodeId: "a".repeat(64),
		grantId: "abcdefghijklmnopqrstuvwx",
		accessToken: "aaaaaa.bbbbbb.cccccc",
		accessTokenExpiresAt: now + 15 * 60_000,
		refreshToken: `vrr_${"d".repeat(43)}`,
		refreshTokenExpiresAt: now + 30 * 24 * 60 * 60_000,
		...overrides,
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
			switch (responseMode) {
				case "refresh":
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							accessToken: "newtoken.payload.signature",
							accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
							tokenType: "Bearer",
						}),
					);
					break;
				case "oversized":
					response.writeHead(200, {
						"content-type": "application/json",
						"transfer-encoding": "chunked",
					});
					response.write(Buffer.alloc(16 * 1024, 0x20));
					response.end(Buffer.from("x"));
					break;
				case "redirect":
					response.writeHead(302, { location: `${serviceUrl}/redirected` });
					response.end();
					break;
				case "revoke":
					response.writeHead(204);
					response.end();
					break;
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(18085, "::1", () => {
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
	it("converts an exact broker exchange response", () => {
		const accessExpiry = new Date(Date.now() + 15 * 60_000);
		const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60_000);
		const parsed = parseIrohRelayCredentialExchange(
			{
				grantId: "abcdefghijklmnopqrstuvwx",
				hostNodeId: "a".repeat(64),
				credential: {
					accessToken: "aaaaaa.bbbbbb.cccccc",
					accessTokenExpiresAt: accessExpiry.toISOString(),
					refreshToken: `vrr_${"d".repeat(43)}`,
					refreshTokenExpiresAt: refreshExpiry.toISOString(),
					tokenType: "Bearer",
				},
			},
			serviceUrl,
			relayUrls,
		);
		expect(parsed).toEqual(
			credential({
				accessTokenExpiresAt: accessExpiry.getTime(),
				refreshTokenExpiresAt: refreshExpiry.getTime(),
			}),
		);
	});

	it("rejects unknown fields and unsafe service URLs", () => {
		expect(() => parseIrohManagedRelayCredential({ ...credential(), extra: true })).toThrow(/unexpected fields/);
		expect(() =>
			parseIrohManagedRelayCredential({
				...credential(),
				serviceUrl: "http://credentials.example.com",
			}),
		).toThrow(/HTTPS origin or the local canary/);
	});
});

describe("managed relay credential lifecycle", () => {
	it("refreshes through the real no-body loopback request", async () => {
		responseMode = "refresh";
		observedRequest = undefined;
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

	it("revokes through the real bounded no-redirect request", async () => {
		responseMode = "revoke";
		observedRequest = undefined;
		const original = credential();
		await revokeIrohManagedRelayCredential(original);
		expect(observedRequest).toEqual({
			url: "/v1/tokens/revoke",
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
