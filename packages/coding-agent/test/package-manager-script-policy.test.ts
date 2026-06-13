import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

describe("DefaultPackageManager script policy", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-script-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("passes --ignore-scripts for npm installs when scripts are disabled", async () => {
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.install("npm:@scope/pkg@1.0.0", { scripts: "never" });

		expect(runCommandSpy).toHaveBeenCalledWith(
			"npm",
			expect.arrayContaining(["install", "@scope/pkg@1.0.0", "--ignore-scripts"]),
			undefined,
		);
	});

	it("keeps existing npm install behavior by default", async () => {
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.install("npm:@scope/pkg@1.0.0");

		const npmCall = runCommandSpy.mock.calls.find(([command]) => command === "npm");
		expect(npmCall?.[1]).not.toContain("--ignore-scripts");
	});

	it("passes --ignore-scripts for git dependency installs when scripts are disabled", async () => {
		const targetDir = join(agentDir, "git", "github.com", "user", "repo");
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockImplementation(async (command, args) => {
				if (command === "git" && args[0] === "clone") {
					mkdirSync(targetDir, { recursive: true });
					writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
				}
			});

		await packageManager.install("git:github.com/user/repo", { scripts: "never" });

		expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev", "--ignore-scripts"], {
			cwd: targetDir,
		});
	});

	it("uses persisted disabled scripts policy when auto-reinstalling missing npm packages", async () => {
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.installAndPersist("npm:@scope/pkg@1.0.0", { local: true, scripts: "never" });
		runCommandSpy.mockClear();

		await packageManager.resolve();

		expect(runCommandSpy).toHaveBeenCalledWith(
			"npm",
			expect.arrayContaining(["install", "@scope/pkg@1.0.0", "--ignore-scripts"]),
			undefined,
		);
	});

	it("uses persisted disabled scripts policy when auto-reinstalling missing git packages", async () => {
		const targetDir = join(tempDir, CONFIG_DIR_NAME, "git", "github.com", "user", "repo");
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockImplementation(async (command, args) => {
				if (command === "git" && args[0] === "clone") {
					mkdirSync(targetDir, { recursive: true });
					writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
				}
			});

		await packageManager.installAndPersist("git:github.com/user/repo", { local: true, scripts: "never" });
		rmSync(targetDir, { recursive: true, force: true });
		runCommandSpy.mockClear();

		await packageManager.resolve();

		expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev", "--ignore-scripts"], {
			cwd: targetDir,
		});
	});

	it("passes --ignore-scripts for npm updates when scripts are disabled", async () => {
		settingsManager.setPackages(["npm:@scope/pkg"]);
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.update(undefined, { scripts: "never" });

		expect(runCommandSpy).toHaveBeenCalledWith(
			"npm",
			expect.arrayContaining(["install", "@scope/pkg@latest", "--ignore-scripts"]),
			undefined,
		);
	});

	it("uses persisted scripts policy for npm updates when no override is provided", async () => {
		settingsManager.setPackages(["npm:@scope/allow", { source: "npm:@scope/never", scripts: "never" }]);
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await packageManager.update();

		const npmInstallCalls = runCommandSpy.mock.calls.filter(
			([command, args]) => command === "npm" && args[0] === "install",
		);
		const allowCall = npmInstallCalls.find(([, args]) => args.includes("@scope/allow@latest"));
		const neverCall = npmInstallCalls.find(([, args]) => args.includes("@scope/never@latest"));
		expect(allowCall).toBeDefined();
		expect(neverCall).toBeDefined();
		expect(allowCall?.[1]).not.toContain("--ignore-scripts");
		expect(neverCall?.[1]).toContain("--ignore-scripts");
	});

	it("passes --ignore-scripts for git update dependency installs when scripts are disabled", async () => {
		settingsManager.setPackages(["git:github.com/user/repo"]);
		const targetDir = join(agentDir, "git", "github.com", "user", "repo");
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockImplementation(async (command, args) => {
				if (command === "git" && args[0] === "clone") {
					mkdirSync(targetDir, { recursive: true });
					writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
				}
			});

		await packageManager.update(undefined, { scripts: "never" });

		expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev", "--ignore-scripts"], {
			cwd: targetDir,
		});
	});

	it("uses persisted disabled scripts policy for git updates when no override is provided", async () => {
		settingsManager.setPackages([{ source: "git:github.com/user/repo", scripts: "never" }]);
		const targetDir = join(agentDir, "git", "github.com", "user", "repo");
		const runCommandSpy = vi
			.spyOn(packageManager as unknown as PackageManagerInternals, "runCommand")
			.mockImplementation(async (command, args) => {
				if (command === "git" && args[0] === "clone") {
					mkdirSync(targetDir, { recursive: true });
					writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
				}
			});

		await packageManager.update();

		expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev", "--ignore-scripts"], {
			cwd: targetDir,
		});
	});
});
