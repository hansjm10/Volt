import { getImageMetadata } from "./terminal-image.ts";
import type { Component } from "./tui.ts";

export interface ImagePlacement {
	/** First row occupied by the image, relative to the rendered lines. */
	top: number;
	/** Row containing the terminal image sequence, relative to the rendered lines. */
	anchor: number;
	/** First occupied terminal column. */
	left: number;
	columns: number;
	rows: number;
	protocol: "kitty" | "iterm2" | "sixel";
	imageId?: number;
	/** Image-only terminal sequence used when layout must relocate or crop the placement. */
	sequence: string;
	/** Whether sequence is an exact substring of the anchor line. */
	exactSequence: boolean;
}

export interface RenderFrame {
	lines: string[];
	images: ImagePlacement[];
}

const imagePlacements = new WeakMap<string[], ImagePlacement[]>();

function inferImagePlacements(lines: string[]): ImagePlacement[] {
	const images: ImagePlacement[] = [];
	const visit = (row: number): void => {
		const line = lines[row] ?? "";
		if (!line.includes("\x1b_G") && !line.includes("\x1b_pi:s=")) return;
		const metadata = getImageMetadata(line);
		if (metadata && "sourceY" in metadata) {
			images.push({
				top: row,
				anchor: row,
				left: 0,
				columns: metadata.columns,
				rows: metadata.rows,
				protocol: "sixel",
				imageId: metadata.imageId,
				sequence: line,
				exactSequence: false,
			});
			return;
		}

		const kittyControls = /\x1b_G([^;]*);/.exec(line)?.[1];
		if (!kittyControls) return;
		const values = new Map(
			kittyControls.split(",").map((control) => {
				const [key = "", value = ""] = control.split("=", 2);
				return [key, Number.parseInt(value, 10)] as const;
			}),
		);
		const imageId = values.get("i") ?? metadata?.imageId;
		const columns = values.get("c") ?? metadata?.columns ?? 1;
		const rows = values.get("r") ?? metadata?.rows ?? 1;
		if (!imageId || columns <= 0 || rows <= 0) return;
		images.push({
			top: row,
			anchor: row,
			left: 0,
			columns,
			rows,
			protocol: "kitty",
			imageId,
			sequence: line,
			exactSequence: false,
		});
	};

	if (lines.length > 1_000_000) {
		for (const key of Object.keys(lines)) {
			const row = Number.parseInt(key, 10);
			if (Number.isInteger(row) && row >= 0 && row < lines.length) visit(row);
		}
	} else {
		for (let row = 0; row < lines.length; row++) visit(row);
	}
	return images;
}

export function setImagePlacements(lines: string[], images: readonly ImagePlacement[]): string[] {
	imagePlacements.set(
		lines,
		images.map((image) => ({ ...image })),
	);
	return lines;
}

export function getImagePlacements(lines: string[]): ImagePlacement[] {
	return imagePlacements.get(lines) ?? inferImagePlacements(lines);
}

export function renderComponentFrame(component: Component, width: number): RenderFrame {
	const lines = component.render(width);
	return { lines, images: getImagePlacements(lines) };
}

export function preserveImagePlacements(source: string[], target: string[]): string[] {
	return setImagePlacements(target, getImagePlacements(source));
}

export function sliceRenderLines(source: string[], start: number, end = source.length): string[] {
	const target = source.slice(start, end);
	const images = getImagePlacements(source)
		.filter(
			(image) => image.anchor >= start && image.anchor < end && image.top < end && image.top + image.rows > start,
		)
		.map((image) => {
			const visibleTop = Math.max(start, image.top);
			const visibleBottom = Math.min(end, image.top + image.rows);
			return {
				...image,
				top: visibleTop - start,
				anchor: image.anchor - start,
				rows: visibleBottom - visibleTop,
			};
		});
	return setImagePlacements(target, images);
}
