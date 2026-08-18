import {
	concatRenderFrames,
	createRenderFrame,
	mapRenderFrameLines,
	prefixRenderFrame,
	type RenderFrame,
} from "../render-frame.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth } from "../utils.ts";

type RenderCache = {
	childFrame: RenderFrame;
	width: number;
	bgSample: string | undefined;
	frame: RenderFrame;
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn: ((text: string) => string) | undefined;

	// Cache for rendered output
	private cache: RenderCache | undefined;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childFrame: RenderFrame, bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childFrame.lines.length === childFrame.lines.length &&
			cache.childFrame.lines.every((line, index) => line === childFrame.lines[index]) &&
			cache.childFrame.images.length === childFrame.images.length &&
			cache.childFrame.images.every((image, index) => {
				const next = childFrame.images[index];
				return (
					next !== undefined &&
					image.top === next.top &&
					image.anchor === next.anchor &&
					image.left === next.left &&
					image.columns === next.columns &&
					image.rows === next.rows &&
					image.protocol === next.protocol &&
					image.imageId === next.imageId &&
					image.sequence === next.sequence &&
					image.exactSequence === next.exactSequence
				);
			})
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): RenderFrame {
		if (this.children.length === 0) return createRenderFrame([]);

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const childFrame = prefixRenderFrame(
			concatRenderFrames(this.children.map((child) => child.render(contentWidth))),
			leftPad,
		);
		if (childFrame.lines.length === 0) return createRenderFrame([]);

		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		if (this.matchCache(width, childFrame, bgSample)) return this.cache!.frame;

		const contentFrame = mapRenderFrameLines(childFrame, (line) => this.applyBg(line, width));
		const paddingLines = Array.from({ length: this.paddingY }, () => this.applyBg("", width));
		const frame = concatRenderFrames([
			createRenderFrame(paddingLines),
			contentFrame,
			createRenderFrame(paddingLines),
		]);
		this.cache = {
			childFrame: createRenderFrame(
				[...childFrame.lines],
				childFrame.images.map((image) => ({ ...image })),
			),
			width,
			bgSample,
			frame,
		};
		return frame;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
