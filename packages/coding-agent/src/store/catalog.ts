import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_STORE_CATALOG_URL = "https://earendil-works.github.io/volt/store/catalog.json";

export type StoreResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface StoreCatalog {
	schemaVersion: 1;
	packages: StoreCatalogPackage[];
}

export interface StoreCatalogPackage {
	id: string;
	name: string;
	description: string;
	source: string;
	repo?: string;
	author?: string;
	license?: string;
	verified?: boolean;
	categories?: string[];
	resources?: StoreResourceType[];
	compatibility?: { volt?: string };
	image?: string;
	video?: string;
}

export interface StoreCatalogValidationResult {
	catalog: StoreCatalog;
	warnings: string[];
}

export interface LoadStoreCatalogResult {
	catalog: StoreCatalog;
	source: "remote" | "cache" | "empty";
	warnings: string[];
}

interface StoreCatalogFetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export type StoreCatalogFetcher = (url: string) => Promise<StoreCatalogFetchResponse>;

export interface LoadDefaultStoreCatalogOptions {
	agentDir: string;
	url?: string;
	offline?: boolean;
	fetcher?: StoreCatalogFetcher;
}

const RESOURCE_TYPES = new Set<StoreResourceType>(["extensions", "skills", "prompts", "themes"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string, errors: string[]): string | undefined {
	const value = record[key];
	if (typeof value === "string" && value.trim()) {
		return value;
	}
	errors.push(`${key} must be a non-empty string`);
	return undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string, errors: string[]): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "string") {
		return value;
	}
	errors.push(`${key} must be a string`);
	return undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string, errors: string[]): boolean | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "boolean") {
		return value;
	}
	errors.push(`${key} must be a boolean`);
	return undefined;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string, errors: string[]): string[] | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		errors.push(`${key} must be an array of strings`);
		return undefined;
	}
	return [...value];
}

function readOptionalResources(
	record: Record<string, unknown>,
	key: string,
	errors: string[],
): StoreResourceType[] | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		errors.push(`${key} must be an array`);
		return undefined;
	}

	const resources: StoreResourceType[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !RESOURCE_TYPES.has(entry as StoreResourceType)) {
			errors.push(`${key} contains an invalid resource type`);
			return undefined;
		}
		resources.push(entry as StoreResourceType);
	}
	return resources;
}

function readOptionalCompatibility(
	record: Record<string, unknown>,
	key: string,
	errors: string[],
): { volt?: string } | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		errors.push(`${key} must be an object`);
		return undefined;
	}
	const volt = readOptionalString(value, "volt", errors);
	return volt === undefined ? {} : { volt };
}

function validateCatalogPackage(value: unknown, index: number): { pkg?: StoreCatalogPackage; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return { errors: [`packages[${index}] must be an object`] };
	}

	const id = readRequiredString(value, "id", errors);
	const name = readRequiredString(value, "name", errors);
	const description = readRequiredString(value, "description", errors);
	const source = readRequiredString(value, "source", errors);
	const repo = readOptionalString(value, "repo", errors);
	const author = readOptionalString(value, "author", errors);
	const license = readOptionalString(value, "license", errors);
	const verified = readOptionalBoolean(value, "verified", errors);
	const categories = readOptionalStringArray(value, "categories", errors);
	const resources = readOptionalResources(value, "resources", errors);
	const compatibility = readOptionalCompatibility(value, "compatibility", errors);
	const image = readOptionalString(value, "image", errors);
	const video = readOptionalString(value, "video", errors);

	if (errors.length > 0 || !id || !name || !description || !source) {
		return { errors };
	}

	const pkg: StoreCatalogPackage = {
		id,
		name,
		description,
		source,
		...(repo !== undefined ? { repo } : {}),
		...(author !== undefined ? { author } : {}),
		...(license !== undefined ? { license } : {}),
		...(verified !== undefined ? { verified } : {}),
		...(categories !== undefined ? { categories } : {}),
		...(resources !== undefined ? { resources } : {}),
		...(compatibility !== undefined ? { compatibility } : {}),
		...(image !== undefined ? { image } : {}),
		...(video !== undefined ? { video } : {}),
	};
	return { pkg, errors: [] };
}

export function validateStoreCatalog(value: unknown): StoreCatalogValidationResult {
	if (!isRecord(value)) {
		throw new Error("Store catalog must be a JSON object");
	}
	if (value.schemaVersion !== 1) {
		throw new Error("Store catalog schemaVersion must be 1");
	}
	if (!Array.isArray(value.packages)) {
		throw new Error("Store catalog packages must be an array");
	}

	const warnings: string[] = [];
	const packages: StoreCatalogPackage[] = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < value.packages.length; index++) {
		const result = validateCatalogPackage(value.packages[index], index);
		if (!result.pkg) {
			warnings.push(`Skipping invalid catalog package at index ${index}: ${result.errors.join("; ")}`);
			continue;
		}
		if (seenIds.has(result.pkg.id)) {
			warnings.push(`Skipping duplicate catalog package id "${result.pkg.id}" at index ${index}`);
			continue;
		}
		seenIds.add(result.pkg.id);
		packages.push(result.pkg);
	}

	return {
		catalog: { schemaVersion: 1, packages },
		warnings,
	};
}

export function parseStoreCatalogJson(raw: string, label = "store catalog"): StoreCatalogValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${label}: ${message}`);
	}
	return validateStoreCatalog(parsed);
}

export function getStoreCatalogCachePath(agentDir: string): string {
	return join(agentDir, "store", "catalogs", "default.json");
}

function isOfflineModeEnabled(): boolean {
	const value = process.env.VOLT_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function getDefaultCatalogUrl(url?: string): string {
	return url ?? process.env.VOLT_STORE_CATALOG_URL ?? DEFAULT_STORE_CATALOG_URL;
}

function readCachedCatalog(agentDir: string): LoadStoreCatalogResult | undefined {
	const cachePath = getStoreCatalogCachePath(agentDir);
	if (!existsSync(cachePath)) {
		return undefined;
	}

	const result = parseStoreCatalogJson(readFileSync(cachePath, "utf-8"), "cached store catalog");
	return {
		catalog: result.catalog,
		source: "cache",
		warnings: result.warnings,
	};
}

function writeCachedCatalog(agentDir: string, raw: string): void {
	const cachePath = getStoreCatalogCachePath(agentDir);
	mkdirSync(join(agentDir, "store", "catalogs"), { recursive: true, mode: 0o700 });
	writeFileSync(cachePath, raw, "utf-8");
}

export async function loadDefaultStoreCatalog(
	options: LoadDefaultStoreCatalogOptions,
): Promise<LoadStoreCatalogResult> {
	const offline = options.offline ?? isOfflineModeEnabled();
	if (offline) {
		try {
			const cached = readCachedCatalog(options.agentDir);
			if (cached) {
				return {
					...cached,
					warnings: ["Offline mode enabled; using cached store catalog.", ...cached.warnings],
				};
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				catalog: { schemaVersion: 1, packages: [] },
				source: "empty",
				warnings: [`Offline mode enabled and cached store catalog is invalid: ${message}`],
			};
		}
		return {
			catalog: { schemaVersion: 1, packages: [] },
			source: "empty",
			warnings: ["Offline mode enabled and no cached store catalog is available."],
		};
	}

	const url = getDefaultCatalogUrl(options.url);
	const fetcher = options.fetcher ?? globalThis.fetch;
	try {
		const response = await fetcher(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const raw = await response.text();
		const result = parseStoreCatalogJson(raw, "remote store catalog");
		writeCachedCatalog(options.agentDir, raw);
		return {
			catalog: result.catalog,
			source: "remote",
			warnings: result.warnings,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const cached = readCachedCatalog(options.agentDir);
		if (cached) {
			return {
				...cached,
				warnings: [`Failed to load remote store catalog (${message}); using cached catalog.`, ...cached.warnings],
			};
		}
		throw new Error(`Failed to load store catalog: ${message}`);
	}
}

export function findCatalogPackage(catalog: StoreCatalog, id: string): StoreCatalogPackage | undefined {
	return catalog.packages.find((pkg) => pkg.id === id);
}

export function searchCatalogPackages(catalog: StoreCatalog, query?: string): StoreCatalogPackage[] {
	const normalizedQuery = query?.trim().toLowerCase();
	if (!normalizedQuery) {
		return [...catalog.packages];
	}

	return catalog.packages.filter((pkg) => {
		const fields = [pkg.id, pkg.name, pkg.description, ...(pkg.categories ?? [])];
		return fields.some((field) => field.toLowerCase().includes(normalizedQuery));
	});
}

function levenshteinDistance(left: string, right: string): number {
	const previous = new Array<number>(right.length + 1);
	const current = new Array<number>(right.length + 1);
	for (let index = 0; index <= right.length; index++) {
		previous[index] = index;
	}
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		current[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + cost,
			);
		}
		for (let index = 0; index <= right.length; index++) {
			previous[index] = current[index];
		}
	}
	return previous[right.length] ?? 0;
}

export function suggestCatalogPackageIds(catalog: StoreCatalog, input: string, limit = 3): string[] {
	const normalizedInput = input.toLowerCase();
	return catalog.packages
		.map((pkg) => ({
			id: pkg.id,
			score: pkg.id.toLowerCase().includes(normalizedInput)
				? 0
				: levenshteinDistance(normalizedInput, pkg.id.toLowerCase()),
		}))
		.filter((entry) => entry.score <= Math.max(2, Math.floor(normalizedInput.length / 2)))
		.sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
		.slice(0, limit)
		.map((entry) => entry.id);
}
