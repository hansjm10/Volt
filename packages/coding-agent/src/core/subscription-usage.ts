import type { SubscriptionUsageResult } from "@hansjm10/volt-ai";
import type { AuthStorage, OAuthCredential } from "./auth-storage.ts";

export const DEFAULT_SUBSCRIPTION_USAGE_CACHE_TTL_MS = 60_000;
export const DEFAULT_SUBSCRIPTION_USAGE_TIMEOUT_MS = 10_000;

export interface SubscriptionUsageProviderReport {
	providerId: string;
	result: SubscriptionUsageResult;
}

export type SubscriptionUsageReport =
	| { status: "providers"; providers: SubscriptionUsageProviderReport[] }
	| { status: "no_subscription" }
	| { status: "unsupported" };

export interface SubscriptionUsageServiceOptions {
	cacheTtlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

interface SubscriptionUsageCacheEntry {
	credential: OAuthCredential;
	expiresAt: number;
	result: SubscriptionUsageResult;
}

function unavailableResult(): SubscriptionUsageResult {
	return {
		status: "error",
		error: { code: "unavailable", message: "Subscription usage is temporarily unavailable." },
	};
}

function timeoutResult(): SubscriptionUsageResult {
	return {
		status: "error",
		error: { code: "timeout", message: "Subscription usage request timed out." },
	};
}

export class SubscriptionUsageService {
	private readonly cache = new Map<string, SubscriptionUsageCacheEntry>();
	private readonly cacheTtlMs: number;
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(options: SubscriptionUsageServiceOptions = {}) {
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_SUBSCRIPTION_USAGE_CACHE_TTL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_SUBSCRIPTION_USAGE_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
	}

	private async fetchProvider(
		authStorage: AuthStorage,
		providerId: string,
		credential: OAuthCredential,
	): Promise<SubscriptionUsageProviderReport> {
		const cached = this.cache.get(providerId);
		const now = this.now();
		if (cached && cached.credential === credential && cached.expiresAt > now) {
			return { providerId, result: cached.result };
		}

		const controller = new AbortController();
		let timeoutHandle: NodeJS.Timeout | undefined;
		const timeout = new Promise<SubscriptionUsageResult>((resolve) => {
			timeoutHandle = setTimeout(() => {
				controller.abort();
				resolve(timeoutResult());
			}, this.timeoutMs);
			timeoutHandle.unref?.();
		});

		let result: SubscriptionUsageResult;
		try {
			const request = authStorage
				.fetchSubscriptionUsage(providerId, { signal: controller.signal })
				.then((value) => value ?? unavailableResult())
				.catch(() => unavailableResult());
			result = await Promise.race([request, timeout]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}

		const currentCredential = authStorage.get(providerId);
		if (currentCredential?.type === "oauth") {
			this.cache.set(providerId, {
				credential: currentCredential,
				expiresAt: this.now() + this.cacheTtlMs,
				result,
			});
		} else {
			this.cache.delete(providerId);
		}

		return { providerId, result };
	}

	async fetch(authStorage: AuthStorage, activeProviderId: string | undefined): Promise<SubscriptionUsageReport> {
		const storedOAuthProviders = authStorage
			.list()
			.filter((providerId) => authStorage.get(providerId)?.type === "oauth");
		if (storedOAuthProviders.length === 0) {
			this.cache.clear();
			return { status: "no_subscription" };
		}

		const capableProviderIds = new Set(
			authStorage
				.getOAuthProviders()
				.filter((provider) => provider.fetchSubscriptionUsage)
				.map((provider) => provider.id),
		);
		const eligibleProviderIds = storedOAuthProviders
			.filter((providerId) => capableProviderIds.has(providerId))
			.sort((left, right) => {
				if (left === activeProviderId) return -1;
				if (right === activeProviderId) return 1;
				return left.localeCompare(right);
			});

		for (const providerId of this.cache.keys()) {
			if (!eligibleProviderIds.includes(providerId)) this.cache.delete(providerId);
		}

		if (eligibleProviderIds.length === 0) {
			return { status: "unsupported" };
		}

		const providers = await Promise.all(
			eligibleProviderIds.map((providerId) => {
				const credential = authStorage.get(providerId);
				if (credential?.type !== "oauth") {
					return { providerId, result: unavailableResult() };
				}
				return this.fetchProvider(authStorage, providerId, credential);
			}),
		);
		return { status: "providers", providers };
	}
}
