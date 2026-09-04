import { getModel } from "../src/models.ts";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../src/providers/cloudflare.ts";
import type { Model } from "../src/types.ts";

// Exercise Workers AI gateway routing even when the upstream gateway catalog omits it.
export function getCloudflareAiGatewayWorkersModel(): Model<"openai-completions"> {
	const model = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");
	return {
		...model,
		id: `workers-ai/${model.id}`,
		provider: "cloudflare-ai-gateway",
		baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		compat: { ...model.compat, sendSessionAffinityHeaders: true },
	};
}

export function hasCloudflareWorkersAICredentials(): boolean {
	return !!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID;
}

export function hasCloudflareAiGatewayCredentials(): boolean {
	return (
		!!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_GATEWAY_ID
	);
}
