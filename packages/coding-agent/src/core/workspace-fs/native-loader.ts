import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

declare const __VOLT_STANDALONE__: boolean | undefined;

const WORKSPACE_FS_API_VERSION = "volt-workspace-fs-v1";
const moduleUrl: string | undefined = import.meta.url;
const cjsRequire = createRequire(moduleUrl || pathToFileURL(process.execPath).href);
const isStandaloneBinary = typeof __VOLT_STANDALONE__ !== "undefined" && __VOLT_STANDALONE__ === true;
const WINDOWS_NATIVE_CACHE_DIRECTORY = path.join(os.tmpdir(), "volt-workspace-fs-native");

export type NativeMetadata = {
	fileType: "file" | "directory" | "symlink" | "other";
	size: number;
	modifiedMs: number;
	mode?: number;
};

export type NativeDirectoryEntry = {
	name: string;
	fileType: "file" | "directory" | "symlink" | "other";
};

export type NativeWorkspaceRoot = {
	lstat(path: string): Promise<NativeMetadata>;
	metadata(path: string): Promise<NativeMetadata>;
	readFile(path: string): Promise<Buffer>;
	readDirectory(path: string): Promise<NativeDirectoryEntry[]>;
	createFile(path: string, data: Buffer): Promise<void>;
	replaceFile(path: string, data: Buffer): Promise<void>;
	rename(oldPath: string, newPath: string, overwrite: boolean): Promise<void>;
	remove(path: string, recursive: boolean): Promise<void>;
	close(): boolean;
};

type NativeWorkspaceRootConstructor = new (rootPath: string) => NativeWorkspaceRoot;

type NativeWorkspaceFsAddon = {
	WorkspaceRoot: NativeWorkspaceRootConstructor;
	workspaceFsApiVersion(): string;
	workspaceFsSourceFingerprint(): string;
};

type NativeArtifact = {
	target: string;
	path: string;
	sha256: string;
};

type NativeManifest = {
	schemaVersion: number;
	apiVersion: string;
	sourceFingerprint: string;
	artifacts: NativeArtifact[];
};

export class WorkspaceFsNativeUnavailableError extends Error {
	readonly code: "WORKSPACE_FS_NATIVE_UNAVAILABLE" | "WORKSPACE_FS_UNSUPPORTED_PLATFORM";

	constructor(code: "WORKSPACE_FS_NATIVE_UNAVAILABLE" | "WORKSPACE_FS_UNSUPPORTED_PLATFORM", message: string) {
		super(message);
		this.name = "WorkspaceFsNativeUnavailableError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseManifest(bytes: Buffer, manifestPath: string): NativeManifest {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new WorkspaceFsNativeUnavailableError(
			"WORKSPACE_FS_NATIVE_UNAVAILABLE",
			`Workspace filesystem native manifest is not valid JSON at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.apiVersion !== "string" ||
		typeof value.sourceFingerprint !== "string" ||
		!Array.isArray(value.artifacts)
	) {
		throw new WorkspaceFsNativeUnavailableError(
			"WORKSPACE_FS_NATIVE_UNAVAILABLE",
			`Workspace filesystem native manifest has an unsupported shape at ${manifestPath}`,
		);
	}
	const artifacts: NativeArtifact[] = [];
	for (const artifact of value.artifacts) {
		if (
			!isRecord(artifact) ||
			typeof artifact.target !== "string" ||
			typeof artifact.path !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(String(artifact.sha256))
		) {
			throw new WorkspaceFsNativeUnavailableError(
				"WORKSPACE_FS_NATIVE_UNAVAILABLE",
				`Workspace filesystem native manifest contains an invalid artifact at ${manifestPath}`,
			);
		}
		artifacts.push({ target: artifact.target, path: artifact.path, sha256: String(artifact.sha256) });
	}
	if (!/^[0-9a-f]{64}$/.test(value.sourceFingerprint)) {
		throw new WorkspaceFsNativeUnavailableError(
			"WORKSPACE_FS_NATIVE_UNAVAILABLE",
			`Workspace filesystem native manifest has an invalid source fingerprint at ${manifestPath}`,
		);
	}
	return {
		schemaVersion: value.schemaVersion,
		apiVersion: value.apiVersion,
		sourceFingerprint: value.sourceFingerprint,
		artifacts,
	};
}

function linuxLibc(): "gnu" | "musl" {
	const report = process.report.getReport() as {
		header?: { glibcVersionRuntime?: unknown };
		sharedObjects?: unknown;
	};
	if (typeof report.header?.glibcVersionRuntime === "string") return "gnu";
	if (
		Array.isArray(report.sharedObjects) &&
		report.sharedObjects.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("musl"))
	) {
		return "musl";
	}
	return "musl";
}

function nativeTarget(): string {
	if (process.arch !== "arm64" && process.arch !== "x64") {
		throw new WorkspaceFsNativeUnavailableError(
			"WORKSPACE_FS_UNSUPPORTED_PLATFORM",
			`Workspace filesystem native support is unavailable for ${process.platform}-${process.arch}`,
		);
	}
	if (process.platform === "darwin") return `darwin-${process.arch}`;
	if (process.platform === "win32") return `win32-${process.arch}-msvc`;
	if (process.platform === "linux") return `linux-${process.arch}-${linuxLibc()}`;
	throw new WorkspaceFsNativeUnavailableError(
		"WORKSPACE_FS_UNSUPPORTED_PLATFORM",
		`Workspace filesystem native support is unavailable for ${process.platform}-${process.arch}`,
	);
}

function nativeRoots(): string[] {
	if (isStandaloneBinary) return [path.resolve(path.dirname(process.execPath), "native/workspace-fs")];
	if (!moduleUrl) {
		throw new WorkspaceFsNativeUnavailableError(
			"WORKSPACE_FS_NATIVE_UNAVAILABLE",
			"Workspace filesystem native addon cannot locate its package-relative root",
		);
	}
	return [path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../../native/workspace-fs")];
}

function sha256(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function stageWindowsAddon(
	source: Buffer,
	digest: string,
	cacheDirectory = WINDOWS_NATIVE_CACHE_DIRECTORY,
): string {
	const destination = path.join(cacheDirectory, `workspace-fs-${digest.slice("sha256:".length)}.node`);
	fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
	try {
		if (source.equals(fs.readFileSync(destination))) return destination;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const temporary = path.join(cacheDirectory, `.stage-${process.pid}-${randomUUID()}.node`);
	try {
		fs.writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
		if (!source.equals(fs.readFileSync(temporary))) {
			throw new WorkspaceFsNativeUnavailableError(
				"WORKSPACE_FS_NATIVE_UNAVAILABLE",
				"Workspace filesystem staged Windows addon failed post-write verification",
			);
		}
		try {
			fs.renameSync(temporary, destination);
		} catch (error) {
			try {
				if (source.equals(fs.readFileSync(destination))) return destination;
			} catch {
				// Report the atomic publication error below.
			}
			throw error;
		}
		if (!source.equals(fs.readFileSync(destination))) {
			throw new WorkspaceFsNativeUnavailableError(
				"WORKSPACE_FS_NATIVE_UNAVAILABLE",
				"Workspace filesystem cached Windows addon failed post-publish verification",
			);
		}
		return destination;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function isNativeAddon(value: unknown): value is NativeWorkspaceFsAddon {
	if (!isRecord(value)) return false;
	return (
		typeof value.WorkspaceRoot === "function" &&
		typeof value.workspaceFsApiVersion === "function" &&
		typeof value.workspaceFsSourceFingerprint === "function"
	);
}

let cachedAddon: NativeWorkspaceFsAddon | undefined;

export function loadWorkspaceFsNativeAddon(): NativeWorkspaceFsAddon {
	if (cachedAddon) return cachedAddon;
	const target = nativeTarget();
	const failures: string[] = [];
	for (const root of nativeRoots()) {
		const manifestPath = path.join(root, "prebuilds", "manifest.json");
		if (!fs.existsSync(manifestPath)) {
			failures.push(`missing manifest ${manifestPath}`);
			continue;
		}
		try {
			const manifest = parseManifest(fs.readFileSync(manifestPath), manifestPath);
			if (manifest.apiVersion !== WORKSPACE_FS_API_VERSION) {
				throw new Error(`expected API ${WORKSPACE_FS_API_VERSION}, found ${manifest.apiVersion}`);
			}
			const matches = manifest.artifacts.filter((artifact) => artifact.target === target);
			if (matches.length !== 1) throw new Error(`expected exactly one ${target} artifact, found ${matches.length}`);
			const artifact = matches[0];
			if (
				path.isAbsolute(artifact.path) ||
				artifact.path.includes("\\") ||
				artifact.path.split("/").includes("..")
			) {
				throw new Error(`artifact path is not a safe relative path: ${artifact.path}`);
			}
			const artifactPath = path.join(root, "prebuilds", ...artifact.path.split("/"));
			const bytes = fs.readFileSync(artifactPath);
			const digest = sha256(bytes);
			if (digest !== artifact.sha256) {
				throw new Error(`checksum mismatch for ${artifactPath}: expected ${artifact.sha256}, found ${digest}`);
			}
			const loadPath = process.platform === "win32" ? stageWindowsAddon(bytes, digest) : artifactPath;
			const addonValue = cjsRequire(loadPath) as unknown;
			if (!isNativeAddon(addonValue)) throw new Error(`addon exports do not match ${WORKSPACE_FS_API_VERSION}`);
			if (addonValue.workspaceFsApiVersion() !== manifest.apiVersion) {
				throw new Error("addon API version does not match its manifest");
			}
			if (addonValue.workspaceFsSourceFingerprint() !== manifest.sourceFingerprint) {
				throw new Error("addon source fingerprint does not match its manifest");
			}
			cachedAddon = addonValue;
			return addonValue;
		} catch (error) {
			failures.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new WorkspaceFsNativeUnavailableError(
		"WORKSPACE_FS_NATIVE_UNAVAILABLE",
		`Workspace filesystem native addon is unavailable for ${target}; no JavaScript mutation fallback is permitted. ${failures.join("; ")}`,
	);
}
