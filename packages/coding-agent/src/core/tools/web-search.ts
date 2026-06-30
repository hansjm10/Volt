import type { AgentTool } from "@earendil-works/volt-agent-core";
import type { Api, Model } from "@earendil-works/volt-ai";
import { Text } from "@earendil-works/volt-tui";
import { type Static, Type } from "typebox";
import { VERSION } from "../../config.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getVoltUserAgent } from "../../utils/volt-user-agent.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_DOMAINS = 10;
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const webSearchSchema = Type.Object({
	query: Type.String({
		description: "Web search query. Use a concise natural-language query or exact phrase.",
		minLength: 1,
		maxLength: 400,
	}),
	limit: Type.Optional(
		Type.Number({
			description: `Maximum number of results to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
		}),
	),
	domains: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Optional domains to restrict results to, e.g. ['docs.rs', 'github.com'].",
			maxItems: MAX_DOMAINS,
		}),
	),
	recencyDays: Type.Optional(
		Type.Number({ description: "Only return results from the last N days when the backend supports freshness." }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchRequest {
	query: string;
	limit: number;
	domains?: string[];
	recencyDays?: number;
}

export interface WebSearchResult {
	title: string;
	url: string;
	snippet?: string;
	source?: string;
	publishedAt?: string;
}

export interface WebSearchResponse {
	provider: string;
	query?: string;
	results: WebSearchResult[];
	content?: string;
}

export interface WebSearchToolDetails {
	query: string;
	submittedQuery?: string;
	provider: string;
	results: WebSearchResult[];
	resultLimitReached?: number;
	truncation?: TruncationResult;
}

export interface WebSearchOperations {
	search: (request: WebSearchRequest, signal?: AbortSignal) => Promise<WebSearchResponse> | WebSearchResponse;
}

export type WebSearchFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface WebSearchModelContext {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	sessionId?: string;
}

export type WebSearchModelContextProvider = () =>
	| Promise<WebSearchModelContext | undefined>
	| WebSearchModelContext
	| undefined;

export interface DefaultWebSearchOperationsOptions {
	env?: Record<string, string | undefined>;
	fetcher?: WebSearchFetcher;
	modelContext?: WebSearchModelContextProvider;
	timeoutMs?: number;
	now?: () => Date;
}

export interface WebSearchToolOptions {
	operations?: WebSearchOperations;
}

interface JsonFetchOptions {
	input: string;
	init: RequestInit;
	fetcher: WebSearchFetcher;
	provider: string;
	signal?: AbortSignal;
	timeoutMs: number;
}

type RenderableWebSearchResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: WebSearchToolDetails;
};

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_LIMIT;
	}
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizeRecencyDays(recencyDays: number | undefined): number | undefined {
	if (recencyDays === undefined || !Number.isFinite(recencyDays) || recencyDays <= 0) {
		return undefined;
	}
	return Math.max(1, Math.floor(recencyDays));
}

function normalizeDomain(value: string): string | undefined {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return undefined;
	const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
	const host = withoutProtocol.split(/[/?#]/, 1)[0]?.replace(/^\*\./, "");
	if (!host || host.length > 253 || !host.includes(".")) return undefined;
	if (!/^[a-z0-9.-]+$/.test(host)) return undefined;
	return host;
}

function normalizeDomains(domains: string[] | undefined): string[] | undefined {
	if (!domains || domains.length === 0) {
		return undefined;
	}
	const unique = new Set<string>();
	for (const domain of domains) {
		const normalized = normalizeDomain(domain);
		if (normalized) {
			unique.add(normalized);
		}
		if (unique.size >= MAX_DOMAINS) {
			break;
		}
	}
	return unique.size > 0 ? [...unique] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&#(\d+);/g, (match, code: string) => {
			const point = Number.parseInt(code, 10);
			if (!Number.isFinite(point)) {
				return match;
			}
			try {
				return String.fromCodePoint(point);
			} catch {
				return match;
			}
		});
}

function cleanText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = decodeHtmlEntities(value.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

function hostnameFromUrl(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

function parseSearchResult(value: unknown): WebSearchResult | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const title = cleanText(getString(value, "title") ?? getString(value, "name"));
	const url = getString(value, "url") ?? getString(value, "link");
	if (!title || !url) {
		return undefined;
	}
	const snippet = cleanText(
		getString(value, "snippet") ??
			getString(value, "description") ??
			getString(value, "content") ??
			getString(value, "text"),
	);
	const publishedAt =
		getString(value, "publishedAt") ??
		getString(value, "published_at") ??
		getString(value, "page_age") ??
		getString(value, "age");
	const source = cleanText(getString(value, "source")) ?? hostnameFromUrl(url);
	return {
		title,
		url,
		...(snippet ? { snippet } : {}),
		...(source ? { source } : {}),
		...(publishedAt ? { publishedAt } : {}),
	};
}

function parseSearchResults(value: unknown): WebSearchResult[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const results: WebSearchResult[] = [];
	for (const item of value) {
		const result = parseSearchResult(item);
		if (result) {
			results.push(result);
		}
	}
	return results;
}

function normalizeSearchResponse(value: unknown, provider: string, query?: string): WebSearchResponse {
	if (!isRecord(value)) {
		throw new Error(`${provider} returned an invalid JSON response`);
	}
	const web = isRecord(value.web) ? value.web : undefined;
	const rawResults = Array.isArray(value.results) ? value.results : web?.results;
	const content = getString(value, "content") ?? getString(value, "output");
	return {
		provider: getString(value, "provider") ?? provider,
		query: getString(value, "query") ?? query,
		results: parseSearchResults(rawResults),
		...(content ? { content } : {}),
	};
}

async function readResponseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function extractErrorMessage(body: unknown): string | undefined {
	if (typeof body === "string") {
		return body.trim().slice(0, 500) || undefined;
	}
	if (!isRecord(body)) {
		return undefined;
	}
	const direct = getString(body, "message") ?? getString(body, "error") ?? getString(body, "detail");
	if (direct) {
		return direct.slice(0, 500);
	}
	const error = body.error;
	if (isRecord(error)) {
		const nested = getString(error, "message") ?? getString(error, "detail");
		if (nested) {
			return nested.slice(0, 500);
		}
	}
	return undefined;
}

async function fetchJson({ input, init, fetcher, provider, signal, timeoutMs }: JsonFetchOptions): Promise<unknown> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		response = await fetcher(input, { ...init, signal: requestSignal });
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new Error(`${provider} request timed out`);
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`${provider} request timed out`);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${provider} request failed: ${message}`);
	}

	const body = await readResponseBody(response);
	if (!response.ok) {
		const message = extractErrorMessage(body);
		throw new Error(`${provider} returned HTTP ${response.status}${message ? `: ${message}` : ""}`);
	}
	if (typeof body === "string") {
		throw new Error(`${provider} returned a non-JSON response`);
	}
	return body;
}

function buildDomainScopedQuery(query: string, domains: string[] | undefined): string {
	if (!domains || domains.length === 0) {
		return query;
	}
	const domainQuery = domains.map((domain) => `site:${domain}`).join(" OR ");
	return `${query} (${domainQuery})`;
}

function formatDateForBrave(date: Date): string {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getBraveFreshness(recencyDays: number | undefined, now: () => Date): string | undefined {
	if (!recencyDays) {
		return undefined;
	}
	const end = now();
	const start = new Date(end.getTime() - recencyDays * 24 * 60 * 60 * 1000);
	return `${formatDateForBrave(start)}to${formatDateForBrave(end)}`;
}

function makeHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"User-Agent": getVoltUserAgent(VERSION),
		accept: "application/json",
		...extra,
	};
}

function setHeaders(headers: Headers, values: Record<string, string> | undefined): void {
	for (const [key, value] of Object.entries(values ?? {})) {
		headers.set(key, value);
	}
}

function resolveOpenAISearchUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/alpha/search`;
}

function resolveCodexSearchUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/alpha/search")) return normalized;
	if (normalized.endsWith("/codex/responses")) return `${normalized.slice(0, -"/responses".length)}/alpha/search`;
	if (normalized.endsWith("/codex")) return `${normalized}/alpha/search`;
	return `${normalized}/codex/alpha/search`;
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.protocol === "https:" && url.hostname === "api.openai.com";
	} catch {
		return false;
	}
}

function isOfficialChatGptBackendBaseUrl(baseUrl: string | undefined): boolean {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api");
	} catch {
		return false;
	}
}

function supportsOpenAISearchBackend(model: Model<Api>): boolean {
	if (model.provider === "openai-codex") {
		return isOfficialChatGptBackendBaseUrl(model.baseUrl);
	}
	return model.provider === "openai" && isOfficialOpenAIBaseUrl(model.baseUrl);
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | undefined {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function extractChatGptAccountId(token: string): string {
	const payload = decodeBase64UrlJson(token.split(".")[1] ?? "");
	const auth = isRecord(payload?.[JWT_CLAIM_PATH]) ? payload[JWT_CLAIM_PATH] : undefined;
	const accountId = isRecord(auth) ? getString(auth, "chatgpt_account_id") : undefined;
	if (!accountId) {
		throw new Error("Failed to extract ChatGPT account id from OpenAI Codex token");
	}
	return accountId;
}

function codexResponseLength(limit: number): "short" | "medium" | "long" {
	if (limit <= 3) return "short";
	if (limit <= 7) return "medium";
	return "long";
}

function codexExternalWebAccess(env: Record<string, string | undefined>): boolean {
	return env.VOLT_WEB_SEARCH_MODE?.trim().toLowerCase() === "live";
}

function buildCodexSearchBody(
	context: WebSearchModelContext,
	request: WebSearchRequest,
	env: Record<string, string | undefined>,
): Record<string, unknown> {
	const searchQuery: Record<string, unknown> = { q: request.query };
	if (request.recencyDays) {
		searchQuery.recency = request.recencyDays;
	}
	if (request.domains && request.domains.length > 0) {
		searchQuery.domains = request.domains;
	}
	return {
		id: context.sessionId ?? "volt-web-search",
		model: context.model.id,
		commands: {
			search_query: [searchQuery],
			response_length: codexResponseLength(request.limit),
		},
		settings: {
			allowed_callers: ["direct"],
			external_web_access: codexExternalWebAccess(env),
		},
	};
}

async function searchOpenAIBackend(
	context: WebSearchModelContext,
	request: WebSearchRequest,
	env: Record<string, string | undefined>,
	fetcher: WebSearchFetcher,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<WebSearchResponse> {
	const model = context.model;
	const isCodexModel = model.provider === "openai-codex";
	const headers = new Headers(makeHeaders({ "content-type": "application/json" }));
	setHeaders(headers, context.headers);
	if (!context.apiKey) {
		throw new Error(`web_search requires authentication for ${model.provider}/${model.id}`);
	}
	headers.set("authorization", `Bearer ${context.apiKey}`);

	const provider = isCodexModel ? "openai-codex" : "openai";
	const input = isCodexModel ? resolveCodexSearchUrl(model.baseUrl) : resolveOpenAISearchUrl(model.baseUrl);
	if (isCodexModel) {
		headers.set("chatgpt-account-id", extractChatGptAccountId(context.apiKey));
		headers.set("originator", "volt");
	}

	const body = await fetchJson({
		input,
		init: {
			method: "POST",
			headers,
			body: JSON.stringify(buildCodexSearchBody(context, request, env)),
		},
		fetcher,
		provider: `${provider} web search`,
		signal,
		timeoutMs,
	});
	if (!isRecord(body)) {
		throw new Error(`${provider} web search returned an invalid JSON response`);
	}
	const content = getString(body, "output");
	if (!content) {
		return normalizeSearchResponse(body, provider, request.query);
	}
	return {
		provider,
		query: request.query,
		results: [],
		content,
	};
}

async function searchCustomEndpoint(
	endpoint: string,
	apiKey: string | undefined,
	request: WebSearchRequest,
	fetcher: WebSearchFetcher,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<WebSearchResponse> {
	const headers = makeHeaders({ "content-type": "application/json" });
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}
	const body = await fetchJson({
		input: endpoint,
		init: {
			method: "POST",
			headers,
			body: JSON.stringify(request),
		},
		fetcher,
		provider: "Volt web search endpoint",
		signal,
		timeoutMs,
	});
	return normalizeSearchResponse(body, "custom", request.query);
}

async function searchBrave(
	apiKey: string,
	request: WebSearchRequest,
	fetcher: WebSearchFetcher,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	now: () => Date,
): Promise<WebSearchResponse> {
	const submittedQuery = buildDomainScopedQuery(request.query, request.domains);
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", submittedQuery);
	url.searchParams.set("count", String(request.limit));
	url.searchParams.set("result_filter", "web");
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("extra_snippets", "false");
	const freshness = getBraveFreshness(request.recencyDays, now);
	if (freshness) {
		url.searchParams.set("freshness", freshness);
	}

	const body = await fetchJson({
		input: url.toString(),
		init: {
			method: "GET",
			headers: makeHeaders({ "X-Subscription-Token": apiKey }),
		},
		fetcher,
		provider: "Brave Search API",
		signal,
		timeoutMs,
	});
	return normalizeSearchResponse(body, "brave", submittedQuery);
}

export function createDefaultWebSearchOperations(options: DefaultWebSearchOperationsOptions = {}): WebSearchOperations {
	const env = options.env ?? process.env;
	const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
	const modelContext = options.modelContext;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());
	return {
		async search(request, signal) {
			if (isTruthyEnvFlag(env.VOLT_OFFLINE)) {
				throw new Error("web_search is unavailable because VOLT_OFFLINE is enabled");
			}

			const endpoint = env.VOLT_WEB_SEARCH_URL?.trim();
			if (endpoint) {
				const apiKey = env.VOLT_WEB_SEARCH_API_KEY?.trim();
				return searchCustomEndpoint(endpoint, apiKey, request, fetcher, signal, timeoutMs);
			}

			const context = await modelContext?.();
			if (context && supportsOpenAISearchBackend(context.model)) {
				return searchOpenAIBackend(context, request, env, fetcher, signal, timeoutMs);
			}

			const braveApiKey = env.BRAVE_SEARCH_API_KEY?.trim();
			if (braveApiKey) {
				return searchBrave(braveApiKey, request, fetcher, signal, timeoutMs, now);
			}

			throw new Error(
				"web_search is not configured. Use an authenticated OpenAI/OpenAI Codex model, set VOLT_WEB_SEARCH_URL, or set BRAVE_SEARCH_API_KEY.",
			);
		},
	};
}

function formatRecency(recencyDays: number): string {
	return recencyDays === 1 ? "last day" : `last ${recencyDays} days`;
}

function createOutput(
	request: WebSearchRequest,
	response: WebSearchResponse,
): {
	text: string;
	details: WebSearchToolDetails;
} {
	const normalizedResults = response.results
		.map((result) => parseSearchResult(result))
		.filter((result): result is WebSearchResult => result !== undefined);
	const results = normalizedResults.slice(0, request.limit);
	const lines: string[] = [`Web search results (${response.provider})`, `Query: ${request.query}`];
	if (response.query && response.query !== request.query) {
		lines.push(`Submitted query: ${response.query}`);
	}
	if (request.domains && request.domains.length > 0) {
		lines.push(`Domains: ${request.domains.join(", ")}`);
	}
	if (request.recencyDays) {
		lines.push(`Recency: ${formatRecency(request.recencyDays)}`);
	}

	if (response.content) {
		lines.push("", response.content.trim());
	} else if (results.length === 0) {
		lines.push("", "No web results found");
	} else {
		lines.push("");
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			lines.push(`[${i + 1}] ${result.title}`);
			lines.push(`URL: ${result.url}`);
			if (result.snippet) {
				lines.push(`Snippet: ${result.snippet}`);
			}
			if (result.publishedAt) {
				lines.push(`Published: ${result.publishedAt}`);
			}
			if (result.source && result.source !== hostnameFromUrl(result.url)) {
				lines.push(`Source: ${result.source}`);
			}
			if (i < results.length - 1) {
				lines.push("");
			}
		}
	}

	const rawOutput = lines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const details: WebSearchToolDetails = {
		query: request.query,
		...(response.query ? { submittedQuery: response.query } : {}),
		provider: response.provider,
		results,
	};
	const notices: string[] = [];
	if (normalizedResults.length > request.limit) {
		details.resultLimitReached = request.limit;
		notices.push(`${request.limit} results limit reached`);
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}

	let text = truncation.content;
	if (notices.length > 0) {
		text += `\n\n[${notices.join(". ")}]`;
	}
	return { text, details };
}

function formatWebSearchCall(
	args: { query?: string; limit?: number; domains?: string[]; recencyDays?: number } | undefined,
	theme: Theme,
): string {
	const query = str(args?.query);
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("web_search")) +
		" " +
		(query === null ? invalidArg : theme.fg("accent", query || "..."));
	if (Array.isArray(args?.domains) && args.domains.length > 0) {
		text += theme.fg("toolOutput", ` (${args.domains.join(", ")})`);
	}
	if (typeof args?.recencyDays === "number") {
		text += theme.fg("toolOutput", ` ${formatRecency(args.recencyDays)}`);
	}
	if (typeof args?.limit === "number") {
		text += theme.fg("toolOutput", ` limit ${args.limit}`);
	}
	return text;
}

function formatWebSearchResult(
	result: RenderableWebSearchResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 16;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createWebSearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const ops = options?.operations ?? createDefaultWebSearchOperations();
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for current or external information. Returns ranked results with titles, URLs, snippets, and publication dates when available. Use domains to restrict sources and recencyDays for fresh results.",
		promptSnippet: "Search the web for current or external information",
		promptGuidelines: [
			"Use web_search when the user asks for current, recently changed, external, or source-attributed information.",
			"After using web_search, cite relevant URLs in your response when the answer depends on search results.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, params: WebSearchToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const query = params.query.trim();
			if (!query) {
				throw new Error("web_search query must not be empty");
			}
			const domains = normalizeDomains(params.domains);
			const recencyDays = normalizeRecencyDays(params.recencyDays);
			const request: WebSearchRequest = {
				query,
				limit: normalizeLimit(params.limit),
				...(domains ? { domains } : {}),
				...(recencyDays ? { recencyDays } : {}),
			};
			const response = await ops.search(request, signal);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const { text, details } = createOutput(request, response);
			return {
				content: [{ type: "text", text }],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchResult(result as RenderableWebSearchResult, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
