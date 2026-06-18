import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("Pi extension compatibility", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads Pi manifest extensions and maps Pi imports to Volt modules", async () => {
		const packageDir = join(tempDir, "pi-extension-package");
		const srcDir = join(packageDir, "src");
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "pi-extension-package",
					pi: {
						extensions: ["./src/main.ts"],
					},
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(srcDir, "main.ts"),
			`
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { truncateLine } from "@earendil-works/pi-coding-agent";
import { StringEnum as LegacyStringEnum } from "@mariozechner/pi-ai";
import { Text as LegacyText } from "@mariozechner/pi-tui";
import { truncateLine as legacyTruncateLine } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function(pi) {
	new Text("modern", 0, 0);
	new LegacyText("legacy", 0, 0);
	const modernName = truncateLine("pi-modern", 100).text;
	const legacyName = legacyTruncateLine("legacy", 100).text;
	pi.registerTool({
		name: modernName + "-" + legacyName,
		label: "Pi Compat",
		description: "Compatibility tool",
		parameters: Type.Object({
			value: StringEnum(["ok"]),
			legacy: LegacyStringEnum(["ok"]),
		}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
}
`,
		);

		const result = await discoverAndLoadExtensions([packageDir], tempDir, agentDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("pi-modern-legacy")).toBe(true);
	});

	it("resolves package resources from package.json pi manifests", async () => {
		const packageDir = join(tempDir, "pi-package");
		mkdirSync(join(packageDir, "src"), { recursive: true });
		mkdirSync(join(packageDir, "skills", "pi-skill"), { recursive: true });
		mkdirSync(join(packageDir, "prompts"), { recursive: true });
		mkdirSync(join(packageDir, "themes"), { recursive: true });
		const extensionPath = join(packageDir, "src", "main.ts");
		const skillPath = join(packageDir, "skills", "pi-skill", "SKILL.md");
		const promptPath = join(packageDir, "prompts", "review.md");
		const themePath = join(packageDir, "themes", "pi-theme.json");
		writeFileSync(extensionPath, "export default function() {}\n");
		writeFileSync(skillPath, "---\nname: pi-skill\ndescription: Pi skill\n---\n");
		writeFileSync(promptPath, "Pi prompt\n");
		writeFileSync(themePath, JSON.stringify({ name: "pi-theme" }));
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "pi-package",
					pi: {
						extensions: ["./src/main.ts"],
						skills: ["./skills"],
						prompts: ["./prompts"],
						themes: ["./themes"],
					},
				},
				null,
				2,
			),
		);

		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
		const result = await packageManager.resolve();

		expect(result.extensions.some((entry) => entry.path === extensionPath && entry.enabled)).toBe(true);
		expect(result.skills.some((entry) => entry.path === skillPath && entry.enabled)).toBe(true);
		expect(result.prompts.some((entry) => entry.path === promptPath && entry.enabled)).toBe(true);
		expect(result.themes.some((entry) => entry.path === themePath && entry.enabled)).toBe(true);
	});

	it("resolves local extension directories from package.json pi.extensions", async () => {
		const packageDir = join(tempDir, "pi-local-extension-dir");
		mkdirSync(join(packageDir, "src"), { recursive: true });
		const extensionPath = join(packageDir, "src", "main.ts");
		const helperPath = join(packageDir, "src", "helper.ts");
		writeFileSync(extensionPath, "export default function() {}\n");
		writeFileSync(helperPath, "export const helper = true;\n");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: "pi-local-extension-dir",
					pi: {
						extensions: ["./src/main.ts"],
					},
				},
				null,
				2,
			),
		);

		const settingsManager = SettingsManager.inMemory({ extensions: [packageDir] });
		const packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
		const result = await packageManager.resolve();

		expect(result.extensions.some((entry) => entry.path === extensionPath && entry.enabled)).toBe(true);
		expect(result.extensions.some((entry) => entry.path === helperPath)).toBe(false);
	});
});
