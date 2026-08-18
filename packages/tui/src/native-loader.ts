import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl: string | undefined = import.meta.url;
const cjsRequire = createRequire(moduleUrl || pathToFileURL(process.execPath).href);
const WINDOWS_NATIVE_CACHE_DIRECTORY = path.join(os.tmpdir(), "volt-tui-native");

/**
 * Copy a Windows native addon outside its install/worktree path before loading it.
 * Windows keeps loaded DLLs locked for the lifetime of the process, so loading the
 * original file would prevent Git and package managers from replacing it.
 */
export function stageWindowsNativeAddon(sourcePath: string, cacheDirectory = WINDOWS_NATIVE_CACHE_DIRECTORY): string {
	const source = fs.readFileSync(sourcePath);
	const digest = createHash("sha256").update(source).digest("hex");
	const basename = path.basename(sourcePath, path.extname(sourcePath));
	const cachedPath = path.join(cacheDirectory, `${basename}-${digest}.node`);
	fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });

	try {
		fs.writeFileSync(cachedPath, source, { flag: "wx", mode: 0o600 });
		return cachedPath;
	} catch {
		if (source.equals(fs.readFileSync(cachedPath))) return cachedPath;
	}

	// A corrupt or concurrently incomplete cache entry must never be loaded.
	const fallbackPath = path.join(cacheDirectory, `${basename}-${digest}-${process.pid}-${randomUUID()}.node`);
	fs.writeFileSync(fallbackPath, source, { flag: "wx", mode: 0o600 });
	return fallbackPath;
}

export function loadNativeAddon<T>(
	candidates: readonly string[],
	isExpectedAddon: (value: unknown) => value is T,
): T | undefined {
	for (const sourcePath of candidates) {
		try {
			const modulePath = process.platform === "win32" ? stageWindowsNativeAddon(sourcePath) : sourcePath;
			const addon = cjsRequire(modulePath) as unknown;
			if (isExpectedAddon(addon)) return addon;
		} catch {
			// Try the next possible packaging location.
		}
	}
	return undefined;
}
