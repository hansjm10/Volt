import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";
import type { StorePackageInspection } from "../src/store/inspector.ts";

interface InspectCall {
	source: string;
	cwd: string;
	npmCommand?: string[];
}

interface StoreCliTestSettings {
	npmCommand?: string[];
	packages?: string[];
	profiles?: Record<string, { npmCommand?: string[] }>;
}

const inspectorMock = vi.hoisted(() => ({
	calls: [] as InspectCall[],
	inspectStorePackage: vi.fn(async (options: InspectCall): Promise<StorePackageInspection> => {
		inspectorMock.calls.push(options);
		return {
			source: options.source,
			discoveredResources: {
				extensions: [],
				skills: [],
				prompts: [],
				themes: [],
			},
			dependencies: {},
			peerDependencies: {},
			optionalDependencies: {},
			scripts: {},
			warnings: [],
		};
	}),
}));

vi.mock("../src/store/inspector.ts", () => ({
	inspectStorePackage: inspectorMock.inspectStorePackage,
}));

const npmCommand = ["custom-npm", "--registry", "https://registry.example.test"];

function createCatalog(source: string): Response {
	return Response.json({
		schemaVersion: 1,
		packages: [
			{
				id: "theme",
				name: "Theme",
				description: "Theme package",
				source,
				verified: true,
				resources: ["themes"],
			},
		],
	});
}

describe("store CLI npm command inspection", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-cli-npm-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeSettings({ npmCommand });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		inspectorMock.calls.length = 0;
		inspectorMock.inspectStorePackage.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalog("npm:@scope/theme@1.0.0")),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSettings(settings: StoreCliTestSettings): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
	}

	function expectLastInspectionUsedConfiguredNpmCommand(): void {
		const call = inspectorMock.calls[inspectorMock.calls.length - 1];
		expect(call?.npmCommand).toEqual(npmCommand);
	}

	it("uses npmCommand for store show inspection", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await main(["store", "show", "theme"]);

		expectLastInspectionUsedConfiguredNpmCommand();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("uses npmCommand for store install inspection", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await main(["store", "install", "theme", "--yes"]);

		expectLastInspectionUsedConfiguredNpmCommand();
		expect(installSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		installSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("uses profile npmCommand for store show inspection", async () => {
		const profileNpmCommand = ["profile-npm", "--registry", "https://profile.example.test"];
		writeSettings({
			npmCommand,
			profiles: {
				work: { npmCommand: profileNpmCommand },
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await main(["store", "show", "theme", "--profile", "work"]);

		const call = inspectorMock.calls[inspectorMock.calls.length - 1];
		expect(call?.npmCommand).toEqual(profileNpmCommand);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("refuses non-interactive store installs without --yes before package inspection", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await main(["store", "install", "theme"]);

		expect(inspectorMock.inspectStorePackage).not.toHaveBeenCalled();
		expect(installSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Non-interactive install requires --yes.",
		);
		expect(process.exitCode).toBe(1);
		installSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("uses npmCommand for store update inspection", async () => {
		writeSettings({ npmCommand, packages: ["npm:@scope/theme@1.0.0"] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalog("npm:@scope/theme@2.0.0")),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await main(["store", "update", "theme", "--yes"]);

		expectLastInspectionUsedConfiguredNpmCommand();
		expect(installSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		installSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("refuses non-interactive catalog updates without --yes before package inspection", async () => {
		writeSettings({ npmCommand, packages: ["npm:@scope/theme@1.0.0"] });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalog("npm:@scope/theme@2.0.0")),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await main(["store", "update", "theme"]);

		expect(inspectorMock.inspectStorePackage).not.toHaveBeenCalled();
		expect(installSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Non-interactive update requires --yes.",
		);
		expect(process.exitCode).toBe(1);
		installSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
