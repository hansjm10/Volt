import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@hansjm10/volt-coding-agent";
import type { Component, EditorTheme, TUI } from "@hansjm10/volt-tui";
import {
	createRenderFrame,
	mapRenderFrameLines,
	type RenderFrame,
	truncateToWidth,
	visibleWidth,
} from "@hansjm10/volt-tui";

function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 3;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow || !usage || usage.percent === null) {
		return "ctx ?";
	}
	return `ctx ${Math.round(usage.percent)}%/${(contextWindow / 1000).toFixed(0)}k`;
}

function formatThinking(level: string): string {
	return level === "off" ? "off" : level;
}

class EmptyFooter implements Component {
	render(): RenderFrame {
		return createRenderFrame([]);
	}

	invalidate(): void {}
}

export default function (volt: ExtensionAPI) {
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	volt.on("agent_start", () => {
		isWorking = true;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 80);
		activeTui?.requestRender();
	});

	volt.on("agent_end", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	volt.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
	});

	volt.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyFooter());

		let branch: string | undefined;

		const refreshBranch = async () => {
			const result = await volt.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined);
			const stdout = result?.stdout.trim();
			branch = stdout && stdout.length > 0 ? stdout : undefined;
			activeTui?.requestRender();
		};
		void refreshBranch();

		class BorderStatusEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
				activeTui = tui;
			}

			render(width: number): RenderFrame {
				const frame = super.render(width);
				if (frame.lines.length < 2) return frame;

				const thm = ctx.ui.theme;
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
				const thinking = volt.getThinkingLevel();
				const topLeft = isWorking ? thm.fg("accent", ` ${spinnerFrames[spinnerIndex]} `) : "";
				const topRight = "";
				const bottomLeft = thm.fg("muted", ` ${model} · ${formatThinking(thinking)} `);
				const bottomRight = thm.fg(
					"muted",
					` ${formatContext(ctx)} · ${formatCwd(ctx.cwd)}${branch ? ` (${branch})` : ""} `,
				);
				const borderColor = (text: string) => this.borderColor(text);

				return mapRenderFrameLines(frame, (line, row) => {
					if (row === 0) return fitBorder(topLeft, topRight, width, borderColor);
					if (row === frame.lines.length - 1) {
						return fitBorder(bottomLeft, bottomRight, width, borderColor);
					}
					return line;
				});
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BorderStatusEditor(tui, theme, keybindings));
	});
}
