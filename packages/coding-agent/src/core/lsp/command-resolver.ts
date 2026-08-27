import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { getSubprocessEnv } from "../../utils/process-env.ts";

export type LspLaunchSource = "absolute" | "project-relative" | "path";

export interface LspLaunchDescriptor {
	configuredCommand: string[];
	command: string[];
	requestedExecutable: string;
	resolvedExecutable?: string;
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
	/** Injectable filesystem probe. Defaults to a regular, executable file check. */
	isExecutable?: (path: string, platform: NodeJS.Platform) => boolean;
}

function defaultIsExecutable(path: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
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
		.filter(Boolean)
		.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
	return [path, ...extensions.map((extension) => `${path}${extension}`)];
}

function executableCandidates(path: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
	return platform === "win32"
		? windowsExecutableCandidates(path, environmentValue(environment, "PATHEXT", platform))
		: [path];
}

function firstExecutable(
	candidates: readonly string[],
	platform: NodeJS.Platform,
	isExecutable: (path: string, platform: NodeJS.Platform) => boolean,
): string | undefined {
	return candidates.find((candidate) => isExecutable(candidate, platform));
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
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const requestedExecutable = configuredCommand[0];
	const explicitRelative = requestedExecutable.includes("/") || requestedExecutable.includes("\\");
	let source: LspLaunchSource;
	let bare: boolean;
	let resolvedExecutable: string | undefined;

	if (pathApi.isAbsolute(requestedExecutable)) {
		source = "absolute";
		bare = false;
		resolvedExecutable = firstExecutable(
			executableCandidates(requestedExecutable, platform, environment),
			platform,
			isExecutable,
		);
	} else if (explicitRelative) {
		source = "project-relative";
		bare = false;
		const projectRelative = pathApi.resolve(options.projectCwd, requestedExecutable);
		resolvedExecutable = firstExecutable(
			executableCandidates(projectRelative, platform, environment),
			platform,
			isExecutable,
		);
	} else {
		source = "path";
		bare = true;
		const pathValue = environmentValue(environment, "PATH", platform);
		const entries =
			pathValue === undefined || pathValue === "" ? [] : pathValue.split(platform === "win32" ? ";" : ":");
		for (const rawEntry of entries) {
			const entry = platform === "win32" ? unquotePathEntry(rawEntry) : rawEntry;
			const directory = pathApi.isAbsolute(entry) ? entry : pathApi.resolve(options.projectCwd, entry || ".");
			resolvedExecutable = firstExecutable(
				executableCandidates(pathApi.join(directory, requestedExecutable), platform, environment),
				platform,
				isExecutable,
			);
			if (resolvedExecutable) break;
		}
	}

	return {
		configuredCommand: [...configuredCommand],
		command: [resolvedExecutable ?? requestedExecutable, ...configuredCommand.slice(1)],
		requestedExecutable,
		...(resolvedExecutable ? { resolvedExecutable } : {}),
		source,
		environment,
		bare,
	};
}
