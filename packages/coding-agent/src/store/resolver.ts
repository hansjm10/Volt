import type { ChildProcessByStdio } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { spawnProcess } from "../utils/child-process.ts";
import type { GitSource } from "../utils/git.ts";
import { parseGitUrl } from "../utils/git.ts";
import { isLocalPath } from "../utils/paths.ts";
import {
	findCatalogPackage,
	type StoreCatalog,
	type StoreCatalogPackage,
	suggestCatalogPackageIds,
} from "./catalog.ts";

export type StoreResolvedSourceKind = "catalog" | "npm" | "git" | "local";

export interface StoreResolvedSource {
	input: string;
	source: string;
	kind: StoreResolvedSourceKind;
	catalogPackage?: StoreCatalogPackage;
	pinned: boolean;
	tracking: boolean;
	warnings: string[];
}

export type StoreGitLsRemote = (repo: string, ref: string) => Promise<string>;

export interface ResolveStoreSourceOptions {
	input: string;
	catalog: StoreCatalog;
	track?: boolean;
	pinGit?: boolean;
	ref?: string;
	gitLsRemote?: StoreGitLsRemote;
}

interface NpmSpecInfo {
	spec: string;
	name: string;
	version?: string;
	exactVersion: boolean;
}

const GIT_REMOTE_TIMEOUT_MS = 10000;

function parseNpmSpec(spec: string): NpmSpecInfo {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const name = match?.[1] ?? spec;
	const version = match?.[2];
	return {
		spec,
		name,
		version,
		exactVersion: version ? /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) : false,
	};
}

function parseNpmSource(source: string): NpmSpecInfo | undefined {
	if (!source.startsWith("npm:")) {
		return undefined;
	}
	const spec = source.slice("npm:".length).trim();
	if (!spec) {
		throw new Error("npm store source must include a package spec");
	}
	return parseNpmSpec(spec);
}

function isStoreLocalPathInput(input: string): boolean {
	const trimmed = input.trim();
	return (
		trimmed === "." ||
		trimmed === ".." ||
		trimmed.startsWith("./") ||
		trimmed.startsWith(".\\") ||
		trimmed.startsWith("../") ||
		trimmed.startsWith("..\\") ||
		trimmed.startsWith("~/") ||
		trimmed.startsWith("~\\") ||
		trimmed.startsWith("file://") ||
		isAbsolute(trimmed) ||
		(isLocalPath(trimmed) && (trimmed.includes("/") || trimmed.includes("\\")))
	);
}

function formatGitSource(source: GitSource, ref?: string): string {
	return `git:${source.repo}${ref ? `@${ref}` : ""}`;
}

function withGitRef(source: GitSource, ref: string): GitSource {
	return {
		...source,
		ref,
		pinned: true,
	};
}

function isCommitRef(ref: string): boolean {
	return /^[0-9a-f]{40}$/i.test(ref);
}

function parseLsRemoteCommit(output: string, ref: string): string {
	const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const refPattern = ref === "HEAD" ? "HEAD" : escapedRef;
	const pattern = new RegExp(`^([0-9a-f]{40})\\s+${refPattern}$`, "im");
	const exactMatch = output.match(pattern);
	if (exactMatch?.[1]) {
		return exactMatch[1];
	}
	const firstCommit = output.match(/^([0-9a-f]{40})\s+/m);
	if (firstCommit?.[1]) {
		return firstCommit[1];
	}
	throw new Error(`Unable to resolve git ref ${ref}`);
}

function runGitLsRemote(repo: string, ref: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawnProcess("git", ["ls-remote", repo, ref], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		}) as ChildProcessByStdio<null, Readable, Readable>;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, GIT_REMOTE_TIMEOUT_MS);

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
				reject(new Error(`git ls-remote ${repo} ${ref} timed out`));
				return;
			}
			if (code === 0) {
				resolvePromise(stdout.trim());
				return;
			}
			const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
			reject(new Error(`git ls-remote ${repo} ${ref} failed with ${status}: ${stderr || stdout}`));
		});
	});
}

async function resolveGitCommit(repo: string, ref: string, gitLsRemote?: StoreGitLsRemote): Promise<string> {
	const output = gitLsRemote ? await gitLsRemote(repo, ref) : await runGitLsRemote(repo, ref);
	return parseLsRemoteCommit(output, ref);
}

function buildUnknownSourceError(input: string, catalog: StoreCatalog): Error {
	const suggestions = suggestCatalogPackageIds(catalog, input);
	const suffix = suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
	return new Error(`Unknown store package or source: ${input}.${suffix}`);
}

export async function resolveStoreSource(options: ResolveStoreSourceOptions): Promise<StoreResolvedSource> {
	const input = options.input.trim();
	if (!input) {
		throw new Error("Missing store source.");
	}

	const catalogPackage = findCatalogPackage(options.catalog, input);
	const baseSource = catalogPackage?.source ?? input;
	const baseKind: StoreResolvedSourceKind = catalogPackage ? "catalog" : "local";
	const warnings: string[] = [];
	const track = options.track ?? false;

	const npmInfo = parseNpmSource(baseSource);
	if (npmInfo) {
		if (options.ref) {
			throw new Error("--ref is only valid for git store sources");
		}
		if (track) {
			throw new Error("--track is only valid for git store sources");
		}
		if (!npmInfo.version) {
			warnings.push(`npm package ${npmInfo.name} is not pinned to an exact version.`);
		} else if (!npmInfo.exactVersion) {
			warnings.push(`npm package ${npmInfo.name} uses non-exact version spec "${npmInfo.version}".`);
		}
		const hasVersion = npmInfo.version !== undefined;
		return {
			input,
			source: baseSource,
			kind: catalogPackage ? "catalog" : "npm",
			...(catalogPackage ? { catalogPackage } : {}),
			pinned: hasVersion,
			tracking: !hasVersion,
			warnings,
		};
	}

	let gitSource = parseGitUrl(baseSource);
	if (gitSource) {
		if (options.ref) {
			gitSource = withGitRef(gitSource, options.ref);
		}

		if (!gitSource.ref) {
			if (track || options.pinGit === false) {
				warnings.push("Git source has no ref and will track the repository default branch if installed.");
				return {
					input,
					source: formatGitSource(gitSource),
					kind: catalogPackage ? "catalog" : "git",
					...(catalogPackage ? { catalogPackage } : {}),
					pinned: false,
					tracking: true,
					warnings,
				};
			}
			const commit = await resolveGitCommit(gitSource.repo, "HEAD", options.gitLsRemote);
			return {
				input,
				source: formatGitSource(gitSource, commit),
				kind: catalogPackage ? "catalog" : "git",
				...(catalogPackage ? { catalogPackage } : {}),
				pinned: true,
				tracking: false,
				warnings,
			};
		}

		if (!isCommitRef(gitSource.ref)) {
			warnings.push(`Git ref "${gitSource.ref}" can be moved by repository owners; commits are more reproducible.`);
		}
		return {
			input,
			source: options.ref ? formatGitSource(gitSource, gitSource.ref) : baseSource,
			kind: catalogPackage ? "catalog" : "git",
			...(catalogPackage ? { catalogPackage } : {}),
			pinned: !track,
			tracking: track,
			warnings,
		};
	}

	if (!catalogPackage && !isStoreLocalPathInput(input)) {
		throw buildUnknownSourceError(input, options.catalog);
	}
	if (options.ref) {
		throw new Error("--ref is only valid for git store sources");
	}
	if (track) {
		throw new Error("--track is only valid for git store sources");
	}

	if (catalogPackage && !isLocalPath(baseSource)) {
		throw new Error(`Catalog package ${catalogPackage.id} has an unsupported source: ${baseSource}`);
	}

	warnings.push("Local package paths are not reproducible and should not appear in public catalogs.");
	return {
		input,
		source: baseSource,
		kind: catalogPackage ? baseKind : "local",
		...(catalogPackage ? { catalogPackage } : {}),
		pinned: false,
		tracking: false,
		warnings,
	};
}
