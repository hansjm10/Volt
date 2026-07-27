import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";
import { createDirectorySymlinkSync, tryCreateFileSymlinkSync } from "./symlink-utils.ts";

describe("file settings storage security", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	function createStorage(): { agentDir: string; cwd: string; storage: FileSettingsStorage } {
		const root = mkdtempSync(join(tmpdir(), "volt-settings-security-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(cwd);
		return { agentDir, cwd, storage: new FileSettingsStorage(cwd, agentDir) };
	}

	test("atomically replaces global settings", () => {
		const { agentDir, storage } = createStorage();
		const settingsPath = join(agentDir, "settings.json");
		storage.withLock("global", () => '{"theme":"one"}');
		const firstInode = statSync(settingsPath, { bigint: true }).ino;

		storage.withLock("global", (current) => {
			expect(current).toBe('{"theme":"one"}');
			return '{"theme":"two"}';
		});

		expect(readFileSync(settingsPath, "utf8")).toBe('{"theme":"two"}');
		expect(statSync(settingsPath, { bigint: true }).ino).not.toBe(firstInode);
	});

	test("uses private and shareable POSIX modes", (context) => {
		if (process.platform === "win32") {
			context.skip("POSIX permission bits are not supported on Windows");
		}
		const { agentDir, cwd, storage } = createStorage();
		storage.withLock("global", () => "{}");
		storage.withLock("project", () => "{}");

		expect(statSync(join(agentDir, "settings.json")).mode & 0o777).toBe(0o600);
		expect(statSync(agentDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(cwd, ".volt", "settings.json")).mode & 0o777).toBe(0o644);
	});

	test("tightens an existing global settings file before reading it", (context) => {
		if (process.platform === "win32") {
			context.skip("POSIX permission bits are not supported on Windows");
		}
		const { agentDir, storage } = createStorage();
		mkdirSync(agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{}", { mode: 0o666 });
		chmodSync(settingsPath, 0o666);

		storage.withLock("global", (current) => {
			expect(current).toBe("{}");
			return undefined;
		});

		expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
	});

	test("refuses non-regular settings targets without modifying symlink referents", () => {
		const { agentDir, storage } = createStorage();
		mkdirSync(agentDir);
		const referent = join(agentDir, "referent.json");
		writeFileSync(referent, '{"secret":true}');
		const settingsPath = join(agentDir, "settings.json");
		const usedSymlink = tryCreateFileSymlinkSync(referent, settingsPath);
		if (!usedSymlink) {
			mkdirSync(settingsPath);
		}

		expect(() => storage.withLock("global", () => "{}")).toThrow("non-regular private file");
		expect(readFileSync(referent, "utf8")).toBe('{"secret":true}');
		expect(usedSymlink ? lstatSync(settingsPath).isSymbolicLink() : lstatSync(settingsPath).isDirectory()).toBe(true);
	});

	test("writes shareable project settings atomically but rejects a symlinked .volt directory", () => {
		const { agentDir, cwd, storage } = createStorage();
		storage.withLock("project", () => '{"theme":"project"}');
		const projectSettingsPath = join(cwd, ".volt", "settings.json");
		expect(readFileSync(projectSettingsPath, "utf8")).toBe('{"theme":"project"}');

		const otherRoot = mkdtempSync(join(tmpdir(), "volt-settings-symlink-"));
		tempDirs.push(otherRoot);
		const otherWorkspace = join(otherRoot, "workspace");
		const target = join(otherRoot, "target");
		mkdirSync(otherWorkspace);
		mkdirSync(target);
		createDirectorySymlinkSync(target, join(otherWorkspace, ".volt"));
		const otherStorage = new FileSettingsStorage(otherWorkspace, agentDir);
		expect(() => otherStorage.withLock("project", () => "{}")).toThrow("non-directory project settings");
		expect(() => statSync(join(target, "settings.json"))).toThrow();
	});
});
