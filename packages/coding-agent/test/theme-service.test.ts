import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { getResolvedThemeColors, loadThemeJson } from "../src/core/theme/discovery.ts";
import { getResolvedThemeColors as legacyGetResolvedThemeColors } from "../src/core/theme/runtime.ts";
import { createThemeFromJson, parseThemeJson, THEME_BG_COLOR_KEYS, Theme } from "../src/core/theme/theme.ts";
import { createThemeService, type ThemeService } from "../src/core/theme/theme-service.ts";

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

function createCustomThemeJson(name: string, accent: string): string {
	const dark = loadThemeJson("dark");
	return JSON.stringify({ ...dark, name, colors: { ...dark.colors, accent } });
}

describe("theme token resolution", () => {
	it.each(["dark", "light"])("resolves %s tokens to CSS hex colors matching the legacy path", (name) => {
		const legacy = legacyGetResolvedThemeColors(name);
		const core = getResolvedThemeColors(name);
		expect(core).toEqual(legacy);
		expect(Object.keys(core).length).toBeGreaterThanOrEqual(50);
		for (const [token, value] of Object.entries(core)) {
			expect(value, `token ${token}`).toMatch(HEX_PATTERN);
		}
	});

	it("service.resolveTokens matches the discovery token map for builtins", () => {
		const service = createThemeService({ initialTheme: "dark", colorMode: "truecolor" });
		expect(service.resolveTokens()).toEqual(getResolvedThemeColors("dark"));
		service.dispose();
	});

	it("loads legacy JSON themes with fullscreen token fallbacks", () => {
		const legacyThemeJson = structuredClone(loadThemeJson("dark"));
		delete legacyThemeJson.colors.scrollbarThumb;
		delete legacyThemeJson.colors.searchMatchBg;
		delete legacyThemeJson.colors.searchMatchText;

		expect(() => parseThemeJson("legacy", legacyThemeJson)).not.toThrow();
		const loaded = createThemeFromJson(legacyThemeJson, "truecolor");
		expect(loaded.getBgAnsi("scrollbarThumb")).toBe(loaded.getBgAnsi("selectedBg"));
		expect(loaded.getBgAnsi("searchMatchBg")).toBe(loaded.getBgAnsi("selectedBg"));
		expect(loaded.getFgAnsi("searchMatchText")).toBe(loaded.getFgAnsi("text"));
	});

	it("applies fullscreen token fallbacks to directly constructed themes", () => {
		const source = createThemeFromJson(loadThemeJson("dark"), "truecolor");
		const foregrounds = Object.fromEntries(
			Object.entries(source.resolvedColors).filter(
				([key]) => !THEME_BG_COLOR_KEYS.has(key) && key !== "searchMatchText",
			),
		) as ConstructorParameters<typeof Theme>[0];
		const backgrounds = Object.fromEntries(
			Object.entries(source.resolvedColors).filter(
				([key]) => THEME_BG_COLOR_KEYS.has(key) && key !== "scrollbarThumb" && key !== "searchMatchBg",
			),
		) as ConstructorParameters<typeof Theme>[1];
		const direct = new Theme(foregrounds, backgrounds, "truecolor");

		expect(direct.getBgAnsi("scrollbarThumb")).toBe(direct.getBgAnsi("selectedBg"));
		expect(direct.getBgAnsi("searchMatchBg")).toBe(direct.getBgAnsi("selectedBg"));
		expect(direct.getFgAnsi("searchMatchText")).toBe(direct.getFgAnsi("text"));
	});
});

describe("ThemeService", () => {
	let customThemesDir: string;
	let service: ThemeService | undefined;

	beforeEach(() => {
		customThemesDir = mkdtempSync(join(tmpdir(), "volt-theme-service-"));
	});

	afterEach(() => {
		service?.dispose();
		service = undefined;
		rmSync(customThemesDir, { recursive: true, force: true });
	});

	function create(options: { initialTheme?: string; onPersist?: (name: string) => void } = {}): ThemeService {
		service = createThemeService({
			dirs: { themesDir: getThemesDir(), customThemesDir },
			colorMode: "truecolor",
			initialTheme: options.initialTheme ?? "dark",
			onPersist: options.onPersist,
		});
		return service;
	}

	it("discovers built-in themes", () => {
		const svc = create();
		const names = svc.getAvailableThemeInfos().map((info) => info.name);
		expect(names).toContain("dark");
		expect(names).toContain("light");
		expect(svc.getAllThemes().length).toBeGreaterThanOrEqual(2);
		expect(svc.getTheme("light")).toBeInstanceOf(Theme);
		expect(svc.getTheme("does-not-exist")).toBeUndefined();
	});

	it("discovers custom themes from the custom themes dir", () => {
		writeFileSync(join(customThemesDir, "mytheme.json"), createCustomThemeJson("mytheme", "#123456"));
		const svc = create();
		expect(svc.getAvailableThemeInfos().map((info) => info.name)).toContain("mytheme");
		expect(svc.resolveTokens(svc.getTheme("mytheme")).accent).toBe("#123456");
	});

	it("falls back to dark for an invalid initial theme", () => {
		const svc = create({ initialTheme: "does-not-exist" });
		expect(svc.currentThemeName).toBe("dark");
		expect(svc.current.name).toBe("dark");
	});

	it("notifies every subscriber on setTheme and supports unsubscribe", async () => {
		const svc = create();
		const seen: string[] = [];
		svc.subscribe((theme) => seen.push(`a:${theme.name}`));
		const unsubscribe = svc.subscribe((theme) => seen.push(`b:${theme.name}`));
		await svc.setTheme("light");
		expect(seen).toEqual(["a:light", "b:light"]);
		unsubscribe();
		await svc.setTheme("dark");
		expect(seen).toEqual(["a:light", "b:light", "a:dark"]);
	});

	it("invokes the persistence hook on successful setTheme only", async () => {
		const persisted: string[] = [];
		const svc = create({ onPersist: (name) => persisted.push(name) });
		expect((await svc.setTheme("light")).success).toBe(true);
		const failed = await svc.setTheme("does-not-exist");
		expect(failed.success).toBe(false);
		expect(failed.error).toContain("does-not-exist");
		expect(persisted).toEqual(["light"]);
		// Fallback applied after failure
		expect(svc.currentThemeName).toBe("dark");
	});

	it("accepts a direct Theme instance", async () => {
		const svc = create();
		const light = svc.getTheme("light");
		expect(light).toBeDefined();
		await svc.setTheme(light as Theme);
		expect(svc.current).toBe(light);
	});

	it("registered themes shadow discovery and are listed", () => {
		const svc = create();
		const light = svc.getTheme("light") as Theme;
		const registered = new Theme(
			Object.fromEntries(
				Object.entries(light.resolvedColors).filter(([key]) => !key.endsWith("Bg")),
			) as ConstructorParameters<typeof Theme>[0],
			Object.fromEntries(
				Object.entries(light.resolvedColors).filter(([key]) => key.endsWith("Bg")),
			) as ConstructorParameters<typeof Theme>[1],
			"truecolor",
			{ name: "registered-theme" },
		);
		svc.setRegisteredThemes([registered]);
		expect(svc.getTheme("registered-theme")).toBe(registered);
		expect(svc.getAvailableThemeInfos().map((info) => info.name)).toContain("registered-theme");
	});

	it("hot reload applies custom theme edits only when enabled", async () => {
		writeFileSync(join(customThemesDir, "hot.json"), createCustomThemeJson("hot", "#111111"));
		const svc = create();
		await svc.setTheme("hot");
		const notified: Theme[] = [];
		svc.subscribe((theme) => notified.push(theme));

		// Watcher not enabled: edits are ignored.
		writeFileSync(join(customThemesDir, "hot.json"), createCustomThemeJson("hot", "#222222"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(notified).toEqual([]);

		svc.enableHotReload();
		writeFileSync(join(customThemesDir, "hot.json"), createCustomThemeJson("hot", "#333333"));
		await expect.poll(() => notified.length, { timeout: 4000 }).toBeGreaterThan(0);
		expect(svc.resolveTokens().accent).toBe("#333333");
	});
});
