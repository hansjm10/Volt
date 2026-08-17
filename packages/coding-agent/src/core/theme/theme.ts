import { getCapabilities } from "@hansjm10/volt-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { SourceInfo } from "../source-info.ts";
import { bgAnsi, fgAnsi, resolveThemeColors } from "./tokens.ts";
import type { ColorMode, ThemeBg, ThemeColor, ThemeColorValue } from "./types.ts";

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

export const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (10 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (11 required, 3 optional)
		selectedBg: ColorValueSchema,
		scrollbarThumb: Type.Optional(ColorValueSchema),
		searchMatchBg: Type.Optional(ColorValueSchema),
		searchMatchText: Type.Optional(ColorValueSchema),
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

export type ThemeJson = Static<typeof ThemeJsonSchema>;

const validateThemeJson = Compile(ThemeJsonSchema);

export const THEME_BG_COLOR_KEYS: ReadonlySet<string> = new Set([
	"selectedBg",
	"scrollbarThumb",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

type OptionalThemeColor = "searchMatchText";
type OptionalThemeBg = "scrollbarThumb" | "searchMatchBg";
type ThemeForegrounds = Record<Exclude<ThemeColor, OptionalThemeColor>, ThemeColorValue> &
	Partial<Record<OptionalThemeColor, ThemeColorValue>>;
type ThemeBackgrounds = Record<Exclude<ThemeBg, OptionalThemeBg>, ThemeColorValue> &
	Partial<Record<OptionalThemeBg, ThemeColorValue>>;

export function withThemeColorFallbacks(colors: ThemeJson["colors"]): ThemeJson["colors"] & {
	scrollbarThumb: ThemeColorValue;
	searchMatchBg: ThemeColorValue;
	searchMatchText: ThemeColorValue;
} {
	return {
		...colors,
		scrollbarThumb: colors.scrollbarThumb ?? colors.selectedBg,
		searchMatchBg: colors.searchMatchBg ?? colors.selectedBg,
		searchMatchText: colors.searchMatchText ?? colors.text,
	};
}

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	/** Resolved raw color values (hex/index/""), keyed by token name; kept for token snapshots. */
	readonly resolvedColors: Record<string, string | number>;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	constructor(
		fgColors: ThemeForegrounds,
		bgColors: ThemeBackgrounds,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		const foregrounds: Record<ThemeColor, ThemeColorValue> = {
			...fgColors,
			searchMatchText: fgColors.searchMatchText ?? fgColors.text,
		};
		const backgrounds: Record<ThemeBg, ThemeColorValue> = {
			...bgColors,
			scrollbarThumb: bgColors.scrollbarThumb ?? bgColors.selectedBg,
			searchMatchBg: bgColors.searchMatchBg ?? bgColors.selectedBg,
		};
		this.resolvedColors = { ...foregrounds, ...backgrounds };
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(foregrounds) as [ThemeColor, ThemeColorValue][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(backgrounds) as [ThemeBg, ThemeColorValue][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
	): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
			case "max":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

export function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ThemeJson;
}

export function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

export function getDefaultColorMode(): ColorMode {
	return getCapabilities().trueColor ? "truecolor" : "256color";
}

export function createThemeFromJson(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? getDefaultColorMode();
	const resolvedColors = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (THEME_BG_COLOR_KEYS.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
	});
}
