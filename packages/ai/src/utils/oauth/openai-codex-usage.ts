import type {
	OAuthCredentials,
	SubscriptionUsageFetchOptions,
	SubscriptionUsageLimit,
	SubscriptionUsageResult,
} from "./types.ts";

const OPENAI_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type WindowKind = "primary" | "secondary";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUsedPercent(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function slugify(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/^codex[-_]/, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "additional"
	);
}

function titleCase(value: string): string {
	return value
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatWindowLabel(durationSeconds: number | undefined, kind: WindowKind): string {
	if (durationSeconds === undefined) return kind === "primary" ? "Primary window" : "Secondary window";
	if (durationSeconds >= 86_400) {
		const days = Math.max(1, Math.round(durationSeconds / 86_400));
		return `${days}-day window`;
	}
	if (durationSeconds >= 3_600) {
		const hours = Math.max(1, Math.round(durationSeconds / 3_600));
		return `${hours}-hour window`;
	}
	const minutes = Math.max(1, Math.round(durationSeconds / 60));
	return `${minutes}-minute window`;
}

function parseWindow(
	value: unknown,
	kind: WindowKind,
	fetchedAt: number,
	options: { idPrefix?: string; labelPrefix?: string; limitReached?: boolean } = {},
): SubscriptionUsageLimit | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = normalizeUsedPercent(value.used_percent);
	if (usedPercent === undefined) return undefined;

	const durationSeconds = finiteNonNegativeNumber(value.limit_window_seconds);
	const resetAtSeconds = finiteNonNegativeNumber(value.reset_at);
	const resetAfterSeconds = finiteNonNegativeNumber(value.reset_after_seconds);
	const resetsAt =
		resetAtSeconds !== undefined
			? resetAtSeconds * 1000
			: resetAfterSeconds !== undefined
				? fetchedAt + resetAfterSeconds * 1000
				: undefined;
	const windowLabel = formatWindowLabel(durationSeconds, kind);

	return {
		id: options.idPrefix ? `${options.idPrefix}:${kind}` : kind,
		label: options.labelPrefix ? `${windowLabel} · ${options.labelPrefix}` : windowLabel,
		usedPercent,
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(durationSeconds === undefined ? {} : { windowDurationMs: durationSeconds * 1000 }),
		...(options.limitReached === undefined ? {} : { limitReached: options.limitReached }),
	};
}

function parseRateLimitWindows(
	value: unknown,
	fetchedAt: number,
	options: { idPrefix?: string; labelPrefix?: string } = {},
): SubscriptionUsageLimit[] {
	if (!isRecord(value)) return [];
	const limitReached = typeof value.limit_reached === "boolean" ? value.limit_reached : undefined;
	const limits: SubscriptionUsageLimit[] = [];
	const primary = parseWindow(value.primary_window, "primary", fetchedAt, { ...options, limitReached });
	const secondary = parseWindow(value.secondary_window, "secondary", fetchedAt, { ...options, limitReached });
	if (primary) limits.push(primary);
	if (secondary) limits.push(secondary);
	return limits;
}

function parseOpenAICodexUsage(payload: unknown, fetchedAt: number): SubscriptionUsageResult {
	if (!isRecord(payload)) {
		return {
			status: "error",
			error: { code: "malformed_response", message: "Subscription usage returned an unsupported response." },
		};
	}

	const limits = parseRateLimitWindows(payload.rate_limit, fetchedAt);
	if (Array.isArray(payload.additional_rate_limits)) {
		for (let index = 0; index < payload.additional_rate_limits.length; index++) {
			const value = payload.additional_rate_limits[index];
			if (!isRecord(value)) continue;
			const rawName =
				typeof value.limit_name === "string" && value.limit_name.trim()
					? value.limit_name.trim()
					: typeof value.metered_feature === "string" && value.metered_feature.trim()
						? value.metered_feature.trim()
						: `Additional ${index + 1}`;
			const idSource =
				typeof value.metered_feature === "string" && value.metered_feature.trim() ? value.metered_feature : rawName;
			limits.push(
				...parseRateLimitWindows(value.rate_limit, fetchedAt, {
					idPrefix: slugify(idSource),
					labelPrefix: titleCase(rawName),
				}),
			);
		}
	}

	if (limits.length === 0) {
		return {
			status: "error",
			error: { code: "malformed_response", message: "Subscription usage did not contain any quota windows." },
		};
	}

	const plan =
		typeof payload.plan_type === "string" && payload.plan_type.trim() ? payload.plan_type.trim() : undefined;
	return {
		status: "success",
		snapshot: {
			providerId: "openai-codex",
			fetchedAt,
			...(plan === undefined ? {} : { plan }),
			limits,
		},
	};
}

function httpError(status: number): SubscriptionUsageResult {
	if (status === 401) {
		return {
			status: "error",
			error: { code: "unauthorized", message: "Subscription usage authentication was rejected." },
		};
	}
	if (status === 429) {
		return {
			status: "error",
			error: { code: "rate_limited", message: "Subscription usage is temporarily rate limited." },
		};
	}
	return {
		status: "error",
		error: { code: "unavailable", message: "Subscription usage is temporarily unavailable." },
	};
}

export async function fetchOpenAICodexSubscriptionUsage(
	credentials: OAuthCredentials,
	options: SubscriptionUsageFetchOptions = {},
): Promise<SubscriptionUsageResult> {
	const accountId = typeof credentials.accountId === "string" ? credentials.accountId.trim() : "";
	if (!accountId) {
		return {
			status: "error",
			error: { code: "unauthorized", message: "Subscription usage account metadata is missing." },
		};
	}

	let response: Response;
	try {
		response = await fetch(OPENAI_CODEX_USAGE_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${credentials.access}`,
				"ChatGPT-Account-Id": accountId,
			},
			signal: options.signal,
		});
	} catch {
		return options.signal?.aborted
			? { status: "error", error: { code: "timeout", message: "Subscription usage request timed out." } }
			: {
					status: "error",
					error: { code: "unavailable", message: "Subscription usage is temporarily unavailable." },
				};
	}

	if (!response.ok) return httpError(response.status);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return {
			status: "error",
			error: { code: "malformed_response", message: "Subscription usage returned invalid JSON." },
		};
	}

	return parseOpenAICodexUsage(payload, Date.now());
}
