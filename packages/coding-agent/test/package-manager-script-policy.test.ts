import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

describe("DefaultPackageManager script policy", () => {
	let tempDir: string;
	let agentDir: string;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-script-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
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
});
