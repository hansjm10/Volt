import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";

describe("store CLI", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "package");
		mkdirSync(join(packageDir, "extensions"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "volt-rtk",
					version: "0.1.0",
					description: "RTK extension",
					volt: { extensions: ["extensions/rtk.ts"] },
				},
				null,
				2,
			),
		);
		writeFileSync(join(packageDir, "extensions", "rtk.ts"), "export default function rtk() {}\n");
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					schemaVersion: 1,
					packages: [
						{
							id: "rtk",
							name: "RTK Output Compression",
							description: "Token optimized shell output",
							source: packageDir,
							verified: true,
							resources: ["extensions"],
						},
					],
				}),
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("searches the catalog without starting normal app mode", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["store", "search", "RTK"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("rtk - RTK Output Compression");
			expect(stdout).toContain("Token optimized shell output");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs a catalog package with --yes and records it in user settings", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["store", "install", "rtk", "--yes"])).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
				packages?: Array<string | { source: string; scripts?: string }>;
			};
			expect(settings.packages).toHaveLength(1);
			expect(settings.packages?.[0]).toEqual({ source: expect.stringContaining("package"), scripts: "never" });
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Store install plan");
			expect(stdout).toContain("Script policy: never");
			expect(stdout).toContain("Installed");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("removes an installed catalog package by catalog ID", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["store", "install", "rtk", "--yes"]);
			await expect(main(["store", "remove", "rtk", "--yes"])).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { packages?: string[] };
			expect(settings.packages ?? []).toHaveLength(0);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Removed");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("removes a project-local catalog package stored relative to the project settings directory", async () => {
		const projectPackageDir = join(projectDir, "pkg");
		mkdirSync(join(projectPackageDir, "extensions"), { recursive: true });
		writeFileSync(
			join(projectPackageDir, "package.json"),
			JSON.stringify(
				{
					name: "project-local-rtk",
					version: "0.1.0",
					description: "Project-local RTK extension",
					volt: { extensions: ["extensions/rtk.ts"] },
				},
				null,
				2,
			),
		);
		writeFileSync(join(projectPackageDir, "extensions", "rtk.ts"), "export default function rtk() {}\n");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					schemaVersion: 1,
					packages: [
						{
							id: "project-local-rtk",
							name: "Project Local RTK",
							description: "Project-local token optimized shell output",
							source: projectPackageDir,
							verified: true,
							resources: ["extensions"],
						},
					],
				}),
			),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["store", "install", "project-local-rtk", "--local", "--approve", "--yes"]);

			const settingsPath = join(projectDir, CONFIG_DIR_NAME, "settings.json");
			const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
				packages?: Array<string | { source: string; scripts?: string }>;
			};
			expect(installedSettings.packages).toEqual([{ source: "../pkg", scripts: "never" }]);

			await expect(
				main(["store", "remove", "project-local-rtk", "--local", "--approve", "--yes"]),
			).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages ?? []).toHaveLength(0);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Removed");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("updates all installed packages with --yes and keeps lifecycle scripts disabled", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);

		try {
			await expect(main(["store", "update", "--yes"])).resolves.toBeUndefined();

			expect(updateSpy).toHaveBeenCalledWith(undefined, { scripts: "never" });
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Updated packages");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			updateSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("updates an installed catalog package without duplicating the settings entry", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["store", "install", "rtk", "--yes"]);
			await expect(main(["store", "update", "rtk", "--yes"])).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { packages?: string[] };
			expect(settings.packages).toHaveLength(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Updated");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("updates the project catalog package with --local when the package is installed in both scopes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					schemaVersion: 1,
					packages: [
						{
							id: "rtk",
							name: "RTK Output Compression",
							description: "Token optimized shell output",
							source: "npm:@scope/rtk",
							verified: true,
							resources: ["extensions"],
						},
					],
				}),
			),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@scope/rtk"] }, null, 2));
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/rtk"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);

		try {
			await expect(main(["store", "update", "rtk", "--local", "--approve", "--yes"])).resolves.toBeUndefined();

			expect(updateSpy).toHaveBeenCalledOnce();
			expect(updateSpy).toHaveBeenCalledWith("npm:@scope/rtk", { local: true, scripts: "never" });
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			updateSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("searches without resolving configured packages during project trust bootstrap", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/missing@1.0.0"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const resolveSpy = vi.spyOn(DefaultPackageManager.prototype, "resolve").mockResolvedValue({
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		});

		try {
			await expect(main(["store", "search", "RTK"])).resolves.toBeUndefined();

			expect(resolveSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			resolveSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refuses non-interactive installs without --yes before resolving configured packages", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/missing@1.0.0"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const resolveSpy = vi.spyOn(DefaultPackageManager.prototype, "resolve").mockResolvedValue({
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		});

		try {
			await expect(main(["store", "install", "rtk"])).resolves.toBeUndefined();

			expect(resolveSpy).not.toHaveBeenCalled();
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"Non-interactive install requires --yes.",
			);
			expect(process.exitCode).toBe(1);
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({
				packages: ["npm:@scope/missing@1.0.0"],
			});
		} finally {
			resolveSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});
