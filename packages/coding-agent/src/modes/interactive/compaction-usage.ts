import type { StopReason, Usage } from "@hansjm10/volt-ai";

const STOP_REASONS = new Set<string>(["stop", "length", "toolUse", "error", "aborted"] satisfies StopReason[]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestUsage(value: unknown): value is Pick<Usage, (typeof USAGE_FIELDS)[number]> {
	return (
		isRecord(value) &&
		USAGE_FIELDS.every((field) => {
			const count = value[field];
			return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && !Object.is(count, -0);
		})
	);
}

/** Format completion-only request lines without trusting extension/imported compaction details. */
export function formatCompactionUsage(details: unknown): string[] {
	if (!isRecord(details) || !Array.isArray(details.requests)) return [];

	const lines: string[] = [];
	const requests: unknown[] = details.requests;
	for (const request of requests) {
		if (
			!isRecord(request) ||
			(request.strategy !== "native" && request.strategy !== "chunked") ||
			typeof request.attempt !== "number" ||
			!Number.isSafeInteger(request.attempt) ||
			request.attempt < 1 ||
			typeof request.provider !== "string" ||
			request.provider.trim().length === 0 ||
			typeof request.model !== "string" ||
			request.model.trim().length === 0 ||
			(request.stopReason !== undefined &&
				(typeof request.stopReason !== "string" || !STOP_REASONS.has(request.stopReason)))
		) {
			continue;
		}

		const strategy = request.strategy === "native" ? "Native" : "Chunked";
		const label = `${strategy} compaction request ${request.attempt} (${request.stopReason ?? "no terminal response"})`;
		const usage = request.usage;
		if (request.stopReason === undefined || !isRequestUsage(usage)) {
			lines.push(`${label}: cache usage unavailable`);
			continue;
		}

		// Output tokens do not participate in prompt cache-hit accounting.
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens === 0 || !Number.isSafeInteger(promptTokens)) {
			lines.push(`${label}: cache usage unavailable`);
			continue;
		}
		const hitRate = ((usage.cacheRead / promptTokens) * 100).toFixed(1);
		lines.push(
			`${label}: ${usage.cacheRead.toLocaleString()} cached / ${promptTokens.toLocaleString()} prompt tokens — ${hitRate}% hit`,
		);
	}
	return lines;
}
