import type { CacheRetention, Model, ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export function resolvePromptCacheRetention(
	model: Model<string>,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
	options: { forceShort?: boolean } = {},
): CacheRetention {
	const requested = cacheRetention ?? (getProviderEnvValue("VOLT_CACHE_RETENTION", env) === "long" ? "long" : "short");
	if (requested === "none") return "none";
	if (!model.promptCache) return options.forceShort ? "short" : "none";
	if (requested === "long" && model.promptCache.retention.long) return "long";
	return "short";
}

export function supportsPromptCacheMode(model: Model<string>, mode: "implicit" | "explicit"): boolean {
	return model.promptCache?.modes.includes(mode) ?? false;
}
