/**
 * Multi-select component for persistent /review tool selection.
 */

import { Container, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/volt-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ReviewToolSelectorOption {
	name: string;
	description?: string;
	source: string;
	active: boolean;
	selected: boolean;
}

export class ReviewToolsSelectorComponent extends Container {
	private options: ReviewToolSelectorOption[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSaveCallback: (toolNames: string[]) => void;
	private onCancelCallback: () => void;

	constructor(options: ReviewToolSelectorOption[], onSave: (toolNames: string[]) => void, onCancel: () => void) {
		super();

		this.options = options.map((option) => ({ ...option }));
		this.onSaveCallback = onSave;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Review tools")), 1, 0));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("up/down", "navigate") +
					"  " +
					keyHint("app.reviewTools.toggle", "toggle") +
					"  " +
					keyHint("tui.select.confirm", "save") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i += 1) {
			const option = this.options[i];
			const isCursor = i === this.selectedIndex;
			const cursor = isCursor ? "> " : "  ";
			const checkbox = option.selected ? "[x]" : "[ ]";
			const active = option.active ? theme.fg("muted", " active") : "";
			const source = theme.fg("muted", ` ${option.source}`);
			const name = isCursor ? theme.fg("accent", option.name) : theme.fg("text", option.name);
			const description = option.description
				? theme.fg("muted", ` - ${truncateToWidth(option.description, 80)}`)
				: "";
			this.listContainer.addChild(
				new Text(
					`${isCursor ? theme.fg("accent", cursor) : cursor}${checkbox} ${name}${source}${active}${description}`,
					1,
					0,
				),
			);
		}
	}

	private toggleSelected(): void {
		const option = this.options[this.selectedIndex];
		if (!option) {
			return;
		}
		option.selected = !option.selected;
		this.updateList();
	}

	private selectedToolNames(): string[] {
		return this.options.filter((option) => option.selected).map((option) => option.name);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 10);
			this.updateList();
		} else if (kb.matches(keyData, "app.reviewTools.toggle")) {
			this.toggleSelected();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSaveCallback(this.selectedToolNames());
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
