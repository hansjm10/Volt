import { Buffer } from "node:buffer";
import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import {
	createDefaultWebSearchOperations,
	createWebSearchTool,
	FALLBACK_MAX_LINES,
	MAX_SNIPPET_CHARS,
	parseProviderContent,
	type WebSearchFetcher,
	type WebSearchOperations,
	type WebSearchRequest,
} from "../src/index.ts";

// Codex wraps citation ids in private-use-area delimiters.
const CITE_START = "\u{E200}";
const CITE_MID = "\u{E202}";
const CITE_END = "\u{E201}";

function citation(index: number): string {
	return `${CITE_START}cite${CITE_MID}turn1search${index}${CITE_END}`;
}

/** Build a blob shaped like real Codex search output: header, detail line, page body. */
function codexBlob(count: number, options: { body?: string } = {}): string {
	const body = options.body ?? "Page body text";
	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		parts.push(`Result ${i} title (https://example.com/${i})`);
		parts.push(
			`${citation(i)} [wordlim: 200] Published: 3 months ago; Crawled: 2 months ago; Snippet body for result ${i}.`,
		);
		parts.push("", `# Result ${i} heading`, body, "");
	}
	return parts.join("\n");
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
}

function getHeader(headers: RequestInit["headers"] | undefined, name: string): string | undefined {
	if (!headers) {
		return undefined;
	}
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
		return match?.[1];
	}
	const value = headers[name] ?? headers[name.toLowerCase()];
	return typeof value === "string" ? value : undefined;
}

function getJsonBody(init: RequestInit): Record<string, unknown> {
	expect(typeof init.body).toBe("string");
	return JSON.parse(init.body as string) as Record<string, unknown>;
}

function modelForSearch(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

function jwtWithAccountId(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("web_search tool", () => {
	it("formats injected operation results and normalizes filters", async () => {
		let capturedRequest: WebSearchRequest | undefined;
		const operations: WebSearchOperations = {
			search: async (request) => {
				capturedRequest = request;
				return {
					provider: "test",
					query: "Volt release notes (site:docs.volt.dev)",
					results: [
						{
							title: "Volt changelog",
							url: "https://docs.volt.dev/changelog",
							snippet: "Latest Volt changes",
							source: "Volt Docs",
							publishedAt: "2026-06-29",
						},
					],
				};
			},
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-1", {
			query: "  Volt release notes  ",
			limit: 2,
			domains: ["https://docs.volt.dev/path", "DOCS.VOLT.DEV", "bad domain"],
			recencyDays: 7.9,
		});

		expect(capturedRequest).toEqual({
			query: "Volt release notes",
			limit: 2,
			domains: ["docs.volt.dev"],
			recencyDays: 7,
		});
		expect(getTextOutput(result)).toContain("[1] Volt changelog");
		expect(getTextOutput(result)).toContain("URL: https://docs.volt.dev/changelog");
		expect(result.details).toEqual({
			query: "Volt release notes",
			submittedQuery: "Volt release notes (site:docs.volt.dev)",
			provider: "test",
			results: [
				{
					title: "Volt changelog",
					url: "https://docs.volt.dev/changelog",
					snippet: "Latest Volt changes",
					source: "Volt Docs",
					publishedAt: "2026-06-29",
				},
			],
		});
	});

	it("clamps requested result limits and reports backend overrun", async () => {
		let capturedRequest: WebSearchRequest | undefined;
		const results = Array.from({ length: 12 }, (_, index) => ({
			title: `Result ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			snippet: `Snippet ${index + 1}`,
			source: "Example",
		}));
		const operations: WebSearchOperations = {
			search: async (request) => {
				capturedRequest = request;
				return { provider: "test", results };
			},
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-2", { query: "many results", limit: 99 });

		expect(capturedRequest).toEqual({ query: "many results", limit: 10 });
		expect(result.details).toEqual({
			query: "many results",
			provider: "test",
			results: results.slice(0, 10),
			resultLimitReached: 10,
		});
		expect(getTextOutput(result)).toContain("[10] Result 10");
		expect(getTextOutput(result)).not.toContain("Result 11");
	});

	it("renders backend-provided search content", async () => {
		const operations: WebSearchOperations = {
			search: async () => ({
				provider: "openai",
				query: "Volt AI",
				results: [],
				content: "Backend-rendered search output\nSource: https://example.com/volt",
			}),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-content", { query: "Volt AI" });

		expect(getTextOutput(result)).toContain("Backend-rendered search output");
		expect(result.details).toEqual({
			query: "Volt AI",
			submittedQuery: "Volt AI",
			provider: "openai",
			results: [],
		});
	});

	it("does not call operations when already aborted", async () => {
		let called = false;
		const operations: WebSearchOperations = {
			search: async () => {
				called = true;
				return { provider: "test", results: [] };
			},
		};
		const controller = new AbortController();
		controller.abort();
		const tool = createWebSearchTool(process.cwd(), { operations });

		await expect(tool.execute("web-search-3", { query: "abort" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(called).toBe(false);
	});

	it("fails clearly when the default backend is not configured", async () => {
		const operations = createDefaultWebSearchOperations({ env: {} });

		await expect(operations.search({ query: "volt", limit: 5 })).rejects.toThrow(
			"web_search is not configured. Use an authenticated OpenAI/OpenAI Codex model, set VOLT_WEB_SEARCH_URL, or set BRAVE_SEARCH_API_KEY.",
		);
	});

	it("uses OpenAI alpha search for authenticated OpenAI models", async () => {
		const fetcher: WebSearchFetcher = async (input, init) => {
			expect(input).toBe("https://api.openai.com/v1/alpha/search");
			expect(getHeader(init.headers, "authorization")).toBe("Bearer sk-openai");
			expect(getHeader(init.headers, "x-test-header")).toBe("yes");
			expect(getJsonBody(init)).toEqual({
				id: "session-openai",
				model: "gpt-test",
				commands: {
					search_query: [
						{
							q: "Volt AI",
							recency: 7,
							domains: ["example.com"],
						},
					],
					response_length: "short",
				},
				settings: {
					allowed_callers: ["direct"],
					external_web_access: false,
				},
			});
			return new Response(
				JSON.stringify({
					output: "OpenAI search output\nSource: https://example.com/volt",
				}),
				{ status: 200 },
			);
		};
		const operations = createDefaultWebSearchOperations({
			env: {},
			fetcher,
			modelContext: () => ({
				model: modelForSearch(),
				apiKey: "sk-openai",
				headers: { "x-test-header": "yes" },
				sessionId: "session-openai",
			}),
		});

		const result = await operations.search({
			query: "Volt AI",
			limit: 3,
			domains: ["example.com"],
			recencyDays: 7,
		});

		expect(result).toEqual({
			provider: "openai",
			query: "Volt AI",
			results: [],
			content: "OpenAI search output\nSource: https://example.com/volt",
		});
	});

	it("uses Codex alpha search for authenticated OpenAI Codex models", async () => {
		const fetcher: WebSearchFetcher = async (input, init) => {
			expect(input).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
			expect(getHeader(init.headers, "authorization")).toBe(`Bearer ${jwtWithAccountId("account-123")}`);
			expect(getHeader(init.headers, "chatgpt-account-id")).toBe("account-123");
			expect(getHeader(init.headers, "originator")).toBe("volt");
			expect(getJsonBody(init)).toEqual({
				id: "session-codex",
				model: "codex-test",
				commands: {
					search_query: [{ q: "Volt remote host" }],
					response_length: "short",
				},
				settings: {
					allowed_callers: ["direct"],
					external_web_access: true,
				},
			});
			return new Response(JSON.stringify({ output: "Codex search output" }), { status: 200 });
		};
		const token = jwtWithAccountId("account-123");
		const operations = createDefaultWebSearchOperations({
			env: { VOLT_WEB_SEARCH_MODE: "live" },
			fetcher,
			modelContext: () => ({
				model: modelForSearch({
					id: "codex-test",
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: "https://chatgpt.com/backend-api",
				}),
				apiKey: token,
				sessionId: "session-codex",
			}),
		});

		const result = await operations.search({ query: "Volt remote host", limit: 8 });

		expect(result).toEqual({
			provider: "openai-codex",
			query: "Volt remote host",
			results: [],
			content: "Codex search output",
		});
	});

	it("does not use Codex alpha search for custom providers using the Codex responses adapter", async () => {
		let called = false;
		const fetcher: WebSearchFetcher = async () => {
			called = true;
			return new Response(JSON.stringify({ output: "should not be used" }), { status: 200 });
		};
		const operations = createDefaultWebSearchOperations({
			env: {},
			fetcher,
			modelContext: () => ({
				model: modelForSearch({
					id: "custom-codex-compatible",
					api: "openai-codex-responses",
					provider: "custom-codex",
					baseUrl: "https://custom.example.test/backend-api",
				}),
				apiKey: jwtWithAccountId("account-123"),
				sessionId: "session-custom-codex",
			}),
		});

		await expect(operations.search({ query: "Volt remote host", limit: 5 })).rejects.toThrow(
			"web_search is not configured. Use an authenticated OpenAI/OpenAI Codex model, set VOLT_WEB_SEARCH_URL, or set BRAVE_SEARCH_API_KEY.",
		);
		expect(called).toBe(false);
	});

	it("does not send OpenAI Codex credentials to non-ChatGPT provider overrides", async () => {
		let called = false;
		const fetcher: WebSearchFetcher = async () => {
			called = true;
			return new Response(JSON.stringify({ output: "should not be used" }), { status: 200 });
		};
		const operations = createDefaultWebSearchOperations({
			env: {},
			fetcher,
			modelContext: () => ({
				model: modelForSearch({
					id: "codex-test",
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: "https://custom.example.test/backend-api",
				}),
				apiKey: jwtWithAccountId("account-123"),
				sessionId: "session-codex-override",
			}),
		});

		await expect(operations.search({ query: "Volt remote host", limit: 5 })).rejects.toThrow(
			"web_search is not configured. Use an authenticated OpenAI/OpenAI Codex model, set VOLT_WEB_SEARCH_URL, or set BRAVE_SEARCH_API_KEY.",
		);
		expect(called).toBe(false);
	});

	it("does not send OpenAI API credentials to non-HTTPS provider overrides", async () => {
		let called = false;
		const fetcher: WebSearchFetcher = async () => {
			called = true;
			return new Response(JSON.stringify({ output: "should not be used" }), { status: 200 });
		};
		const operations = createDefaultWebSearchOperations({
			env: {},
			fetcher,
			modelContext: () => ({
				model: modelForSearch({
					baseUrl: "http://api.openai.com/v1",
				}),
				apiKey: "sk-openai",
				sessionId: "session-openai-override",
			}),
		});

		await expect(operations.search({ query: "Volt remote host", limit: 5 })).rejects.toThrow(
			"web_search is not configured. Use an authenticated OpenAI/OpenAI Codex model, set VOLT_WEB_SEARCH_URL, or set BRAVE_SEARCH_API_KEY.",
		);
		expect(called).toBe(false);
	});

	it("uses Brave Search when BRAVE_SEARCH_API_KEY is configured", async () => {
		const fetcher: WebSearchFetcher = async (input, init) => {
			const url = new URL(input);
			expect(`${url.origin}${url.pathname}`).toBe("https://api.search.brave.com/res/v1/web/search");
			expect(url.searchParams.get("q")).toBe("Volt AI (site:example.com)");
			expect(url.searchParams.get("count")).toBe("3");
			expect(url.searchParams.get("freshness")).toBe("2026-06-23to2026-06-30");
			expect(getHeader(init.headers, "X-Subscription-Token")).toBe("test-brave-key");
			return new Response(
				JSON.stringify({
					web: {
						results: [
							{
								title: "<b>Volt</b> AI",
								url: "https://example.com/volt",
								description: "A &amp; B",
								page_age: "2026-06-29",
							},
						],
					},
				}),
				{ status: 200 },
			);
		};
		const operations = createDefaultWebSearchOperations({
			env: { BRAVE_SEARCH_API_KEY: "test-brave-key" },
			fetcher,
			now: () => new Date("2026-06-30T12:00:00.000Z"),
		});

		const result = await operations.search({
			query: "Volt AI",
			limit: 3,
			domains: ["example.com"],
			recencyDays: 7,
		});

		expect(result).toEqual({
			provider: "brave",
			query: "Volt AI (site:example.com)",
			results: [
				{
					title: "Volt AI",
					url: "https://example.com/volt",
					snippet: "A & B",
					source: "example.com",
					publishedAt: "2026-06-29",
				},
			],
		});
	});

	it("falls back to fallbackBraveApiKey when BRAVE_SEARCH_API_KEY is not set", async () => {
		let subscriptionToken: string | undefined;
		const fetcher: WebSearchFetcher = async (input, init) => {
			const url = new URL(input);
			expect(`${url.origin}${url.pathname}`).toBe("https://api.search.brave.com/res/v1/web/search");
			subscriptionToken = getHeader(init.headers, "X-Subscription-Token");
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};
		const operations = createDefaultWebSearchOperations({
			env: {},
			fetcher,
			fallbackBraveApiKey: async () => "stored-brave-key",
		});

		const result = await operations.search({ query: "Volt AI", limit: 3 });

		expect(subscriptionToken).toBe("stored-brave-key");
		expect(result.provider).toBe("brave");
	});

	it("prefers env BRAVE_SEARCH_API_KEY over fallbackBraveApiKey", async () => {
		let subscriptionToken: string | undefined;
		const fetcher: WebSearchFetcher = async (_input, init) => {
			subscriptionToken = getHeader(init.headers, "X-Subscription-Token");
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};
		const operations = createDefaultWebSearchOperations({
			env: { BRAVE_SEARCH_API_KEY: "env-brave-key" },
			fetcher,
			fallbackBraveApiKey: () => "stored-brave-key",
		});

		await operations.search({ query: "Volt AI", limit: 3 });

		expect(subscriptionToken).toBe("env-brave-key");
	});

	it("still reports not configured when the fallback returns undefined", async () => {
		let called = false;
		const fetcher: WebSearchFetcher = async () => {
			called = true;
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};
		const operations = createDefaultWebSearchOperations({
			env: {},
			fetcher,
			fallbackBraveApiKey: () => undefined,
		});

		await expect(operations.search({ query: "Volt AI", limit: 3 })).rejects.toThrow(
			"web_search is not configured. Use an authenticated OpenAI/OpenAI Codex model, set VOLT_WEB_SEARCH_URL, or set BRAVE_SEARCH_API_KEY.",
		);
		expect(called).toBe(false);
	});
});

describe("web_search provider blob extraction", () => {
	it("extracts results from a Codex blob and keeps page bodies out of the output", async () => {
		const operations: WebSearchOperations = {
			search: async () => ({
				provider: "openai-codex",
				query: "libuv uv_kill",
				results: [],
				content: codexBlob(2, { body: "GIANT PAGE BODY" }),
			}),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-blob-1", { query: "libuv uv_kill" });

		expect(result.details?.results).toEqual([
			{
				title: "Result 0 title",
				url: "https://example.com/0",
				snippet: "Snippet body for result 0.",
				source: "example.com",
				publishedAt: "3 months ago",
			},
			{
				title: "Result 1 title",
				url: "https://example.com/1",
				snippet: "Snippet body for result 1.",
				source: "example.com",
				publishedAt: "3 months ago",
			},
		]);

		const text = getTextOutput(result);
		expect(text).toContain("[1] Result 0 title");
		expect(text).toContain("URL: https://example.com/0");
		expect(text).not.toContain("GIANT PAGE BODY");
		expect(text).not.toContain("wordlim");
		expect(text).not.toContain(CITE_START);
	});

	it("applies the caller's limit to results recovered from a blob", async () => {
		const operations: WebSearchOperations = {
			search: async (request) => ({
				provider: "openai-codex",
				query: request.query,
				results: [],
				content: codexBlob(11),
			}),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-blob-2", { query: "many hits", limit: 5 });

		expect(result.details?.results).toHaveLength(5);
		expect(result.details?.resultLimitReached).toBe(5);
		expect(getTextOutput(result)).toContain("[5] Result 4 title");
		expect(getTextOutput(result)).not.toContain("[6] ");
	});

	it("caps long snippets", async () => {
		const operations: WebSearchOperations = {
			search: async () => ({
				provider: "openai-codex",
				query: "long snippet",
				results: [],
				content: `A title (https://example.com/long)\n${citation(0)} [wordlim: 200] ${"x".repeat(900)}`,
			}),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-blob-3", { query: "long snippet" });

		const snippet = result.details?.results[0]?.snippet ?? "";
		expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 3);
		expect(snippet.endsWith("...")).toBe(true);
	});

	it("labels a hit that has a URL but no title", () => {
		const results = parseProviderContent(
			`(https://www.n0.computer/)\n${citation(0)} [wordlim: 200] Crawled: today; iroh`,
		);

		expect(results).toEqual([{ title: "n0.computer", url: "https://www.n0.computer/", snippet: "iroh" }]);
	});

	it("does not treat body prose ending in a URL as a result header", () => {
		const blob = [
			"Real title (https://example.com/real)",
			`${citation(0)} [wordlim: 200] Real snippet.`,
			"",
			"As an alternative, there is `EndTask` (https://msdn.microsoft.com/library/ms633492)",
			"which does something else entirely.",
		].join("\n");

		expect(parseProviderContent(blob)).toEqual([
			{ title: "Real title", url: "https://example.com/real", snippet: "Real snippet." },
		]);
	});

	it("falls back to a cleaned blob when nothing parses", async () => {
		const noisy = [
			"Some heading",
			"Copy link",
			"More actions",
			"  * Fork 3.9k",
			"a repeated line of real content",
			"",
			"",
			"a repeated line of real content",
			`${citation(6)} [wordlim: 200] trailing marker text`,
		].join("\n");
		const operations: WebSearchOperations = {
			search: async () => ({ provider: "openai-codex", query: "unparseable", results: [], content: noisy }),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-blob-4", { query: "unparseable" });

		expect(result.details?.results).toEqual([]);
		const text = getTextOutput(result);
		expect(text).toContain("Some heading");
		expect(text).not.toContain("Copy link");
		expect(text).not.toContain("More actions");
		expect(text).not.toContain("Fork 3.9k");
		expect(text).not.toContain("wordlim");
		expect(text.match(/a repeated line of real content/g)).toHaveLength(1);
	});

	it("truncates an oversized fallback blob by line count", async () => {
		const operations: WebSearchOperations = {
			search: async () => ({
				provider: "openai-codex",
				query: "huge",
				results: [],
				// Distinct lines so deduplication cannot shrink it below the cap.
				content: Array.from({ length: FALLBACK_MAX_LINES * 2 }, (_, i) => `unique content line ${i}`).join("\n"),
			}),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-blob-5", { query: "huge" });

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.truncation?.truncatedBy).toBe("lines");
		expect(getTextOutput(result)).toContain("limit reached");
	});

	it("leaves structured backends untouched", async () => {
		const operations: WebSearchOperations = {
			search: async () => ({
				provider: "brave",
				query: "structured",
				results: [{ title: "Brave hit", url: "https://example.com/brave", snippet: "From Brave" }],
				content: "a blob that must be ignored when results are present",
			}),
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("web-search-blob-6", { query: "structured" });

		expect(result.details?.results).toEqual([
			{ title: "Brave hit", url: "https://example.com/brave", snippet: "From Brave", source: "example.com" },
		]);
		expect(getTextOutput(result)).not.toContain("must be ignored");
	});
});
