/**
 * Component for displaying bash command execution with streaming output.
 */

import {
	type Component,
	Container,
	createRenderFrame,
	Loader,
	prefixRenderFrame,
	type RenderFrame,
	Spacer,
	Text,
	type TUI,
} from "@hansjm10/volt-tui";
import { highlightShellCommand, theme } from "../../../core/theme/runtime.ts";
import { formatDuration } from "../../../core/tools/render-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

class BashOutputRail implements Component {
	private component: Component;
	private colorKey: "bashMode" | "dim";

	constructor(component: Component, colorKey: "bashMode" | "dim") {
		this.component = component;
		this.colorKey = colorKey;
	}

	render(width: number): RenderFrame {
		if (width <= 2) return this.component.render(width);
		return prefixRenderFrame(this.component.render(width - 2), `${theme.fg(this.colorKey, "│")} `);
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private displayDirty = true;
	private contentContainer: Container;
	private colorKey: "bashMode" | "dim";
	private startedAt = Date.now();
	private durationMs?: number;

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;

		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		this.addChild(new BashOutputRail(this.contentContainer, this.colorKey));

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(this.colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running (${keyText("tui.select.cancel")} to cancel)`,
		);
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.displayDirty = true;
	}

	override invalidate(): void {
		super.invalidate();
		this.displayDirty = true;
	}

	override render(width: number): RenderFrame {
		if (this.displayDirty) {
			this.updateDisplay();
		}
		return super.render(width);
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.displayDirty = true;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		this.durationMs ??= Date.now() - this.startedAt;

		// Stop loader
		this.loader.stop();
		this.displayDirty = true;
	}

	private updateDisplay(): void {
		this.displayDirty = false;
		// Apply truncation for LLM context limits (same limits as bash tool)
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command, state, and duration form a compact semantic header.
		let state: string;
		if (this.status === "running") {
			state = theme.fg("warning", "[running]");
		} else if (this.status === "complete") {
			state = theme.fg("success", "[success]");
		} else if (this.status === "cancelled") {
			state = theme.fg("warning", "[cancelled]");
		} else {
			state = theme.fg("error", "[failure]");
		}
		const duration =
			this.durationMs !== undefined && this.durationMs >= 1000
				? ` ${theme.fg("dim", `(${formatDuration(this.durationMs)})`)}`
				: "";
		const command =
			this.colorKey === "dim"
				? theme.fg("dim", this.command)
				: highlightShellCommand(this.command, "bashMode").join("\n");
		const header = new Text(`${theme.fg(this.colorKey, theme.bold("$ "))}${command} ${state}${duration}`, 1, 0);
		this.contentContainer.addChild(header);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return createRenderFrame(cachedLines ?? []);
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "Cancelled"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `Exit code: ${this.exitCode}`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
