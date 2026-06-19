/**
 * SWE-Pruner Tool
 *
 * Adds `swe_pruner_find`, a task-focused find tool that sends a local file to a
 * local SWE-Pruner service and returns relevant excerpts to the model.
 *
 * Usage:
 *   SWE_PRUNER_URL=http://127.0.0.1:8000 volt -e ./packages/coding-agent/examples/extensions/swe-pruner.ts
 *
 * Start SWE-Pruner with the Core AI backend from the sibling swe-pruner repo:
 *   npm run swe-pruner:start
 * Stop it:
 *   npm run swe-pruner:stop
 *
 * Config files (merged, project takes precedence):
 * - ~/.volt/agent/extensions/swe-pruner.json (global)
 * - <cwd>/.volt/swe-pruner.json (project-local)
 *
 * Example .volt/swe-pruner.json:
 * ```json
 * {
 *   "service_url": "http://127.0.0.1:8000",
 *   "threshold": 0.5,
 *   "always_keep_first_frags": false,
 *   "chunk_overlap_tokens": 50,
 *   "max_bytes": 2097152,
 *   "timeout_ms": 60000
 * }
 * ```
 */

import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/volt-coding-agent";
import {
	defineTool,
	formatSize,
	getAgentDir,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/volt-coding-agent";
import { Text } from "@earendil-works/volt-tui";
import { type Static, Type } from "typebox";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8000";
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 50;
const BINARY_SAMPLE_BYTES = 4096;
const CONFIG_FILE_NAME = "swe-pruner.json";
const CONFIG_KEYS = [
	"service_url",
	"threshold",
	"always_keep_first_frags",
	"chunk_overlap_tokens",
	"max_bytes",
	"timeout_ms",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];
type ConfigScope = "global" | "project";

interface SwePrunerConfig {
	service_url?: string;
	threshold?: number;
	always_keep_first_frags?: boolean;
	chunk_overlap_tokens?: number;
	max_bytes?: number;
	timeout_ms?: number;
}

const DEFAULT_CONFIG: Required<SwePrunerConfig> = {
	service_url: DEFAULT_SERVICE_URL,
	threshold: DEFAULT_THRESHOLD,
	always_keep_first_frags: false,
	chunk_overlap_tokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
	max_bytes: DEFAULT_MAX_FILE_BYTES,
	timeout_ms: DEFAULT_TIMEOUT_MS,
};

const swePrunerFindSchema = Type.Object({
	path: Type.String({ description: "Path to a local text file, relative to the current Volt session cwd" }),
	query: Type.String({
		description: 'Natural-language code query, e.g. "Find functions that handle user authentication".',
	}),
	threshold: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description: "Line pruning threshold from 0 to 1. Lower keeps more content. Default: 0.5.",
		}),
	),
	always_keep_first_frags: Type.Optional(
		Type.Boolean({ description: "Keep the first fragment even when it scores below threshold. Default: false." }),
	),
	chunk_overlap_tokens: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Token overlap between SWE-Pruner chunks for long files. Default: 50.",
		}),
	),
	max_bytes: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Maximum file size to send to SWE-Pruner. Defaults to config, SWE_PRUNER_MAX_BYTES, or 2MB. Increase for large generated files only when intentional.",
		}),
	),
	service_url: Type.Optional(
		Type.String({
			description:
				"SWE-Pruner service base URL or /prune endpoint. Defaults to config, SWE_PRUNER_URL, or http://127.0.0.1:8000.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "HTTP timeout for the SWE-Pruner request. Defaults to config, SWE_PRUNER_TIMEOUT_MS, or 60000.",
		}),
	),
});

type SwePrunerFindInput = Static<typeof swePrunerFindSchema>;

interface SwePrunerRequest {
	query: string;
	code: string;
	threshold: number;
	always_keep_first_frags: boolean;
	chunk_overlap_tokens: number;
}

interface SwePrunerResponse {
	score: number;
	pruned_code: string;
	kept_frags: number[];
	origin_token_cnt: number;
	left_token_cnt: number;
	model_input_token_cnt: number;
	error_msg?: string | null;
}

interface SwePrunerFindDetails {
	path: string;
	absolutePath: string;
	serviceUrl: string;
	sourceBytes: number;
	maxBytes: number;
	score: number;
	keptLines: number[];
	keptLineCount: number;
	originTokenCount: number;
	leftTokenCount: number;
	modelInputTokenCount: number;
	truncation?: TruncationResult;
	prunerWarning?: string;
}

interface RuntimeConfig {
	serviceUrl: string;
	threshold: number;
	alwaysKeepFirstFrags: boolean;
	chunkOverlapTokens: number;
	maxBytes: number;
	timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`SWE-Pruner response field "${key}" was not a finite number`);
	}
	return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`SWE-Pruner response field "${key}" was not a string`);
	}
	return value;
}

function parsePruneResponse(payload: unknown): SwePrunerResponse {
	if (!isRecord(payload)) {
		throw new Error("SWE-Pruner returned a non-object response");
	}
	const keptFrags = payload.kept_frags;
	if (!isNumberArray(keptFrags)) {
		throw new Error('SWE-Pruner response field "kept_frags" was not a number array');
	}
	const errorMsg = payload.error_msg;
	if (errorMsg !== undefined && errorMsg !== null && typeof errorMsg !== "string") {
		throw new Error('SWE-Pruner response field "error_msg" was not a string');
	}
	return {
		score: requiredNumber(payload, "score"),
		pruned_code: requiredString(payload, "pruned_code"),
		kept_frags: keptFrags,
		origin_token_cnt: requiredNumber(payload, "origin_token_cnt"),
		left_token_cnt: requiredNumber(payload, "left_token_cnt"),
		model_input_token_cnt: requiredNumber(payload, "model_input_token_cnt"),
		error_msg: errorMsg,
	};
}

function parseJsonPayload(text: string, url: string): unknown {
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`SWE-Pruner returned non-JSON from ${url}`);
	}
}

function responseDetail(payload: unknown, fallback: string): string {
	if (!isRecord(payload)) return fallback;
	const detail = payload.detail;
	if (typeof detail === "string") return detail;
	if (detail !== undefined) return JSON.stringify(detail);
	return fallback;
}

function configPath(scope: ConfigScope, cwd: string): string {
	return scope === "project"
		? join(cwd, ".volt", CONFIG_FILE_NAME)
		: join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

function optionalStringField(record: Record<string, unknown>, key: ConfigKey): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`"${key}" must be a non-empty string`);
	}
	return value.trim();
}

function optionalNumberField(record: Record<string, unknown>, key: ConfigKey): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`"${key}" must be a finite number`);
	}
	return value;
}

function optionalBooleanField(record: Record<string, unknown>, key: ConfigKey): boolean | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`"${key}" must be a boolean`);
	}
	return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return Math.floor(value);
}

function normalizeThreshold(value: number | undefined): number {
	if (value === undefined) return DEFAULT_THRESHOLD;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("threshold must be between 0 and 1");
	}
	return value;
}

function parseConfigObject(payload: unknown, source: string): SwePrunerConfig {
	if (!isRecord(payload)) {
		throw new Error(`${source} must contain a JSON object`);
	}

	const config: SwePrunerConfig = {};
	const serviceUrl = optionalStringField(payload, "service_url");
	if (serviceUrl !== undefined) config.service_url = serviceUrl;

	const threshold = optionalNumberField(payload, "threshold");
	if (threshold !== undefined) config.threshold = normalizeThreshold(threshold);

	const alwaysKeepFirstFrags = optionalBooleanField(payload, "always_keep_first_frags");
	if (alwaysKeepFirstFrags !== undefined) config.always_keep_first_frags = alwaysKeepFirstFrags;

	const chunkOverlapTokens = optionalNumberField(payload, "chunk_overlap_tokens");
	if (chunkOverlapTokens !== undefined) {
		config.chunk_overlap_tokens = normalizeNonNegativeInteger(
			chunkOverlapTokens,
			DEFAULT_CHUNK_OVERLAP_TOKENS,
			"chunk_overlap_tokens",
		);
	}

	const maxBytes = optionalNumberField(payload, "max_bytes");
	if (maxBytes !== undefined)
		config.max_bytes = normalizePositiveInteger(maxBytes, DEFAULT_MAX_FILE_BYTES, "max_bytes");

	const timeoutMs = optionalNumberField(payload, "timeout_ms");
	if (timeoutMs !== undefined)
		config.timeout_ms = normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, "timeout_ms");

	return config;
}

function readConfigFile(filePath: string): SwePrunerConfig {
	if (!existsSync(filePath)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		return parseConfigObject(parsed, filePath);
	} catch (error) {
		console.error(`Warning: Could not load SWE-Pruner config ${filePath}: ${formatError(error)}`);
		return {};
	}
}

function mergeConfig(base: Required<SwePrunerConfig>, overrides: SwePrunerConfig): Required<SwePrunerConfig> {
	return {
		service_url: overrides.service_url ?? base.service_url,
		threshold: overrides.threshold ?? base.threshold,
		always_keep_first_frags: overrides.always_keep_first_frags ?? base.always_keep_first_frags,
		chunk_overlap_tokens: overrides.chunk_overlap_tokens ?? base.chunk_overlap_tokens,
		max_bytes: overrides.max_bytes ?? base.max_bytes,
		timeout_ms: overrides.timeout_ms ?? base.timeout_ms,
	};
}

function loadConfig(cwd: string): Required<SwePrunerConfig> {
	const globalConfig = readConfigFile(configPath("global", cwd));
	const projectConfig = readConfigFile(configPath("project", cwd));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	if (source.aborted) {
		target.abort();
		return () => {};
	}
	const onAbort = () => target.abort();
	source.addEventListener("abort", onAbort, { once: true });
	return () => source.removeEventListener("abort", onAbort);
}

async function requestJson(
	url: string,
	init: { method?: string; headers?: Record<string, string>; body?: string },
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; payload: unknown; text: string }> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const cleanupAbort = forwardAbort(signal, controller);

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		return {
			status: response.status,
			ok: response.ok,
			payload: parseJsonPayload(text, url),
			text,
		};
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}
		if (timedOut) {
			throw new Error(`SWE-Pruner request timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		cleanupAbort();
	}
}

function readPositiveIntegerEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeServiceBaseUrl(rawUrl: string | undefined): string {
	const configuredUrl = rawUrl?.trim() || DEFAULT_SERVICE_URL;
	return configuredUrl.replace(/\/+$/, "");
}

function pruneUrl(rawUrl: string | undefined): string {
	const baseUrl = normalizeServiceBaseUrl(rawUrl);
	return baseUrl.endsWith("/prune") ? baseUrl : `${baseUrl}/prune`;
}

function healthUrl(rawUrl: string | undefined): string {
	const baseUrl = normalizeServiceBaseUrl(rawUrl);
	return baseUrl.endsWith("/prune") ? baseUrl.replace(/\/prune$/, "/health") : `${baseUrl}/health`;
}

function resolveUserPath(input: string, cwd: string): string {
	const trimmed = input.trim();
	const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	const expanded =
		withoutAt === "~" || withoutAt.startsWith("~/") ? resolve(homedir(), withoutAt.slice(2)) : withoutAt;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function displayPath(absolutePath: string, cwd: string): string {
	const relativePath = relative(cwd, absolutePath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
	return (isInsideCwd ? relativePath || "." : absolutePath).split(sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES));
	return sample.includes(0);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveRuntimeConfig(params: SwePrunerFindInput, cwd: string): RuntimeConfig {
	const config = loadConfig(cwd);
	return {
		serviceUrl: params.service_url?.trim() || process.env.SWE_PRUNER_URL?.trim() || config.service_url,
		threshold: normalizeThreshold(params.threshold ?? config.threshold),
		alwaysKeepFirstFrags: params.always_keep_first_frags ?? config.always_keep_first_frags,
		chunkOverlapTokens: normalizeNonNegativeInteger(
			params.chunk_overlap_tokens,
			config.chunk_overlap_tokens,
			"chunk_overlap_tokens",
		),
		maxBytes: normalizePositiveInteger(
			params.max_bytes,
			readPositiveIntegerEnv("SWE_PRUNER_MAX_BYTES") ?? config.max_bytes,
			"max_bytes",
		),
		timeoutMs: normalizePositiveInteger(
			params.timeout_ms,
			readPositiveIntegerEnv("SWE_PRUNER_TIMEOUT_MS") ?? config.timeout_ms,
			"timeout_ms",
		),
	};
}

function formatStats(details: SwePrunerFindDetails): string {
	const tokenReduction =
		details.originTokenCount > 0
			? `${Math.round((1 - details.leftTokenCount / details.originTokenCount) * 100)}%`
			: "0%";
	return [
		`score=${details.score.toFixed(4)}`,
		`tokens=${details.leftTokenCount}/${details.originTokenCount}`,
		`reduction=${tokenReduction}`,
		`kept_lines=${details.keptLineCount}`,
	].join(" ");
}

function formatFindExcerpts(displayedPath: string, keptLines: number[], prunedCode: string): string {
	const outputLines = prunedCode.split("\n");
	if (outputLines.at(-1) === "" && keptLines.length === outputLines.length - 1) {
		outputLines.pop();
	}
	if (keptLines.length !== outputLines.length) {
		return prunedCode;
	}
	return outputLines.map((line, index) => `${displayedPath}:${keptLines[index]}:${line}`).join("\n");
}

function formatToolOutput(displayedPath: string, details: SwePrunerFindDetails, prunedCode: string): string {
	const excerpts = formatFindExcerpts(displayedPath, details.keptLines, prunedCode);
	const truncation = truncateHead(excerpts);
	details.truncation = truncation.truncated ? truncation : undefined;

	const lines = [`[swe_pruner_find] matches in ${displayedPath}`, `[${formatStats(details)}]`];
	if (details.prunerWarning) {
		lines.push(`[SWE-Pruner warning: ${details.prunerWarning}]`);
	}
	lines.push("", truncation.content || "[No relevant excerpts returned by SWE-Pruner.]");
	if (truncation.truncated) {
		lines.push(
			"",
			`[SWE-Pruner output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Use a higher threshold or a narrower query for less output.]`,
		);
	}
	return lines.join("\n");
}

async function pruneCode(
	url: string,
	request: SwePrunerRequest,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SwePrunerResponse> {
	const response = await requestJson(
		url,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		},
		timeoutMs,
		signal,
	);
	if (!response.ok) {
		throw new Error(
			`SWE-Pruner returned HTTP ${response.status}: ${responseDetail(response.payload, response.text)}`,
		);
	}
	return parsePruneResponse(response.payload);
}

const swePrunerFindTool = defineTool<typeof swePrunerFindSchema, SwePrunerFindDetails>({
	name: "swe_pruner_find",
	label: "SWE-Pruner find",
	description:
		"Find task-relevant excerpts in a known local text file using a natural-language query. SWE-Pruner returns pruned code with irrelevant sections filtered out, plus the document relevance score and token counts.",
	promptSnippet: "Find task-relevant excerpts in a known local file with SWE-Pruner",
	promptGuidelines: [
		"Use rg/grep/find only to discover candidate files or verify exact string matches; once you have a likely file, use swe_pruner_find to understand the relevant sections.",
		'Use swe_pruner_find for semantic code questions like "Find authentication functions" or "Find code that updates session state" when a candidate text file is known.',
		"Prefer swe_pruner_find over read or broad grep snippets for large files, generated files, and files that are only partly relevant to the task.",
		"Do not use swe_pruner_find for symbols/references that LSP can answer, binary/image files, exact line ranges, or complete small files that should be read in full.",
		"If SWE-Pruner keeps too much or too little, retry with a narrower query or adjust threshold before falling back to reading the whole file.",
	],
	parameters: swePrunerFindSchema,
	executionMode: "sequential",

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const absolutePath = resolveUserPath(params.path, ctx.cwd);
		const runtimeConfig = resolveRuntimeConfig(params, ctx.cwd);
		const url = pruneUrl(runtimeConfig.serviceUrl);

		await access(absolutePath, constants.R_OK);
		const fileInfo = await stat(absolutePath);
		if (!fileInfo.isFile()) {
			throw new Error(`Not a regular file: ${params.path}`);
		}
		if (fileInfo.size > runtimeConfig.maxBytes) {
			throw new Error(
				`File is ${formatSize(fileInfo.size)}, above max_bytes ${formatSize(runtimeConfig.maxBytes)}. Increase max_bytes only when sending this whole file to SWE-Pruner is intentional.`,
			);
		}

		const buffer = await readFile(absolutePath);
		if (looksBinary(buffer)) {
			throw new Error(`File appears to be binary: ${params.path}`);
		}

		const response = await pruneCode(
			url,
			{
				query: params.query,
				code: buffer.toString("utf8"),
				threshold: runtimeConfig.threshold,
				always_keep_first_frags: runtimeConfig.alwaysKeepFirstFrags,
				chunk_overlap_tokens: runtimeConfig.chunkOverlapTokens,
			},
			runtimeConfig.timeoutMs,
			signal,
		);

		const displayedPath = displayPath(absolutePath, ctx.cwd);
		const details: SwePrunerFindDetails = {
			path: displayedPath,
			absolutePath,
			serviceUrl: url,
			sourceBytes: fileInfo.size,
			maxBytes: runtimeConfig.maxBytes,
			score: response.score,
			keptLines: response.kept_frags,
			keptLineCount: response.kept_frags.length,
			originTokenCount: response.origin_token_cnt,
			leftTokenCount: response.left_token_cnt,
			modelInputTokenCount: response.model_input_token_cnt,
			prunerWarning: response.error_msg ?? undefined,
		};

		return {
			content: [{ type: "text", text: formatToolOutput(displayedPath, details, response.pruned_code) }],
			details,
		};
	},

	renderCall(args, theme) {
		const path = typeof args.path === "string" ? args.path : "";
		const rawQuery = typeof args.query === "string" ? args.query : "";
		const query = rawQuery.length > 48 ? `${rawQuery.slice(0, 45)}...` : rawQuery;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("swe_pruner_find"))} ${theme.fg("accent", path)} ${theme.fg("dim", JSON.stringify(query))}`,
			0,
			0,
		);
	},

	renderResult(result, { expanded, isPartial }, theme) {
		if (isPartial) {
			return new Text(theme.fg("warning", "Finding relevant excerpts..."), 0, 0);
		}
		const details = result.details;
		if (!details) {
			return new Text("", 0, 0);
		}
		let text = theme.fg("success", formatStats(details));
		if (details.truncation?.truncated) {
			text += theme.fg("warning", " (output truncated)");
		}
		if (details.prunerWarning) {
			text += theme.fg("warning", ` warning: ${details.prunerWarning}`);
		}
		if (expanded) {
			const firstContent = result.content[0];
			if (firstContent?.type === "text") {
				text += `\n${theme.fg("dim", firstContent.text.split("\n").slice(0, 24).join("\n"))}`;
			}
		}
		return new Text(text, 0, 0);
	},
});

function isConfigScope(value: string): value is ConfigScope {
	return value === "global" || value === "project";
}

function isConfigKey(value: string): value is ConfigKey {
	return CONFIG_KEYS.includes(value as ConfigKey);
}

function parseBooleanConfigValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(normalized)) return true;
	if (["false", "0", "no", "off"].includes(normalized)) return false;
	throw new Error("boolean values must be true or false");
}

function parseNumberConfigValue(value: string, key: ConfigKey): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${key} must be a finite number`);
	}
	if (key === "threshold") return normalizeThreshold(parsed);
	if (key === "chunk_overlap_tokens") return normalizeNonNegativeInteger(parsed, 0, key);
	return normalizePositiveInteger(parsed, 1, key);
}

function setConfigValue(config: SwePrunerConfig, key: ConfigKey, rawValue: string): SwePrunerConfig {
	const next = { ...config };
	switch (key) {
		case "service_url":
			if (!rawValue.trim()) throw new Error("service_url must be a non-empty string");
			next.service_url = rawValue.trim();
			return next;
		case "threshold":
			next.threshold = parseNumberConfigValue(rawValue, key);
			return next;
		case "always_keep_first_frags":
			next.always_keep_first_frags = parseBooleanConfigValue(rawValue);
			return next;
		case "chunk_overlap_tokens":
			next.chunk_overlap_tokens = parseNumberConfigValue(rawValue, key);
			return next;
		case "max_bytes":
			next.max_bytes = parseNumberConfigValue(rawValue, key);
			return next;
		case "timeout_ms":
			next.timeout_ms = parseNumberConfigValue(rawValue, key);
			return next;
	}
	return next;
}

async function writeConfigFile(filePath: string, config: SwePrunerConfig): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await withFileMutationQueue(filePath, async () => {
		await writeFile(filePath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	});
}

function formatConfig(config: Required<SwePrunerConfig>, cwd: string): string {
	return [
		"SWE-Pruner config:",
		`  service_url: ${config.service_url}`,
		`  threshold: ${config.threshold}`,
		`  always_keep_first_frags: ${config.always_keep_first_frags}`,
		`  chunk_overlap_tokens: ${config.chunk_overlap_tokens}`,
		`  max_bytes: ${config.max_bytes} (${formatSize(config.max_bytes)})`,
		`  timeout_ms: ${config.timeout_ms}`,
		"",
		"Config files:",
		`  global: ${configPath("global", cwd)}`,
		`  project: ${configPath("project", cwd)}`,
		"",
		"Commands:",
		"  /swe-pruner-config init project",
		"  /swe-pruner-config set project service_url http://127.0.0.1:8000",
		"  /swe-pruner-config unset project threshold",
	].join("\n");
}

async function handleConfigCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "show") {
		ctx.ui.notify(formatConfig(loadConfig(ctx.cwd), ctx.cwd), "info");
		return;
	}

	const parts = trimmed.split(/\s+/);
	const action = parts[0];
	if (action === "init") {
		const scope = parts[1] ?? "project";
		if (!isConfigScope(scope)) {
			ctx.ui.notify("Usage: /swe-pruner-config init <project|global>", "error");
			return;
		}
		const filePath = configPath(scope, ctx.cwd);
		const current = readConfigFile(filePath);
		await writeConfigFile(filePath, mergeConfig(DEFAULT_CONFIG, current));
		ctx.ui.notify(`Wrote SWE-Pruner ${scope} config: ${filePath}`, "info");
		return;
	}

	if (action === "set") {
		const scope = parts[1];
		const key = parts[2];
		const rawValue = parts.slice(3).join(" ");
		if (!isConfigScope(scope) || !isConfigKey(key) || !rawValue) {
			ctx.ui.notify(`Usage: /swe-pruner-config set <project|global> <${CONFIG_KEYS.join("|")}> <value>`, "error");
			return;
		}
		try {
			const filePath = configPath(scope, ctx.cwd);
			const next = setConfigValue(readConfigFile(filePath), key, rawValue);
			await writeConfigFile(filePath, next);
			ctx.ui.notify(`Updated SWE-Pruner ${scope} config: ${key}`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not update SWE-Pruner config: ${formatError(error)}`, "error");
		}
		return;
	}

	if (action === "unset") {
		const scope = parts[1];
		const key = parts[2];
		if (!isConfigScope(scope) || !isConfigKey(key)) {
			ctx.ui.notify(`Usage: /swe-pruner-config unset <project|global> <${CONFIG_KEYS.join("|")}>`, "error");
			return;
		}
		const filePath = configPath(scope, ctx.cwd);
		const next = readConfigFile(filePath);
		delete next[key];
		await writeConfigFile(filePath, next);
		ctx.ui.notify(`Removed ${key} from SWE-Pruner ${scope} config`, "info");
		return;
	}

	ctx.ui.notify("Usage: /swe-pruner-config [show|init|set|unset]", "error");
}

export default function (volt: ExtensionAPI) {
	volt.registerTool(swePrunerFindTool);

	volt.registerCommand("swe-pruner-config", {
		description: "Show or persist SWE-Pruner config. Usage: /swe-pruner-config [show|init|set|unset]",
		handler: async (args, ctx) => {
			await handleConfigCommand(args, ctx);
		},
	});

	volt.registerCommand("swe-pruner-status", {
		description: "Check the configured SWE-Pruner service health. Optional arg: service URL.",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const rawUrl = args.trim() || process.env.SWE_PRUNER_URL?.trim() || config.service_url;
			const url = healthUrl(rawUrl);
			const timeoutMs = readPositiveIntegerEnv("SWE_PRUNER_TIMEOUT_MS") ?? config.timeout_ms;
			try {
				const response = await requestJson(url, { method: "GET" }, timeoutMs);
				if (!response.ok) {
					ctx.ui.notify(`SWE-Pruner health check failed: HTTP ${response.status}`, "error");
					return;
				}
				const payload = isRecord(response.payload) ? response.payload : {};
				const status = typeof payload.status === "string" ? payload.status : "unknown";
				const loaded = typeof payload.model_loaded === "boolean" ? payload.model_loaded : undefined;
				const backend = typeof payload.backend === "string" ? payload.backend : "unknown";
				const loadedText = loaded === undefined ? "unknown" : loaded ? "loaded" : "not loaded";
				ctx.ui.notify(
					`SWE-Pruner ${status}: backend=${backend}, model=${loadedText}`,
					loaded === false ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(`SWE-Pruner unavailable: ${formatError(error)}`, "error");
			}
		},
	});
}
