import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDaemonCliInvocation } from "../src/daemon/spawn.ts";

const originalPackageDir = process.env.VOLT_PACKAGE_DIR;
let packageDir: string | undefined;

afterEach(() => {
	if (originalPackageDir === undefined) {
		delete process.env.VOLT_PACKAGE_DIR;
	} else {
		process.env.VOLT_PACKAGE_DIR = originalPackageDir;
	}
	if (packageDir) {
		rmSync(packageDir, { recursive: true, force: true });
		packageDir = undefined;
	}
});

function createPackageDir(): string {
	packageDir = mkdtempSync(join(tmpdir(), "volt-daemon-entrypoint-"));
	process.env.VOLT_PACKAGE_DIR = packageDir;
	return packageDir;
}

function createFile(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
}

describe("daemon CLI entrypoint resolution", () => {
	it("uses the bundled npm CLI when the source entrypoint is absent", () => {
		const root = createPackageDir();
		const bundledEntry = join(root, "dist", "core", "npm", "cli.js");
		createFile(bundledEntry);
		createFile(join(root, "dist", "cli.js"));

		expect(resolveDaemonCliInvocation()).toEqual({ nodeArgs: ["--optimize-for-size"], entry: bundledEntry });
	});

	it("falls back to the modular CLI for older package layouts", () => {
		const root = createPackageDir();
		const modularEntry = join(root, "dist", "cli.js");
		createFile(modularEntry);

		expect(resolveDaemonCliInvocation()).toEqual({ nodeArgs: ["--optimize-for-size"], entry: modularEntry });
	});

	it("keeps source execution ahead of generated package entrypoints", () => {
		const root = createPackageDir();
		const sourceEntry = join(root, "src", "cli.ts");
		createFile(sourceEntry);
		createFile(join(root, "dist", "core", "npm", "cli.js"));

		expect(resolveDaemonCliInvocation()).toEqual({
			nodeArgs: ["--optimize-for-size", "--conditions", "volt-source"],
			entry: sourceEntry,
		});
	});
});
