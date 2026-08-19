import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	mapRenderFrameLines,
	prefixRenderFrame,
	type RenderFrame,
	Spacer,
} from "@hansjm10/volt-tui";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class UserMessageRail implements Component {
	private content: Component;

	constructor(content: Component) {
		this.content = content;
	}

	render(width: number): RenderFrame {
		if (width <= 2) return this.content.render(width);
		return prefixRenderFrame(this.content.render(width - 2), `${theme.fg("borderAccent", "│")} `);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(
			new UserMessageRail(
				new Markdown(
					text,
					0,
					0,
					markdownTheme,
					{
						color: (content: string) => theme.fg("userMessageText", content),
					},
					{ preserveOrderedListMarkers: true },
				),
			),
		);
	}

	override render(width: number): RenderFrame {
		const frame = super.render(width);
		if (frame.lines.length === 0) return frame;
		return mapRenderFrameLines(frame, (line, row) => {
			if (row === 0) return OSC133_ZONE_START + line;
			if (row === frame.lines.length - 1) return OSC133_ZONE_END + OSC133_ZONE_FINAL + line;
			return line;
		});
	}
}
