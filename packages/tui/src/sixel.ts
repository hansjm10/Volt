import { convertIndexedToRgb, type DecodedPng, decode } from "fast-png";

const SIXEL_MAX_COLORS = 256;
const SIXEL_ALPHA_THRESHOLD = 128;

/**
 * Conservative hard limits for Sixel work. These bounds apply before decode,
 * resize, quantization, and output construction so malformed images cannot
 * turn a terminal render into unbounded allocation or event-loop work.
 */
export const SIXEL_LIMITS = {
	maxPngSourceBytes: 8 * 1024 * 1024,
	maxDecodedDimension: 16_384,
	maxDecodedPixels: 16 * 1024 * 1024,
	maxTargetPixels: 1024 * 1024,
	maxTargetWidth: 4_096,
	maxTargetHeight: 2_048,
	maxEncodedBytes: 8 * 1024 * 1024,
} as const;

export interface RgbaRaster {
	width: number;
	height: number;
	data: Uint8Array;
}

export interface IndexedSixelRaster {
	width: number;
	height: number;
	colors: Array<readonly [number, number, number]>;
	indexes: Int16Array;
}

function checkedPixelCount(width: number, height: number, maxPixels: number): number | undefined {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
	if (width > Math.floor(maxPixels / height)) return undefined;
	return width * height;
}

export function isSixelPngSourceSizeAllowed(base64Length: number): boolean {
	if (!Number.isSafeInteger(base64Length) || base64Length < 0) return false;
	return base64Length <= Math.ceil(SIXEL_LIMITS.maxPngSourceBytes / 3) * 4;
}

export function isSixelTargetSizeAllowed(width: number, height: number): boolean {
	return (
		width <= SIXEL_LIMITS.maxTargetWidth &&
		height <= SIXEL_LIMITS.maxTargetHeight &&
		checkedPixelCount(width, height, SIXEL_LIMITS.maxTargetPixels) !== undefined
	);
}

function sampleToByte(value: number, depth: number): number {
	if (depth === 16) return Math.round(value / 257);
	if (depth === 8) return value;
	return Math.round((value * 255) / ((1 << depth) - 1));
}

function paletteRaster(decoded: DecodedPng): RgbaRaster {
	const palette = decoded.palette;
	if (!palette?.[0]) throw new Error("Indexed PNG has no palette entries");
	const channels = palette[0].length;
	if (channels !== 3 && channels !== 4) throw new Error("Indexed PNG palette must contain RGB or RGBA entries");
	const pixelCount = checkedPixelCount(decoded.width, decoded.height, SIXEL_LIMITS.maxDecodedPixels);
	if (pixelCount === undefined) throw new RangeError("PNG dimensions exceed Sixel decode limits");
	const source = convertIndexedToRgb(decoded);
	const data = new Uint8Array(pixelCount * 4);
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const sourceOffset = pixel * channels;
		const targetOffset = pixel * 4;
		data[targetOffset] = source[sourceOffset] ?? 0;
		data[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
		data[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
		data[targetOffset + 3] = channels === 4 ? (source[sourceOffset + 3] ?? 255) : 255;
	}
	return { width: decoded.width, height: decoded.height, data };
}

function directRaster(decoded: DecodedPng): RgbaRaster {
	const { width, height, channels, depth, transparency } = decoded;
	if (channels < 1 || channels > 4) throw new Error(`Unsupported PNG channel count: ${channels}`);
	const pixelCount = checkedPixelCount(width, height, SIXEL_LIMITS.maxDecodedPixels);
	if (pixelCount === undefined) throw new RangeError("PNG dimensions exceed Sixel decode limits");
	if (decoded.data.length !== pixelCount * channels) throw new Error("Unsupported packed PNG sample layout");
	const data = new Uint8Array(pixelCount * 4);

	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const sourceOffset = pixel * channels;
		const targetOffset = pixel * 4;
		const first = decoded.data[sourceOffset] ?? 0;
		const second = decoded.data[sourceOffset + 1] ?? 0;
		const third = decoded.data[sourceOffset + 2] ?? 0;
		let red: number;
		let green: number;
		let blue: number;
		let alpha = 255;

		if (channels === 1 || channels === 2) {
			red = green = blue = sampleToByte(first, depth);
			if (channels === 2) alpha = sampleToByte(second, depth);
			else if (transparency?.[0] === first) alpha = 0;
		} else {
			red = sampleToByte(first, depth);
			green = sampleToByte(second, depth);
			blue = sampleToByte(third, depth);
			if (channels === 4) alpha = sampleToByte(decoded.data[sourceOffset + 3] ?? 0, depth);
			else if (transparency?.[0] === first && transparency[1] === second && transparency[2] === third) alpha = 0;
		}

		data[targetOffset] = red;
		data[targetOffset + 1] = green;
		data[targetOffset + 2] = blue;
		data[targetOffset + 3] = alpha;
	}
	return { width, height, data };
}

function hasAllowedPngHeader(buffer: Buffer): boolean {
	if (buffer.length < 24 || buffer.length > SIXEL_LIMITS.maxPngSourceBytes) return false;
	if (
		buffer[0] !== 0x89 ||
		buffer[1] !== 0x50 ||
		buffer[2] !== 0x4e ||
		buffer[3] !== 0x47 ||
		buffer[4] !== 0x0d ||
		buffer[5] !== 0x0a ||
		buffer[6] !== 0x1a ||
		buffer[7] !== 0x0a ||
		buffer.readUInt32BE(8) !== 13 ||
		buffer.toString("ascii", 12, 16) !== "IHDR"
	) {
		return false;
	}
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	return (
		width <= SIXEL_LIMITS.maxDecodedDimension &&
		height <= SIXEL_LIMITS.maxDecodedDimension &&
		checkedPixelCount(width, height, SIXEL_LIMITS.maxDecodedPixels) !== undefined
	);
}

export function decodePngRaster(base64Data: string): RgbaRaster | null {
	try {
		if (!isSixelPngSourceSizeAllowed(base64Data.length)) return null;
		const buffer = Buffer.from(base64Data, "base64");
		if (!hasAllowedPngHeader(buffer)) return null;
		const decoded = decode(buffer);
		if (decoded.width <= 0 || decoded.height <= 0) return null;
		return decoded.palette ? paletteRaster(decoded) : directRaster(decoded);
	} catch {
		return null;
	}
}

function validateRgbaRaster(raster: RgbaRaster, maxPixels: number): number {
	const pixelCount = checkedPixelCount(raster.width, raster.height, maxPixels);
	if (pixelCount === undefined || raster.data.byteLength !== pixelCount * 4) {
		throw new RangeError("RGBA raster exceeds Sixel limits or has an invalid data length");
	}
	return pixelCount;
}

export function resizeRgbaRaster(source: RgbaRaster, width: number, height: number): RgbaRaster {
	validateRgbaRaster(source, SIXEL_LIMITS.maxDecodedPixels);
	const targetWidth = Math.max(1, Math.floor(width));
	const targetHeight = Math.max(1, Math.floor(height));
	if (!isSixelTargetSizeAllowed(targetWidth, targetHeight)) throw new RangeError("Target raster exceeds Sixel limits");
	if (targetWidth === source.width && targetHeight === source.height) return source;

	const data = new Uint8Array(targetWidth * targetHeight * 4);
	for (let y = 0; y < targetHeight; y++) {
		const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / targetHeight));
		for (let x = 0; x < targetWidth; x++) {
			const sourceX = Math.min(source.width - 1, Math.floor((x * source.width) / targetWidth));
			const sourceOffset = (sourceY * source.width + sourceX) * 4;
			const targetOffset = (y * targetWidth + x) * 4;
			data[targetOffset] = source.data[sourceOffset] ?? 0;
			data[targetOffset + 1] = source.data[sourceOffset + 1] ?? 0;
			data[targetOffset + 2] = source.data[sourceOffset + 2] ?? 0;
			data[targetOffset + 3] = source.data[sourceOffset + 3] ?? 255;
		}
	}
	return { width: targetWidth, height: targetHeight, data };
}

interface HistogramColor {
	value: number;
	red: number;
	green: number;
	blue: number;
	count: number;
}

interface ColorBox {
	colors: HistogramColor[];
	population: number;
	redRange: number;
	greenRange: number;
	blueRange: number;
}

function createColorBox(colors: HistogramColor[]): ColorBox {
	let population = 0;
	let minRed = 255;
	let maxRed = 0;
	let minGreen = 255;
	let maxGreen = 0;
	let minBlue = 255;
	let maxBlue = 0;
	for (const color of colors) {
		population += color.count;
		minRed = Math.min(minRed, color.red);
		maxRed = Math.max(maxRed, color.red);
		minGreen = Math.min(minGreen, color.green);
		maxGreen = Math.max(maxGreen, color.green);
		minBlue = Math.min(minBlue, color.blue);
		maxBlue = Math.max(maxBlue, color.blue);
	}
	return {
		colors,
		population,
		redRange: maxRed - minRed,
		greenRange: maxGreen - minGreen,
		blueRange: maxBlue - minBlue,
	};
}

function splitColorBox(box: ColorBox): [ColorBox, ColorBox] | null {
	if (box.colors.length < 2) return null;
	const channel =
		box.greenRange > box.redRange && box.greenRange >= box.blueRange
			? "green"
			: box.blueRange > box.redRange && box.blueRange > box.greenRange
				? "blue"
				: "red";
	const colors = [...box.colors].sort((left, right) => left[channel] - right[channel] || left.value - right.value);
	const targetPopulation = box.population / 2;
	let cumulativePopulation = 0;
	let splitIndex = 1;
	for (let index = 0; index < colors.length - 1; index++) {
		cumulativePopulation += colors[index]!.count;
		splitIndex = index + 1;
		if (cumulativePopulation >= targetPopulation) break;
	}
	return [createColorBox(colors.slice(0, splitIndex)), createColorBox(colors.slice(splitIndex))];
}

function representativeColor(box: ColorBox): readonly [number, number, number] {
	let red = 0;
	let green = 0;
	let blue = 0;
	for (const color of box.colors) {
		red += color.red * color.count;
		green += color.green * color.count;
		blue += color.blue * color.count;
	}
	return [Math.round(red / box.population), Math.round(green / box.population), Math.round(blue / box.population)];
}

function nearestPaletteIndex(color: HistogramColor, palette: Array<readonly [number, number, number]>): number {
	let bestIndex = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < palette.length; index++) {
		const candidate = palette[index]!;
		const redDistance = color.red - candidate[0];
		const greenDistance = color.green - candidate[1];
		const blueDistance = color.blue - candidate[2];
		const distance = redDistance * redDistance + greenDistance * greenDistance + blueDistance * blueDistance;
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = index;
		}
	}
	return bestIndex;
}

export function prepareSixelRaster(raster: RgbaRaster): IndexedSixelRaster {
	const pixelCount = validateRgbaRaster(raster, SIXEL_LIMITS.maxTargetPixels);
	if (!isSixelTargetSizeAllowed(raster.width, raster.height))
		throw new RangeError("Target raster exceeds Sixel limits");
	const histogram = new Map<number, number>();
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const offset = pixel * 4;
		if ((raster.data[offset + 3] ?? 255) < SIXEL_ALPHA_THRESHOLD) continue;
		const value =
			((raster.data[offset] ?? 0) << 16) | ((raster.data[offset + 1] ?? 0) << 8) | (raster.data[offset + 2] ?? 0);
		histogram.set(value, (histogram.get(value) ?? 0) + 1);
	}

	const histogramColors = [...histogram.entries()]
		.map(
			([value, count]): HistogramColor => ({
				value,
				red: (value >> 16) & 0xff,
				green: (value >> 8) & 0xff,
				blue: value & 0xff,
				count,
			}),
		)
		.sort((left, right) => left.value - right.value);

	let colors: Array<readonly [number, number, number]>;
	if (histogramColors.length <= SIXEL_MAX_COLORS) {
		colors = histogramColors.map((color) => [color.red, color.green, color.blue]);
	} else {
		const boxes = [createColorBox(histogramColors)];
		while (boxes.length < SIXEL_MAX_COLORS) {
			let splitIndex = -1;
			let splitScore = -1;
			for (let index = 0; index < boxes.length; index++) {
				const box = boxes[index]!;
				if (box.colors.length < 2) continue;
				const score = Math.max(box.redRange, box.greenRange, box.blueRange) * box.population;
				if (score > splitScore) {
					splitIndex = index;
					splitScore = score;
				}
			}
			if (splitIndex === -1) break;
			const split = splitColorBox(boxes[splitIndex]!);
			if (!split) break;
			boxes.splice(splitIndex, 1, ...split);
		}
		colors = boxes.map(representativeColor);
	}

	const colorIndexes = new Map<number, number>();
	for (let index = 0; index < histogramColors.length; index++) {
		const color = histogramColors[index]!;
		colorIndexes.set(
			color.value,
			histogramColors.length <= SIXEL_MAX_COLORS ? index : nearestPaletteIndex(color, colors),
		);
	}

	const indexes = new Int16Array(pixelCount);
	indexes.fill(-1);
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const offset = pixel * 4;
		if ((raster.data[offset + 3] ?? 255) < SIXEL_ALPHA_THRESHOLD) continue;
		const value =
			((raster.data[offset] ?? 0) << 16) | ((raster.data[offset + 1] ?? 0) << 8) | (raster.data[offset + 2] ?? 0);
		indexes[pixel] = colorIndexes.get(value) ?? -1;
	}
	return { width: raster.width, height: raster.height, colors, indexes };
}

function colorPercentage(value: number): number {
	return Math.round((value * 100) / 255);
}

function encodeRun(character: string, count: number): string {
	return count >= 4 ? `!${count}${character}` : character.repeat(count);
}

function encodeSixelRow(values: ArrayLike<number>): string {
	let end = values.length;
	while (end > 0 && values[end - 1] === 0) end--;
	if (end === 0) return "?";
	let result = "";
	let current = String.fromCharCode(63 + (values[0] ?? 0));
	let count = 1;
	for (let index = 1; index < end; index++) {
		const character = String.fromCharCode(63 + (values[index] ?? 0));
		if (character === current) {
			count++;
			continue;
		}
		result += encodeRun(current, count);
		current = character;
		count = 1;
	}
	return result + encodeRun(current, count);
}

export function encodePreparedSixelRange(
	prepared: IndexedSixelRaster,
	top = 0,
	height = prepared.height,
	maxOutputBytes = SIXEL_LIMITS.maxEncodedBytes,
): string {
	const pixelCount = checkedPixelCount(prepared.width, prepared.height, SIXEL_LIMITS.maxTargetPixels);
	if (
		pixelCount === undefined ||
		prepared.height > SIXEL_LIMITS.maxTargetHeight ||
		prepared.indexes.length !== pixelCount ||
		prepared.colors.length > SIXEL_MAX_COLORS
	) {
		throw new RangeError("Prepared Sixel raster exceeds limits");
	}
	const safeTop = Math.floor(top);
	const safeHeight = Math.floor(height);
	if (safeTop < 0 || safeHeight <= 0 || safeTop + safeHeight > prepared.height) {
		throw new RangeError("Invalid Sixel row range");
	}
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError("Invalid Sixel output limit");

	let outputLength = 0;
	const chunks: string[] = [];
	const append = (value: string): void => {
		outputLength += value.length;
		if (outputLength > maxOutputBytes) throw new RangeError("Encoded Sixel output exceeds limit");
		chunks.push(value);
	};

	const usedColors = new Set<number>();
	for (let y = safeTop; y < safeTop + safeHeight; y++) {
		const rowOffset = y * prepared.width;
		for (let x = 0; x < prepared.width; x++) {
			const color = prepared.indexes[rowOffset + x] ?? -1;
			if (color >= 0) usedColors.add(color);
		}
	}
	const colors = [...usedColors].sort((left, right) => left - right);
	append(`\x1b7\x1bP0;1;0q"1;1;${prepared.width};${safeHeight}`);
	for (const color of colors) {
		const paletteColor = prepared.colors[color];
		if (!paletteColor) throw new RangeError("Prepared Sixel palette index is invalid");
		append(
			`#${color};2;${colorPercentage(paletteColor[0])};${colorPercentage(paletteColor[1])};${colorPercentage(paletteColor[2])}`,
		);
	}

	const bandCount = Math.ceil(safeHeight / 6);
	for (let band = 0; band < bandCount; band++) {
		const bandRows = new Map<number, Uint8Array>();
		for (let bit = 0; bit < 6; bit++) {
			const relativeY = band * 6 + bit;
			if (relativeY >= safeHeight) break;
			const rowOffset = (safeTop + relativeY) * prepared.width;
			for (let x = 0; x < prepared.width; x++) {
				const color = prepared.indexes[rowOffset + x] ?? -1;
				if (color < 0) continue;
				let values = bandRows.get(color);
				if (!values) {
					values = new Uint8Array(prepared.width);
					bandRows.set(color, values);
				}
				values[x] = (values[x] ?? 0) | (1 << bit);
			}
		}

		const bandColors = [...bandRows.keys()].sort((left, right) => left - right);
		if (bandColors.length === 0) {
			append("?");
		} else {
			for (let index = 0; index < bandColors.length; index++) {
				if (index > 0) append("$");
				const color = bandColors[index]!;
				append(`#${color}${encodeSixelRow(bandRows.get(color)!)}`);
			}
		}
		if (band < bandCount - 1) append("-");
	}
	append("\x1b\\\x1b8");
	return chunks.join("");
}

export function encodeSixelRaster(raster: RgbaRaster, maxOutputBytes = SIXEL_LIMITS.maxEncodedBytes): string {
	return encodePreparedSixelRange(prepareSixelRaster(raster), 0, raster.height, maxOutputBytes);
}
