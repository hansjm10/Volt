import { lookup } from "node:dns/promises";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { Text } from "@hansjm10/volt-tui";
import { type Static, Type } from "typebox";
import { VERSION } from "../../config.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { decodeHtmlEntity } from "../../utils/html.ts";
import { getVoltUserAgent } from "../../utils/volt-user-agent.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { Theme } from "../theme/runtime.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const DEFAULT_MAX_BYTES = 20_000;
const MIN_MAX_BYTES = 1_000;
const MAX_MAX_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
/** Hard ceiling on the response body we will read, before truncation. */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

const webFetchSchema = Type.Object({
	url: Type.String({
		description: "Absolute http(s) URL to fetch. Prefer URLs returned by web_search or provided by the user.",
		minLength: 1,
		maxLength: 2048,
	}),
	maxBytes: Type.Optional(
		Type.Number({
			description: `Maximum characters of page text to return (default: ${DEFAULT_MAX_BYTES}, max: ${MAX_MAX_BYTES})`,
		}),
	),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchRequest {
	url: string;
	maxBytes: number;
}

export interface WebFetchResponse {
	url: string;
	title?: string;
	contentType?: string;
	content: string;
}

export interface WebFetchToolDetails {
	url: string;
	requestedUrl?: string;
	title?: string;
	contentType?: string;
	truncation?: TruncationResult;
}

export interface WebFetchOperations {
	fetch: (request: WebFetchRequest, signal?: AbortSignal) => Promise<WebFetchResponse> | WebFetchResponse;
}

export type WebFetchFetcher = (input: string, init: RequestInit) => Promise<Response>;

/** Resolves a hostname to its addresses so private targets can be rejected. */
export type WebFetchHostResolver = (hostname: string) => Promise<string[]>;

export interface DefaultWebFetchOperationsOptions {
	env?: Record<string, string | undefined>;
	fetcher?: WebFetchFetcher;
	resolveHost?: WebFetchHostResolver;
	timeoutMs?: number;
}

export interface WebFetchToolOptions {
	operations?: WebFetchOperations;
}

type RenderableWebFetchResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: WebFetchToolDetails;
};

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
	if (maxBytes === undefined || !Number.isFinite(maxBytes)) {
		return DEFAULT_MAX_BYTES;
	}
	return Math.min(MAX_MAX_BYTES, Math.max(MIN_MAX_BYTES, Math.floor(maxBytes)));
}

function parseIpv4(value: string): number[] | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number.parseInt(part, 10);
		if (octet > 255) return undefined;
		octets.push(octet);
	}
	return octets;
}

/**
 * Reject addresses that are not routable on the public internet.
 *
 * Covers loopback, RFC1918, carrier-grade NAT, link-local (including the cloud
 * instance-metadata address), benchmarking, multicast, and reserved space.
 */
function isPrivateAddress(address: string): boolean {
	const value = address
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");

	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	const ipv4 = parseIpv4(mapped ? mapped[1] : value);
	if (ipv4) {
		const [a, b] = ipv4;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 192 && b === 0) return true;
		if (a === 198 && (b === 18 || b === 19)) return true;
		if (a >= 224) return true;
		return false;
	}

	if (value === "::" || value === "::1") return true;
	// Unique-local fc00::/7 and link-local fe80::/10.
	if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
	if (/^fe[89ab][0-9a-f]:/.test(value)) return true;
	return false;
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (host.length === 0) return true;
	if (host === "localhost") return true;
	return host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

async function assertFetchableUrl(raw: string, resolveHost: WebFetchHostResolver): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`web_fetch requires an absolute http(s) URL: ${raw}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`web_fetch only supports http and https URLs, got ${url.protocol}`);
	}
	if (isBlockedHostname(url.hostname)) {
		throw new Error(`web_fetch refuses to fetch internal host ${url.hostname}`);
	}

	// A public-looking hostname can still resolve to a private address, so check
	// what it actually resolves to rather than trusting its shape.
	const addresses = await resolveHost(url.hostname);
	if (addresses.length === 0) {
		throw new Error(`web_fetch could not resolve ${url.hostname}`);
	}
	for (const address of addresses) {
		if (isPrivateAddress(address)) {
			throw new Error(`web_fetch refuses to fetch ${url.hostname}: resolves to non-public address ${address}`);
		}
	}
	return url;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
	if (isPrivateAddress(hostname)) {
		return [hostname];
	}
	const results = await lookup(hostname, { all: true });
	return results.map((entry) => entry.address);
}

function decodeEntities(value: string): string {
	return value.replace(/&(#?[a-zA-Z0-9]{1,10});/g, (match, entity: string) => decodeHtmlEntity(entity) ?? match);
}

function extractTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = decodeEntities(match[1].replace(/\s+/g, " ")).trim();
	return title.length > 0 ? title : undefined;
}

/** Minimal HTML-to-text: enough for reading prose, without an HTML parser dependency. */
export function htmlToText(html: string): string {
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

	const withBreaks = stripped
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|ul|ol|table)>/gi, "\n")
		.replace(/<(p|div|section|article|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n");

	const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "));

	const lines: string[] = [];
	for (const line of text.split("\n")) {
		const collapsed = line.replace(/[^\S\n]+/g, " ").trim();
		if (collapsed.length === 0) {
			if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
			continue;
		}
		lines.push(collapsed);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function isTextualContentType(contentType: string): boolean {
	const type = contentType.split(";", 1)[0].trim().toLowerCase();
	if (type.startsWith("text/")) return true;
	return (
		type === "application/json" ||
		type === "application/xml" ||
		type === "application/xhtml+xml" ||
		type.endsWith("+json") ||
		type.endsWith("+xml")
	);
}

export function createDefaultWebFetchOperations(options: DefaultWebFetchOperationsOptions = {}): WebFetchOperations {
	const env = options.env ?? process.env;
	const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
	const resolveHost = options.resolveHost ?? defaultResolveHost;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		async fetch(request, signal) {
			if (isTruthyEnvFlag(env.VOLT_OFFLINE)) {
				throw new Error("web_fetch is unavailable because VOLT_OFFLINE is enabled");
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			let current = await assertFetchableUrl(request.url, resolveHost);
			let response: Response | undefined;

			// Redirects are followed by hand so every hop is re-validated; letting fetch
			// follow them would allow a public URL to bounce to an internal address.
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				try {
					response = await fetcher(current.toString(), {
						method: "GET",
						redirect: "manual",
						headers: {
							"User-Agent": getVoltUserAgent(VERSION),
							accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
						},
						signal: requestSignal,
					});
				} catch (error) {
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}
					if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
						throw new Error(`web_fetch request timed out after ${timeoutMs}ms`);
					}
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`web_fetch request failed: ${message}`);
				}

				if (response.status < 300 || response.status >= 400) {
					break;
				}
				const location = response.headers.get("location");
				if (!location) {
					break;
				}
				if (hop === MAX_REDIRECTS) {
					throw new Error(`web_fetch exceeded ${MAX_REDIRECTS} redirects starting at ${request.url}`);
				}
				current = await assertFetchableUrl(new URL(location, current).toString(), resolveHost);
			}

			if (!response) {
				throw new Error(`web_fetch request failed: ${request.url}`);
			}
			if (!response.ok) {
				throw new Error(`web_fetch returned HTTP ${response.status} for ${current.toString()}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (contentType && !isTextualContentType(contentType)) {
				throw new Error(`web_fetch cannot read content type ${contentType.split(";", 1)[0].trim()}`);
			}

			const body = await response.text();
			const bounded = body.length > MAX_DOWNLOAD_BYTES ? body.slice(0, MAX_DOWNLOAD_BYTES) : body;
			const isHtml = /html/i.test(contentType) || /^\s*<(!doctype html|html)\b/i.test(bounded);

			return {
				url: current.toString(),
				...(isHtml ? { title: extractTitle(bounded) } : {}),
				...(contentType ? { contentType } : {}),
				content: isHtml ? htmlToText(bounded) : bounded.trim(),
			};
		},
	};
}

function createOutput(
	request: WebFetchRequest,
	response: WebFetchResponse,
): {
	text: string;
	details: WebFetchToolDetails;
} {
	const lines: string[] = [`Fetched: ${response.url}`];
	if (response.title) {
		lines.push(`Title: ${response.title}`);
	}
	lines.push("", response.content.length > 0 ? response.content : "(no readable text content)");

	const truncation = truncateHead(lines.join("\n"), { maxBytes: request.maxBytes });
	const details: WebFetchToolDetails = {
		url: response.url,
		...(response.url !== request.url ? { requestedUrl: request.url } : {}),
		...(response.title ? { title: response.title } : {}),
		...(response.contentType ? { contentType: response.contentType } : {}),
	};

	let text = truncation.content;
	if (truncation.truncated) {
		details.truncation = truncation;
		const limit = truncation.truncatedBy === "lines" ? `${truncation.maxLines} lines` : formatSize(request.maxBytes);
		text += `\n\n[${limit} limit reached]`;
	}
	return { text, details };
}

function formatWebFetchCall(args: { url?: string; maxBytes?: number } | undefined, theme: Theme): string {
	const url = str(args?.url);
	const invalidArg = invalidArgText(theme);
	return (
		theme.fg("toolTitle", theme.bold("web_fetch")) +
		" " +
		(url === null ? invalidArg : theme.fg("accent", url || "..."))
	);
}

function formatWebFetchResult(
	result: RenderableWebFetchResult,
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
	if (result.details?.truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(result.details.truncation.maxBytes)} limit]`)}`;
	}
	return text;
}

export function createWebFetchToolDefinition(
	_cwd: string,
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	const ops = options?.operations ?? createDefaultWebFetchOperations();
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a single http(s) URL and return its readable text. Use after web_search when a result's snippet is not enough, or when the user supplies a URL. Returns page text with HTML markup removed.",
		promptSnippet: "Fetch the readable text of a URL",
		promptGuidelines: [
			"Use web_fetch to read a specific page, and web_search to discover pages.",
			"Prefer URLs that came from web_search results or from the user; do not guess URLs.",
			"Raise maxBytes only when the default output is truncated and the rest of the page is needed.",
		],
		parameters: webFetchSchema,
		async execute(_toolCallId, params: WebFetchToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const url = params.url.trim();
			if (!url) {
				throw new Error("web_fetch url must not be empty");
			}
			const request: WebFetchRequest = { url, maxBytes: normalizeMaxBytes(params.maxBytes) };
			const response = await ops.fetch(request, signal);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const { text, details } = createOutput(request, response);
			return { content: [{ type: "text", text }], details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchResult(result as RenderableWebFetchResult, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebFetchTool(cwd: string, options?: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd, options));
}
