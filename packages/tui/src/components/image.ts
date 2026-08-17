import { type ImagePlacement, setImagePlacements } from "../render-frame.ts";
import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	getImageRenderGeneration,
	type ImageDimensions,
	imageFallback,
	releaseSixelImage,
	renderImage,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty image ID. If provided, reuses this ID (for animations/updates). */
	imageId?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId: number | undefined;

	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private cachedGeneration: number | undefined;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** Get the Kitty image ID used by this image (if any). */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.cachedGeneration = undefined;
	}

	/** Release terminal-side preparation retained for this image. Safe to call repeatedly. */
	dispose(): void {
		if (this.imageId !== undefined) releaseSixelImage(this.imageId);
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.cachedGeneration = undefined;
	}

	render(width: number): string[] {
		const generation = getImageRenderGeneration();
		if (this.cachedLines && this.cachedWidth === width && this.cachedGeneration === generation) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;

		const caps = getCapabilities();
		let lines: string[];
		let imagePlacement: ImagePlacement | undefined;

		if (caps.images) {
			if ((caps.images === "kitty" || caps.images === "sixel") && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				...(this.imageId === undefined ? {} : { imageId: this.imageId }),
				moveCursor: false,
			});

			if (result) {
				// Store the image ID for later cleanup
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				if (caps.images === "kitty" || caps.images === "sixel") {
					// Kitty suppresses cursor movement and Sixel saves/restores the cursor.
					lines = [result.sequence];
					imagePlacement = {
						top: 0,
						anchor: 0,
						left: 0,
						columns: result.columns,
						rows: result.rows,
						protocol: caps.images,
						...(result.imageId === undefined ? {} : { imageId: result.imageId }),
						sequence: result.sequence,
						exactSequence: true,
					};

					// Return `rows` lines so TUI accounts for image height.
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
				} else {
					// Return `rows` lines so TUI accounts for image height.
					// First (rows-1) lines are empty and cleared before the image is drawn.
					// Last line: move cursor back up, draw the image, then move back down
					// so TUI cursor accounting stays inside the scroll area.
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					const rowOffset = result.rows - 1;
					const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
					const sequence = moveUp + result.sequence;
					lines.push(sequence);
					imagePlacement = {
						top: 0,
						anchor: rowOffset,
						left: 0,
						columns: result.columns,
						rows: result.rows,
						protocol: "iterm2",
						sequence,
						exactSequence: true,
					};
				}
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [this.theme.fallbackColor(fallback)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [this.theme.fallbackColor(fallback)];
		}

		setImagePlacements(lines, imagePlacement ? [imagePlacement] : []);
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedGeneration = generation;

		return lines;
	}
}
