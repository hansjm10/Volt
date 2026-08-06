import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { Api, ImageContent, Model } from "@hansjm10/volt-ai";
import { type Static, Type } from "typebox";
import { getAgentDir, VERSION } from "../../config.ts";
import { writeDurableAtomicFile } from "../../utils/durable-atomic-write.ts";
import { decodeImageToPng } from "../../utils/image-codec.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { getVoltUserAgent } from "../../utils/volt-user-agent.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const IMAGE_MODEL = "gpt-image-2";
const MAX_REFERENCE_IMAGES = 5;
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCE_MEGABYTES = 50;
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
	num_last_images_to_include: Type.Optional(
		Type.Integer({
			description: "Number of recent conversation images to edit or use as references",
			minimum: 1,
			maximum: MAX_REFERENCE_IMAGES,
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

export type ImageGenRecentImagesProvider = (
	count: number,
) => Promise<readonly ImageContent[]> | readonly ImageContent[];

export interface ImageGenReferenceFileHandle {
	close(): Promise<void>;
	read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	stat(): Promise<{ isFile(): boolean; size: number }>;
}

export interface ImageGenReferenceFileOperations {
	open(path: string, flags: "r"): Promise<ImageGenReferenceFileHandle>;
}

const DEFAULT_REFERENCE_FILE_OPERATIONS: ImageGenReferenceFileOperations = { open };

export interface ImageGenToolOptions {
	modelContext?: ImageGenModelContextProvider;
	recentImages?: ImageGenRecentImagesProvider;
	fetcher?: ImageGenFetcher;
	outputRoot?: string;
	referenceFileOperations?: ImageGenReferenceFileOperations;
	timeoutMs?: number;
}

export interface ImageGenToolDetails {
	model: typeof IMAGE_MODEL;
	operation: "generate" | "edit";
	outputPath: string;
	referencedImagePaths?: string[];
	referencedConversationImageCount?: number;
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

interface ImageReference {
	path?: string;
	image_url: string;
}

async function normalizeReferenceImage(data: Uint8Array, description: string): Promise<string> {
	const detectedMimeType = detectSupportedImageMimeType(data);
	if (!detectedMimeType) {
		throw new Error(`${description} is not a supported image`);
	}
	if (detectedMimeType !== "image/gif") {
		return `data:${detectedMimeType};base64,${Buffer.from(data).toString("base64")}`;
	}
	const png = await decodeImageToPng(data);
	if (!png) {
		throw new Error(`${description} could not be converted from GIF to PNG`);
	}
	return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

function decodeStrictBase64(value: string, description: string): Buffer {
	const invalid = (): never => {
		throw new Error(`${description} is not valid non-empty base64`);
	};
	if (value.length === 0 || value.length % 4 !== 0) invalid();
	const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const dataLength = value.length - paddingLength;
	let finalValue = 0;
	for (let index = 0; index < dataLength; index++) {
		const code = value.charCodeAt(index);
		let decodedValue = -1;
		if (code >= 65 && code <= 90) decodedValue = code - 65;
		else if (code >= 97 && code <= 122) decodedValue = code - 71;
		else if (code >= 48 && code <= 57) decodedValue = code + 4;
		else if (code === 43) decodedValue = 62;
		else if (code === 47) decodedValue = 63;
		if (decodedValue < 0) invalid();
		finalValue = decodedValue;
	}
	for (let index = dataLength; index < value.length; index++) {
		if (value[index] !== "=") invalid();
	}
	if ((paddingLength === 2 && (finalValue & 0x0f) !== 0) || (paddingLength === 1 && (finalValue & 0x03) !== 0)) {
		invalid();
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.length === 0) invalid();
	return decoded;
}

function ensureReferenceBudget(size: number, description: string, totalBytes: number): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error(`${description} has an invalid size`);
	}
	if (size === 0) {
		throw new Error(`${description} must not be empty`);
	}
	if (size >= MAX_REFERENCE_BYTES) {
		throw new Error(`${description} must be smaller than ${MAX_REFERENCE_MEGABYTES} MB`);
	}
	if (totalBytes + size > MAX_REFERENCE_BYTES) {
		throw new Error(
			`Reference images exceed the ${MAX_REFERENCE_MEGABYTES} MB combined decoded size limit; use fewer or smaller images`,
		);
	}
}

async function referenceImage(
	path: string,
	cwd: string,
	totalBytes: number,
	operations: ImageGenReferenceFileOperations,
): Promise<{ reference: ImageReference; size: number }> {
	const absolutePath = resolveToCwd(path, cwd);
	const description = `Referenced file ${path}`;
	const handle = await operations.open(absolutePath, "r").catch((error: unknown) => {
		throw new Error(`${description} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
	});
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) {
			throw new Error(`${description} must be a regular file`);
		}
		ensureReferenceBudget(stats.size, description, totalBytes);

		const data = Buffer.allocUnsafe(stats.size);
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
			if (bytesRead === 0) {
				throw new Error(`${description} changed while it was being read; retry with a stable file`);
			}
			offset += bytesRead;
		}
		return {
			reference: {
				path: absolutePath,
				image_url: await normalizeReferenceImage(data, description),
			},
			size: data.length,
		};
	} finally {
		await handle.close();
	}
}

async function conversationReferenceImage(
	image: ImageContent,
	index: number,
	totalBytes: number,
): Promise<{ reference: ImageReference; size: number }> {
	const description = `Recent conversation image ${index + 1}`;
	const data = decodeStrictBase64(image.data, description);
	ensureReferenceBudget(data.length, description, totalBytes);
	return {
		reference: { image_url: await normalizeReferenceImage(data, description) },
		size: data.length,
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
	const b64Json = first.b64_json;
	if (typeof b64Json !== "string" || b64Json.length === 0) {
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
	const referenceFileOperations = options.referenceFileOperations ?? DEFAULT_REFERENCE_FILE_OPERATIONS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		name: "image_gen",
		label: "image_gen",
		description:
			"Generate or edit an image with OpenAI GPT Image 2. Reference up to 5 local or recent conversation images and optionally choose where the generated PNG is saved.",
		promptSnippet: "Generate or edit images with GPT Image 2",
		promptGuidelines: [
			"Use image_gen when the user asks to create or edit an image and a Codex model is selected.",
			"For edits, use referenced_image_paths when every target has a local path; otherwise set num_last_images_to_include to the smallest recent-image count that includes every target.",
			"Never provide both referenced_image_paths and num_last_images_to_include.",
			"Set output_path when the image should become a repository asset; otherwise it is saved in Volt's generated-images directory.",
		],
		parameters: imageGenSchema,
		async execute(toolCallId, params: ImageGenToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const prompt = params.prompt.trim();
			if (!prompt) throw new Error("image_gen prompt must not be empty");
			const outputPath = params.output_path
				? resolveToCwd(params.output_path, cwd)
				: defaultOutputPath(outputRoot, toolCallId);
			ensurePngOutputPath(outputPath);

			const context = await options.modelContext?.();
			if (!context || !isCodexImageGenerationModel(context.model)) {
				throw new Error("image_gen is available only when an OpenAI Codex model is selected");
			}
			if (!context.apiKey) {
				throw new Error(`image_gen requires authentication for ${context.model.provider}/${context.model.id}`);
			}

			const requestedPaths = params.referenced_image_paths ?? [];
			const requestedConversationImageCount = params.num_last_images_to_include;
			if (requestedPaths.length > MAX_REFERENCE_IMAGES) {
				throw new Error(`referenced_image_paths must contain at most ${MAX_REFERENCE_IMAGES} paths`);
			}
			if (
				requestedConversationImageCount !== undefined &&
				(!Number.isInteger(requestedConversationImageCount) ||
					requestedConversationImageCount < 1 ||
					requestedConversationImageCount > MAX_REFERENCE_IMAGES)
			) {
				throw new Error(`num_last_images_to_include must be between 1 and ${MAX_REFERENCE_IMAGES}`);
			}
			if (requestedPaths.length > 0 && requestedConversationImageCount !== undefined) {
				throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include");
			}

			const references: ImageReference[] = [];
			let totalReferenceBytes = 0;
			if (requestedPaths.length > 0) {
				for (const path of requestedPaths) {
					const loaded = await referenceImage(path, cwd, totalReferenceBytes, referenceFileOperations);
					references.push(loaded.reference);
					totalReferenceBytes += loaded.size;
				}
			} else if (requestedConversationImageCount !== undefined) {
				const recentImages = await options.recentImages?.(requestedConversationImageCount);
				if (!recentImages) {
					throw new Error("Recent conversation images are unavailable in this session");
				}
				if (recentImages.length !== requestedConversationImageCount) {
					throw new Error(
						`Requested the last ${requestedConversationImageCount} conversation images, but only ${recentImages.length} were available`,
					);
				}
				for (const [index, image] of recentImages.entries()) {
					const loaded = await conversationReferenceImage(image, index, totalReferenceBytes);
					references.push(loaded.reference);
					totalReferenceBytes += loaded.size;
				}
			}
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
				output_format: "png",
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
			let imageBytes: Buffer;
			try {
				imageBytes = decodeStrictBase64(imageData, "OpenAI Codex image generation response");
			} catch {
				throw new Error("OpenAI Codex image generation returned invalid base64 image data");
			}
			if (detectSupportedImageMimeType(imageBytes) !== "image/png") {
				throw new Error("OpenAI Codex image generation returned non-PNG image data");
			}
			if (!(await decodeImageToPng(imageBytes))) {
				throw new Error("OpenAI Codex image generation returned malformed PNG image data");
			}

			await writeDurableAtomicFile(
				outputPath,
				imageBytes,
				params.output_path ? { directoryMode: 0o755, fileMode: 0o644 } : undefined,
			);

			const referencedImagePaths = references.flatMap((reference) =>
				reference.path === undefined ? [] : [reference.path],
			);
			const details: ImageGenToolDetails = {
				model: IMAGE_MODEL,
				operation,
				outputPath,
				...(referencedImagePaths.length > 0 ? { referencedImagePaths } : {}),
				...(requestedConversationImageCount !== undefined
					? { referencedConversationImageCount: requestedConversationImageCount }
					: {}),
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

export function createImageGenTool(
	cwd: string,
	options: ImageGenToolOptions = {},
): AgentTool<typeof imageGenSchema, ImageGenToolDetails> {
	return wrapToolDefinition(createImageGenToolDefinition(cwd, options));
}
