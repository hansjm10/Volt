import type { ChildProcessByStdio } from "node:child_process";
import { type Dirent, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, type Stats, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { globSync } from "glob";
import { minimatch } from "minimatch";
import { spawnProcess } from "../utils/child-process.ts";
import { parseGitUrl } from "../utils/git.ts";
import { addIgnoreRules, createIgnoreMatcher, type IgnoreMatcher } from "../utils/ignore-files.ts";
import { resolvePath } from "../utils/paths.ts";
import { getSubprocessEnv } from "../utils/process-env.ts";
import type { StoreResourceType } from "./catalog.ts";

export interface StoreVoltManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	image?: string;
	video?: string;
}

export interface StorePackageInspection {
	source: string;
	packageName?: string;
	packageVersion?: string;
	packageDescription?: string;
	packageLicense?: string;
	packageRepository?: string;
	voltManifest?: StoreVoltManifest;
	discoveredResources: Record<StoreResourceType, string[]>;
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	optionalDependencies: Record<string, string>;
	scripts: Record<string, string>;
	warnings: string[];
}

export interface InspectStorePackageOptions {
	source: string;
	cwd: string;
	npmCommand?: string[];
}

interface CommandCaptureOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

interface PackageJsonData {
	name?: string;
	version?: string;
	description?: string;
	license?: string;
	repository?: string;
	voltManifest?: StoreVoltManifest;
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	optionalDependencies: Record<string, string>;
	scripts: Record<string, string>;
}

interface InspectionDiscoveryOptions {
	localFallbackExtension?: boolean;
}

const RESOURCE_TYPES: StoreResourceType[] = ["extensions", "skills", "prompts", "themes"];
const EMPTY_RESOURCES: Record<StoreResourceType, string[]> = {
	extensions: [],
	skills: [],
	prompts: [],
	themes: [],
};
const FILE_PATTERNS: Record<StoreResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};
const COMMAND_TIMEOUT_MS = 30000;

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		return undefined;
	}
	return [...value];
}

function readStringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			result[key] = entry;
		}
	}
	return result;
}

function readRepository(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (isRecord(value)) {
		return readString(value.url);
	}
	return undefined;
}

function readLicense(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (isRecord(value)) {
		return readString(value.type);
	}
	return undefined;
}

function readVoltManifest(value: unknown): StoreVoltManifest | undefined {
	if (!value) {
		return undefined;
	}
	if (!isRecord(value)) {
		return {};
	}
	const manifest: StoreVoltManifest = {};
	const extensions = readStringArray(value.extensions);
	const skills = readStringArray(value.skills);
	const prompts = readStringArray(value.prompts);
	const themes = readStringArray(value.themes);
	const image = readString(value.image);
	const video = readString(value.video);
	if (extensions !== undefined) manifest.extensions = extensions;
	if (skills !== undefined) manifest.skills = skills;
	if (prompts !== undefined) manifest.prompts = prompts;
	if (themes !== undefined) manifest.themes = themes;
	if (image !== undefined) manifest.image = image;
	if (video !== undefined) manifest.video = video;
	return manifest;
}

function readPackageJsonData(value: unknown): PackageJsonData {
	if (!isRecord(value)) {
		return {
			dependencies: {},
			peerDependencies: {},
			optionalDependencies: {},
			scripts: {},
		};
	}
	return {
		name: readString(value.name),
		version: readString(value.version),
		description: readString(value.description),
		license: readLicense(value.license),
		repository: readRepository(value.repository),
		voltManifest: readVoltManifest(value.volt),
		dependencies: readStringRecord(value.dependencies),
		peerDependencies: readStringRecord(value.peerDependencies),
		optionalDependencies: readStringRecord(value.optionalDependencies),
		scripts: readStringRecord(value.scripts),
	};
}

function readPackageJsonFile(packageJsonPath: string): PackageJsonData {
	const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
	return readPackageJsonData(parsed);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function statIfExists(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function getDirentKind(entry: Dirent, fullPath: string): { isDirectory: boolean; isFile: boolean } | undefined {
	if (!entry.isSymbolicLink()) {
		return { isDirectory: entry.isDirectory(), isFile: entry.isFile() };
	}
	const stats = statIfExists(fullPath);
	if (!stats) {
		return undefined;
	}
	return { isDirectory: stats.isDirectory(), isFile: stats.isFile() };
}

function collectSkillResourceFiles(dir: string, root = dir, ignoreMatcher?: IgnoreMatcher): string[] {
	if (!existsSync(dir)) {
		return [];
	}

	const ig = ignoreMatcher ?? createIgnoreMatcher();
	addIgnoreRules(ig, dir, root);
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		const kind = getDirentKind(entry, fullPath);
		if (!kind) {
			continue;
		}
		const relPath = toPosixPath(relative(root, fullPath));
		if (entry.name === "SKILL.md" && kind.isFile && !ig.ignores(relPath)) {
			return [fullPath];
		}
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		const fullPath = join(dir, entry.name);
		const kind = getDirentKind(entry, fullPath);
		if (!kind) {
			continue;
		}
		const relPath = toPosixPath(relative(root, fullPath));
		if (kind.isDirectory) {
			if (ig.ignores(`${relPath}/`)) {
				continue;
			}
			files.push(...collectSkillResourceFiles(fullPath, root, ig));
		} else if (dir === root && kind.isFile && FILE_PATTERNS.skills.test(entry.name) && !ig.ignores(relPath)) {
			files.push(fullPath);
		}
	}
	return files;
}

function collectResourceFiles(
	dir: string,
	resourceType: StoreResourceType,
	root = dir,
	ignoreMatcher?: IgnoreMatcher,
): string[] {
	if (resourceType === "extensions") {
		return collectConventionalExtensionFiles(dir);
	}
	if (resourceType === "skills") {
		return collectSkillResourceFiles(dir);
	}
	if (!existsSync(dir)) {
		return [];
	}

	const ig = ignoreMatcher ?? createIgnoreMatcher();
	addIgnoreRules(ig, dir, root);
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		const fullPath = join(dir, entry.name);
		const kind = getDirentKind(entry, fullPath);
		if (!kind) {
			continue;
		}
		const relPath = toPosixPath(relative(root, fullPath));
		const ignorePath = kind.isDirectory ? `${relPath}/` : relPath;
		if (ig.ignores(ignorePath)) {
			continue;
		}
		if (kind.isDirectory) {
			files.push(...collectResourceFiles(fullPath, resourceType, root, ig));
		} else if (kind.isFile && FILE_PATTERNS[resourceType].test(entry.name)) {
			files.push(fullPath);
		}
	}
	return files;
}

function readVoltManifestFile(packageJsonPath: string): StoreVoltManifest | undefined {
	try {
		return readPackageJsonFile(packageJsonPath).voltManifest;
	} catch {
		return undefined;
	}
}

function resolveConventionalExtensionEntries(dir: string): string[] | undefined {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readVoltManifestFile(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries = manifest.extensions.map((entry) => resolve(dir, entry)).filter((entry) => existsSync(entry));
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}
	return undefined;
}

function collectConventionalExtensionFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}

	const rootEntries = resolveConventionalExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	const ig = createIgnoreMatcher();
	addIgnoreRules(ig, dir, dir);
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		const fullPath = join(dir, entry.name);
		const kind = getDirentKind(entry, fullPath);
		if (!kind) {
			continue;
		}
		const relPath = toPosixPath(relative(dir, fullPath));
		const ignorePath = kind.isDirectory ? `${relPath}/` : relPath;
		if (ig.ignores(ignorePath)) {
			continue;
		}
		if (kind.isDirectory) {
			const resolvedEntries = resolveConventionalExtensionEntries(fullPath);
			if (resolvedEntries) {
				files.push(...resolvedEntries);
			}
		} else if (kind.isFile && FILE_PATTERNS.extensions.test(entry.name)) {
			files.push(fullPath);
		}
	}
	return files;
}

function collectFilesFromPaths(paths: string[], resourceType: StoreResourceType): string[] {
	const files: string[] = [];
	for (const path of paths) {
		const stats = statIfExists(path);
		if (!stats) {
			continue;
		}
		if (stats.isDirectory()) {
			files.push(...collectResourceFiles(path, resourceType));
		} else if (stats.isFile()) {
			files.push(path);
		}
	}
	return files;
}

function hasGlobPattern(entry: string): boolean {
	return entry.includes("*") || entry.includes("?");
}

function isOverridePattern(entry: string): boolean {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function applyManifestPatterns(allFiles: string[], entries: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const entry of entries) {
		if (entry.startsWith("+")) {
			forceIncludes.push(entry.slice(1));
		} else if (entry.startsWith("-")) {
			forceExcludes.push(entry.slice(1));
		} else if (entry.startsWith("!")) {
			excludes.push(entry.slice(1));
		} else {
			includes.push(entry);
		}
	}

	let result =
		includes.length === 0 ? [...allFiles] : allFiles.filter((file) => matchesAnyPattern(file, includes, baseDir));
	if (excludes.length > 0) {
		result = result.filter((file) => !matchesAnyPattern(file, excludes, baseDir));
	}
	if (forceIncludes.length > 0) {
		for (const file of allFiles) {
			if (!result.includes(file) && matchesAnyExactPattern(file, forceIncludes, baseDir)) {
				result.push(file);
			}
		}
	}
	if (forceExcludes.length > 0) {
		result = result.filter((file) => !matchesAnyExactPattern(file, forceExcludes, baseDir));
	}
	return new Set(result);
}

function collectManifestFiles(root: string, entries: string[], resourceType: StoreResourceType): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const resolved = sourceEntries.flatMap((entry) => {
		if (!hasGlobPattern(entry)) {
			return [resolve(root, entry)];
		}
		return globSync(entry, {
			cwd: root,
			absolute: true,
			dot: false,
			nodir: false,
		}).map((match) => resolve(match));
	});
	const files = collectFilesFromPaths(resolved, resourceType);
	const overridePatterns = entries.filter(isOverridePattern);
	const enabled = applyManifestPatterns(files, overridePatterns, root);
	return files.filter((file) => enabled.has(file));
}

function toRelativeResourcePath(root: string, path: string): string {
	return toPosixPath(relative(root, path)) || ".";
}

function discoverResources(
	root: string,
	voltManifest?: StoreVoltManifest,
	options: InspectionDiscoveryOptions = {},
): Record<StoreResourceType, string[]> {
	const discovered = structuredClone(EMPTY_RESOURCES);
	if (voltManifest) {
		for (const resourceType of RESOURCE_TYPES) {
			const entries = voltManifest[resourceType];
			discovered[resourceType] = entries
				? collectManifestFiles(root, entries, resourceType).map((path) => toRelativeResourcePath(root, path))
				: [];
		}
		return discovered;
	}

	let hasAnyResourcePath = false;
	for (const resourceType of RESOURCE_TYPES) {
		const dir = join(root, resourceType);
		if (existsSync(dir)) {
			hasAnyResourcePath = true;
		}
		discovered[resourceType] = isDirectory(dir)
			? collectResourceFiles(dir, resourceType).map((path) => toRelativeResourcePath(root, path))
			: [];
	}
	if (options.localFallbackExtension && !hasAnyResourcePath) {
		const stats = statIfExists(root);
		if (stats?.isDirectory() || stats?.isFile()) {
			discovered.extensions = [toRelativeResourcePath(root, root)];
		}
	}
	return discovered;
}

function buildInspection(
	source: string,
	pkg: PackageJsonData,
	root: string | undefined,
	warnings: string[],
	discoveryOptions?: InspectionDiscoveryOptions,
) {
	const inspection: StorePackageInspection = {
		source,
		...(pkg.name !== undefined ? { packageName: pkg.name } : {}),
		...(pkg.version !== undefined ? { packageVersion: pkg.version } : {}),
		...(pkg.description !== undefined ? { packageDescription: pkg.description } : {}),
		...(pkg.license !== undefined ? { packageLicense: pkg.license } : {}),
		...(pkg.repository !== undefined ? { packageRepository: pkg.repository } : {}),
		...(pkg.voltManifest !== undefined ? { voltManifest: pkg.voltManifest } : {}),
		discoveredResources: root
			? discoverResources(root, pkg.voltManifest, discoveryOptions)
			: structuredClone(EMPTY_RESOURCES),
		dependencies: pkg.dependencies,
		peerDependencies: pkg.peerDependencies,
		optionalDependencies: pkg.optionalDependencies,
		scripts: pkg.scripts,
		warnings,
	};
	return inspection;
}

function getNpmCommand(npmCommand?: string[]): { command: string; args: string[] } {
	if (!npmCommand || npmCommand.length === 0) {
		return { command: "npm", args: [] };
	}
	const [command, ...args] = npmCommand;
	if (!command) {
		throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
	}
	return { command, args };
}

function runCommandCapture(command: string, args: string[], options: CommandCaptureOptions = {}): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const baseEnv = getSubprocessEnv();
		const child = spawnProcess(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: options.env ? { ...baseEnv, ...options.env } : baseEnv,
		}) as ChildProcessByStdio<null, Readable, Readable>;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`${command} ${args.join(" ")} timed out`));
				return;
			}
			if (code === 0) {
				resolvePromise(stdout.trim());
				return;
			}
			const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${status}: ${stderr || stdout}`));
		});
	});
}

async function runCommand(command: string, args: string[], options: CommandCaptureOptions = {}): Promise<void> {
	await runCommandCapture(command, args, options);
}

async function inspectNpmPackage(options: InspectStorePackageOptions): Promise<StorePackageInspection> {
	const spec = options.source.slice("npm:".length).trim();
	const npmCommand = getNpmCommand(options.npmCommand);
	const output = await runCommandCapture(npmCommand.command, [...npmCommand.args, "view", spec, "--json"], {
		cwd: options.cwd,
	});
	const parsed = JSON.parse(output) as unknown;
	const manifest = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
	const pkg = readPackageJsonData(manifest);
	const warnings = ["npm inspection uses registry metadata only; exact package files are resolved during install."];
	return buildInspection(options.source, pkg, undefined, warnings);
}

async function inspectGitPackage(options: InspectStorePackageOptions): Promise<StorePackageInspection> {
	const parsed = parseGitUrl(options.source);
	if (!parsed) {
		throw new Error(`Invalid git store source: ${options.source}`);
	}
	const tempRoot = mkdtempSync(join(tmpdir(), "volt-store-inspect-"));
	const checkoutDir = join(tempRoot, "repo");
	try {
		await runCommand("git", ["clone", parsed.repo, checkoutDir], {
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
		if (parsed.ref) {
			await runCommand("git", ["checkout", parsed.ref], { cwd: checkoutDir });
		}
		return inspectPackageDirectory(options.source, checkoutDir, [
			"Inspected git metadata without installing dependencies or loading extension code.",
		]);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

export function inspectPackageDirectory(
	source: string,
	root: string,
	initialWarnings: string[] = [],
	discoveryOptions?: InspectionDiscoveryOptions,
): StorePackageInspection {
	const packageJsonPath = join(root, "package.json");
	if (!existsSync(packageJsonPath)) {
		return buildInspection(
			source,
			readPackageJsonData({}),
			root,
			[`No package.json found at ${root}.`, ...initialWarnings],
			discoveryOptions,
		);
	}
	try {
		const pkg = readPackageJsonFile(packageJsonPath);
		return buildInspection(source, pkg, root, initialWarnings, discoveryOptions);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return buildInspection(
			source,
			readPackageJsonData({}),
			root,
			[`Failed to read package metadata: ${message}`, ...initialWarnings],
			discoveryOptions,
		);
	}
}

export async function inspectStorePackage(options: InspectStorePackageOptions): Promise<StorePackageInspection> {
	if (options.source.startsWith("npm:")) {
		return inspectNpmPackage(options);
	}

	if (parseGitUrl(options.source)) {
		return inspectGitPackage(options);
	}

	const root = resolvePath(options.source, options.cwd, { trim: true });
	return inspectPackageDirectory(
		options.source,
		root,
		["Local package paths are not reproducible and are inspected directly from disk."],
		{ localFallbackExtension: true },
	);
}
