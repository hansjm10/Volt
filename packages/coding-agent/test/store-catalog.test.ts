import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getStoreCatalogCachePath,
	loadDefaultStoreCatalog,
	searchCatalogPackages,
	validateStoreCatalog,
} from "../src/store/catalog.ts";

describe("store catalog", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("validates entries and skips malformed or duplicate packages", () => {
		const result = validateStoreCatalog({
			schemaVersion: 1,
			packages: [
				{
					id: "rtk",
					name: "RTK",
					description: "Token optimized shell output",
					source: "git:github.com/earendil-works/volt-rtk@v0.1.0",
					resources: ["extensions"],
				},
				{
					id: "bad",
					name: "Bad",
					source: "npm:bad@1.0.0",
				},
				{
					id: "rtk",
					name: "Duplicate",
					description: "Duplicate",
					source: "npm:duplicate@1.0.0",
				},
			],
		});

		expect(result.catalog.packages.map((pkg) => pkg.id)).toEqual(["rtk"]);
		expect(result.warnings).toEqual([
			"Skipping invalid catalog package at index 1: description must be a non-empty string",
			'Skipping duplicate catalog package id "rtk" at index 2',
		]);
	});

	it("searches ids, names, descriptions, and categories case-insensitively", () => {
		const catalog = validateStoreCatalog({
			schemaVersion: 1,
			packages: [
				{
					id: "rtk",
					name: "RTK Output Compression",
					description: "Token optimized shell output",
					source: "git:github.com/earendil-works/volt-rtk@v0.1.0",
					categories: ["Shell"],
				},
				{
					id: "theme-dark",
					name: "Dark Theme",
					description: "Theme package",
					source: "npm:@scope/theme-dark@1.0.0",
					categories: ["Theme"],
				},
			],
		}).catalog;

		expect(searchCatalogPackages(catalog, "SHELL").map((pkg) => pkg.id)).toEqual(["rtk"]);
		expect(searchCatalogPackages(catalog, "theme").map((pkg) => pkg.id)).toEqual(["theme-dark"]);
		expect(searchCatalogPackages(catalog, "token").map((pkg) => pkg.id)).toEqual(["rtk"]);
	});

	it("fetches and caches the default catalog", async () => {
		const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, packages: [] }));

		const result = await loadDefaultStoreCatalog({ agentDir: tempDir, fetcher });

		expect(result.source).toBe("remote");
		expect(fetcher).toHaveBeenCalledOnce();
		expect(JSON.parse(readFileSync(getStoreCatalogCachePath(tempDir), "utf-8"))).toEqual({
			schemaVersion: 1,
			packages: [],
		});
	});

	it("keeps the remote catalog when cache persistence fails", async () => {
		const agentDir = join(tempDir, "agent-file");
		writeFileSync(agentDir, "not a directory");
		const fetcher = vi.fn(async () =>
			Response.json({
				schemaVersion: 1,
				packages: [
					{
						id: "remote",
						name: "Remote",
						description: "Fresh remote package",
						source: "npm:@scope/remote@1.0.0",
					},
				],
			}),
		);

		const result = await loadDefaultStoreCatalog({ agentDir, fetcher });

		expect(result.source).toBe("remote");
		expect(result.catalog.packages.map((pkg) => pkg.id)).toEqual(["remote"]);
		expect(result.warnings).toEqual([expect.stringContaining("Failed to cache remote store catalog")]);
	});

	it("uses the cached catalog in offline mode", async () => {
		const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, packages: [] }));
		await loadDefaultStoreCatalog({ agentDir: tempDir, fetcher });

		const result = await loadDefaultStoreCatalog({ agentDir: tempDir, offline: true });

		expect(result.source).toBe("cache");
		expect(result.warnings[0]).toBe("Offline mode enabled; using cached store catalog.");
	});

	it("falls back to the cached catalog when the remote fetch times out", async () => {
		await loadDefaultStoreCatalog({
			agentDir: tempDir,
			fetcher: vi.fn(async () =>
				Response.json({
					schemaVersion: 1,
					packages: [
						{
							id: "cached",
							name: "Cached",
							description: "Cached package",
							source: "npm:@scope/cached@1.0.0",
						},
					],
				}),
			),
		});
		const fetcher = vi.fn(() => new Promise<never>(() => {}));
		const options = { agentDir: tempDir, fetcher, timeoutMs: 5 };

		const result = await Promise.race([
			loadDefaultStoreCatalog(options),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
		]);

		expect(result).not.toBe("hung");
		if (result === "hung") return;
		expect(result.source).toBe("cache");
		expect(result.catalog.packages.map((pkg) => pkg.id)).toEqual(["cached"]);
		expect(result.warnings[0]).toContain("Failed to load remote store catalog");
		expect(result.warnings[0]).toContain("using cached catalog");
	});
});
