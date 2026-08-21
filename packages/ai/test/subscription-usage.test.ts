import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider } from "../src/utils/oauth/anthropic.ts";
import { fetchAnthropicSubscriptionUsage } from "../src/utils/oauth/anthropic-usage.ts";
import { openaiCodexOAuthProvider } from "../src/utils/oauth/openai-codex.ts";
import { fetchOpenAICodexSubscriptionUsage } from "../src/utils/oauth/openai-codex-usage.ts";
import type { OAuthCredentials, SubscriptionUsageResult } from "../src/utils/oauth/types.ts";

const credentials: OAuthCredentials = {
	access: "access-token",
	refresh: "refresh-token",
	expires: 1_900_000_000_000,
	accountId: "account-123",
};

function loadFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/subscription-usage/${name}.json`, import.meta.url), "utf-8"),
	) as unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requireSuccess(result: SubscriptionUsageResult) {
	expect(result.status).toBe("success");
	if (result.status !== "success") throw new Error("Expected successful subscription usage");
	return result.snapshot;
}

function getRequestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

describe.sequential("subscription usage adapters", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("normalizes Anthropic legacy and generic scoped limits through the OAuth provider capability", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(getRequestUrl(input)).toBe("https://api.anthropic.com/api/oauth/usage");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer access-token");
			expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
			return jsonResponse(loadFixture("anthropic"));
		});
		vi.stubGlobal("fetch", fetchMock);

		const snapshot = requireSuccess(await anthropicOAuthProvider.fetchSubscriptionUsage!(credentials));

		expect(snapshot).toMatchObject({
			providerId: "anthropic",
			fetchedAt: 1_800_000_000_000,
		});
		expect(snapshot.limits).toContainEqual({
			id: "session",
			label: "Session",
			usedPercent: 42.5,
			resetsAt: Date.parse("2026-08-21T18:00:00Z"),
		});
		expect(snapshot.limits).toContainEqual({
			id: "weekly",
			label: "Weekly",
			usedPercent: 100,
			resetsAt: Date.parse("2026-08-25T12:30:00Z"),
		});
		expect(snapshot.limits).toContainEqual({
			id: "weekly-scoped:sonnet",
			label: "Weekly · Claude Sonnet 4.6",
			usedPercent: 68.25,
			resetsAt: Date.parse("2026-08-27T09:15:00Z"),
		});
		expect(snapshot.limits).toContainEqual({
			id: "weekly-scoped:fable",
			label: "Weekly · Fable",
			usedPercent: 0,
		});
		expect(snapshot.limits.filter((limit) => limit.id === "weekly-scoped:sonnet")).toHaveLength(1);
		expect(snapshot.limits).toContainEqual({
			id: "seven-day-oauth-apps",
			label: "Seven Day Oauth Apps",
			usedPercent: 17,
		});
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("user-secret");
		expect(serialized).not.toContain("org-secret");
		expect(serialized).not.toContain("extra_usage");
		expect(serialized).not.toContain("spend");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("normalizes Codex base and additional windows without retaining identity or spend fields", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(getRequestUrl(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer access-token");
			expect(headers.get("chatgpt-account-id")).toBe("account-123");
			return jsonResponse(loadFixture("openai-codex"));
		});
		vi.stubGlobal("fetch", fetchMock);

		const snapshot = requireSuccess(await openaiCodexOAuthProvider.fetchSubscriptionUsage!(credentials));

		expect(snapshot).toMatchObject({
			providerId: "openai-codex",
			fetchedAt: 1_800_000_000_000,
			plan: "plus",
		});
		expect(snapshot.limits).toEqual([
			{
				id: "primary",
				label: "5-hour window",
				usedPercent: 100,
				resetsAt: 1_787_335_200_000,
				windowDurationMs: 18_000_000,
				limitReached: true,
			},
			{
				id: "spark:primary",
				label: "1-hour window · Codex Spark",
				usedPercent: 0,
				resetsAt: 1_800_000_120_000,
				windowDurationMs: 3_600_000,
				limitReached: false,
			},
			{
				id: "spark:secondary",
				label: "7-day window · Codex Spark",
				usedPercent: 50.5,
				resetsAt: 1_787_936_400_000,
				windowDurationMs: 604_800_000,
				limitReached: false,
			},
		]);
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("person@example.com");
		expect(serialized).not.toContain("account-secret");
		expect(serialized).not.toContain("credits");
		expect(serialized).not.toContain("spend_control");
	});

	it.each([
		{ name: "fractional", seconds: 0.0005, expectedDurationMs: undefined },
		{ name: "overflowing", seconds: Number.MAX_VALUE, expectedDurationMs: undefined },
		{
			name: "out-of-range",
			seconds: 9_006_000_000_000,
			expectedDurationMs: 9_006_000_000_000_000,
		},
	])("omits $name Codex reset times and unsafe durations", async ({ seconds, expectedDurationMs }) => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					rate_limit: {
						primary_window: {
							used_percent: 25,
							reset_at: seconds,
							reset_after_seconds: seconds,
							limit_window_seconds: seconds,
						},
					},
				}),
			),
		);

		const snapshot = requireSuccess(await fetchOpenAICodexSubscriptionUsage(credentials));
		const limit = snapshot.limits[0];

		expect(limit?.resetsAt).toBeUndefined();
		expect(limit?.windowDurationMs).toBe(expectedDurationMs);
		if (limit?.windowDurationMs !== undefined) {
			expect(Number.isSafeInteger(limit.windowDurationMs)).toBe(true);
		}
	});

	it("falls back to a valid relative Codex reset time when the absolute time is invalid", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					rate_limit: {
						primary_window: {
							used_percent: 25,
							reset_at: Number.MAX_VALUE,
							reset_after_seconds: 0.001,
							limit_window_seconds: 1.5,
						},
					},
				}),
			),
		);

		const snapshot = requireSuccess(await fetchOpenAICodexSubscriptionUsage(credentials));

		expect(snapshot.limits[0]).toMatchObject({
			resetsAt: 1_800_000_000_001,
			windowDurationMs: 1_500,
		});
	});

	it("marks only the exhausted Codex window as limit reached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					rate_limit: {
						limit_reached: true,
						primary_window: { used_percent: 100 },
						secondary_window: { used_percent: 50 },
					},
				}),
			),
		);

		const snapshot = requireSuccess(await fetchOpenAICodexSubscriptionUsage(credentials));

		expect(snapshot.limits).toEqual([
			{
				id: "primary",
				label: "Primary window",
				usedPercent: 100,
				limitReached: true,
			},
			{
				id: "secondary",
				label: "Secondary window",
				usedPercent: 50,
				limitReached: false,
			},
		]);
	});

	it.each([
		{ status: 401, code: "unauthorized" },
		{ status: 429, code: "rate_limited" },
		{ status: 503, code: "unavailable" },
	] as const)("maps HTTP $status to $code without reading response bodies", async ({ status, code }) => {
		const response = new Response("person@example.com account-secret", { status });
		const textSpy = vi.spyOn(response, "text");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		const anthropic = await fetchAnthropicSubscriptionUsage(credentials);
		expect(anthropic).toMatchObject({ status: "error", error: { code } });
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("returns safe malformed-response errors for invalid JSON and missing windows", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not-json", { status: 200 })),
		);
		expect(await fetchAnthropicSubscriptionUsage(credentials)).toMatchObject({
			status: "error",
			error: { code: "malformed_response" },
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ rate_limit: { primary_window: null } })),
		);
		expect(await fetchOpenAICodexSubscriptionUsage(credentials)).toMatchObject({
			status: "error",
			error: { code: "malformed_response" },
		});
	});

	it("classifies aborted requests as timeouts", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("secret network failure"))),
		);

		expect(await fetchOpenAICodexSubscriptionUsage(credentials, { signal: controller.signal })).toMatchObject({
			status: "error",
			error: { code: "timeout" },
		});
	});
});
