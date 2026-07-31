import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import { type Static, Type } from "typebox";
import { getAgentDir, VERSION } from "../../config.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { getVoltUserAgent } from "../../utils/volt-user-agent.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const IMAGE_MODEL = "gpt-image-2";
const MAX_REFERENCE_IMAGES = 5;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const imageGenSchema = Type.Object({
	prompt: Type.String({
		description: "Detailed prompt describing the image to generate or the edit to apply",
		minLength: 1,
	}),
	referenced_image_paths: Type.Optional(
		Type.Array(Type.String({ description: "Path to a local input image" }), {
			description: "Up to 5 local images to edit or use as references",
			maxItems: MAX_REFERENCE_IMAGES,
		}),
	),
	output_path: Type.Optional(
		Type.String({
			description: "Where to save the generated PNG, relative to the working directory or absolute",
		}),
	),
});

export type ImageGenToolInput = Static<typeof imageGenSchema>;

export interface ImageGenModelContext {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
}

export type ImageGenModelContextProvider = () =>
	| Promise<ImageGenModelContext | undefined>
	| ImageGenModelContext
	| undefined;

export type ImageGenFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ImageGenToolOptions {
	modelContext?: ImageGenModelContextProvider;
	fetcher?: ImageGenFetcher;
	outputRoot?: string;
	timeoutMs?: number;
}

export interface ImageGenToolDetails {
	model: typeof IMAGE_MODEL;
	operation: "generate" | "edit";
	outputPath: string;
	referencedImagePaths?: string[];
	size?: string;
	quality?: string;
}

interface ImageApiResponse {
	data: Array<{ b64_json: string }>;
	size?: string;
	quality?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isCodexImageGenerationModel(model: Model<Api> | undefined): model is Model<"openai-codex-responses"> {
	return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function resolveCodexImagesUrl(baseUrl: string | undefined, operation: "generations" | "edits"): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith(`/images/${operation}`)) return normalized;
	if (normalized.endsWith("/codex/responses")) {
		return `${normalized.slice(0, -"/responses".length)}/images/${operation}`;
	}
	if (normalized.endsWith("/codex")) return `${normalized}/images/${operation}`;
	return `${normalized}/codex/images/${operation}`;
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | undefined {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
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

function sanitizeFileStem(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
	return sanitized || `image-${Date.now()}`;
}

function defaultOutputPath(outputRoot: string, toolCallId: string): string {
	return join(outputRoot, `${sanitizeFileStem(toolCallId)}.png`);
}

async function referenceImage(path: string, cwd: string): Promise<{ path: string; image_url: string }> {
	const absolutePath = resolveToCwd(path, cwd);
	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (!mimeType) {
		throw new Error(`Referenced file is not a supported image: ${path}`);
	}
	const data = await readFile(absolutePath);
	return {
		path: absolutePath,
		image_url: `data:${mimeType};base64,${data.toString("base64")}`,
	};
}

async function readResponseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function responseErrorMessage(body: unknown): string | undefined {
	if (typeof body === "string") return body.trim().slice(0, 500) || undefined;
	if (!isRecord(body)) return undefined;
	const error = body.error;
	if (isRecord(error)) return getString(error, "message")?.slice(0, 500);
	return getString(body, "message")?.slice(0, 500);
}

function parseImageResponse(body: unknown): ImageApiResponse {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new Error("OpenAI Codex image generation returned an invalid response");
	}
	const first = body.data[0];
	if (!isRecord(first)) {
		throw new Error("OpenAI Codex image generation returned no image data");
	}
	const b64Json = getString(first, "b64_json");
	if (!b64Json) {
		throw new Error("OpenAI Codex image generation returned no image data");
	}
	return {
		data: [{ b64_json: b64Json }],
		size: getString(body, "size"),
		quality: getString(body, "quality"),
	};
}

function ensurePngOutputPath(path: string): void {
	if (extname(path).toLowerCase() !== ".png") {
		throw new Error(`image_gen output_path must use a .png extension: ${path}`);
	}
}

export function createImageGenToolDefinition(
	cwd: string,
	options: ImageGenToolOptions = {},
): ToolDefinition<typeof imageGenSchema, ImageGenToolDetails> {
	const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
	const outputRoot = options.outputRoot ?? join(getAgentDir(), "generated_images");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		name: "image_gen",
		label: "image_gen",
		description:
			"Generate or edit an image with OpenAI GPT Image 2. Reference up to 5 local images and optionally choose where the generated PNG is saved.",
		promptSnippet: "Generate or edit images with GPT Image 2",
		promptGuidelines: [
			"Use image_gen when the user asks to create or edit an image and a Codex model is selected.",
			"Set output_path when the image should become a repository asset; otherwise it is saved in Volt's generated-images directory.",
		],
		parameters: imageGenSchema,
		async execute(toolCallId, params: ImageGenToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const prompt = params.prompt.trim();
			if (!prompt) throw new Error("image_gen prompt must not be empty");

			const context = await options.modelContext?.();
			if (!context || !isCodexImageGenerationModel(context.model)) {
				throw new Error("image_gen is available only when an OpenAI Codex model is selected");
			}
			if (!context.apiKey) {
				throw new Error(`image_gen requires authentication for ${context.model.provider}/${context.model.id}`);
			}

			const requestedPaths = params.referenced_image_paths ?? [];
			if (requestedPaths.length > MAX_REFERENCE_IMAGES) {
				throw new Error(`referenced_image_paths must contain at most ${MAX_REFERENCE_IMAGES} paths`);
			}
			const references = await Promise.all(requestedPaths.map((path) => referenceImage(path, cwd)));
			const operation = references.length > 0 ? "edit" : "generate";
			const endpointOperation = operation === "edit" ? "edits" : "generations";
			const headers = new Headers(context.model.headers);
			for (const [name, value] of Object.entries(context.headers ?? {})) headers.set(name, value);
			headers.set("authorization", `Bearer ${context.apiKey}`);
			headers.set("chatgpt-account-id", extractChatGptAccountId(context.apiKey));
			headers.set("originator", "volt");
			headers.set("user-agent", getVoltUserAgent(VERSION));
			headers.set("accept", "application/json");
			headers.set("content-type", "application/json");
			headers.set("x-codex-image-turn-id", toolCallId);

			const body: Record<string, unknown> = {
				prompt,
				background: "auto",
				model: IMAGE_MODEL,
				quality: "auto",
				size: "auto",
			};
			if (references.length > 0) {
				body.images = references.map(({ image_url }) => ({ image_url }));
			}

			let response: Response;
			try {
				const timeoutSignal = AbortSignal.timeout(timeoutMs);
				const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
				response = await fetcher(resolveCodexImagesUrl(context.model.baseUrl, endpointOperation), {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: requestSignal,
				});
			} catch (error) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
					throw new Error("OpenAI Codex image generation timed out");
				}
				throw new Error(
					`OpenAI Codex image generation request failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const responseBody = await readResponseBody(response);
			if (!response.ok) {
				const message = responseErrorMessage(responseBody);
				throw new Error(
					`OpenAI Codex image generation returned HTTP ${response.status}${message ? `: ${message}` : ""}`,
				);
			}
			const parsed = parseImageResponse(responseBody);
			const imageData = parsed.data[0].b64_json;
			const imageBytes = Buffer.from(imageData, "base64");
			if (imageBytes.length === 0) {
				throw new Error("OpenAI Codex image generation returned invalid image data");
			}

			const outputPath = params.output_path
				? resolveToCwd(params.output_path, cwd)
				: defaultOutputPath(outputRoot, toolCallId);
			ensurePngOutputPath(outputPath);
			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, imageBytes);

			const referencedImagePaths = references.map((reference) => reference.path);
			const details: ImageGenToolDetails = {
				model: IMAGE_MODEL,
				operation,
				outputPath,
				...(referencedImagePaths.length > 0 ? { referencedImagePaths } : {}),
				...(parsed.size ? { size: parsed.size } : {}),
				...(parsed.quality ? { quality: parsed.quality } : {}),
			};
			return {
				content: [
					{ type: "text", text: `Generated image saved to ${outputPath}` },
					{ type: "image", mimeType: "image/png", data: imageData },
				],
				details,
			};
		},
	};
}

export function createImageGenTool(cwd: string, options: ImageGenToolOptions = {}): AgentTool<typeof imageGenSchema> {
	return wrapToolDefinition(createImageGenToolDefinition(cwd, options));
}
