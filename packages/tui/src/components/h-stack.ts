import { compositeLayoutLine } from "../line-compositor.ts";
import { type ImagePlacement, renderComponentFrame, setImagePlacements } from "../render-frame.ts";
import { visibleWidth } from "../utils.ts";
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class HStack extends Stack {
	protected readonly layoutType = "hstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const viewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		if (entries.length === 0) return [];

		const intrinsicWidths = entries.map((entry) => {
			const frame = renderComponentFrame(entry.component, safeWidth);
			return frame.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		});
		const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, this.gap);
		const rendered = entries.map((entry, index) =>
			widths[index] === 0 ? { lines: [], images: [] } : renderComponentFrame(entry.component, widths[index]!),
		);
		const height = rendered.reduce((max, frame) => Math.max(max, frame.lines.length), 0);
		const result = Array.from({ length: height }, () => "");
		const images: ImagePlacement[] = [];
		let x = 0;
		for (let index = 0; index < rendered.length; index++) {
			const frame = rendered[index]!;
			const childWidth = widths[index]!;
			let offset = 0;
			if (this.align === "center") offset = Math.floor((height - frame.lines.length) / 2);
			else if (this.align === "end") offset = height - frame.lines.length;
			for (let row = 0; row < frame.lines.length; row++) {
				const target = row + offset;
				if (target < 0 || target >= result.length) continue;
				result[target] = compositeLayoutLine(result[target]!, frame.lines[row]!, x, childWidth, safeWidth);
			}
			for (const image of frame.images) {
				images.push({
					...image,
					top: image.top + offset,
					anchor: image.anchor + offset,
					left: image.left + x,
				});
			}
			x += childWidth + this.gap;
		}
		return setImagePlacements(result, images);
	}
}
