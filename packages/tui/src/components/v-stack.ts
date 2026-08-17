import { type ImagePlacement, renderComponentFrame, setImagePlacements } from "../render-frame.ts";
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => renderComponentFrame(entry.component, viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((frame) => frame.lines.length),
			undefined,
			this.gap,
		);
		const lines: string[] = [];
		const images: ImagePlacement[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) lines.push("");
			}
			const frame = rendered[index]!;
			const childSize = sizes[index]!;
			const top = lines.length;
			const childLines = frame.lines.slice(0, childSize);
			lines.push(...childLines);
			for (const image of frame.images) {
				if (image.anchor >= childSize || image.top >= childSize) continue;
				images.push({
					...image,
					top: image.top + top,
					anchor: image.anchor + top,
				});
			}
			for (let padding = childLines.length; padding < childSize; padding++) lines.push("");
		}
		return setImagePlacements(lines, images);
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
