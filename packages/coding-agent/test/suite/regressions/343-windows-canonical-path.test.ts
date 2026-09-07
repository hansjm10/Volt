import { spawnSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePath } from "../../../src/utils/paths.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()!.cleanupAsync();
});

describe("regression #343: canonical workspace identity", () => {
	it("uses the same workspace and file identity as asynchronous filesystem operations", async () => {
		const harness = await createHarness({ settings: { lsp: { enabled: false } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "Mixed Case Source.txt");
		await writeFile(file, "workspace data");
		expect(canonicalizePath(harness.tempDir)).toBe(await realpath(harness.tempDir));
		expect(canonicalizePath(file)).toBe(await realpath(file));
	});

	it.skipIf(process.platform !== "win32")("unifies Windows short names and case aliases", async () => {
		const harness = await createHarness({ settings: { lsp: { enabled: false } } });
		harnesses.push(harness);
		const directory = join(harness.tempDir, "Long Workspace Directory");
		await mkdir(directory);
		const longPath = await realpath(directory);
		const shortName = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`], {
			encoding: "utf8",
			windowsVerbatimArguments: true,
		});
		expect(shortName.status, shortName.error?.message ?? shortName.stderr).toBe(0);
		const shortPath = shortName.stdout.trim();
		// Volumes can disable 8.3 creation; in that case this also exercises the
		// native long-name result. Casing still must agree with async realpath.
		expect(canonicalizePath(shortPath)).toBe(longPath);
		expect(canonicalizePath(longPath.toUpperCase())).toBe(longPath);
	});
});
