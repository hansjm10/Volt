import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type { ContextUsage } from "./extensions/types.ts";

/** Lifetime token and provider-cost totals for one session or isolated workflow. */
export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * UI-safe usage state for work that is not owned by the currently open session.
 * Context describes the active isolated session while totals may span multiple
 * sequential sessions in the same workflow.
 */
export interface SessionUsageProjection {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	fastModeEnabled: boolean;
	contextUsage?: ContextUsage;
	totals: SessionUsageTotals;
	latestCacheHitRate?: number;
}
