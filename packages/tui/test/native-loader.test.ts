import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stageWindowsNativeAddon } from "../src/native-loader.ts";

describe("stageWindowsNativeAddon", () => {
	it("reuses verified content-addressed copies outside the source directory", () => {
		const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "volt-tui-native-loader-test-"));
		try {
			const sourcePath = path.join(testDirectory, "source", "helper.node");
			const cacheDirectory = path.join(testDirectory, "cache");
			fs.mkdirSync(path.dirname(sourcePath));
			fs.writeFileSync(sourcePath, "first addon");

			const firstPath = stageWindowsNativeAddon(sourcePath, cacheDirectory);
			const reusedPath = stageWindowsNativeAddon(sourcePath, cacheDirectory);
			assert.notEqual(firstPath, sourcePath);
			assert.equal(reusedPath, firstPath);
			assert.deepEqual(fs.readFileSync(firstPath), fs.readFileSync(sourcePath));

			fs.writeFileSync(sourcePath, "second addon");
			const secondPath = stageWindowsNativeAddon(sourcePath, cacheDirectory);
			assert.notEqual(secondPath, firstPath);
			assert.deepEqual(fs.readFileSync(secondPath), fs.readFileSync(sourcePath));
		} finally {
			fs.rmSync(testDirectory, { recursive: true, force: true });
		}
	});

	it("does not reuse a corrupt cache entry", () => {
		const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "volt-tui-native-loader-test-"));
		try {
			const sourcePath = path.join(testDirectory, "helper.node");
			const cacheDirectory = path.join(testDirectory, "cache");
			fs.writeFileSync(sourcePath, "expected addon");
			const cachedPath = stageWindowsNativeAddon(sourcePath, cacheDirectory);
			fs.writeFileSync(cachedPath, "corrupt addon");

			const recoveredPath = stageWindowsNativeAddon(sourcePath, cacheDirectory);
			assert.notEqual(recoveredPath, cachedPath);
			assert.deepEqual(fs.readFileSync(recoveredPath), fs.readFileSync(sourcePath));
		} finally {
			fs.rmSync(testDirectory, { recursive: true, force: true });
		}
	});
});

describe("loadNativeAddon", () => {
	it(
		"keeps the source addon replaceable while the loaded Windows process is running",
		{ skip: process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64") },
		async () => {
			const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "volt-tui-native-lock-test-"));
			const sourcePath = path.join(testDirectory, "win32-console-mode.node");
			const movedPath = `${sourcePath}.moved`;
			const fixturePath = fileURLToPath(
				new URL(`../native/win32/prebuilds/win32-${process.arch}/win32-console-mode.node`, import.meta.url),
			);
			fs.copyFileSync(fixturePath, sourcePath);

			const loaderUrl = new URL("../src/native-loader.ts", import.meta.url).href;
			const childScript = `
import { loadNativeAddon } from ${JSON.stringify(loaderUrl)};
const addon = loadNativeAddon(
	[${JSON.stringify(sourcePath)}],
	(value) =>
		typeof value === "object" &&
		value !== null &&
		typeof value.enableVirtualTerminalInput === "function",
);
if (!addon) throw new Error("native addon did not load");
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
			const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});

			try {
				const output = await Promise.race([
					once(child.stdout, "data", { signal: AbortSignal.timeout(5000) }).then(([chunk]) => String(chunk)),
					once(child, "exit").then(([code, signal]) => {
						throw new Error(`native addon child exited before ready (${code ?? signal}): ${stderr}`);
					}),
				]);
				assert.equal(output, "ready\n");

				fs.renameSync(sourcePath, movedPath);
				assert.equal(fs.existsSync(movedPath), true);
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.kill();
					await exited;
				}
				fs.rmSync(testDirectory, { recursive: true, force: true });
			}
		},
	);
});
