import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, ImageContent, Model } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createImageGenTool,
	type ImageGenFetcher,
	type ImageGenReferenceFileOperations,
	isCodexImageGenerationModel,
} from "../src/index.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "volt-image-gen-"));
	tempDirs.push(directory);
	return directory;
}

function codexModel(baseUrl = "https://chatgpt.com/backend-api"): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function nonCodexModel(): Model<Api> {
	return { ...codexModel("https://api.openai.com/v1"), api: "openai-responses", provider: "openai" };
}

function codexToken(accountId = "account-123"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function createReferenceFileOperations(
	entries: Record<string, { data: Uint8Array; isFile?: boolean; size?: number }>,
	events: string[],
): ImageGenReferenceFileOperations {
	return {
		open: vi.fn(async (path) => {
			const entry = entries[path];
			if (!entry) throw new Error("missing simulated file");
			events.push(`open:${path}`);
			return {
				stat: vi.fn(async () => {
					events.push(`stat:${path}`);
					return { isFile: () => entry.isFile ?? true, size: entry.size ?? entry.data.length };
				}),
				read: vi.fn(async (buffer, offset, length, position) => {
					events.push(`read:${path}`);
					const availableData = entry.data.subarray(position, Math.min(entry.data.length, position + length));
					buffer.set(availableData, offset);
					return { bytesRead: length };
				}),
				close: vi.fn(async () => {
					events.push(`close:${path}`);
				}),
			};
		}),
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("image_gen tool", () => {
	it("generates with GPT Image 2, uses Codex auth, saves the PNG, and returns image content", async () => {
		const cwd = await createTempDir();
		const outputPath = join(cwd, "assets", "hero.png");
		const fetcher = vi.fn<ImageGenFetcher>(async (input, init) => {
			expect(input).toBe("https://chatgpt.com/backend-api/codex/images/generations");
			expect(init?.method).toBe("POST");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${codexToken()}`);
			expect(headers.get("chatgpt-account-id")).toBe("account-123");
			expect(headers.get("originator")).toBe("volt");
			expect(headers.get("x-codex-image-turn-id")).toBe("call/gen 1");
			expect(headers.get("x-test-header")).toBe("kept");
			expect(JSON.parse(init?.body as string)).toEqual({
				prompt: "A luminous Volt logo",
				background: "auto",
				model: "gpt-image-2",
				output_format: "png",
				quality: "auto",
				size: "auto",
			});
			return jsonResponse({
				data: [{ b64_json: PNG_BASE64 }],
				size: "1024x1024",
				quality: "high",
			});
		});
		const tool = createImageGenTool(cwd, {
			fetcher,
			outputRoot: join(cwd, "generated"),
			modelContext: () => ({
				model: codexModel(),
				apiKey: codexToken(),
				headers: { "x-test-header": "kept" },
			}),
		});

		const result = await tool.execute("call/gen 1", {
			prompt: " A luminous Volt logo ",
			output_path: "assets/hero.png",
		});

		expect(fetcher).toHaveBeenCalledOnce();
		expect(await readFile(outputPath)).toEqual(Buffer.from(PNG_BASE64, "base64"));
		if (process.platform !== "win32") {
			expect((await stat(outputPath)).mode & 0o777).toBe(0o644);
		}
		expect(result.content).toEqual([
			{ type: "text", text: `Generated image saved to ${outputPath}` },
			{ type: "image", mimeType: "image/png", data: PNG_BASE64 },
		]);
		expect(result.details).toEqual({
			model: "gpt-image-2",
			operation: "generate",
			outputPath,
			size: "1024x1024",
			quality: "high",
		});
	});

	it("uses the Codex edits endpoint for referenced local images and a sanitized default path", async () => {
		const cwd = await createTempDir();
		const outputRoot = join(cwd, "generated");
		const referencePath = join(cwd, "reference.png");
		await writeFile(referencePath, Buffer.from(PNG_BASE64, "base64"));
		const fetcher = vi.fn<ImageGenFetcher>(async (input, init) => {
			expect(input).toBe("https://chatgpt.com/backend-api/codex/images/edits");
			const body = JSON.parse(init?.body as string) as Record<string, unknown>;
			expect(body).toMatchObject({
				prompt: "Add a blue halo",
				model: "gpt-image-2",
			});
			expect(body.images).toEqual([{ image_url: `data:image/png;base64,${PNG_BASE64}` }]);
			return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
		});
		const tool = createImageGenTool(cwd, {
			fetcher,
			outputRoot,
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		const result = await tool.execute("call/edit 2", {
			prompt: "Add a blue halo",
			referenced_image_paths: ["reference.png"],
		});

		const expectedOutputPath = join(outputRoot, "call_edit_2.png");
		expect(await readFile(expectedOutputPath)).toEqual(Buffer.from(PNG_BASE64, "base64"));
		if (process.platform !== "win32") {
			expect((await stat(expectedOutputPath)).mode & 0o777).toBe(0o600);
		}
		expect(result.details).toEqual({
			model: "gpt-image-2",
			operation: "edit",
			outputPath: expectedOutputPath,
			referencedImagePaths: [referencePath],
		});
	});

	it("edits the exact recent conversation images in provider order", async () => {
		const cwd = await createTempDir();
		const firstImage = { type: "image", mimeType: "image/png", data: PNG_BASE64 } as const;
		const secondData = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.from([1])]).toString("base64");
		const secondImage = { type: "image", mimeType: "image/jpeg", data: secondData } as const;
		const recentImages = vi.fn<(count: number) => readonly ImageContent[]>(() => [firstImage, secondImage]);
		const fetcher = vi.fn<ImageGenFetcher>(async (input, init) => {
			expect(input).toBe("https://chatgpt.com/backend-api/codex/images/edits");
			expect(JSON.parse(init?.body as string)).toMatchObject({
				images: [
					{ image_url: `data:image/png;base64,${PNG_BASE64}` },
					{ image_url: `data:image/png;base64,${secondData}` },
				],
			});
			return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
		});
		const tool = createImageGenTool(cwd, {
			fetcher,
			outputRoot: join(cwd, "generated"),
			recentImages,
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		const result = await tool.execute("conversation-edit", {
			prompt: "Combine the references",
			num_last_images_to_include: 2,
		});

		expect(recentImages).toHaveBeenCalledWith(2);
		expect(result.details).toMatchObject({
			operation: "edit",
			referencedConversationImageCount: 2,
		});
	});

	it("rejects ambiguous or insufficient conversation image selectors without fetching", async () => {
		const cwd = await createTempDir();
		const fetcher = vi.fn<ImageGenFetcher>();
		const tool = createImageGenTool(cwd, {
			fetcher,
			recentImages: () => [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await expect(
			tool.execute("ambiguous", {
				prompt: "Edit",
				referenced_image_paths: ["reference.png"],
				num_last_images_to_include: 1,
			}),
		).rejects.toThrow("Provide only one of referenced_image_paths or num_last_images_to_include");
		await expect(tool.execute("insufficient", { prompt: "Edit", num_last_images_to_include: 2 })).rejects.toThrow(
			"Requested the last 2 conversation images, but only 1 were available",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects non-regular, empty, oversized, and excessive local references before fetching", async () => {
		const cwd = await createTempDir();
		const png = Buffer.from(PNG_BASE64, "base64");
		const paths = {
			directory: join(cwd, "directory.png"),
			empty: join(cwd, "empty.png"),
			large: join(cwd, "large.png"),
			first: join(cwd, "first.png"),
			second: join(cwd, "second.png"),
		};
		const events: string[] = [];
		const fetcher = vi.fn<ImageGenFetcher>();
		const referenceFileOperations = createReferenceFileOperations(
			{
				[paths.directory]: { data: png, isFile: false },
				[paths.empty]: { data: Buffer.alloc(0) },
				[paths.large]: { data: png, size: 50 * 1024 * 1024 },
				[paths.first]: { data: png, size: 26 * 1024 * 1024 },
				[paths.second]: { data: png, size: 25 * 1024 * 1024 },
			},
			events,
		);
		const tool = createImageGenTool(cwd, {
			fetcher,
			referenceFileOperations,
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await expect(
			tool.execute("directory", { prompt: "Edit", referenced_image_paths: ["directory.png"] }),
		).rejects.toThrow("must be a regular file");
		await expect(tool.execute("empty", { prompt: "Edit", referenced_image_paths: ["empty.png"] })).rejects.toThrow(
			"must not be empty",
		);
		await expect(tool.execute("large", { prompt: "Edit", referenced_image_paths: ["large.png"] })).rejects.toThrow(
			"must be smaller than 50 MB",
		);
		await expect(
			tool.execute("combined", {
				prompt: "Edit",
				referenced_image_paths: ["first.png", "second.png"],
			}),
		).rejects.toThrow("50 MB combined decoded size limit");
		expect(fetcher).not.toHaveBeenCalled();
		expect(events).toEqual([
			`open:${paths.directory}`,
			`stat:${paths.directory}`,
			`close:${paths.directory}`,
			`open:${paths.empty}`,
			`stat:${paths.empty}`,
			`close:${paths.empty}`,
			`open:${paths.large}`,
			`stat:${paths.large}`,
			`close:${paths.large}`,
			`open:${paths.first}`,
			`stat:${paths.first}`,
			`read:${paths.first}`,
			`close:${paths.first}`,
			`open:${paths.second}`,
			`stat:${paths.second}`,
			`close:${paths.second}`,
		]);
	});

	it("loads local references sequentially and closes each bounded handle on validation failure", async () => {
		const cwd = await createTempDir();
		const firstPath = join(cwd, "first.png");
		const invalidPath = join(cwd, "invalid.png");
		const events: string[] = [];
		const fetcher = vi.fn<ImageGenFetcher>();
		const tool = createImageGenTool(cwd, {
			fetcher,
			referenceFileOperations: createReferenceFileOperations(
				{
					[firstPath]: { data: Buffer.from(PNG_BASE64, "base64") },
					[invalidPath]: { data: Buffer.from("not an image") },
				},
				events,
			),
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await expect(
			tool.execute("sequential", {
				prompt: "Edit",
				referenced_image_paths: ["first.png", "invalid.png"],
			}),
		).rejects.toThrow("Referenced file invalid.png is not a supported image");
		expect(events).toEqual([
			`open:${firstPath}`,
			`stat:${firstPath}`,
			`read:${firstPath}`,
			`close:${firstPath}`,
			`open:${invalidPath}`,
			`stat:${invalidPath}`,
			`read:${invalidPath}`,
			`close:${invalidPath}`,
		]);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects more than five local references before opening files or fetching", async () => {
		const cwd = await createTempDir();
		const fetcher = vi.fn<ImageGenFetcher>();
		const referenceFileOperations: ImageGenReferenceFileOperations = { open: vi.fn() };
		const tool = createImageGenTool(cwd, {
			fetcher,
			referenceFileOperations,
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await expect(
			tool.execute("too-many", {
				prompt: "Edit",
				referenced_image_paths: ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"],
			}),
		).rejects.toThrow("at most 5 paths");
		expect(referenceFileOperations.open).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects an oversized decoded conversation reference before fetching", async () => {
		const cwd = await createTempDir();
		const fetcher = vi.fn<ImageGenFetcher>();
		const oversizedImage = Buffer.alloc(50 * 1024 * 1024, 0);
		Buffer.from(PNG_BASE64, "base64").copy(oversizedImage);
		const tool = createImageGenTool(cwd, {
			fetcher,
			recentImages: () => [{ type: "image", mimeType: "image/png", data: oversizedImage.toString("base64") }],
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await expect(
			tool.execute("large-conversation-image", { prompt: "Edit", num_last_images_to_include: 1 }),
		).rejects.toThrow("must be smaller than 50 MB");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("converts referenced GIFs to PNG before sending an edit", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "reference.gif"), Buffer.from(GIF_BASE64, "base64"));
		const fetcher = vi.fn<ImageGenFetcher>(async (_input, init) => {
			const body = JSON.parse(init?.body as string) as { images: Array<{ image_url: string }> };
			expect(body.images).toHaveLength(1);
			expect(body.images[0]?.image_url).toMatch(/^data:image\/png;base64,/);
			expect(body.images[0]?.image_url).not.toContain(GIF_BASE64);
			return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
		});
		const tool = createImageGenTool(cwd, {
			fetcher,
			outputRoot: join(cwd, "generated"),
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await tool.execute("gif-edit", {
			prompt: "Edit the GIF",
			referenced_image_paths: ["reference.gif"],
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("rejects non-PNG output paths before resolving auth or fetching", async () => {
		const cwd = await createTempDir();
		const fetcher = vi.fn<ImageGenFetcher>();
		const modelContext = vi.fn(() => ({ model: codexModel(), apiKey: codexToken() }));
		const tool = createImageGenTool(cwd, { fetcher, modelContext });

		await expect(tool.execute("bad-output", { prompt: "A fox", output_path: "fox.jpg" })).rejects.toThrow(
			"image_gen output_path must use a .png extension",
		);
		expect(modelContext).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects execution without a selected Codex model", async () => {
		const cwd = await createTempDir();
		const fetcher = vi.fn<ImageGenFetcher>();
		const tool = createImageGenTool(cwd, {
			fetcher,
			modelContext: () => ({ model: nonCodexModel(), apiKey: "unused" }),
		});

		await expect(tool.execute("call-1", { prompt: "A fox" })).rejects.toThrow(
			"image_gen is available only when an OpenAI Codex model is selected",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("preserves an existing output when responses contain malformed base64, non-PNG, or truncated PNG data", async () => {
		const cwd = await createTempDir();
		const outputPath = join(cwd, "existing.png");
		const original = Buffer.from("existing output");
		const truncatedPng = Buffer.from(PNG_BASE64, "base64").subarray(0, 32).toString("base64");
		const cases = [
			{ data: "%%%%", error: "invalid base64 image data" },
			{ data: ` ${PNG_BASE64} `, error: "invalid base64 image data" },
			{ data: GIF_BASE64, error: "non-PNG image data" },
			{ data: truncatedPng, error: "malformed PNG image data" },
		];

		for (const testCase of cases) {
			await writeFile(outputPath, original);
			const tool = createImageGenTool(cwd, {
				fetcher: async () => jsonResponse({ data: [{ b64_json: testCase.data }] }),
				modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
			});
			await expect(tool.execute("bad-response", { prompt: "A fox", output_path: outputPath })).rejects.toThrow(
				testCase.error,
			);
			expect(await readFile(outputPath)).toEqual(original);
		}
	});

	it("surfaces Codex API error messages without writing an output", async () => {
		const cwd = await createTempDir();
		const outputRoot = join(cwd, "generated");
		const tool = createImageGenTool(cwd, {
			outputRoot,
			fetcher: async () => jsonResponse({ error: { message: "Image quota exhausted" } }, 429),
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});

		await expect(tool.execute("call-1", { prompt: "A fox" })).rejects.toThrow(
			"OpenAI Codex image generation returned HTTP 429: Image quota exhausted",
		);
		await expect(readFile(join(outputRoot, "call-1.png"))).rejects.toThrow();
	});
});

describe("isCodexImageGenerationModel", () => {
	it("requires both the OpenAI Codex provider and API", () => {
		expect(isCodexImageGenerationModel(codexModel())).toBe(true);
		expect(isCodexImageGenerationModel(nonCodexModel())).toBe(false);
		expect(isCodexImageGenerationModel({ ...codexModel(), provider: "custom" })).toBe(false);
	});
});
