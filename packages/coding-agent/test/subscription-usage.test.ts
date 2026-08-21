import type { OAuthCredentials, OAuthProviderInterface, SubscriptionUsageResult } from "@hansjm10/volt-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@hansjm10/volt-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SubscriptionUsageService } from "../src/core/subscription-usage.ts";

const registeredProviderIds: string[] = [];

function oauthCredential(access = "access-token") {
	return {
		type: "oauth" as const,
		access,
		refresh: "refresh-token",
		expires: 1_900_000_000_000,
	};
}

function registerUsageProvider(
	id: string,
	fetchSubscriptionUsage?: (
		credentials: OAuthCredentials,
		options?: { signal?: AbortSignal },
	) => Promise<SubscriptionUsageResult>,
): OAuthProviderInterface {
	const provider: OAuthProviderInterface = {
		id,
		name: id,
		async login() {
			throw new Error("Not used in this test");
		},
		async refreshToken(credentials) {
			return credentials;
		},
		getApiKey(credentials) {
			return credentials.access;
		},
		...(fetchSubscriptionUsage ? { fetchSubscriptionUsage } : {}),
	};
	registerOAuthProvider(provider);
	registeredProviderIds.push(id);
	return provider;
}

function successfulResult(providerId: string, fetchedAt = 1_800_000_000_000): SubscriptionUsageResult {
	return {
		status: "success",
		snapshot: {
			providerId,
			fetchedAt,
			limits: [{ id: "session", label: "Session", usedPercent: 25 }],
		},
	};
}

describe("SubscriptionUsageService", () => {
	afterEach(() => {
		for (const providerId of registeredProviderIds.splice(0)) {
			unregisterOAuthProvider(providerId);
		}
		vi.restoreAllMocks();
	});

	it("distinguishes no stored subscription from stored unsupported OAuth", async () => {
		const unsupportedId = `unsupported-${Date.now()}`;
		registerUsageProvider(unsupportedId);
		const service = new SubscriptionUsageService();

		expect(
			await service.fetch(
				AuthStorage.inMemory({ [unsupportedId]: { type: "api_key", key: "api-key" } }),
				unsupportedId,
			),
		).toEqual({ status: "no_subscription" });
		expect(await service.fetch(AuthStorage.inMemory({ [unsupportedId]: oauthCredential() }), unsupportedId)).toEqual({
			status: "unsupported",
		});
	});

	it("omits usage-capable providers without stored OAuth credentials", async () => {
		const configuredId = `configured-${Date.now()}`;
		const unconfiguredId = `unconfigured-${Date.now()}`;
		const configuredFetch = vi.fn(async () => successfulResult(configuredId));
		const unconfiguredFetch = vi.fn(async () => successfulResult(unconfiguredId));
		registerUsageProvider(configuredId, configuredFetch);
		registerUsageProvider(unconfiguredId, unconfiguredFetch);
		const authStorage = AuthStorage.inMemory({ [configuredId]: oauthCredential() });

		const report = await new SubscriptionUsageService().fetch(authStorage, unconfiguredId);

		expect(report).toMatchObject({
			status: "providers",
			providers: [{ providerId: configuredId }],
		});
		expect(configuredFetch).toHaveBeenCalledOnce();
		expect(unconfiguredFetch).not.toHaveBeenCalled();
	});

	it("orders the active provider first and preserves partial successes", async () => {
		const alphaId = `alpha-${Date.now()}`;
		const zetaId = `zeta-${Date.now()}`;
		registerUsageProvider(alphaId, async () => successfulResult(alphaId));
		registerUsageProvider(zetaId, async () => ({
			status: "error",
			error: { code: "rate_limited", message: "Subscription usage is temporarily rate limited." },
		}));
		const authStorage = AuthStorage.inMemory({
			[alphaId]: oauthCredential("alpha-token"),
			[zetaId]: oauthCredential("zeta-token"),
		});

		const report = await new SubscriptionUsageService().fetch(authStorage, zetaId);

		expect(report.status).toBe("providers");
		if (report.status !== "providers") throw new Error("Expected provider usage report");
		expect(report.providers.map((provider) => provider.providerId)).toEqual([zetaId, alphaId]);
		expect(report.providers[0]?.result).toMatchObject({ status: "error", error: { code: "rate_limited" } });
		expect(report.providers[1]?.result).toMatchObject({ status: "success", snapshot: { providerId: alphaId } });
	});

	it("caches results for 60 seconds only while the credential object remains current", async () => {
		const providerId = `cache-${Date.now()}`;
		let now = 1_800_000_000_000;
		const fetchSubscriptionUsage = vi.fn(async () => successfulResult(providerId, now));
		registerUsageProvider(providerId, fetchSubscriptionUsage);
		const authStorage = AuthStorage.inMemory({ [providerId]: oauthCredential("first-token") });
		const service = new SubscriptionUsageService({ now: () => now });

		await service.fetch(authStorage, providerId);
		now += 59_000;
		await service.fetch(authStorage, providerId);
		expect(fetchSubscriptionUsage).toHaveBeenCalledTimes(1);

		authStorage.set(providerId, oauthCredential("second-token"));
		await service.fetch(authStorage, providerId);
		expect(fetchSubscriptionUsage).toHaveBeenCalledTimes(2);

		now += 60_001;
		await service.fetch(authStorage, providerId);
		expect(fetchSubscriptionUsage).toHaveBeenCalledTimes(3);
	});

	it("bounds providers that ignore abort signals with the operation timeout", async () => {
		const providerId = `timeout-${Date.now()}`;
		registerUsageProvider(providerId, async () => new Promise<SubscriptionUsageResult>(() => {}));
		const authStorage = AuthStorage.inMemory({ [providerId]: oauthCredential() });
		const service = new SubscriptionUsageService({ timeoutMs: 5 });

		const report = await service.fetch(authStorage, providerId);

		expect(report).toMatchObject({
			status: "providers",
			providers: [{ providerId, result: { status: "error", error: { code: "timeout" } } }],
		});
	});
});
