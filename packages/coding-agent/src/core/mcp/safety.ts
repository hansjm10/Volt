import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpRisk } from "./types.ts";

const TOKEN_START = "(?:^|[^a-z0-9])";
const TOKEN_END = "(?:$|[^a-z0-9])";
const DESTRUCTIVE_VERBS = [
	"delet(?:e|es|ed|ing)",
	"remov(?:e|es|ed|ing)",
	"rm",
	"destroy(?:s|ed|ing)?",
	"drop(?:s|ped|ping)?",
	"truncat(?:e|es|ed|ing)",
	"eras(?:e|es|ed|ing)",
	"reset(?:s|ting)?",
	"revok(?:e|es|ed|ing)",
	"terminat(?:e|es|ed|ing)",
	"kill(?:s|ed|ing)?",
	"purg(?:e|es|ed|ing)",
	"archiv(?:e|es|ed|ing)",
	"unarchiv(?:e|es|ed|ing)",
];
const WRITE_VERBS = [
	"creat(?:e|es|ed|ing)",
	"updat(?:e|es|ed|ing)",
	"writ(?:e|es|ten|ing)",
	"edit(?:s|ed|ing)?",
	"patch(?:es|ed|ing)?",
	"post(?:s|ed|ing)?",
	"put(?:s|ting)?",
	"send(?:s|ing)?",
	"sent",
	"submit(?:s|ted|ting)?",
	"comment(?:s|ed|ing)?",
	"merg(?:e|es|ed|ing)",
	"commit(?:s|ted|ting)?",
	"push(?:es|ed|ing)?",
	"publish(?:es|ed|ing)?",
	"upload(?:s|ed|ing)?",
	"insert(?:s|ed|ing)?",
	"set(?:s|ting)?",
	"add(?:s|ed|ing)?",
	"assign(?:s|ed|ing)?",
	"clos(?:e|es|ed|ing)",
	"reopen(?:s|ed|ing)?",
	"approv(?:e|es|ed|ing)",
	"reject(?:s|ed|ing)?",
	"execut(?:e|es|ed|ing)",
	"run(?:s|ning)?",
	"ran",
	"invok(?:e|es|ed|ing)",
	"trigger(?:s|ed|ing)?",
	"enabl(?:e|es|ed|ing)",
	"disabl(?:e|es|ed|ing)",
	"start(?:s|ed|ing)?",
	"stop(?:s|ped|ping)?",
	"cancel(?:s|ed|ing|led|ling)?",
];
const DESTRUCTIVE_NAME_PATTERN = new RegExp(`${TOKEN_START}(?:${DESTRUCTIVE_VERBS.join("|")})${TOKEN_END}`, "i");
const WRITE_NAME_PATTERN = new RegExp(`${TOKEN_START}(?:${WRITE_VERBS.join("|")})${TOKEN_END}`, "i");
const READ_NAME_PATTERN = new RegExp(
	`${TOKEN_START}(read|get|list|search|find|query|fetch|lookup|inspect|describe|show|view|download)${TOKEN_END}`,
	"i",
);
const SECRET_KEY_PATTERN = /token|secret|password|passwd|api[-_]?key|authorization|credential|private/i;
const SECRET_VALUE_PATTERN =
	/(bearer\s+)[A-Za-z0-9._~+/=-]+|((?:token|secret|password|passwd|api[-_]?key|authorization|credential|private)[\s:=]+)[^\s,;]+/gi;

function tokenizeRiskText(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.trim();
}

export function classifyMcpToolRisk(tool: Pick<SdkTool, "name" | "description" | "annotations">): McpRisk {
	if (tool.annotations?.destructiveHint === true) {
		return "destructive";
	}
	const haystack = tokenizeRiskText(`${tool.name} ${tool.description ?? ""}`);
	if (DESTRUCTIVE_NAME_PATTERN.test(haystack)) {
		return "destructive";
	}
	if (WRITE_NAME_PATTERN.test(haystack)) {
		return "write";
	}
	if (READ_NAME_PATTERN.test(haystack)) {
		return "read";
	}
	if (tool.annotations?.readOnlyHint === true) {
		return "read";
	}
	return "unknown";
}

export function isMcpToolTrustedReadCandidate(tool: Pick<SdkTool, "name" | "description" | "annotations">): boolean {
	return tool.annotations?.readOnlyHint === true && classifyMcpToolRisk(tool) === "read";
}

export function redactMcpText(value: string): string {
	return value.replace(
		SECRET_VALUE_PATTERN,
		(_match, bearerPrefix: string | undefined, keyPrefix: string | undefined) => {
			if (bearerPrefix) {
				return `${bearerPrefix}[redacted]`;
			}
			if (keyPrefix) {
				return `${keyPrefix}[redacted]`;
			}
			return "[redacted]";
		},
	);
}

export function sanitizeMcpArguments(value: unknown, depth = 0): unknown {
	if (depth > 4) {
		return "[redacted: nested]";
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return redactMcpText(value);
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((entry) => sanitizeMcpArguments(entry, depth + 1));
	}
	if (typeof value !== "object") {
		return String(value);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			result[key] = "[redacted]";
		} else {
			result[key] = sanitizeMcpArguments(entry, depth + 1);
		}
	}
	return result;
}
