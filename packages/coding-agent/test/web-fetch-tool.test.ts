import { describe, expect, it } from "vitest";
import {
	createDefaultWebFetchOperations,
	createWebFetchTool,
	htmlToText,
	type WebFetchFetcher,
	type WebFetchHostResolver,
	type WebFetchOperations,
	type WebFetchRequest,
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
		const tool = createWebFetchTool(process.cwd(), { operations });

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
		const tool = createWebFetchTool(process.cwd(), { operations });

		const result = await tool.execute("web-fetch-2", { url: "https://example.com/big", maxBytes: 10 });

		expect(capturedRequest?.maxBytes).toBe(1_000);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(getTextOutput(result)).toContain("limit reached");
	});

	it("records the final URL when redirected", async () => {
		const operations: WebFetchOperations = {
			fetch: async () => ({ url: "https://example.com/final", content: "done" }),
		};
		const tool = createWebFetchTool(process.cwd(), { operations });

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
		const tool = createWebFetchTool(process.cwd(), { operations });

		await expect(tool.execute("web-fetch-4", { url: "   " })).rejects.toThrow("web_fetch url must not be empty");

		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("web-fetch-5", { url: "https://example.com" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(called).toBe(false);
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
});

describe("htmlToText", () => {
	it("collapses runs of blank lines to a single paragraph break", () => {
		expect(htmlToText("<p>one</p>\n\n\n<p>two</p>")).toBe("one\n\ntwo");
	});

	it("decodes entities and keeps line breaks", () => {
		expect(htmlToText("<p>a &amp; b<br>c &#65;</p>")).toBe("a & b\nc A");
	});
});
