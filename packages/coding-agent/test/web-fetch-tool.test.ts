import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createDefaultWebFetchOperations,
	createWebFetchTool,
	extractHtml,
	extractUrls,
	htmlToText,
	normalizeFetchUrl,
	type WebFetchFetcher,
	type WebFetchHostResolver,
	type WebFetchOperations,
	type WebFetchRequest,
	type WebFetchUrlPolicy,
} from "../src/index.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
}

/** Every hostname resolves to a public address unless a test says otherwise. */
const publicHost: WebFetchHostResolver = async () => ["93.184.216.34"];

/** Most tool tests are about fetching, not about the allowlist. */
const UNRESTRICTED: WebFetchUrlPolicy = { type: "unrestricted" };

function conversationWith(...urls: string[]): WebFetchUrlPolicy {
	return { type: "conversation", urls: () => urls };
}

function okOperations(): WebFetchOperations {
	return { fetch: async (request) => ({ url: request.url, content: "page text" }) };
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

describe("web_fetch tool", () => {
	it("returns readable text and drops markup", async () => {
		let capturedRequest: WebFetchRequest | undefined;
		const operations: WebFetchOperations = {
			fetch: async (request) => {
				capturedRequest = request;
				return {
					url: "https://example.com/article",
					title: "Article Title",
					contentType: "text/html",
					content: "First paragraph.\nSecond paragraph.",
				};
			},
		};
		const tool = createWebFetchTool(process.cwd(), { operations, urlPolicy: UNRESTRICTED });

		const result = await tool.execute("web-fetch-1", { url: "  https://example.com/article  " });

		expect(capturedRequest).toEqual({ url: "https://example.com/article", maxBytes: 20_000 });
		expect(result.details).toEqual({
			url: "https://example.com/article",
			title: "Article Title",
			contentType: "text/html",
		});
		const text = getTextOutput(result);
		expect(text).toContain("Fetched: https://example.com/article");
		expect(text).toContain("Title: Article Title");
		expect(text).toContain("First paragraph.");
	});

	it("clamps maxBytes and truncates oversized pages", async () => {
		let capturedRequest: WebFetchRequest | undefined;
		const operations: WebFetchOperations = {
			fetch: async (request) => {
				capturedRequest = request;
				return { url: "https://example.com/big", content: "x".repeat(50_000) };
			},
		};
		const tool = createWebFetchTool(process.cwd(), { operations, urlPolicy: UNRESTRICTED });

		const result = await tool.execute("web-fetch-2", { url: "https://example.com/big", maxBytes: 10 });

		expect(capturedRequest?.maxBytes).toBe(1_000);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(getTextOutput(result)).toContain("limit reached");
	});

	it("reports when the raw download was truncated before extraction", async () => {
		const operations: WebFetchOperations = {
			fetch: async () => ({
				url: "https://example.com/oversized",
				content: "",
				downloadTruncation: { maxBytes: 5 * 1024 * 1024 },
			}),
		};
		const tool = createWebFetchTool(process.cwd(), { operations, urlPolicy: UNRESTRICTED });

		const result = await tool.execute("web-fetch-download-truncation", {
			url: "https://example.com/oversized",
		});

		expect(result.details?.downloadTruncation).toEqual({ maxBytes: 5 * 1024 * 1024 });
		expect(getTextOutput(result)).toContain("[Download truncated at 5.0MB]");
	});

	it("records the final URL when redirected", async () => {
		const operations: WebFetchOperations = {
			fetch: async () => ({ url: "https://example.com/final", content: "done" }),
		};
		const tool = createWebFetchTool(process.cwd(), { operations, urlPolicy: UNRESTRICTED });

		const result = await tool.execute("web-fetch-3", { url: "https://example.com/start" });

		expect(result.details?.url).toBe("https://example.com/final");
		expect(result.details?.requestedUrl).toBe("https://example.com/start");
	});

	it("rejects an empty url and aborted signals", async () => {
		let called = false;
		const operations: WebFetchOperations = {
			fetch: async () => {
				called = true;
				return { url: "https://example.com", content: "" };
			},
		};
		const tool = createWebFetchTool(process.cwd(), { operations, urlPolicy: UNRESTRICTED });

		await expect(tool.execute("web-fetch-4", { url: "   " })).rejects.toThrow("web_fetch url must not be empty");

		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("web-fetch-5", { url: "https://example.com" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(called).toBe(false);
	});
});

describe("web_fetch conversation allowlist", () => {
	it("refuses a URL that never appeared in the conversation", async () => {
		let called = false;
		const operations: WebFetchOperations = {
			fetch: async () => {
				called = true;
				return { url: "https://evil.example.com", content: "" };
			},
		};
		const tool = createWebFetchTool(process.cwd(), {
			operations,
			urlPolicy: conversationWith("https://docs.example.com/guide"),
		});

		await expect(tool.execute("allow-1", { url: "https://evil.example.com/exfil?data=secret" })).rejects.toThrow(
			"web_fetch can only read URLs that already appeared in this conversation",
		);
		expect(called).toBe(false);
	});

	it("allows a URL that appeared in the conversation", async () => {
		const tool = createWebFetchTool(process.cwd(), {
			operations: okOperations(),
			urlPolicy: conversationWith(...extractUrls("see https://docs.example.com/guide for details")),
		});

		const result = await tool.execute("allow-2", { url: "https://docs.example.com/guide" });

		expect(result.details?.url).toBe("https://docs.example.com/guide");
	});

	it("ignores case, trailing slash, and fragment when matching", async () => {
		const tool = createWebFetchTool(process.cwd(), {
			operations: okOperations(),
			urlPolicy: conversationWith("HTTPS://Docs.Example.com/guide#section-2"),
		});

		await expect(tool.execute("allow-3", { url: "https://docs.example.com/guide" })).resolves.toBeDefined();
	});

	it("does not treat a different path or query as the same URL", async () => {
		const tool = createWebFetchTool(process.cwd(), {
			operations: okOperations(),
			urlPolicy: conversationWith("https://docs.example.com/guide"),
		});

		await expect(tool.execute("allow-4", { url: "https://docs.example.com/guide/../../etc" })).rejects.toThrow(
			"already appeared in this conversation",
		);
		await expect(tool.execute("allow-5", { url: "https://docs.example.com/guide?x=1" })).rejects.toThrow(
			"already appeared in this conversation",
		);
	});

	it("refuses everything when no URL source is wired", async () => {
		const tool = createWebFetchTool(process.cwd(), { operations: okOperations() });

		await expect(tool.execute("allow-6", { url: "https://docs.example.com/guide" })).rejects.toThrow(
			"already appeared in this conversation",
		);
	});

	it("extracts URLs from prose without swallowing trailing punctuation", () => {
		expect(extractUrls("See https://a.example.com/x, and (https://b.example.com/y).")).toEqual([
			"https://a.example.com/x",
			"https://b.example.com/y",
		]);
		expect(extractUrls("Read https://en.wikipedia.org/wiki/Function_(mathematics).")).toEqual([
			"https://en.wikipedia.org/wiki/Function_(mathematics)",
		]);
		expect(extractUrls("Wrapped (https://example.com/path_(nested))).")).toEqual([
			"https://example.com/path_(nested)",
		]);
		expect(extractUrls("URL: https://c.example.com/z\nnext line")).toEqual(["https://c.example.com/z"]);
		expect(extractUrls("no links here")).toEqual([]);
	});

	it("normalizes only non-meaningful differences", () => {
		expect(normalizeFetchUrl("HTTPS://Example.COM/")).toBe("https://example.com");
		expect(normalizeFetchUrl("https://example.com/a?b=1#frag")).toBe("https://example.com/a?b=1");
		expect(normalizeFetchUrl("ftp://example.com/a")).toBeUndefined();
		expect(normalizeFetchUrl("not a url")).toBeUndefined();
	});

	it("refuses credentials smuggled into an otherwise allowed URL", async () => {
		const tool = createWebFetchTool(process.cwd(), {
			operations: okOperations(),
			urlPolicy: conversationWith("https://docs.example.com/guide"),
		});

		expect(normalizeFetchUrl("https://secret@docs.example.com/guide")).toBeUndefined();
		await expect(tool.execute("allow-7", { url: "https://secret@docs.example.com/guide" })).rejects.toThrow(
			"already appeared in this conversation",
		);
	});
});

describe("web_fetch network operations", () => {
	it("fetches a page and converts HTML to text", async () => {
		const fetcher: WebFetchFetcher = async (input) => {
			expect(input).toBe("https://example.com/doc");
			return htmlResponse(
				"<html><head><title>Doc &amp; Notes</title><style>a{color:red}</style></head>" +
					"<body><h1>Heading</h1><p>Para one.</p><script>evil()</script><ul><li>Item A</li><li>Item B</li></ul></body></html>",
			);
		};
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		const response = await operations.fetch({ url: "https://example.com/doc", maxBytes: 20_000 });

		expect(response.title).toBe("Doc & Notes");
		expect(response.content).toContain("Heading");
		expect(response.content).toContain("Para one.");
		expect(response.content).toContain("- Item A");
		expect(response.content).not.toContain("evil()");
		expect(response.content).not.toContain("color:red");
		expect(response.content).not.toContain("<");
	});

	it("binds each request to the addresses that passed validation", async () => {
		let pinnedAddresses: unknown;
		const fetcher: WebFetchFetcher = async (...args: unknown[]) => {
			pinnedAddresses = args[2];
			return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
		};
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		await operations.fetch({ url: "https://example.com/doc", maxBytes: 20_000 });

		expect(pinnedAddresses).toEqual(["93.184.216.34"]);
	});

	it("normalizes a public IPv6 literal without passing brackets to DNS or the socket", async () => {
		let pinnedAddresses: readonly string[] | undefined;
		const fetcher: WebFetchFetcher = async (_input, _init, validatedAddresses) => {
			pinnedAddresses = validatedAddresses;
			return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
		};
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher });

		const response = await operations.fetch({
			url: "https://[2606:4700:4700::1111]/",
			maxBytes: 20_000,
		});

		expect(response.content).toBe("ok");
		expect(pinnedAddresses).toEqual(["2606:4700:4700::1111"]);
	});

	it("refuses non-http schemes and internal hostnames", async () => {
		let called = false;
		const fetcher: WebFetchFetcher = async () => {
			called = true;
			return htmlResponse("nope");
		};
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		await expect(operations.fetch({ url: "file:///etc/passwd", maxBytes: 20_000 })).rejects.toThrow(
			"web_fetch only supports http and https URLs",
		);
		await expect(operations.fetch({ url: "http://localhost:8080/admin", maxBytes: 20_000 })).rejects.toThrow(
			"refuses to fetch internal host localhost",
		);
		await expect(operations.fetch({ url: "http://db.internal/status", maxBytes: 20_000 })).rejects.toThrow(
			"refuses to fetch internal host db.internal",
		);
		expect(called).toBe(false);
	});

	it("refuses hostnames that resolve to private or metadata addresses", async () => {
		let called = false;
		const fetcher: WebFetchFetcher = async () => {
			called = true;
			return htmlResponse("nope");
		};
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"192.168.1.5",
			"172.16.0.9",
			"169.254.169.254",
			"::1",
			"fd00::1",
		]) {
			const operations = createDefaultWebFetchOperations({
				env: {},
				fetcher,
				resolveHost: async () => [address],
			});
			await expect(operations.fetch({ url: "https://sneaky.example.com/", maxBytes: 20_000 })).rejects.toThrow(
				`resolves to non-public address ${address}`,
			);
		}
		expect(called).toBe(false);
	});

	it("re-validates redirect targets so a public URL cannot bounce to an internal one", async () => {
		const seen: string[] = [];
		const fetcher: WebFetchFetcher = async (input) => {
			seen.push(input);
			return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
		};
		const operations = createDefaultWebFetchOperations({
			env: {},
			fetcher,
			resolveHost: async (hostname) => (hostname === "example.com" ? ["93.184.216.34"] : ["169.254.169.254"]),
		});

		await expect(operations.fetch({ url: "https://example.com/start", maxBytes: 20_000 })).rejects.toThrow(
			"resolves to non-public address 169.254.169.254",
		);
		expect(seen).toEqual(["https://example.com/start"]);
	});

	it("stops after too many redirects", async () => {
		let hops = 0;
		const fetcher: WebFetchFetcher = async () => {
			hops++;
			return new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
		};
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		await expect(operations.fetch({ url: "https://example.com/start", maxBytes: 20_000 })).rejects.toThrow(
			"exceeded 5 redirects",
		);
		// One initial request plus MAX_REDIRECTS follows.
		expect(hops).toBe(6);
	});

	it("rejects binary content types and HTTP errors", async () => {
		const pdf: WebFetchFetcher = async () =>
			new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } });
		await expect(
			createDefaultWebFetchOperations({ env: {}, fetcher: pdf, resolveHost: publicHost }).fetch({
				url: "https://example.com/a.pdf",
				maxBytes: 20_000,
			}),
		).rejects.toThrow("cannot read content type application/pdf");

		const missing: WebFetchFetcher = async () => new Response("nope", { status: 404 });
		await expect(
			createDefaultWebFetchOperations({ env: {}, fetcher: missing, resolveHost: publicHost }).fetch({
				url: "https://example.com/missing",
				maxBytes: 20_000,
			}),
		).rejects.toThrow("returned HTTP 404");
	});

	it("is unavailable when VOLT_OFFLINE is set", async () => {
		let called = false;
		const fetcher: WebFetchFetcher = async () => {
			called = true;
			return htmlResponse("nope");
		};
		const operations = createDefaultWebFetchOperations({
			env: { VOLT_OFFLINE: "1" },
			fetcher,
			resolveHost: publicHost,
		});

		await expect(operations.fetch({ url: "https://example.com", maxBytes: 20_000 })).rejects.toThrow(
			"web_fetch is unavailable because VOLT_OFFLINE is enabled",
		);
		expect(called).toBe(false);
	});

	it("passes plain text through untouched", async () => {
		const fetcher: WebFetchFetcher = async () =>
			new Response("line one\nline two", { status: 200, headers: { "content-type": "text/plain" } });
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		const response = await operations.fetch({ url: "https://example.com/raw.txt", maxBytes: 20_000 });

		expect(response.content).toBe("line one\nline two");
		expect(response.title).toBeUndefined();
	});

	it("cancels an oversized response before consuming the entire stream", async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(0x61);
		let pulls = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(chunk);
				if (pulls === 20) {
					controller.close();
				}
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetcher: WebFetchFetcher = async () =>
			new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		const response = await operations.fetch({ url: "https://example.com/unbounded", maxBytes: 20_000 });

		expect(new TextEncoder().encode(response.content)).toHaveLength(5 * 1024 * 1024);
		expect(response.downloadTruncation).toEqual({ maxBytes: 5 * 1024 * 1024 });
		expect(pulls).toBeLessThan(20);
		expect(cancelled).toBe(true);
	});

	it("reports raw truncation when HTML extraction removes the partial body", async () => {
		const fetcher: WebFetchFetcher = async () =>
			htmlResponse(`<script>${"x".repeat(6 * 1024 * 1024)}</script><main>useful text</main>`);
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		const response = await operations.fetch({ url: "https://example.com/script-heavy", maxBytes: 20_000 });

		expect(response.content).toBe("");
		expect(response.downloadTruncation).toEqual({ maxBytes: 5 * 1024 * 1024 });
	});

	it("does not mark an exactly 5 MiB response as truncated", async () => {
		const fetcher: WebFetchFetcher = async () =>
			new Response(new Uint8Array(5 * 1024 * 1024).fill(0x61), {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		const operations = createDefaultWebFetchOperations({ env: {}, fetcher, resolveHost: publicHost });

		const response = await operations.fetch({ url: "https://example.com/exact", maxBytes: 20_000 });

		expect(new TextEncoder().encode(response.content)).toHaveLength(5 * 1024 * 1024);
		expect(response.downloadTruncation).toBeUndefined();
	});
});

describe("web_fetch session integration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-web-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		return createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
	}

	// Reserved by RFC 2606, so resolution fails before any request is made.
	const USER_URL = "https://user-supplied.invalid/doc";
	const SEARCH_URL = "https://from-search.invalid/page";
	const SEARCH_SNIPPET_URL = "https://snippet-invented.invalid/trap";
	const BASH_URL = "https://bash-invented.invalid/exfil";
	const FAILED_SEARCH_URL = "https://failed-search.invalid/trap";
	const ASSISTANT_URL = "https://assistant-invented.invalid/x";

	it("permits user and web_search result URLs without trusting model-controlled tool output", async () => {
		const { session } = await createSession();
		const model = session.model!;
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Please read ${USER_URL}` }],
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `I should also read ${ASSISTANT_URL}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "web_search",
			content: [{ type: "text", text: `[1] A page\nURL: ${SEARCH_URL}\nSnippet: ${SEARCH_SNIPPET_URL}` }],
			isError: false,
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "bash",
			content: [{ type: "text", text: `URL: ${BASH_URL}` }],
			isError: false,
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-3",
			toolName: "web_search",
			content: [{ type: "text", text: `URL: ${FAILED_SEARCH_URL}` }],
			isError: true,
			timestamp: Date.now(),
		});

		const tool = session.agent.state.tools.find((candidate) => candidate.name === "web_fetch");
		expect(tool).toBeDefined();
		const blocked = "web_fetch can only read URLs that already appeared in this conversation";

		await expect(tool!.execute("session-1", { url: "https://never-mentioned.invalid/" })).rejects.toThrow(blocked);
		await expect(tool!.execute("session-2", { url: ASSISTANT_URL })).rejects.toThrow(blocked);
		await expect(tool!.execute("session-3", { url: BASH_URL })).rejects.toThrow(blocked);
		await expect(tool!.execute("session-4", { url: SEARCH_SNIPPET_URL })).rejects.toThrow(blocked);
		await expect(tool!.execute("session-5", { url: FAILED_SEARCH_URL })).rejects.toThrow(blocked);

		// These are allowed, so they fail later (name resolution) rather than on the allowlist.
		for (const allowed of [USER_URL, SEARCH_URL]) {
			const error = await tool!.execute("session-6", { url: allowed }).then(
				() => undefined,
				(thrown: unknown) => thrown as Error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(error?.message).not.toContain(blocked);
		}

		session.dispose();
	});

	it("preserves trusted URL provenance after compaction removes the source message from model context", async () => {
		const { session } = await createSession();
		const model = session.model!;
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Please read ${USER_URL}` }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "I will keep working." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.sessionManager.appendCompaction("The earlier user message was summarized.", firstKeptEntryId, 1_000);
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		expect(
			session.agent.state.messages.some(
				(message) =>
					message.role === "user" &&
					(typeof message.content === "string"
						? message.content.includes(USER_URL)
						: message.content.some((part) => part.type === "text" && part.text.includes(USER_URL))),
			),
		).toBe(false);

		const tool = session.agent.state.tools.find((candidate) => candidate.name === "web_fetch");
		const blocked = "web_fetch can only read URLs that already appeared in this conversation";
		const error = await tool!.execute("session-compacted", { url: USER_URL }).then(
			() => undefined,
			(thrown: unknown) => thrown as Error,
		);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).not.toContain(blocked);
		session.dispose();
	});
});

describe("htmlToText", () => {
	it("does not load stylesheets or frames while parsing untrusted HTML", async () => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url ?? "");
			response.writeHead(200, { "content-type": request.url === "/style.css" ? "text/css" : "text/html" });
			response.end(request.url === "/style.css" ? "body { color: red; }" : "<p>private frame</p>");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Expected a TCP test server");
		}

		try {
			extractHtml(
				`<html><head><link rel="stylesheet" href="http://127.0.0.1:${address.port}/style.css"></head>` +
					`<body><iframe src="http://127.0.0.1:${address.port}/frame"></iframe><p>public body</p></body></html>`,
			);
			await delay(50);
			expect(requests).toEqual([]);
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("collapses runs of blank lines to a single paragraph break", () => {
		expect(htmlToText("<p>one</p>\n\n\n<p>two</p>")).toBe("one\n\ntwo");
	});

	it("decodes entities and keeps line breaks", () => {
		expect(htmlToText("<p>a &amp; b<br>c &#65;</p>")).toBe("a & b\nc A");
	});

	it("handles markup that defeats tag-stripping regexes", () => {
		// A '>' inside an attribute value ends the tag too early for /<[^>]+>/.
		expect(htmlToText('<p>before</p><a title="a>b">link</a><p>after</p>')).toBe("before\nlink\nafter");
		// An unclosed <script> never matches a paired strip pattern, leaking its body.
		expect(htmlToText("<p>before</p><script>var x = 1; alert('leak')</script>")).toBe("before");
		expect(htmlToText("<p>before</p><script>var x = 1; alert('leak')")).toBe("before");
	});

	it("extracts element-heavy documents without retaining a browser DOM", () => {
		const html = `<body>${"<span></span>".repeat(82_000)}<p>useful text</p></body>`;
		expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(1024 * 1024);
		expect(htmlToText(html)).toBe("useful text");
	});

	it("keeps whitespace inside pre and code blocks", () => {
		expect(htmlToText("<pre>line one\n  indented\n    deeper\nline four</pre>")).toBe(
			"line one\n  indented\n    deeper\nline four",
		);
		expect(htmlToText("<pre><code>def f():\n    return 1\n</code></pre>")).toBe("def f():\n    return 1");
	});

	it("renders lists and table rows readably", () => {
		expect(htmlToText("<ul><li>Item A</li><li>Item B</li></ul>")).toBe("- Item A\n- Item B");
		expect(htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>")).toBe(
			"a\tb\nc\td",
		);
	});

	it("drops navigation and footer chrome but keeps headers and asides", () => {
		const html =
			"<nav>Home About Contact</nav><header>Page Heading</header>" +
			"<main><p>Body text.</p></main><aside>Note: important</aside><footer>Copyright 2026</footer>";
		const text = htmlToText(html);
		expect(text).toContain("Body text.");
		expect(text).toContain("Page Heading");
		expect(text).toContain("Note: important");
		expect(text).not.toContain("Home About Contact");
		expect(text).not.toContain("Copyright 2026");
	});

	it("recovers from malformed markup", () => {
		// Unclosed <p> elements are still separate paragraphs after tree construction.
		expect(htmlToText("<p>one<p>two<div>three")).toBe("one\n\ntwo\n\nthree");
	});

	it("reads the document title", () => {
		expect(extractHtml("<html><head><title>T &amp; T</title></head><body>x</body></html>").title).toBe("T & T");
		expect(extractHtml("<html><body>x</body></html>").title).toBeUndefined();
	});
});

describe("private address detection", () => {
	// Exercised through normalizeFetchUrl-adjacent behaviour: the resolver seam lets
	// a test assert the guard directly for every textual spelling of an address.
	async function fetchWith(address: string): Promise<string> {
		const operations = createDefaultWebFetchOperations({
			env: {},
			fetcher: async () => new Response("should not be reached", { status: 200 }),
			resolveHost: async () => [address],
		});
		try {
			await operations.fetch({ url: "https://looks-public.example.com/", maxBytes: 20_000 });
			return "ALLOWED";
		} catch (error) {
			return (error as Error).message;
		}
	}

	it("blocks every spelling of a non-public address", async () => {
		const blocked = [
			"127.0.0.1",
			"10.0.0.1",
			"192.168.1.1",
			"172.16.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"192.0.2.1",
			"198.51.100.1",
			"203.0.113.1",
			"::1",
			"::1%lo",
			// Same address, written out in full rather than compressed.
			"0:0:0:0:0:0:0:1",
			"fe80::1",
			"fd00::1",
			"ff02::1",
			"64:ff9b:1::1",
			"100::1",
			"2001:db8::1",
			"3fff::1",
			"5f00::1",
			// IPv4-mapped loopback, in both the dotted and hexadecimal serializations.
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			// IPv4-compatible and NAT64 embeddings of loopback.
			"::127.0.0.1",
			"64:ff9b::7f00:1",
		];
		for (const address of blocked) {
			expect(await fetchWith(address), address).toContain("non-public address");
		}
	});

	it("allows genuinely public addresses", async () => {
		for (const address of [
			"93.184.216.34",
			"8.8.8.8",
			"192.0.0.9",
			"2606:2800:220:1:248:1893:25c8:1946",
			"2001:3::1",
			"64:ff9b::808:808",
		]) {
			expect(await fetchWith(address), address).not.toContain("non-public address");
		}
	});
});
