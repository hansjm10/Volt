/**
 * Extraction helpers for web search backends that return a prose blob instead of
 * structured results.
 *
 * The OpenAI/Codex search backend responds with a single `content` string holding
 * scraped page text for every hit. Emitting that verbatim costs thousands of tokens
 * per call and ignores the caller's `limit`. The blob is structured enough to parse:
 * each hit starts with a `Title (URL)` line followed by a detail line carrying a
 * `[wordlim: N]` marker and a provider-supplied snippet.
 */

import type { WebSearchResult } from "./web-search.ts";

/** Max characters kept from a provider-supplied snippet. */
export const MAX_SNIPPET_CHARS = 300;

/** Line cap applied to a provider blob that could not be parsed into results. */
export const FALLBACK_MAX_LINES = 150;

/**
 * Codex output wraps citation ids in private-use-area delimiters, e.g.
 * U+E200 "cite" U+E202 "turn1search0" U+E201.
 */
const CITATION_RUN = /\u{E200}[\s\S]{0,80}?\u{E201}/gu;
const PRIVATE_USE_RESIDUE = /[\u{E000}-\u{F8FF}]/gu;
const WORDLIM_MARKER = /\[wordlim:\s*\d+\]/;
const WORDLIM_MARKERS = /\[wordlim:\s*\d+\]/g;

/** A result header is a whole line ending in a parenthesized URL. Titles may be empty. */
const RESULT_HEADER = /^(.{0,200}?) ?\((https?:\/\/\S+)\)$/;
const PUBLISHED_PREFIX = /^Published:\s*([^;]+);\s*/;
const CRAWLED_PREFIX = /^Crawled:\s*[^;]+;\s*/;
const SEPARATOR_LINE = /^-{8,}$/;

/** Site furniture that carries no information about the query. */
const NAVIGATION_CHROME = [
	/^Copy link$/,
	/^More actions$/,
	/^New issue$/,
	/^Issue body actions$/,
	/^Additional navigation options$/,
	/^Skip to content$/i,
	/^Sign (in|up)\b/i,
	/^You must be signed in/i,
	/^\*\s*(Notifications|Fork|Star|Code|Issues|Pull requests|Discussions|Actions|Projects|Wiki|Security|Insights|Settings)\b/i,
];

function stripProviderMarkup(value: string): string {
	return value.replace(CITATION_RUN, "").replace(PRIVATE_USE_RESIDUE, "").replace(WORDLIM_MARKERS, "");
}

/** Some hits carry a bare URL with no title; the host is the best label available. */
function hostLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "") || url;
	} catch {
		return url;
	}
}

function capSnippet(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (trimmed.length <= MAX_SNIPPET_CHARS) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_SNIPPET_CHARS).trimEnd()}...`;
}

/**
 * Parse a provider blob into search results.
 *
 * A line is treated as a result header only when the following non-empty line
 * carries the provider's `[wordlim: N]` marker. That second condition rejects body
 * prose that happens to end in a parenthesized URL.
 *
 * Returns raw results for the caller to normalize; returns an empty array when the
 * blob does not follow the expected shape.
 */
export function parseProviderContent(content: string | undefined): WebSearchResult[] {
	if (!content) {
		return [];
	}

	const lines = content.split("\n");
	const results: WebSearchResult[] = [];

	for (let i = 0; i < lines.length - 1; i++) {
		const header = RESULT_HEADER.exec(lines[i]);
		if (!header) {
			continue;
		}

		const detail = lines[i + 1];
		if (!WORDLIM_MARKER.test(detail)) {
			continue;
		}

		let rest = stripProviderMarkup(detail).trim();
		const published = PUBLISHED_PREFIX.exec(rest);
		if (published) {
			rest = rest.slice(published[0].length);
		}
		const crawled = CRAWLED_PREFIX.exec(rest);
		if (crawled) {
			rest = rest.slice(crawled[0].length);
		}

		const snippet = capSnippet(rest);
		const publishedAt = published ? published[1].trim() : undefined;
		const url = header[2];
		const title = stripProviderMarkup(header[1]).trim();
		results.push({
			title: title.length > 0 ? title : hostLabel(url),
			url,
			...(snippet ? { snippet } : {}),
			...(publishedAt ? { publishedAt } : {}),
		});
		i++;
	}

	return results;
}

/**
 * Reduce a provider blob that could not be parsed into results.
 *
 * Strips provider markup, site furniture, repeated lines, and runs of blank lines.
 * Line and byte limits are applied separately by the caller.
 */
export function cleanProviderContent(content: string): string {
	const seen = new Set<string>();
	const kept: string[] = [];

	for (const line of stripProviderMarkup(content).split("\n")) {
		const trimmed = line.trim();

		if (trimmed.length === 0 || SEPARATOR_LINE.test(trimmed)) {
			if (kept.length > 0 && kept[kept.length - 1] !== "") {
				kept.push("");
			}
			continue;
		}

		if (NAVIGATION_CHROME.some((pattern) => pattern.test(trimmed))) {
			continue;
		}

		// Short lines repeat legitimately (list markers, code punctuation); only
		// deduplicate lines long enough to carry meaning.
		if (trimmed.length > 12) {
			if (seen.has(trimmed)) {
				continue;
			}
			seen.add(trimmed);
		}

		kept.push(trimmed);
	}

	while (kept.length > 0 && kept[kept.length - 1] === "") {
		kept.pop();
	}
	return kept.join("\n");
}
