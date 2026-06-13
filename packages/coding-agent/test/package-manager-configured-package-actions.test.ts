import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

describe("configured package actions", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-configured-actions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("exposes an actionable source for settings-relative project-local packages", async () => {
		const packageDir = join(tempDir, "pkg");
		mkdirSync(packageDir, { recursive: true });

		await packageManager.installAndPersist(packageDir, { local: true });

		const [configured] = packageManager.listConfiguredPackages();
		expect(configured).toBeDefined();
		expect(configured.source).toBe(relative(join(tempDir, CONFIG_DIR_NAME), packageDir));
		expect(configured.actionSource).toBe(packageDir);

		await expect(packageManager.update(configured.actionSource, { scripts: "never" })).resolves.toBeUndefined();
		await expect(packageManager.removeAndPersist(configured.actionSource, { local: true })).resolves.toBe(true);
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});

	it("does not reinstall installed npm packages for non-exact version specs", async () => {
		const packageDir = join(agentDir, "npm", "node_modules", "@scope", "theme");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "@scope/theme", version: "1.2.3" }, null, 2),
		);
		settingsManager.setPackages(["npm:@scope/theme@^1.0.0"]);
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.resolve();

		const npmInstallCalls = runCommandSpy.mock.calls.filter(
			([command, args]) => command === "npm" && args[0] === "install",
		);
		expect(npmInstallCalls).toHaveLength(0);
	});

	it("updates only the selected scope when configured packages share an identity", async () => {
		settingsManager.setPackages(["npm:example"]);
		settingsManager.setProjectPackages(["npm:example"]);
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.update("npm:example", { local: true, scripts: "never" });

		let npmInstallCalls = runCommandSpy.mock.calls.filter(
			([command, args]) => command === "npm" && args[0] === "install",
		);
		expect(npmInstallCalls).toHaveLength(1);
		expect(npmInstallCalls[0]?.[1]).toEqual(
			expect.arrayContaining(["--prefix", join(tempDir, CONFIG_DIR_NAME, "npm")]),
		);
		expect(npmInstallCalls[0]?.[1]).not.toContain(join(agentDir, "npm"));

		runCommandSpy.mockClear();

		await packageManager.update("npm:example", { local: false, scripts: "never" });

		npmInstallCalls = runCommandSpy.mock.calls.filter(
			([command, args]) => command === "npm" && args[0] === "install",
		);
		expect(npmInstallCalls).toHaveLength(1);
		expect(npmInstallCalls[0]?.[1]).toEqual(expect.arrayContaining(["--prefix", join(agentDir, "npm")]));
		expect(npmInstallCalls[0]?.[1]).not.toContain(join(tempDir, CONFIG_DIR_NAME, "npm"));
	});
});
