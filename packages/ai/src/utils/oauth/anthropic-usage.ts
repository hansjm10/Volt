import type {
	OAuthCredentials,
	SubscriptionUsageFetchOptions,
	SubscriptionUsageLimit,
	SubscriptionUsageResult,
} from "./types.ts";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const LEGACY_BUCKET_LABELS: Readonly<Record<string, { id: string; label: string }>> = {
	five_hour: { id: "session", label: "Session" },
	seven_day: { id: "weekly", label: "Weekly" },
	seven_day_opus: { id: "weekly-scoped:opus", label: "Weekly · Opus" },
	seven_day_sonnet: { id: "weekly-scoped:sonnet", label: "Weekly · Sonnet" },
};
const NON_LIMIT_KEYS = new Set(["extra_usage", "limits", "spend"]);
const MODEL_FAMILIES = ["opus", "sonnet", "fable", "mythos"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUsedPercent(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
}

function parseIsoTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function slugify(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "limit"
	);
}

function titleCase(value: string): string {
	return value
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function modelScopeId(displayName: string): string {
	const normalized = displayName.toLowerCase();
	return MODEL_FAMILIES.find((family) => normalized.includes(family)) ?? slugify(displayName);
}

function parseLegacyBucket(key: string, value: unknown): SubscriptionUsageLimit | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = normalizeUsedPercent(value.utilization);
	if (usedPercent === undefined) return undefined;
	const known = LEGACY_BUCKET_LABELS[key];
	const resetsAt = parseIsoTimestamp(value.resets_at);
	return {
		id: known?.id ?? slugify(key),
		label: known?.label ?? titleCase(key),
		usedPercent,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function parseScopedLimit(value: unknown): SubscriptionUsageLimit | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = normalizeUsedPercent(value.percent);
	if (usedPercent === undefined) return undefined;

	const kind = typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "limit";
	const scope = isRecord(value.scope) ? value.scope : undefined;
	const model = isRecord(scope?.model) ? scope.model : undefined;
	const displayName =
		typeof model?.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : undefined;
	const kindId = slugify(kind);
	const modelId = displayName ? modelScopeId(displayName) : undefined;
	const id = modelId ? `${kindId}:${modelId}` : kindId;
	const kindLabel = kind === "weekly_scoped" ? "Weekly" : titleCase(kind);
	const resetsAt = parseIsoTimestamp(value.resets_at);

	return {
		id,
		label: displayName ? `${kindLabel} · ${displayName}` : kindLabel,
		usedPercent,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function parseAnthropicUsage(payload: unknown, fetchedAt: number): SubscriptionUsageResult {
	if (!isRecord(payload)) {
		return {
			status: "error",
			error: { code: "malformed_response", message: "Subscription usage returned an unsupported response." },
		};
	}

	const limits = new Map<string, SubscriptionUsageLimit>();
	for (const [key, value] of Object.entries(payload)) {
		if (NON_LIMIT_KEYS.has(key)) continue;
		const limit = parseLegacyBucket(key, value);
		if (limit) limits.set(limit.id, limit);
	}

	if (Array.isArray(payload.limits)) {
		for (const value of payload.limits) {
			const limit = parseScopedLimit(value);
			if (limit) limits.set(limit.id, limit);
		}
	}

	if (limits.size === 0) {
		return {
			status: "error",
			error: { code: "malformed_response", message: "Subscription usage did not contain any quota windows." },
		};
	}

	return {
		status: "success",
		snapshot: {
			providerId: "anthropic",
			fetchedAt,
			limits: Array.from(limits.values()),
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

export async function fetchAnthropicSubscriptionUsage(
	credentials: OAuthCredentials,
	options: SubscriptionUsageFetchOptions = {},
): Promise<SubscriptionUsageResult> {
	let response: Response;
	try {
		response = await fetch(ANTHROPIC_USAGE_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${credentials.access}`,
				"anthropic-beta": "oauth-2025-04-20",
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

	return parseAnthropicUsage(payload, Date.now());
}
