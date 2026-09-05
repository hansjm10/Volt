import type { Api, InferenceSpeed, Model, Usage } from "../types.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const TOKENS_PER_MILLION = 1_000_000;

interface PriorityTokenRates {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

const OPENAI_PRIORITY_RATES: Readonly<Partial<Record<string, PriorityTokenRates>>> = {
	"gpt-6-astra": { input: 20, cacheRead: 2, cacheWrite: 25, output: 100 },
	"gpt-5.6": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 60 },
	"gpt-5.6-sol": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 60 },
	"gpt-5.6-terra": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
	"gpt-5.6-luna": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
	"gpt-5.5": { input: 12.5, cacheRead: 1.25, cacheWrite: 0, output: 75 },
	"gpt-5.4": { input: 5, cacheRead: 0.5, cacheWrite: 0, output: 30 },
	"gpt-5.4-mini": { input: 1.5, cacheRead: 0.15, cacheWrite: 0, output: 9 },
	"gpt-5.2": { input: 3.5, cacheRead: 0.35, cacheWrite: 0, output: 28 },
	"gpt-5.1": { input: 2.5, cacheRead: 0.25, cacheWrite: 0, output: 20 },
	"gpt-5": { input: 2.5, cacheRead: 0.25, cacheWrite: 0, output: 20 },
	"gpt-5-mini": { input: 0.45, cacheRead: 0.045, cacheWrite: 0, output: 3.6 },
	"gpt-4.1": { input: 3.5, cacheRead: 0.875, cacheWrite: 0, output: 14 },
	"gpt-4.1-mini": { input: 0.7, cacheRead: 0.175, cacheWrite: 0, output: 2.8 },
	"gpt-4.1-nano": { input: 0.2, cacheRead: 0.05, cacheWrite: 0, output: 0.8 },
	"gpt-4o": { input: 4.25, cacheRead: 2.125, cacheWrite: 0, output: 17 },
	"gpt-4o-2024-05-13": { input: 8.75, cacheRead: 0, cacheWrite: 0, output: 26.25 },
	"gpt-4o-mini": { input: 0.25, cacheRead: 0.125, cacheWrite: 0, output: 1 },
	o3: { input: 3.5, cacheRead: 0.875, cacheWrite: 0, output: 14 },
	"o4-mini": { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
};

const OPENAI_CODEX_FAST_MODELS = new Set([
	"gpt-6-astra",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
]);

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

function isDirectOpenAIFastModel(model: Pick<Model<Api>, "api" | "provider" | "baseUrl" | "id">): boolean {
	return (
		model.provider === "openai" &&
		model.api === "openai-responses" &&
		normalizeBaseUrl(model.baseUrl) === OPENAI_BASE_URL &&
		Object.hasOwn(OPENAI_PRIORITY_RATES, model.id)
	);
}

function isOpenAICodexFastModel(model: Pick<Model<Api>, "api" | "provider" | "baseUrl" | "id">): boolean {
	return (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		normalizeBaseUrl(model.baseUrl) === OPENAI_CODEX_BASE_URL &&
		OPENAI_CODEX_FAST_MODELS.has(model.id)
	);
}

export function supportsFastInference(model: Pick<Model<Api>, "api" | "provider" | "baseUrl" | "id">): boolean {
	return isDirectOpenAIFastModel(model) || isOpenAICodexFastModel(model);
}

export function getFastInferenceServiceTier(
	model: Pick<Model<Api>, "api" | "provider" | "baseUrl" | "id">,
	inferenceSpeed: InferenceSpeed | undefined,
): "default" | "priority" | undefined {
	if (inferenceSpeed === undefined || !supportsFastInference(model)) {
		return undefined;
	}
	return inferenceSpeed === "fast" ? "priority" : "default";
}

export function applyOpenAIPriorityPricing(
	usage: Usage,
	model: Pick<Model<"openai-responses">, "api" | "provider" | "baseUrl" | "id">,
): boolean {
	if (!isDirectOpenAIFastModel(model)) {
		return false;
	}
	const rates = OPENAI_PRIORITY_RATES[model.id];
	if (!rates) {
		return false;
	}

	usage.cost.input = (usage.input * rates.input) / TOKENS_PER_MILLION;
	usage.cost.output = (usage.output * rates.output) / TOKENS_PER_MILLION;
	usage.cost.cacheRead = (usage.cacheRead * rates.cacheRead) / TOKENS_PER_MILLION;
	usage.cost.cacheWrite = (usage.cacheWrite * rates.cacheWrite) / TOKENS_PER_MILLION;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return true;
}
