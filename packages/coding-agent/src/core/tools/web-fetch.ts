import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { Text } from "@hansjm10/volt-tui";
import { Window } from "happy-dom";
import { type Static, Type } from "typebox";
import { Agent, fetch as undiciFetch } from "undici";
import { VERSION } from "../../config.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
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

export type WebFetchFetcher = (
	input: string,
	init: RequestInit,
	validatedAddresses: readonly string[],
) => Promise<Response>;

/** Resolves a hostname to its addresses so private targets can be rejected. */
export type WebFetchHostResolver = (hostname: string) => Promise<string[]>;

export interface DefaultWebFetchOperationsOptions {
	env?: Record<string, string | undefined>;
	fetcher?: WebFetchFetcher;
	resolveHost?: WebFetchHostResolver;
	timeoutMs?: number;
}

/**
 * Supplies the URLs that already appeared in the conversation.
 *
 * Yields URLs, not the text they were found in; use {@link extractUrls} to pull
 * them out of trusted message text first.
 */
export type WebFetchUrlSource = () => Iterable<string>;

/**
 * Which URLs the model is allowed to fetch.
 *
 * `conversation` is the safe mode: only URLs the user supplied or that arrived as
 * trusted discovery results may be fetched, so a model that has read untrusted
 * content cannot construct a URL to exfiltrate context to. `unrestricted` is an
 * explicit opt-out for embedders that have no conversation to check against.
 */
export type WebFetchUrlPolicy = { type: "conversation"; urls: WebFetchUrlSource } | { type: "unrestricted" };

export interface WebFetchToolOptions {
	operations?: WebFetchOperations;
	/**
	 * Defaults to an empty conversation allowlist, so a tool wired without a URL
	 * source refuses everything rather than silently allowing model-authored URLs.
	 */
	urlPolicy?: WebFetchUrlPolicy;
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
 * Expand any textual IPv6 form into its 16 bytes.
 *
 * Matching IPv6 by string shape does not work: the same address has many
 * spellings, and `::ffff:127.0.0.1` serializes as `::ffff:7f00:1`, which no
 * dotted-quad pattern catches. Comparing bytes removes the whole class of
 * alternate-encoding bypasses.
 */
function parseIpv6(value: string): number[] | undefined {
	if (!value.includes(":")) return undefined;
	const halves = value.split("::");
	if (halves.length > 2) return undefined;

	const expand = (part: string): number[] | undefined => {
		if (part.length === 0) return [];
		const bytes: number[] = [];
		const groups = part.split(":");
		for (let index = 0; index < groups.length; index++) {
			const group = groups[index];
			// A trailing IPv4 literal represents the last four bytes.
			if (group.includes(".")) {
				if (index !== groups.length - 1) return undefined;
				const quad = parseIpv4(group);
				if (!quad) return undefined;
				bytes.push(...quad);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
			const word = Number.parseInt(group, 16);
			bytes.push((word >> 8) & 0xff, word & 0xff);
		}
		return bytes;
	};

	const head = expand(halves[0]);
	const tail = halves.length === 2 ? expand(halves[1]) : [];
	if (!head || !tail) return undefined;
	if (halves.length === 1) return head.length === 16 ? head : undefined;
	const gap = 16 - head.length - tail.length;
	if (gap < 0) return undefined;
	return [...head, ...new Array(gap).fill(0), ...tail];
}

/** True when these four bytes are not routable on the public internet. */
function isPrivateIpv4(bytes: number[]): boolean {
	const [a, b] = bytes;
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

/**
 * Reject addresses that are not routable on the public internet.
 *
 * Covers loopback, RFC1918, carrier-grade NAT, link-local (including the cloud
 * instance-metadata address), benchmarking, multicast, and reserved space, plus
 * the IPv6 equivalents and every embedding of an IPv4 address inside IPv6.
 */
function isPrivateAddress(address: string): boolean {
	const value = address
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");

	const ipv4 = parseIpv4(value);
	if (ipv4) {
		return isPrivateIpv4(ipv4);
	}

	const ipv6 = parseIpv6(value);
	if (!ipv6) {
		// Not an address literal at all; hostname rules handle those.
		return false;
	}

	if (ipv6.every((byte) => byte === 0)) return true;
	if (ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1) return true;
	// Unique-local fc00::/7 and link-local fe80::/10.
	if ((ipv6[0] & 0xfe) === 0xfc) return true;
	if (ipv6[0] === 0xfe && (ipv6[1] & 0xc0) === 0x80) return true;
	// Multicast ff00::/8.
	if (ipv6[0] === 0xff) return true;

	// IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, and NAT64 64:ff9b::/96 all
	// carry an IPv4 destination in the last four bytes.
	const embedded = ipv6.slice(12);
	const prefix = ipv6.slice(0, 12);
	const isMapped = prefix.slice(0, 10).every((byte) => byte === 0) && prefix[10] === 0xff && prefix[11] === 0xff;
	const isCompatible = prefix.every((byte) => byte === 0);
	const isNat64 =
		ipv6[0] === 0x00 &&
		ipv6[1] === 0x64 &&
		ipv6[2] === 0xff &&
		ipv6[3] === 0x9b &&
		prefix.slice(4).every((b) => b === 0);
	if (isMapped || isCompatible || isNat64) {
		return isPrivateIpv4(embedded);
	}
	return false;
}

/** URLs in prose usually end before sentence punctuation or a closing bracket. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const URL_TRAILING_NOISE = /[.,;:!?'"`)\]}]+$/;

/** Collect http(s) URLs from free text, such as a user message or a tool result. */
export function extractUrls(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(URL_IN_TEXT)) {
		const trimmed = match[0].replace(URL_TRAILING_NOISE, "");
		if (trimmed.length > 0) {
			found.push(trimmed);
		}
	}
	return found;
}

/** Extract only the canonical result URL fields emitted by web_search. */
export function extractWebSearchResultUrls(text: string): string[] {
	const found: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^URL:\s*(\S+)\s*$/.exec(line);
		if (match && normalizeFetchUrl(match[1]) !== undefined) {
			found.push(match[1]);
		}
	}
	return found;
}

/**
 * Canonical form used to compare a requested URL against the conversation.
 *
 * Case in the scheme and host, a bare trailing slash, and the fragment are not
 * meaningful differences; everything else is kept so a different path or query
 * is a different URL.
 */
export function normalizeFetchUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return undefined;
	}
	// Userinfo is not part of the identity of a page, so ignoring it would let
	// `https://secret@allowed.example/page` pass as `https://allowed.example/page`
	// and carry data out in the credentials. Refuse to canonicalize it instead.
	if (url.username !== "" || url.password !== "") {
		return undefined;
	}
	const path = url.pathname === "/" ? "" : url.pathname;
	return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

function assertUrlAllowed(url: string, policy: WebFetchUrlPolicy): void {
	if (policy.type === "unrestricted") {
		return;
	}
	const target = normalizeFetchUrl(url);
	if (target !== undefined) {
		for (const candidate of policy.urls()) {
			if (normalizeFetchUrl(candidate) === target) {
				return;
			}
		}
	}
	throw new Error(
		`web_fetch can only read URLs that already appeared in this conversation, and ${url} did not. ` +
			"Use web_search to find the page, or ask the user for the URL.",
	);
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (host.length === 0) return true;
	if (host === "localhost") return true;
	return host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

interface ValidatedWebFetchUrl {
	url: URL;
	addresses: string[];
}

async function assertFetchableUrl(raw: string, resolveHost: WebFetchHostResolver): Promise<ValidatedWebFetchUrl> {
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
	if (isPrivateAddress(url.hostname)) {
		throw new Error(`web_fetch refuses to fetch ${url.hostname}: resolves to non-public address ${url.hostname}`);
	}

	// A public-looking hostname can still resolve to a private address, so check
	// what it actually resolves to rather than trusting its shape.
	const addresses = await resolveHost(url.hostname);
	if (addresses.length === 0) {
		throw new Error(`web_fetch could not resolve ${url.hostname}`);
	}
	for (const address of addresses) {
		if (isIP(address) === 0) {
			throw new Error(`web_fetch received an invalid address for ${url.hostname}: ${address}`);
		}
		if (isPrivateAddress(address)) {
			throw new Error(`web_fetch refuses to fetch ${url.hostname}: resolves to non-public address ${address}`);
		}
	}
	return { url, addresses };
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
	if (isPrivateAddress(hostname)) {
		return [hostname];
	}
	const results = await lookup(hostname, { all: true });
	return results.map((entry) => entry.address);
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Elements whose content is markup, styling, or scripting rather than page text. */
const NON_CONTENT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE", "HEAD", "IFRAME", "CANVAS"]);
/**
 * Site furniture dropped before extraction.
 *
 * NAV and FOOTER are reliably chrome. HEADER and ASIDE are not: headers often
 * carry the page heading and asides carry callouts, so they are kept even though
 * dropping them would shrink output further.
 */
const CHROME_TAGS = new Set(["NAV", "FOOTER"]);
/** Elements that start and end a line of output. */
const BLOCK_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TBODY",
	"TFOOT",
	"THEAD",
	"TR",
	"UL",
]);
/** Table cells separate with a tab so one row stays on one line. */
const CELL_TAGS = new Set(["TD", "TH"]);

/** Structural subset of the DOM this walker needs, so happy-dom types stay internal. */
interface DomNode {
	nodeType: number;
	data?: string;
	tagName?: string;
	childNodes: Iterable<DomNode>;
}

export interface ExtractedHtml {
	text: string;
	title?: string;
}

/**
 * Convert HTML to readable text.
 *
 * Uses a real HTML parser rather than tag-stripping regexes, which mishandle
 * attributes containing `>` and leak the body of an unclosed `<script>`. Text
 * inside `<pre>` keeps its whitespace so code samples survive.
 */
export function extractHtml(html: string): ExtractedHtml {
	const window = new Window({
		settings: {
			enableJavaScriptEvaluation: false,
			disableJavaScriptFileLoading: true,
			disableCSSFileLoading: true,
			enableImageFileLoading: false,
			handleDisabledFileLoadingAsSuccess: true,
			navigation: {
				disableMainFrameNavigation: true,
				disableChildFrameNavigation: true,
				disableChildPageNavigation: true,
				disableFallbackToSetURL: true,
			},
		},
	});
	try {
		const document = window.document;
		document.write(html);

		const lines: string[] = [];
		let current = "";
		let currentIsPre = false;

		const flush = (): void => {
			// Leading whitespace is meaningful inside <pre> and noise everywhere else.
			lines.push(currentIsPre ? current.replace(/\s+$/, "") : current.trim());
			current = "";
			currentIsPre = false;
		};

		const appendPre = (value: string): void => {
			const parts = value.split("\n");
			current += parts[0];
			currentIsPre = true;
			for (let index = 1; index < parts.length; index++) {
				flush();
				currentIsPre = true;
				current = parts[index];
			}
		};

		const walk = (node: DomNode, inPre: boolean): void => {
			if (node.nodeType === TEXT_NODE) {
				const raw = node.data ?? "";
				if (inPre) {
					appendPre(raw);
					return;
				}
				current += raw.replace(/\s+/g, " ");
				return;
			}
			if (node.nodeType !== ELEMENT_NODE) {
				return;
			}
			const tag = node.tagName ?? "";
			if (NON_CONTENT_TAGS.has(tag) || CHROME_TAGS.has(tag)) {
				return;
			}
			if (tag === "BR") {
				flush();
				return;
			}
			if (CELL_TAGS.has(tag)) {
				if (current.length > 0 && !current.endsWith("\t")) {
					current += "\t";
				}
				for (const child of node.childNodes) walk(child, inPre);
				return;
			}
			const block = BLOCK_TAGS.has(tag);
			const pre = inPre || tag === "PRE";
			if (block) flush();
			if (tag === "LI") current += "- ";
			for (const child of node.childNodes) walk(child, pre);
			// A list item or table row ends at its next sibling or at the container
			// close, so flushing here too would put a blank line between every bullet
			// and every row.
			if (block && tag !== "LI" && tag !== "TR") flush();
		};

		const root = (document.body ?? document.documentElement) as unknown as DomNode | null;
		if (root) walk(root, false);
		flush();

		const output: string[] = [];
		for (const line of lines) {
			if (line.length === 0) {
				if (output.length > 0 && output[output.length - 1] !== "") output.push("");
				continue;
			}
			output.push(line);
		}
		while (output.length > 0 && output[output.length - 1] === "") output.pop();

		const title = document.title?.trim();
		return { text: output.join("\n"), ...(title ? { title } : {}) };
	} finally {
		window.close();
	}
}

/** Readable text of an HTML document. */
export function htmlToText(html: string): string {
	return extractHtml(html).text;
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

function createPinnedDispatcher(addresses: readonly string[]): Agent {
	const records: Array<{ address: string; family: 4 | 6 }> = [];
	for (const address of addresses) {
		const family = isIP(address);
		if (family !== 4 && family !== 6) {
			throw new Error(`web_fetch cannot pin invalid address ${address}`);
		}
		records.push({ address, family });
	}

	const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
		const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
		const matching = requestedFamily ? records.filter((record) => record.family === requestedFamily) : records;
		if (matching.length === 0) {
			const error = new Error("No validated address matches the requested address family") as NodeJS.ErrnoException;
			error.code = "ENOTFOUND";
			callback(error, []);
			return;
		}
		if (options.all) {
			callback(null, matching);
			return;
		}
		callback(null, matching[0].address, matching[0].family);
	};

	return new Agent({
		connections: 1,
		connect: { lookup: pinnedLookup },
	});
}

async function readBoundedResponseBody(response: Response): Promise<string> {
	if (!response.body) {
		return "";
	}

	const bytes = new Uint8Array(MAX_DOWNLOAD_BYTES);
	const reader = response.body.getReader();
	let length = 0;
	try {
		while (length < bytes.byteLength) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const accepted = value.subarray(0, bytes.byteLength - length);
			bytes.set(accepted, length);
			length += accepted.byteLength;
			if (length === bytes.byteLength) {
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(bytes.subarray(0, length));
}

async function discardResponseBody(response: Response | undefined): Promise<void> {
	if (!response?.body || response.bodyUsed) {
		return;
	}
	await response.body.cancel().catch(() => undefined);
}

export function createDefaultWebFetchOperations(options: DefaultWebFetchOperationsOptions = {}): WebFetchOperations {
	const env = options.env ?? process.env;
	const fetcher = options.fetcher;
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
			let dispatcher: Agent | undefined;

			try {
				// Redirects are followed by hand so every hop is re-validated and
				// connected through only the DNS addresses validated for that hop.
				for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
					try {
						const headers = {
							"User-Agent": getVoltUserAgent(VERSION),
							accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
						};
						const init: RequestInit = {
							method: "GET",
							redirect: "manual",
							headers,
							signal: requestSignal,
						};
						if (fetcher) {
							response = await fetcher(current.url.toString(), init, current.addresses);
						} else {
							dispatcher = createPinnedDispatcher(current.addresses);
							response = (await undiciFetch(current.url.toString(), {
								method: "GET",
								redirect: "manual",
								headers,
								signal: requestSignal,
								dispatcher,
							})) as unknown as Response;
						}
					} catch (error) {
						await dispatcher?.close().catch(() => undefined);
						dispatcher = undefined;
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
					const redirectUrl = new URL(location, current.url).toString();
					await discardResponseBody(response);
					response = undefined;
					await dispatcher?.close();
					dispatcher = undefined;
					current = await assertFetchableUrl(redirectUrl, resolveHost);
				}

				if (!response) {
					throw new Error(`web_fetch request failed: ${request.url}`);
				}
				if (!response.ok) {
					throw new Error(`web_fetch returned HTTP ${response.status} for ${current.url.toString()}`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				if (contentType && !isTextualContentType(contentType)) {
					throw new Error(`web_fetch cannot read content type ${contentType.split(";", 1)[0].trim()}`);
				}

				const body = await readBoundedResponseBody(response);
				const isHtml = /html/i.test(contentType) || /^\s*<(!doctype html|html)\b/i.test(body);
				const extracted = isHtml ? extractHtml(body) : undefined;

				return {
					url: current.url.toString(),
					...(extracted?.title ? { title: extracted.title } : {}),
					...(contentType ? { contentType } : {}),
					content: extracted ? extracted.text : body.trim(),
				};
			} finally {
				await discardResponseBody(response);
				await dispatcher?.close().catch(() => undefined);
			}
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
	const urlPolicy: WebFetchUrlPolicy = options?.urlPolicy ?? { type: "conversation", urls: () => [] };
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a single http(s) URL and return its readable text. Use after web_search when a result's snippet is not enough, or when the user supplies a URL. Only URLs that already appeared in this conversation can be fetched. Returns page text with HTML markup removed.",
		promptSnippet: "Fetch the readable text of a URL",
		promptGuidelines: [
			"Use web_fetch to read a specific page, and web_search to discover pages.",
			"web_fetch only accepts URLs already present in the conversation, so search for a page or ask the user for its URL rather than constructing one.",
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
			// Checked here rather than inside the operations so that swapping the
			// network implementation cannot bypass the allowlist. Redirect targets are
			// deliberately exempt: they are revalidated for SSRF, but a redirect from an
			// allowed URL is part of fetching that URL.
			assertUrlAllowed(url, urlPolicy);
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
