import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { getSubprocessEnv } from "../../utils/process-env.ts";

export type LspLaunchSource = "absolute" | "project-relative" | "path";
export type LspExecutableProbeResult = "missing" | "unusable" | "executable";

export interface LspLaunchDescriptor {
	configuredCommand: string[];
	command: string[];
	requestedExecutable: string;
	resolvedExecutable?: string;
	/** First candidate found on disk when no launchable executable resolved. */
	unusableExecutable?: string;
	source: LspLaunchSource;
	environment: NodeJS.ProcessEnv;
	/** Bare commands are the only launch form eligible for a reviewed automatic install. */
	bare: boolean;
}

export interface ResolveLspLaunchOptions {
	/** Canonical project workspace used for explicit relative commands and relative PATH entries. */
	projectCwd: string;
	/** Exact environment inherited by the launched server. Defaults to getSubprocessEnv(). */
	environment?: NodeJS.ProcessEnv;
	/** Injectable for deterministic cross-platform tests. */
	platform?: NodeJS.Platform;
	/** Injectable filesystem probe. Defaults to distinguishing missing, unusable, and executable candidates. */
	probeExecutable?: (path: string, platform: NodeJS.Platform) => LspExecutableProbeResult;
}

function missingProbeResult(error: unknown): LspExecutableProbeResult {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
		? "missing"
		: "unusable";
}

function defaultProbeExecutable(path: string, platform: NodeJS.Platform): LspExecutableProbeResult {
	try {
		if (!statSync(path).isFile()) return "unusable";
	} catch (error) {
		return missingProbeResult(error);
	}
	if (platform !== "win32") {
		try {
			accessSync(path, constants.X_OK);
		} catch (error) {
			return missingProbeResult(error);
		}
	}
	return "executable";
}

function environmentValue(
	environment: NodeJS.ProcessEnv,
	name: "PATH" | "PATHEXT",
	platform: NodeJS.Platform,
): string | undefined {
	if (platform !== "win32") return environment[name];
	const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name);
	return entry?.[1];
}

function windowsExecutableCandidates(path: string, pathExt: string | undefined): string[] {
	const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim())
		.map((extension) => (extension === "" || extension.startsWith(".") ? extension : `.${extension}`));
	const lowerPath = path.toLowerCase();
	if (extensions.some((extension) => extension !== "" && lowerPath.endsWith(extension.toLowerCase()))) {
		return [path];
	}
	return extensions.map((extension) => `${path}${extension}`);
}

function executableCandidates(path: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
	return platform === "win32"
		? windowsExecutableCandidates(path, environmentValue(environment, "PATHEXT", platform))
		: [path];
}

function probeCandidates(
	candidates: readonly string[],
	platform: NodeJS.Platform,
	probeExecutable: (path: string, platform: NodeJS.Platform) => LspExecutableProbeResult,
): { executable?: string; unusable?: string } {
	let unusable: string | undefined;
	for (const candidate of candidates) {
		const result = probeExecutable(candidate, platform);
		if (result === "executable") return { executable: candidate };
		if (result === "unusable" && unusable === undefined) unusable = candidate;
	}
	return unusable ? { unusable } : {};
}

function unquotePathEntry(entry: string): string {
	return entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
}

/**
 * Resolve configured LSP argv without consulting process.cwd() or node_modules.
 *
 * Absolute commands remain absolute, explicit relative commands are based at
 * projectCwd, and bare commands are searched only through the supplied PATH and
 * PATHEXT. The returned environment is the exact object to pass to spawn.
 */
export function resolveLspLaunch(
	configuredCommand: readonly string[],
	options: ResolveLspLaunchOptions,
): LspLaunchDescriptor {
	if (configuredCommand.length === 0 || !configuredCommand[0]) {
		throw new Error("LSP server command cannot be empty");
	}
	const platform = options.platform ?? process.platform;
	const pathApi = platform === "win32" ? win32 : posix;
	const environment = options.environment ?? getSubprocessEnv();
	const probeExecutable = options.probeExecutable ?? defaultProbeExecutable;
	const requestedExecutable = configuredCommand[0];
	const explicitRelative = requestedExecutable.includes("/") || requestedExecutable.includes("\\");
	let source: LspLaunchSource;
	let bare: boolean;
	let resolvedExecutable: string | undefined;
	let unusableExecutable: string | undefined;

	if (pathApi.isAbsolute(requestedExecutable)) {
		source = "absolute";
		bare = false;
		const result = probeCandidates(
			executableCandidates(requestedExecutable, platform, environment),
			platform,
			probeExecutable,
		);
		resolvedExecutable = result.executable;
		unusableExecutable = result.unusable;
	} else if (explicitRelative) {
		source = "project-relative";
		bare = false;
		const projectRelative = pathApi.resolve(options.projectCwd, requestedExecutable);
		const result = probeCandidates(
			executableCandidates(projectRelative, platform, environment),
			platform,
			probeExecutable,
		);
		resolvedExecutable = result.executable;
		unusableExecutable = result.unusable;
	} else {
		source = "path";
		bare = true;
		const pathValue = environmentValue(environment, "PATH", platform);
		const entries =
			pathValue === undefined || pathValue === "" ? [] : pathValue.split(platform === "win32" ? ";" : ":");
		for (const rawEntry of entries) {
			const entry = platform === "win32" ? unquotePathEntry(rawEntry) : rawEntry;
			const directory = pathApi.isAbsolute(entry) ? entry : pathApi.resolve(options.projectCwd, entry || ".");
			const result = probeCandidates(
				executableCandidates(pathApi.join(directory, requestedExecutable), platform, environment),
				platform,
				probeExecutable,
			);
			if (result.executable) {
				resolvedExecutable = result.executable;
				break;
			}
			unusableExecutable ??= result.unusable;
		}
	}

	return {
		configuredCommand: [...configuredCommand],
		command: [resolvedExecutable ?? requestedExecutable, ...configuredCommand.slice(1)],
		requestedExecutable,
		...(resolvedExecutable ? { resolvedExecutable } : {}),
		...(!resolvedExecutable && unusableExecutable ? { unusableExecutable } : {}),
		source,
		environment,
		bare,
	};
}
