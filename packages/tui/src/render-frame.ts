import { cropImageLine } from "./terminal-image.ts";
import { visibleWidth } from "./utils.ts";

export interface ImagePlacement {
	/** First row occupied by the image, relative to the rendered lines. */
	readonly top: number;
	/** Row containing the terminal image sequence, relative to the rendered lines. */
	readonly anchor: number;
	/** First occupied terminal column. */
	readonly left: number;
	readonly columns: number;
	readonly rows: number;
	readonly protocol: "kitty" | "iterm2" | "sixel";
	readonly imageId?: number;
	/** Image-only terminal sequence used when layout must relocate or crop the placement. */
	readonly sequence: string;
	/** Whether sequence is an exact substring of the anchor line. */
	readonly exactSequence: boolean;
}

/** Complete component render output. Image placements are always explicit. */
export interface RenderFrame {
	readonly lines: readonly string[];
	readonly images: readonly ImagePlacement[];
}

export function createRenderFrame(lines: readonly string[], images: readonly ImagePlacement[] = []): RenderFrame {
	return { lines, images };
}

export function translateRenderFrame(frame: RenderFrame, rows: number, columns: number): RenderFrame {
	if (rows === 0 && columns === 0) return frame;
	return createRenderFrame(
		frame.lines,
		frame.images.map((image) => ({
			...image,
			top: image.top + rows,
			anchor: image.anchor + rows,
			left: image.left + columns,
		})),
	);
}

/** Concatenate frames vertically and translate every image by its output row. */
export function concatRenderFrames(frames: readonly RenderFrame[], gap = 0): RenderFrame {
	const safeGap = Math.max(0, Math.floor(gap));
	const lines: string[] = [];
	const images: ImagePlacement[] = [];
	for (const [index, frame] of frames.entries()) {
		if (index > 0) {
			for (let row = 0; row < safeGap; row++) lines.push("");
		}
		const top = lines.length;
		lines.push(...frame.lines);
		for (const image of frame.images) {
			images.push({ ...image, top: image.top + top, anchor: image.anchor + top });
		}
	}
	return createRenderFrame(lines, images);
}

/**
 * Slice frame rows and retain placements whose anchor and occupied rows remain visible.
 * Callers that can cut through an image should first choose an image-safe boundary.
 */
export function sliceRenderFrame(frame: RenderFrame, start: number, end = frame.lines.length): RenderFrame {
	const safeStart = Math.max(0, Math.min(frame.lines.length, Math.floor(start)));
	const safeEnd = Math.max(safeStart, Math.min(frame.lines.length, Math.floor(end)));
	const lines = frame.lines.slice(safeStart, safeEnd);
	const images: ImagePlacement[] = [];
	for (const image of frame.images) {
		const visibleTop = Math.max(safeStart, image.top);
		const visibleBottom = Math.min(safeEnd, image.top + image.rows);
		if (visibleBottom <= visibleTop || image.anchor < safeStart || image.anchor >= safeEnd) continue;

		const hiddenRows = visibleTop - image.top;
		const visibleRows = visibleBottom - visibleTop;
		const partial = hiddenRows > 0 || visibleRows < image.rows;
		const anchor = image.anchor - safeStart;
		if (partial && image.protocol === "iterm2") {
			if (image.exactSequence) lines[anchor] = lines[anchor]?.replace(image.sequence, "") ?? "";
			continue;
		}

		const sequence = partial ? cropImageLine(image.sequence, hiddenRows, visibleRows) : image.sequence;
		if (image.exactSequence && sequence !== image.sequence) {
			lines[anchor] = lines[anchor]?.replace(image.sequence, sequence) ?? sequence;
		}
		images.push({
			...image,
			top: visibleTop - safeStart,
			anchor,
			rows: visibleRows,
			sequence,
		});
	}
	return createRenderFrame(lines, images);
}

/** Insert or replace complete rows while translating placements below an image-safe edit boundary. */
export function spliceRenderFrameRows(
	frame: RenderFrame,
	start: number,
	deleteCount: number,
	insert: RenderFrame = createRenderFrame([]),
): RenderFrame {
	const safeStart = Math.max(0, Math.min(frame.lines.length, Math.floor(start)));
	const safeDeleteCount = Math.max(0, Math.min(frame.lines.length - safeStart, Math.floor(deleteCount)));
	const deleteEnd = safeStart + safeDeleteCount;
	const delta = insert.lines.length - safeDeleteCount;
	const images: ImagePlacement[] = insert.images.map((image) => ({
		...image,
		top: image.top + safeStart,
		anchor: image.anchor + safeStart,
	}));

	for (const image of frame.images) {
		const imageEnd = image.top + image.rows;
		if (safeDeleteCount === 0 && safeStart > image.top && safeStart < imageEnd) {
			throw new Error(`Render-frame row insertion splits an image at row ${safeStart}`);
		}
		const intersectsDeletion = safeDeleteCount > 0 && image.top < deleteEnd && imageEnd > safeStart;
		if (intersectsDeletion) {
			if (safeStart <= image.top && deleteEnd >= imageEnd) continue;
			throw new Error(`Render-frame row deletion splits an image at rows ${safeStart}-${deleteEnd}`);
		}
		images.push(
			image.top >= deleteEnd ? { ...image, top: image.top + delta, anchor: image.anchor + delta } : { ...image },
		);
	}

	images.sort((left, right) => left.top - right.top || left.anchor - right.anchor || left.left - right.left);
	return createRenderFrame(
		[...frame.lines.slice(0, safeStart), ...insert.lines, ...frame.lines.slice(deleteEnd)],
		images,
	);
}

/** Replace line text without changing row count or image positions. */
export function mapRenderFrameLines(frame: RenderFrame, mapLine: (line: string, row: number) => string): RenderFrame {
	const lines = frame.lines.map(mapLine);
	for (const image of frame.images) {
		if (image.exactSequence && !lines[image.anchor]?.includes(image.sequence)) {
			throw new Error(`Render-frame line transform removed an image sequence at row ${image.anchor}`);
		}
	}
	return createRenderFrame(
		lines,
		frame.images.map((image) => ({ ...image })),
	);
}

/** Prefix every row and translate image columns by the prefix's visible width. */
export function prefixRenderFrame(frame: RenderFrame, prefix: string): RenderFrame {
	if (!prefix) return frame;
	return createRenderFrame(
		frame.lines.map((line) => `${prefix}${line}`),
		frame.images.map((image) => ({ ...image, left: image.left + visibleWidth(prefix) })),
	);
}

/** Add blank rows around a frame and translate placements by the top padding. */
export function padRenderFrameRows(frame: RenderFrame, top: number, bottom: number): RenderFrame {
	const safeTop = Math.max(0, Math.floor(top));
	const safeBottom = Math.max(0, Math.floor(bottom));
	return concatRenderFrames([
		createRenderFrame(Array.from({ length: safeTop }, () => "")),
		frame,
		createRenderFrame(Array.from({ length: safeBottom }, () => "")),
	]);
}
