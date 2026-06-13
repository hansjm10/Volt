import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ConfiguredPackage, PackageInstallOptions, PackageUpdateOptions } from "../src/core/package-manager.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { StoreCatalog } from "../src/store/catalog.ts";
import type { StorePackageInspection } from "../src/store/inspector.ts";
import type { ResolveStoreSourceOptions, StoreResolvedSource } from "../src/store/resolver.ts";

const trackedGitSource = "git:https://github.com/acme/rtk";
const pinnedGitSource = "git:https://github.com/acme/rtk@0123456789abcdef0123456789abcdef01234567";

const resolverMock = vi.hoisted(() => ({
	resolveStoreSource: vi.fn<(options: ResolveStoreSourceOptions) => Promise<StoreResolvedSource>>(),
}));

const inspectorMock = vi.hoisted(() => ({
	inspectStorePackage: vi.fn(
		async (options: { source: string }): Promise<StorePackageInspection> => ({
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
		}),
	),
}));

function resolveTrackedGitStoreSource(options: ResolveStoreSourceOptions): StoreResolvedSource {
	return {
		input: options.input,
		source: options.pinGit ? pinnedGitSource : trackedGitSource,
		kind: "catalog",
		catalogPackage: {
			id: "rtk",
			name: "RTK",
			description: "Token optimized shell output",
			source: trackedGitSource,
		},
		pinned: options.pinGit === true,
		tracking: options.pinGit !== true,
		warnings: [],
	};
}

vi.mock("../src/store/resolver.ts", () => ({
	resolveStoreSource: resolverMock.resolveStoreSource,
}));

vi.mock("../src/store/inspector.ts", () => ({
	inspectStorePackage: inspectorMock.inspectStorePackage,
}));

interface InteractiveSettingsManager {
	isProjectTrusted(): boolean;
	flush(): Promise<void>;
}

interface FakeStorePackageManager {
	getPackageIdentity(source: string, scope?: "user" | "project"): string;
	listConfiguredPackages(): ConfiguredPackage[];
	update(source?: string, options?: PackageUpdateOptions): Promise<void>;
	installAndPersist(source: string, options?: PackageInstallOptions): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
}

interface InteractiveStoreMode {
	runtimeHost: {
		session: {
			settingsManager: InteractiveSettingsManager;
			sessionManager: { getCwd(): string };
		};
	};
	loadStoreCatalog(required: boolean): Promise<StoreCatalog | undefined>;
	getStorePackageManager(): FakeStorePackageManager;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showStoreText(text: string): void;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	reportStoreSettingsErrors(
		packageManager: FakeStorePackageManager,
		source: string,
		scope: "user" | "project",
	): boolean;
	offerStoreReload(message: string): Promise<void>;
}

const storeCatalog: StoreCatalog = {
	schemaVersion: 1,
	packages: [
		{
			id: "rtk",
			name: "RTK",
			description: "Token optimized shell output",
			source: trackedGitSource,
		},
	],
};

function createCatalogResponse(): Response {
	return Response.json(storeCatalog);
}

function getFakePackageIdentity(source: string, scope?: "user" | "project"): string {
	if (source === trackedGitSource || source === pinnedGitSource) {
		return "git:github.com/acme/rtk";
	}
	if (source === "/repo/project/pkg") {
		return "local:/repo/project/pkg";
	}
	if (source === "../pkg" && scope === "project") {
		return "local:/repo/project/pkg";
	}
	if (source === "../pkg") {
		return "local:/repo/pkg";
	}
	return source;
}

function createInteractiveMode(packageManager: FakeStorePackageManager): InteractiveStoreMode {
	const settingsManager: InteractiveSettingsManager = {
		isProjectTrusted: () => true,
		flush: vi.fn(async () => {}),
	};
	const sessionManager = {
		getCwd: () => "/repo/project",
	};
	return Object.assign(Object.create(InteractiveMode.prototype) as InteractiveStoreMode, {
		runtimeHost: {
			session: {
				settingsManager,
				sessionManager,
			},
		},
		loadStoreCatalog: vi.fn(async () => storeCatalog),
		getStorePackageManager: vi.fn(() => packageManager),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStoreText: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
		reportStoreSettingsErrors: vi.fn(() => false),
		offerStoreReload: vi.fn(async () => {}),
	});
}

function getInteractiveStoreUpdateFlow(): (
	this: InteractiveStoreMode,
	input?: string,
	catalog?: StoreCatalog,
) => Promise<void> {
	return Reflect.get(InteractiveMode.prototype, "showStoreUpdateFlow") as (
		this: InteractiveStoreMode,
		input?: string,
		catalog?: StoreCatalog,
	) => Promise<void>;
}

function getInteractiveStoreRemoveFlow(): (
	this: InteractiveStoreMode,
	input: string,
	local?: boolean,
	catalog?: StoreCatalog,
) => Promise<void> {
	return Reflect.get(InteractiveMode.prototype, "showStoreRemoveFlow") as (
		this: InteractiveStoreMode,
		input: string,
		local?: boolean,
		catalog?: StoreCatalog,
	) => Promise<void>;
}

describe("tracked git store updates", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-tracked-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [trackedGitSource] }, null, 2));
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		resolverMock.resolveStoreSource.mockImplementation(async (options) => resolveTrackedGitStoreSource(options));
		inspectorMock.inspectStorePackage.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalogResponse()),
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

	it("preserves tracked git sources during CLI catalog updates", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await main(["store", "update", "rtk", "--yes"]);

		expect(updateSpy).toHaveBeenCalledWith(trackedGitSource, { local: false, scripts: "never" });
		expect(installSpy).not.toHaveBeenCalled();
		expect(inspectorMock.inspectStorePackage).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("preserves tracked git sources during interactive catalog updates", async () => {
		const update = vi
			.fn<(source?: string, options?: PackageUpdateOptions) => Promise<void>>()
			.mockResolvedValue(undefined);
		const installAndPersist = vi
			.fn<(source: string, options?: PackageInstallOptions) => Promise<void>>()
			.mockResolvedValue(undefined);
		const packageManager: FakeStorePackageManager = {
			getPackageIdentity: getFakePackageIdentity,
			listConfiguredPackages: () => [
				{ source: trackedGitSource, actionSource: trackedGitSource, scope: "user", filtered: false },
			],
			update,
			installAndPersist,
			removeAndPersist: vi.fn(async () => true),
		};
		const mode = createInteractiveMode(packageManager);

		await getInteractiveStoreUpdateFlow().call(mode, "rtk", storeCatalog);

		expect(update).toHaveBeenCalledWith(trackedGitSource, { local: false, scripts: "never" });
		expect(installAndPersist).not.toHaveBeenCalled();
		expect(inspectorMock.inspectStorePackage).not.toHaveBeenCalled();
	});
});

describe("interactive store local removals", () => {
	beforeEach(() => {
		resolverMock.resolveStoreSource.mockResolvedValue({
			input: "../pkg",
			source: "../pkg",
			kind: "local",
			pinned: false,
			tracking: false,
			warnings: [],
		});
	});

	afterEach(() => {
		resolverMock.resolveStoreSource.mockReset();
	});

	it("uses the selected action source when removing settings-relative project packages", async () => {
		const removeAndPersist = vi
			.fn<(source: string, options?: { local?: boolean }) => Promise<boolean>>()
			.mockResolvedValue(true);
		const packageManager: FakeStorePackageManager = {
			getPackageIdentity: getFakePackageIdentity,
			listConfiguredPackages: () => [
				{ source: "../pkg", actionSource: "/repo/project/pkg", scope: "project", filtered: false },
			],
			update: vi.fn(async () => {}),
			installAndPersist: vi.fn(async () => {}),
			removeAndPersist,
		};
		const mode = createInteractiveMode(packageManager);

		await getInteractiveStoreRemoveFlow().call(mode, "../pkg", undefined, storeCatalog);

		expect(removeAndPersist).toHaveBeenCalledWith("/repo/project/pkg", { local: true });
	});
});
