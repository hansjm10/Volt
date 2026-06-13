import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectStorePackage } from "../src/store/inspector.ts";
import { buildStoreInstallPlan } from "../src/store/install-plan.ts";
import { renderStoreInstallPlan } from "../src/store/render.ts";
import type { StoreResolvedSource } from "../src/store/resolver.ts";

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

		expect(plan.compatibility).toBe("compatible");
		expect(plan.warnings).toContain("Extensions run as local code with the full permissions of the Volt process.");
		expect(plan.warnings).toContain("Package lifecycle scripts will be disabled for this store install.");
		expect(rendered).toContain("Dependencies:");
		expect(rendered).toContain("leftpad: 1.0.0");
		expect(rendered).toContain("Scripts:");
		expect(rendered).toContain("postinstall: node build.js");
		expect(rendered).toContain("Compatibility: compatible");
	});
});
