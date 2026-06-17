import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { main } from "../src/main.ts";

interface ConfiguredUpdateSourceForTest {
	source: string;
	scope: "user" | "project";
	scripts: "never" | "allow";
}

interface PackageManagerInternals {
	updateConfiguredSources(sources: ConfiguredUpdateSourceForTest[]): Promise<void>;
}

interface NpmSourceForTest {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	pinned: boolean;
}

interface PackageManagerRemoveInternals {
	uninstallNpm(source: NpmSourceForTest, scope: "user" | "project" | "temporary"): Promise<void>;
}

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalVoltPackageDir: string | undefined;
	let originalLatestVersionUrl: string | undefined;
	let originalVoltProfile: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalVoltPackageDir = process.env.VOLT_PACKAGE_DIR;
		originalLatestVersionUrl = process.env.VOLT_LATEST_VERSION_URL;
		originalVoltProfile = process.env.VOLT_PROFILE;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
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
		if (originalVoltPackageDir === undefined) {
			delete process.env.VOLT_PACKAGE_DIR;
		} else {
			process.env.VOLT_PACKAGE_DIR = originalVoltPackageDir;
		}
		if (originalLatestVersionUrl === undefined) {
			delete process.env.VOLT_LATEST_VERSION_URL;
		} else {
			process.env.VOLT_LATEST_VERSION_URL = originalLatestVersionUrl;
		}
		if (originalVoltProfile === undefined) {
			delete process.env.VOLT_PROFILE;
		} else {
			process.env.VOLT_PROFILE = originalVoltProfile;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("skips untrusted project package settings", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses remembered project trust for list", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("overrides remembered trust for list with --no-approve", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("approves project trust for list with --approve", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses default project trust for list", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lists active profile packages", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:@base/pkg"],
				profiles: { work: { packages: ["npm:@profile/pkg"] } },
			}),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--profile", "work"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("npm:@profile/pkg");
			expect(stdout).not.toContain("npm:@base/pkg");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("removes packages from the active global profile", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					profiles: {
						work: { packages: [packageDir] },
					},
				},
				null,
				2,
			),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["remove", packageDir, "--profile", "work"])).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
				packages?: string[];
				profiles?: Record<string, { packages?: string[] }>;
			};
			expect(settings.packages).toBeUndefined();
			expect(settings.profiles?.work?.packages).toEqual([]);
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(`Removed ${packageDir}`);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("does not uninstall an inherited global package removed only by an active profile", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					packages: ["npm:@base/pkg"],
					profiles: {
						work: {},
					},
				},
				null,
				2,
			),
		);
		const uninstallSpy = vi
			.spyOn(DefaultPackageManager.prototype as unknown as PackageManagerRemoveInternals, "uninstallNpm")
			.mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["remove", "npm:@base/pkg", "--profile", "work"])).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
				packages?: string[];
				profiles?: Record<string, { packages?: string[] }>;
			};
			expect(settings.packages).toEqual(["npm:@base/pkg"]);
			expect(settings.profiles?.work?.packages).toEqual([]);
			expect(uninstallSpy).not.toHaveBeenCalled();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Removed npm:@base/pkg");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			uninstallSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("rejects missing package command --profile values before another option", async () => {
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: VERSION })),
		);
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--profile", "--extensions"])).resolves.toBeUndefined();

			expect(updateSpy).not.toHaveBeenCalled();
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("--profile requires a value");
			expect(process.exitCode).toBe(1);
		} finally {
			updateSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it.each([
		{ name: "VOLT_PROFILE", args: ["update", "--extensions"], envProfile: "work" },
		{ name: "trailing --profile", args: ["update", "--extensions", "--profile", "work"] },
		{ name: "leading --profile", args: ["--profile", "work", "update", "--extensions"] },
	])("applies $name to package command settings", async ({ args, envProfile }) => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					packages: ["npm:@base/pkg"],
					profiles: {
						work: {
							packages: ["npm:@profile/pkg"],
						},
					},
				},
				null,
				2,
			),
		);
		if (envProfile !== undefined) {
			process.env.VOLT_PROFILE = envProfile;
		}
		const updateConfiguredSourcesSpy = vi
			.spyOn(DefaultPackageManager.prototype as unknown as PackageManagerInternals, "updateConfiguredSources")
			.mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(args)).resolves.toBeUndefined();

			expect(updateConfiguredSourcesSpy).toHaveBeenCalledWith([
				{ source: "npm:@profile/pkg", scope: "user", scripts: "allow" },
			]);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			updateConfiguredSourcesSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("uses project_trust extensions for package commands", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["list"], {
					extensionFactories: [
						(volt) => {
							volt.on("project_trust", () => ({ trusted: "yes" }));
						},
					],
				}),
			).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lets trust.json override default project trust", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".volt", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("blocks local package changes when project is untrusted", async () => {
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "-l", "./local-package"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted. Use --approve to modify local package config.");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows local package install to initialize fresh project settings", async () => {
		await main(["install", "-l", packageDir, "--approve"]);

		const settingsPath = join(projectDir, ".volt", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		expect(realpathSync(join(projectDir, ".volt", stored))).toBe(realpathSync(packageDir));
		expect(process.exitCode).toBeUndefined();
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("volt install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "volt --help" or "volt install <source> [-l] [--approve|--no-approve]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: volt install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("uses global npmCommand and current package name for forced self updates without checking the api", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "volt-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(join(projectDir, ".volt"), { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		writeFileSync(
			join(projectDir, ".volt", "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix] }, null, 2),
		);
		process.env.VOLT_PACKAGE_DIR = selfPackageDir;
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(globalPrefix);
			expect(recordedArgs).toContain(PACKAGE_NAME);
			expect(recordedArgs).not.toContain(projectPrefix);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("uses profile npmCommand for forced self updates", async () => {
		const selfUpdatePrefix = join(tempDir, "self-update-prefix");
		const selfPackageDir = join(selfUpdatePrefix, "lib", "node_modules", "@mariozechner", "volt-coding-agent");
		const fakeGlobalNpmPath = join(tempDir, "fake-global-npm.cjs");
		const fakeProfileNpmPath = join(tempDir, "fake-profile-npm.cjs");
		const recordPath = join(tempDir, "profile-self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		const fakeNpmScript = (label: string) =>
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify({label:${JSON.stringify(label)},args}));
`;
		writeFileSync(fakeGlobalNpmPath, fakeNpmScript("global"));
		writeFileSync(fakeProfileNpmPath, fakeNpmScript("profile"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					npmCommand: [originalExecPath, fakeGlobalNpmPath, "--prefix", selfUpdatePrefix],
					profiles: {
						work: { npmCommand: [originalExecPath, fakeProfileNpmPath, "--prefix", selfUpdatePrefix] },
					},
				},
				null,
				2,
			),
		);
		process.env.VOLT_PACKAGE_DIR = selfPackageDir;
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self", "--force", "--profile", "work"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			const recorded = JSON.parse(readFileSync(recordPath, "utf-8")) as { label?: string; args?: string[] };
			expect(recorded.label).toBe("profile");
			expect(recorded.args).toContain(PACKAGE_NAME);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("uses the current package name when the update check omits packageName", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "volt-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VOLT_PACKAGE_DIR = selfPackageDir;
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json({ version: getNewerPatchVersion() }));
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(PACKAGE_NAME);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs the active package name from the update check during self-update", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "volt-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else {
	const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
	records.push(args);
	fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
}
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VOLT_PACKAGE_DIR = selfPackageDir;
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME === "@new-scope/volt" ? "@newer-scope/volt" : "@new-scope/volt";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([
				expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
				expect.arrayContaining(["install", "-g", activePackageName]),
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("fails self-update when renamed npm package installation fails", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "volt-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm-fail.cjs");
		const recordPath = join(tempDir, "self-update-fail.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) {
	console.log(path.join(prefix,"lib","node_modules"));
	process.exit(0);
}
const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
records.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
if(args.includes("install")) process.exit(23);
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VOLT_PACKAGE_DIR = selfPackageDir;
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME === "@new-scope/volt" ? "@newer-scope/volt" : "@new-scope/volt";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain(`Updated volt`);
			expect(stderr).toContain("exited with code 23");
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([
				expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
				expect.arrayContaining(["install", "-g", activePackageName]),
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:volt-formatter"] }, null, 2));
		const originalOffline = process.env.VOLT_OFFLINE;
		process.env.VOLT_OFFLINE = "1";

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "volt-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:volt-formatter?");
			expect(stdout).not.toContain("Updated volt-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:volt-formatter");
		} finally {
			if (originalOffline === undefined) {
				delete process.env.VOLT_OFFLINE;
			} else {
				process.env.VOLT_OFFLINE = originalOffline;
			}
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
