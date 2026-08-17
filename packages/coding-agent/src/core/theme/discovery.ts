import * as fs from "node:fs";
import * as path from "node:path";
import type { RgbColor } from "@hansjm10/volt-tui";
import { getCustomThemesDir, getThemesDir } from "../../config.ts";
import {
	createThemeFromJson,
	parseThemeJsonContent,
	type Theme,
	type ThemeJson,
	withThemeColorFallbacks,
} from "./theme.ts";
import { ansi256ToHex, hexToRgb, resolveVarRefs } from "./tokens.ts";
import type { ColorMode, TerminalTheme, TerminalThemeDetection, ThemeColorValue, ThemeInfo } from "./types.ts";

export interface ThemeDiscoveryDirs {
	/** Directory holding the built-in dark.json/light.json. Defaults to the packaged themes dir. */
	themesDir?: string;
	/** Directory holding user custom themes. Defaults to <agentDir>/themes. */
	customThemesDir?: string;
}

function resolveDirs(dirs: ThemeDiscoveryDirs = {}): { themesDir: string; customThemesDir: string } {
	return {
		themesDir: dirs.themesDir ?? getThemesDir(),
		customThemesDir: dirs.customThemesDir ?? getCustomThemesDir(),
	};
}

const builtinThemesCache = new Map<string, Record<string, ThemeJson>>();

function getBuiltinThemes(themesDir: string): Record<string, ThemeJson> {
	let builtin = builtinThemesCache.get(themesDir);
	if (!builtin) {
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		builtin = {
			dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")) as ThemeJson,
			light: JSON.parse(fs.readFileSync(lightPath, "utf-8")) as ThemeJson,
		};
		builtinThemesCache.set(themesDir, builtin);
	}
	return builtin;
}

const NO_REGISTERED_THEMES: ReadonlyMap<string, Theme> = new Map();

export function getAvailableThemesWithPaths(
	registeredThemes: ReadonlyMap<string, Theme> = NO_REGISTERED_THEMES,
	dirs?: ThemeDiscoveryDirs,
): ThemeInfo[] {
	const { themesDir, customThemesDir } = resolveDirs(dirs);
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// Built-in themes
	for (const name of Object.keys(getBuiltinThemes(themesDir))) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	for (const themeInfo of getCustomThemeInfos(customThemesDir)) {
		addTheme(themeInfo);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function getCustomThemeInfos(customThemesDir: string): ThemeInfo[] {
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// Invalid themes are ignored here; the resource loader reports them
			// during normal startup/reload.
		}
	}
	return result;
}

export function loadThemeJson(
	name: string,
	registeredThemes: ReadonlyMap<string, Theme> = NO_REGISTERED_THEMES,
	dirs?: ThemeDiscoveryDirs,
): ThemeJson {
	const { themesDir, customThemesDir } = resolveDirs(dirs);
	const builtinThemes = getBuiltinThemes(themesDir);
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createThemeFromJson(themeJson, mode, themePath);
}

export function loadTheme(
	name: string,
	mode?: ColorMode,
	registeredThemes: ReadonlyMap<string, Theme> = NO_REGISTERED_THEMES,
	dirs?: ThemeDiscoveryDirs,
): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name, registeredThemes, dirs);
	return createThemeFromJson(themeJson, mode);
}

// ============================================================================
// Terminal background detection
// ============================================================================

export interface TerminalThemeDetectionOptions {
	env?: NodeJS.ProcessEnv;
}

export interface TerminalBackgroundThemeDetector {
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined>;
}

export interface TerminalBackgroundThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalBackgroundThemeDetector;
	timeoutMs: number;
}

function getColorFgBgBackgroundIndex(colorfgbg: string): number | undefined {
	const parts = colorfgbg.split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			return bg;
		}
	}
	return undefined;
}

function getRgbColorLuminance({ r, g, b }: RgbColor): number {
	const toLinear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getAnsiColorLuminance(index: number): number {
	return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
	return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

export function detectTerminalBackgroundFromEnv(options: TerminalThemeDetectionOptions = {}): TerminalThemeDetection {
	const env = options.env ?? process.env;
	const colorfgbg = env.COLORFGBG || "";
	const bg = getColorFgBgBackgroundIndex(colorfgbg);
	if (bg !== undefined) {
		return {
			theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
			source: "COLORFGBG",
			detail: `background color index ${bg}`,
			confidence: "high",
		};
	}

	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

export async function detectTerminalBackgroundTheme({
	ui,
	timeoutMs,
	env,
}: TerminalBackgroundThemeDetectionOptions): Promise<TerminalThemeDetection> {
	try {
		const rgb = await ui.queryTerminalBackgroundColor({ timeoutMs });
		if (rgb) {
			return {
				theme: getThemeForRgbColor(rgb),
				source: "terminal background",
				detail: `OSC 11 background rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
				confidence: "high",
			};
		}
	} catch {
		// Fall back to environment-based detection when the terminal query fails.
	}

	return detectTerminalBackgroundFromEnv({ env });
}

export function getDefaultTheme(): string {
	return detectTerminalBackgroundFromEnv().theme;
}

// ============================================================================
// Token snapshots / HTML export helpers
// ============================================================================

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export and token snapshots to generate CSS custom properties.
 */
export function getResolvedThemeColors(
	name: string,
	registeredThemes: ReadonlyMap<string, Theme> = NO_REGISTERED_THEMES,
	dirs?: ThemeDiscoveryDirs,
): Record<string, string> {
	const isLight = name === "light";
	const themeJson = loadThemeJson(name, registeredThemes, dirs);
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(withThemeColorFallbacks(themeJson.colors))) {
		resolved[key] = resolveVarRefs(value, themeJson.vars ?? {});
	}

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
	// Currently just check the name - could be extended to analyze colors
	return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(
	name: string,
	registeredThemes: ReadonlyMap<string, Theme> = NO_REGISTERED_THEMES,
	dirs?: ThemeDiscoveryDirs,
): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	try {
		const themeJson = loadThemeJson(name, registeredThemes, dirs);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: ThemeColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}
