import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface ConfiguredUpdateSourceForTest {
	source: string;
	scope: "user" | "project";
	scripts: "never" | "allow";
}

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
	updateConfiguredSources(sources: ConfiguredUpdateSourceForTest[]): Promise<void>;
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

	it("removes project-local packages using the settings-relative listed source", async () => {
		const packageDir = join(tempDir, "pkg");
		mkdirSync(packageDir, { recursive: true });

		await packageManager.installAndPersist("./pkg", { local: true });

		const [configured] = packageManager.listConfiguredPackages();
		expect(configured).toBeDefined();
		expect(configured.source).toBe(relative(join(tempDir, CONFIG_DIR_NAME), packageDir));
		expect(packageManager.removeSourceFromSettings(configured.source, { local: true })).toBe(true);
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});

	it("updates settings-relative project-local package inputs in the selected scope", async () => {
		const packageDir = join(tempDir, "pkg");
		mkdirSync(packageDir, { recursive: true });
		settingsManager.setProjectPackages(["../pkg"]);

		await expect(packageManager.update("../pkg", { local: true, scripts: "never" })).resolves.toBeUndefined();
	});

	it("updates cwd-relative project-local package inputs in the selected scope", async () => {
		const packageDir = join(tempDir, "pkg");
		mkdirSync(packageDir, { recursive: true });
		settingsManager.setProjectPackages(["../pkg"]);

		await expect(packageManager.update("./pkg", { local: true, scripts: "never" })).resolves.toBeUndefined();
	});

	it("removes only the exact project-local package when one input matches two local paths", () => {
		settingsManager.setProjectPackages(["foo", "../foo"]);

		expect(packageManager.removeSourceFromSettings("foo", { local: true })).toBe(true);

		expect(settingsManager.getProjectSettings().packages).toEqual(["../foo"]);
	});

	it("updates only the exact project-local package when one input matches two local paths", async () => {
		settingsManager.setProjectPackages(["foo", "../foo"]);
		const updateConfiguredSourcesSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "updateConfiguredSources")
			.mockResolvedValue(undefined);

		await packageManager.update("foo", { local: true, scripts: "never" });

		expect(updateConfiguredSourcesSpy).toHaveBeenCalledWith([{ source: "foo", scope: "project", scripts: "never" }]);
	});

	it("does not wait for background descendants that inherit output pipes", async () => {
		const scriptPath = join(tempDir, "hold-stdio.cjs");
		writeFileSync(
			scriptPath,
			[
				'const { spawn } = require("node:child_process");',
				'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 750);"], {',
				'\tstdio: ["ignore", "inherit", "inherit"],',
				"});",
				"child.unref();",
			].join("\n"),
		);
		const runCommandPromise = (packageManager as unknown as PackageManagerInternals)
			.runCommand(process.execPath, [scriptPath])
			.then(() => "resolved" as const);

		const result = await Promise.race([
			runCommandPromise,
			new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 500)),
		]);

		expect(result).toBe("resolved");
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

	it("preserves tracking npm specs when updating packages", async () => {
		settingsManager.setPackages([
			"npm:@scope/latest",
			"npm:@scope/beta@beta",
			"npm:@scope/ranged@^1.0.0",
			"npm:@scope/exact@1.2.3",
		]);
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.update();

		const npmInstallCalls = runCommandSpy.mock.calls.filter(
			([command, args]) => command === "npm" && args[0] === "install",
		);
		expect(npmInstallCalls).toHaveLength(1);
		expect(npmInstallCalls[0]?.[1]).toEqual(
			expect.arrayContaining(["@scope/latest@latest", "@scope/beta@beta", "@scope/ranged@^1.0.0"]),
		);
		expect(npmInstallCalls[0]?.[1]).not.toContain("@scope/exact@1.2.3");
	});

	it("checks npm updates against the configured tracking spec", async () => {
		const packageDir = join(agentDir, "npm", "node_modules", "@scope", "ranged");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "@scope/ranged", version: "1.9.0" }, null, 2),
		);
		settingsManager.setPackages(["npm:@scope/ranged@^1.0.0"]);
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);
		const runCommandCaptureSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommandCapture")
			.mockResolvedValue(JSON.stringify(["1.8.0", "1.9.0"]));

		await packageManager.update();

		expect(runCommandCaptureSpy).toHaveBeenCalledWith(
			"npm",
			["view", "@scope/ranged@^1.0.0", "version", "--json"],
			expect.objectContaining({ cwd: tempDir }),
		);
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
