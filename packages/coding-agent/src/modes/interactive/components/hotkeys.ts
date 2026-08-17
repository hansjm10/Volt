import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

export interface HotkeyEntry {
	key: string;
	action: string;
}

export interface HotkeySection {
	title: string;
	entries: HotkeyEntry[];
}

type HotkeyRow = { type: "section"; title: string } | { type: "entry"; key: string; action: string };

/** Scrollable shortcut reference with persistent title, position, and controls. */
export class HotkeysComponent implements Component {
	private readonly rows: HotkeyRow[];
	private readonly getTerminalRows: () => number;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private scrollOffset = 0;

	constructor(
		sections: HotkeySection[],
		getTerminalRows: () => number,
		onClose: () => void,
		requestRender: () => void,
	) {
		this.rows = sections.flatMap((section) => [
			{ type: "section" as const, title: section.title },
			...section.entries.map((entry) => ({ type: "entry" as const, ...entry })),
		]);
		this.getTerminalRows = getTerminalRows;
		this.onClose = onClose;
		this.requestRender = requestRender;
	}

	invalidate(): void {
		// Styling is resolved during render so theme changes apply immediately.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const visibleRows = this.getVisibleRowCount();
		const maxOffset = Math.max(0, this.rows.length - visibleRows);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = Math.min(this.rows.length, this.scrollOffset + visibleRows);
		const position = this.rows.length > 0 ? `${this.scrollOffset + 1}–${end}/${this.rows.length}` : "0/0";
		const activeSection = this.getActiveSection();
		const titleLabel =
			this.rows[this.scrollOffset]?.type === "entry" && activeSection
				? `Keyboard Shortcuts · ${activeSection}`
				: "Keyboard Shortcuts";
		const title = theme.bold(theme.fg("accent", titleLabel));
		const positionText = theme.fg("dim", position);
		const titlePadding = " ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(positionText) - 2));
		const lines = [
			new DynamicBorder().render(width)[0]!,
			"",
			truncateToWidth(` ${title}${titlePadding}${positionText} `, width),
			"",
		];

		const keyWidth = Math.min(
			Math.max(12, Math.floor(width * 0.5)),
			40,
			Math.max(12, ...this.rows.flatMap((row) => (row.type === "entry" ? [visibleWidth(row.key)] : []))),
		);
		for (const row of this.rows.slice(this.scrollOffset, end)) {
			if (row.type === "section") {
				lines.push(truncateToWidth(` ${theme.bold(theme.fg("muted", row.title.toUpperCase()))}`, width));
				continue;
			}
			const key = truncateToWidth(row.key, keyWidth, "");
			const keyPadding = " ".repeat(Math.max(0, keyWidth - visibleWidth(key)));
			lines.push(
				truncateToWidth(` ${theme.fg("accent", key)}${keyPadding}  ${theme.fg("text", row.action)}`, width),
			);
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				` ${keyHint("tui.select.cancel", "close")}  ${rawKeyHint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "scroll")}`,
				width,
			),
		);
		lines.push(
			truncateToWidth(
				` ${rawKeyHint(`${keyText("tui.editor.pageUp")}/${keyText("tui.editor.pageDown")}`, "page")}`,
				width,
			),
		);
		lines.push(new DynamicBorder().render(width)[0]!);
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const visibleRows = this.getVisibleRowCount();
		const maxOffset = Math.max(0, this.rows.length - visibleRows);
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
		} else if (kb.matches(data, "tui.editor.pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - visibleRows);
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + visibleRows);
		} else {
			return;
		}
		this.requestRender();
	}

	private getActiveSection(): string | undefined {
		for (let index = this.scrollOffset; index >= 0; index--) {
			const row = this.rows[index];
			if (row?.type === "section") return row.title;
		}
		return undefined;
	}

	private getVisibleRowCount(): number {
		return Math.max(5, Math.min(16, this.getTerminalRows() - 12));
	}
}
