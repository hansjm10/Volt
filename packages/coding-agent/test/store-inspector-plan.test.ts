import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { inspectStorePackage } from "../src/store/inspector.ts";
import { buildStoreInstallPlan } from "../src/store/install-plan.ts";
import { renderStoreInstallPlan } from "../src/store/render.ts";
import type { StoreResolvedSource } from "../src/store/resolver.ts";
import { createDirectorySymlinkSync, tryCreateFileSymlinkSync } from "./symlink-utils.ts";

describe("store inspector and install plan", () => {
	let tempDir: string;
	let packageDir: string;
	let sentinelPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-inspector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		packageDir = join(tempDir, "pkg");
		sentinelPath = join(tempDir, "loaded.txt");
		mkdirSync(join(packageDir, "extensions"), { recursive: true });
		mkdirSync(join(packageDir, "skills", "helper"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "volt-example",
					version: "1.2.3",
					description: "Example package",
					license: "MIT",
					repository: { url: "https://github.com/user/volt-example" },
					dependencies: { leftpad: "1.0.0" },
					peerDependencies: { "@earendil-works/volt-coding-agent": "*" },
					optionalDependencies: { optional: "2.0.0" },
					scripts: { postinstall: "node build.js" },
					volt: { extensions: ["extensions/*.ts"] },
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(packageDir, "extensions", "example.ts"),
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "loaded");
`,
		);
		writeFileSync(join(packageDir, "skills", "helper", "SKILL.md"), "---\nname: helper\n---\n");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function resolveRuntimeResources(root: string): Promise<{
		extensions: string[];
		skills: string[];
		prompts: string[];
		themes: string[];
	}> {
		const packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		const resolved = await packageManager.resolveExtensionSources([root]);
		return {
			extensions: resolved.extensions.map((resource) => relative(root, resource.path).replace(/\\/g, "/")).sort(),
			skills: resolved.skills.map((resource) => relative(root, resource.path).replace(/\\/g, "/")).sort(),
			prompts: resolved.prompts.map((resource) => relative(root, resource.path).replace(/\\/g, "/")).sort(),
			themes: resolved.themes.map((resource) => relative(root, resource.path).replace(/\\/g, "/")).sort(),
		};
	}

	async function resolveRuntimeSkillResources(root: string): Promise<string[]> {
		return (await resolveRuntimeResources(root)).skills;
	}

	it("reads package metadata and manifest resources without loading extension code", async () => {
		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });

		expect(inspection.packageName).toBe("volt-example");
		expect(inspection.packageVersion).toBe("1.2.3");
		expect(inspection.voltManifest?.extensions).toEqual(["extensions/*.ts"]);
		expect(inspection.discoveredResources.extensions).toEqual(["extensions/example.ts"]);
		expect(inspection.dependencies).toEqual({ leftpad: "1.0.0" });
		expect(inspection.peerDependencies).toEqual({ "@earendil-works/volt-coding-agent": "*" });
		expect(inspection.optionalDependencies).toEqual({ optional: "2.0.0" });
		expect(inspection.scripts).toEqual({ postinstall: "node build.js" });
		expect(existsSync(sentinelPath)).toBe(false);
	});

	it("reports explicit manifest extension files that runtime loading accepts", async () => {
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(packageDir, "dist", "index.mjs"), "export default function extension() {}\n");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "volt-example",
					version: "1.2.3",
					volt: { extensions: ["dist/index.mjs"] },
				},
				null,
				2,
			),
		);

		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });

		expect(inspection.discoveredResources.extensions).toEqual(["dist/index.mjs"]);
	});

	it("applies manifest override patterns when discovering resources", async () => {
		writeFileSync(join(packageDir, "extensions", "dev.ts"), "export default function dev() {}\n");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "volt-example",
					version: "1.2.3",
					volt: { extensions: ["extensions/*.ts", "!extensions/dev.ts"] },
				},
				null,
				2,
			),
		);

		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });

		expect(inspection.voltManifest?.extensions).toEqual(["extensions/*.ts", "!extensions/dev.ts"]);
		expect(inspection.discoveredResources.extensions).toContain("extensions/example.ts");
		expect(inspection.discoveredResources.extensions).not.toContain("extensions/dev.ts");
	});

	it("discovers resources from manifest directory entries", async () => {
		mkdirSync(join(packageDir, "prompts"), { recursive: true });
		mkdirSync(join(packageDir, "themes"), { recursive: true });
		writeFileSync(join(packageDir, "extensions", "dev.ts"), "export default function dev() {}\n");
		writeFileSync(join(packageDir, "prompts", "summary.md"), "Summarize this.\n");
		writeFileSync(join(packageDir, "themes", "dark.json"), "{}\n");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "volt-example",
					version: "1.2.3",
					volt: {
						extensions: ["./extensions", "!extensions/dev.ts"],
						skills: ["./skills"],
						prompts: ["./prompts"],
						themes: ["./themes"],
					},
				},
				null,
				2,
			),
		);

		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });

		expect(inspection.discoveredResources.extensions).toEqual(["extensions/example.ts"]);
		expect(inspection.discoveredResources.skills).toEqual(["skills/helper/SKILL.md"]);
		expect(inspection.discoveredResources.prompts).toEqual(["prompts/summary.md"]);
		expect(inspection.discoveredResources.themes).toEqual(["themes/dark.json"]);
	});

	it("matches runtime loading for nested conventional skill markdown files", async () => {
		const nestedPackageDir = join(tempDir, "nested-skill-markdown-pkg");
		mkdirSync(join(nestedPackageDir, "skills", "nested"), { recursive: true });
		writeFileSync(join(nestedPackageDir, "package.json"), JSON.stringify({ name: "nested-skills" }, null, 2));
		writeFileSync(join(nestedPackageDir, "skills", "nested", "extra.md"), "---\nname: extra\n---\n");

		const inspection = await inspectStorePackage({ source: nestedPackageDir, cwd: tempDir });
		const runtimeSkills = await resolveRuntimeSkillResources(nestedPackageDir);

		expect(runtimeSkills).toEqual([]);
		expect(inspection.discoveredResources.skills.sort()).toEqual(runtimeSkills);
	});

	it("matches runtime loading when a manifest skill directory contains nested skills", async () => {
		mkdirSync(join(packageDir, "skills", "root-skill", "nested-skill"), { recursive: true });
		writeFileSync(join(packageDir, "skills", "root-skill", "SKILL.md"), "---\nname: root-skill\n---\n");
		writeFileSync(join(packageDir, "skills", "root-skill", "nested-skill", "SKILL.md"), "---\nname: nested\n---\n");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "volt-example", version: "1.2.3", volt: { skills: ["skills/root-skill"] } }, null, 2),
		);

		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });
		const runtimeSkills = await resolveRuntimeSkillResources(packageDir);

		expect(runtimeSkills).toEqual(["skills/root-skill/SKILL.md"]);
		expect(inspection.discoveredResources.skills.sort()).toEqual(runtimeSkills);
	});

	it("discovers conventional resource directories when no volt manifest exists", async () => {
		mkdirSync(join(packageDir, "extensions", "nested"), { recursive: true });
		mkdirSync(join(packageDir, "extensions", "with-index"), { recursive: true });
		mkdirSync(join(packageDir, "extensions", "with-manifest", "src"), { recursive: true });
		writeFileSync(join(packageDir, "extensions", "nested", "hidden.ts"), "export default function hidden() {}\n");
		writeFileSync(join(packageDir, "extensions", "with-index", "index.ts"), "export default function indexed() {}\n");
		writeFileSync(
			join(packageDir, "extensions", "with-manifest", "package.json"),
			JSON.stringify({ volt: { extensions: ["./src/main.ts"] } }, null, 2),
		);
		writeFileSync(
			join(packageDir, "extensions", "with-manifest", "src", "main.ts"),
			"export default function manifested() {}\n",
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "volt-example", version: "1.2.3" }, null, 2),
		);

		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });

		expect([...inspection.discoveredResources.extensions].sort()).toEqual([
			"extensions/example.ts",
			"extensions/with-index/index.ts",
			"extensions/with-manifest/src/main.ts",
		]);
		expect(inspection.discoveredResources.skills).toEqual(["skills/helper/SKILL.md"]);
	});

	it("discovers symlinked conventional extension resources to match runtime loading", async () => {
		const symlinkPackageDir = join(tempDir, "symlinked-resources");
		const targetDir = join(tempDir, "symlink-targets");
		mkdirSync(join(symlinkPackageDir, "extensions"), { recursive: true });
		mkdirSync(join(targetDir, "extension-dir"), { recursive: true });
		writeFileSync(join(symlinkPackageDir, "package.json"), JSON.stringify({ name: "symlinked-resources" }, null, 2));
		writeFileSync(join(targetDir, "real.ts"), "export default function real() {}\n");
		writeFileSync(join(targetDir, "extension-dir", "index.ts"), "export default function indexed() {}\n");
		const hasFileSymlink = tryCreateFileSymlinkSync(
			join(targetDir, "real.ts"),
			join(symlinkPackageDir, "extensions", "link.ts"),
		);
		createDirectorySymlinkSync(join(targetDir, "extension-dir"), join(symlinkPackageDir, "extensions", "linked-dir"));

		const inspection = await inspectStorePackage({ source: symlinkPackageDir, cwd: tempDir });
		const runtimeResources = await resolveRuntimeResources(symlinkPackageDir);
		const expectedExtensions = ["extensions/linked-dir/index.ts"];
		if (hasFileSymlink) expectedExtensions.unshift("extensions/link.ts");

		expect(inspection.discoveredResources.extensions.sort()).toEqual(runtimeResources.extensions);
		expect(inspection.discoveredResources.extensions.sort()).toEqual(expectedExtensions);
	});

	it("discovers conventional resources after package metadata parse failures to match runtime loading", async () => {
		const malformedPackageDir = join(tempDir, "malformed-package-json");
		mkdirSync(join(malformedPackageDir, "extensions"), { recursive: true });
		writeFileSync(join(malformedPackageDir, "package.json"), "{ invalid json");
		writeFileSync(join(malformedPackageDir, "extensions", "ext.ts"), "export default function extension() {}\n");

		const inspection = await inspectStorePackage({ source: malformedPackageDir, cwd: tempDir });
		const runtimeResources = await resolveRuntimeResources(malformedPackageDir);

		expect(inspection.warnings[0]).toContain("Failed to read package metadata:");
		expect(inspection.discoveredResources).toEqual(runtimeResources);
		expect(inspection.discoveredResources.extensions).toEqual(["extensions/ext.ts"]);
	});

	it("preserves empty volt manifests during inspection to match runtime loading", async () => {
		const emptyManifestPackageDir = join(tempDir, "empty-manifest");
		mkdirSync(join(emptyManifestPackageDir, "extensions"), { recursive: true });
		mkdirSync(join(emptyManifestPackageDir, "skills", "helper"), { recursive: true });
		writeFileSync(
			join(emptyManifestPackageDir, "package.json"),
			JSON.stringify({ name: "empty-manifest", volt: {} }, null, 2),
		);
		writeFileSync(join(emptyManifestPackageDir, "extensions", "ext.ts"), "export default function extension() {}\n");
		writeFileSync(join(emptyManifestPackageDir, "skills", "helper", "SKILL.md"), "---\nname: helper\n---\n");

		const inspection = await inspectStorePackage({ source: emptyManifestPackageDir, cwd: tempDir });
		const runtimeResources = await resolveRuntimeResources(emptyManifestPackageDir);

		expect(inspection.voltManifest).toEqual({});
		expect(inspection.discoveredResources).toEqual(runtimeResources);
		expect(inspection.discoveredResources.extensions).toEqual([]);
		expect(inspection.discoveredResources.skills).toEqual([]);
	});

	it("discovers conventional resources without package.json to match runtime loading", async () => {
		const packageWithoutManifestDir = join(tempDir, "no-package-json");
		mkdirSync(join(packageWithoutManifestDir, "extensions"), { recursive: true });
		mkdirSync(join(packageWithoutManifestDir, "skills", "helper"), { recursive: true });
		mkdirSync(join(packageWithoutManifestDir, "prompts"), { recursive: true });
		mkdirSync(join(packageWithoutManifestDir, "themes"), { recursive: true });
		writeFileSync(
			join(packageWithoutManifestDir, "extensions", "index.ts"),
			"export default function extension() {}\n",
		);
		writeFileSync(join(packageWithoutManifestDir, "skills", "helper", "SKILL.md"), "---\nname: helper\n---\n");
		writeFileSync(join(packageWithoutManifestDir, "prompts", "summary.md"), "Summarize this.\n");
		writeFileSync(join(packageWithoutManifestDir, "themes", "dark.json"), "{}\n");

		const inspection = await inspectStorePackage({ source: packageWithoutManifestDir, cwd: tempDir });
		const runtimeResources = await resolveRuntimeResources(packageWithoutManifestDir);

		expect(inspection.warnings).toContain(`No package.json found at ${packageWithoutManifestDir}.`);
		expect(inspection.discoveredResources).toEqual(runtimeResources);
	});

	it.each([".gitignore", ".ignore", ".fdignore"])(
		"honors %s when discovering conventional package resources",
		async (ignoreFileName) => {
			const ignoredPackageDir = join(tempDir, `ignored-${ignoreFileName.slice(1)}`);
			mkdirSync(join(ignoredPackageDir, "extensions"), { recursive: true });
			mkdirSync(join(ignoredPackageDir, "prompts"), { recursive: true });
			mkdirSync(join(ignoredPackageDir, "themes"), { recursive: true });
			writeFileSync(join(ignoredPackageDir, "package.json"), JSON.stringify({ name: "ignored-resources" }, null, 2));
			writeFileSync(join(ignoredPackageDir, "extensions", ignoreFileName), "ignored.ts\n");
			writeFileSync(join(ignoredPackageDir, "prompts", ignoreFileName), "ignored.md\n");
			writeFileSync(join(ignoredPackageDir, "themes", ignoreFileName), "ignored.json\n");
			writeFileSync(join(ignoredPackageDir, "extensions", "visible.ts"), "export default function visible() {}\n");
			writeFileSync(join(ignoredPackageDir, "extensions", "ignored.ts"), "export default function ignored() {}\n");
			writeFileSync(join(ignoredPackageDir, "prompts", "visible.md"), "Visible prompt\n");
			writeFileSync(join(ignoredPackageDir, "prompts", "ignored.md"), "Ignored prompt\n");
			writeFileSync(join(ignoredPackageDir, "themes", "visible.json"), "{}\n");
			writeFileSync(join(ignoredPackageDir, "themes", "ignored.json"), "{}\n");

			const inspection = await inspectStorePackage({ source: ignoredPackageDir, cwd: tempDir });
			const runtimeResources = await resolveRuntimeResources(ignoredPackageDir);

			expect(inspection.discoveredResources).toEqual(runtimeResources);
			expect(inspection.discoveredResources.extensions).toEqual(["extensions/visible.ts"]);
			expect(inspection.discoveredResources.prompts).toEqual(["prompts/visible.md"]);
			expect(inspection.discoveredResources.themes).toEqual(["themes/visible.json"]);
		},
	);

	it("builds and renders a plan with security, dependency, script, and compatibility details", async () => {
		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });
		const resolved: StoreResolvedSource = {
			input: "example",
			source: packageDir,
			kind: "catalog",
			pinned: false,
			tracking: false,
			catalogPackage: {
				id: "example",
				name: "Example",
				description: "Example",
				source: packageDir,
				compatibility: { volt: ">=0.1.0" },
			},
			warnings: ["Local package paths are not reproducible."],
		};

		const plan = buildStoreInstallPlan({
			resolved,
			inspection,
			scope: "user",
			scriptPolicy: "never",
			currentVersion: "0.79.1",
		});
		const rendered = renderStoreInstallPlan(plan);

		expect(rendered).toContain("Package: example - Example");
		expect(plan.compatibility).toBe("compatible");
		expect(plan.warnings).toContain("Extensions run as local code with the full permissions of the Volt process.");
		expect(plan.warnings).toContain("Package lifecycle scripts will be disabled for this store install.");
		expect(rendered).toContain("Dependencies:");
		expect(rendered).toContain("leftpad: 1.0.0");
		expect(rendered).toContain("Scripts:");
		expect(rendered).toContain("postinstall: node build.js");
		expect(rendered).toContain("Compatibility: compatible");
	});

	it("renders catalog git plans with package names and shortened source labels", async () => {
		const inspection = await inspectStorePackage({ source: packageDir, cwd: tempDir });
		const resolved: StoreResolvedSource = {
			input: "rtk",
			source: "git:https://github.com/user/volt-rtk@0123456789abcdef0123456789abcdef01234567",
			kind: "catalog",
			pinned: true,
			tracking: false,
			catalogPackage: {
				id: "rtk",
				name: "RTK Output Compression",
				description: "Token optimized shell output",
				source: "git:https://github.com/user/volt-rtk",
			},
			warnings: [],
		};

		const plan = buildStoreInstallPlan({
			resolved,
			inspection,
			scope: "user",
			scriptPolicy: "never",
		});
		const rendered = renderStoreInstallPlan(plan);

		expect(rendered).toContain("Package: rtk - RTK Output Compression");
		expect(rendered).toContain("Source: git github.com/user/volt-rtk @ 0123456789ab");
		expect(rendered).not.toContain("git:https://github.com/user/volt-rtk@0123456789abcdef0123456789abcdef01234567");
	});
});
