import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	mapRenderFrameLines,
	type RenderFrame,
	Spacer,
	Text,
} from "@hansjm10/volt-tui";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private contentDirty = false;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.contentDirty = true;
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.hideThinkingBlock = hide;
		this.contentDirty = true;
	}

	setHiddenThinkingLabel(label: string): void {
		if (this.hiddenThinkingLabel === label) return;
		this.hiddenThinkingLabel = label;
		this.contentDirty = true;
	}

	override render(width: number): RenderFrame {
		if (this.contentDirty) {
			this.rebuildContent();
		}
		const frame = super.render(width);
		if (this.hasToolCalls || frame.lines.length === 0) return frame;
		return mapRenderFrameLines(frame, (line, row) => {
			if (row === 0) return OSC133_ZONE_START + line;
			if (row === frame.lines.length - 1) return OSC133_ZONE_END + OSC133_ZONE_FINAL + line;
			return line;
		});
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.contentDirty = true;
	}

	private rebuildContent(): void {
		this.contentDirty = false;
		this.contentContainer.clear();
		const message = this.lastMessage;
		if (!message) return;

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const thinkingLabel = theme.italic(theme.fg("accent", "[thinking]"));
				if (this.hideThinkingBlock) {
					this.contentContainer.addChild(
						new Text(
							`${thinkingLabel} ${theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel))}`,
							1,
							0,
						),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					this.contentContainer.addChild(new Text(thinkingLabel, 1, 0));
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", `[aborted] ${abortMessage}`), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `[failure] ${errorMsg}`), 1, 0));
			}
		}
	}
}
