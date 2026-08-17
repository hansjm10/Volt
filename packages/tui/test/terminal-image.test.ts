/**
 * Tests for terminal image detection and line handling
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { encode } from "fast-png";
import { Image } from "../src/components/image.ts";
import {
	decodePngRaster,
	encodeSixelRaster,
	isSixelPngSourceSizeAllowed,
	isSixelTargetSizeAllowed,
	SIXEL_LIMITS,
} from "../src/sixel.ts";
import {
	applyDeviceAttributes,
	clearSixelImages,
	cropImageLine,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeKitty,
	getCapabilities,
	getImageMetadata,
	getSixelRegistryStats,
	hyperlink,
	isImageLine,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";

function lineAt(lines: string[], index: number): string {
	const line = lines[index];
	assert.notStrictEqual(line, undefined, `Expected rendered line at index ${index}`);
	return line ?? "";
}

function pngBase64(width: number, height: number, data: Uint8Array): string {
	return Buffer.from(encode({ width, height, channels: 4, depth: 8, data })).toString("base64");
}

function solidRgba(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8Array {
	const data = new Uint8Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) data.set(rgba, pixel * 4);
	return data;
}

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"CMUX_WORKSPACE_ID",
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("Sixel support", () => {
	it("enables Sixel only after Windows Terminal reports DA1 attribute 4", () => {
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			resetCapabilitiesCache();
			assert.strictEqual(getCapabilities().images, null);
			assert.strictEqual(applyDeviceAttributes([62, 52]), false);
			assert.strictEqual(getCapabilities().images, null);
			assert.strictEqual(applyDeviceAttributes([62, 4, 52]), true);
			assert.strictEqual(getCapabilities().images, "sixel");
			resetCapabilitiesCache();
		});
	});

	it("enables Sixel on Windows consoles without WT_SESSION after DA1 confirmation", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platformDescriptor);
		withEnv({ TERM: "xterm-256color" }, () => {
			try {
				Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
				resetCapabilitiesCache();
				assert.strictEqual(getCapabilities().images, null);
				assert.strictEqual(applyDeviceAttributes([62, 4, 52]), true);
				assert.strictEqual(getCapabilities().images, "sixel");
			} finally {
				resetCapabilitiesCache();
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		});
	});

	it("keeps Sixel disabled inside terminal multiplexers", () => {
		withEnv({ WT_SESSION: "session", TMUX: "session", TERM: "tmux-256color" }, () => {
			resetCapabilitiesCache();
			assert.strictEqual(applyDeviceAttributes([4]), false);
			assert.strictEqual(getCapabilities().images, null);
			resetCapabilitiesCache();
		});
	});

	it("encodes deterministic framed Sixel with transparency and run-length compression", () => {
		const opaqueRed = { width: 6, height: 1, data: solidRgba(6, 1, [255, 0, 0, 255]) };
		const encoded = encodeSixelRaster(opaqueRed);
		assert.strictEqual(encoded, encodeSixelRaster(opaqueRed));
		assert.ok(encoded.startsWith('\x1b7\x1bP0;1;0q"1;1;6;1'));
		assert.ok(encoded.includes("#0;2;100;0;0"));
		assert.ok(encoded.includes("#0!6@"));
		assert.ok(encoded.endsWith("\x1b\\\x1b8"));

		const transparent = encodeSixelRaster({ width: 6, height: 1, data: solidRgba(6, 1, [0, 255, 0, 0]) });
		assert.ok(transparent.includes('"1;1;6;1?'));
		assert.ok(!transparent.includes(";100;0"));
	});

	it("preserves exact source colors and caps adaptive palettes at 256 entries", () => {
		const exactColor = encodeSixelRaster({
			width: 1,
			height: 1,
			data: Uint8Array.of(85, 42, 170, 255),
		});
		assert.ok(exactColor.includes("#0;2;33;16;67"));

		const data = new Uint8Array(300 * 4);
		for (let pixel = 0; pixel < 300; pixel++) {
			data.set([pixel % 256, Math.floor(pixel / 256) * 127, (pixel * 53) % 256, 255], pixel * 4);
		}
		const manyColors = encodeSixelRaster({ width: 300, height: 1, data });
		const paletteIndexes = [...manyColors.matchAll(/#(\d+);2;/g)].map((match) => Number.parseInt(match[1]!, 10));
		assert.ok(paletteIndexes.length > 64);
		assert.ok(paletteIndexes.length <= 256);
		assert.ok(paletteIndexes.every((index) => index >= 0 && index < 256));
	});

	it("sizes PNGs to terminal cells and reserves the rendered rows", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const data = pngBase64(2, 2, solidRgba(2, 2, [255, 0, 0, 255]));
			const result = renderImage(data, { widthPx: 2, heightPx: 2 }, { maxWidthCells: 4, maxHeightCells: 2 });
			assert.ok(result);
			assert.strictEqual(result.columns, 2);
			assert.strictEqual(result.rows, 2);
			assert.ok(result.sequence.includes('"1;1;20;20'));
			assert.deepStrictEqual(getImageMetadata(result.sequence), {
				imageId: result.imageId,
				columns: 2,
				rows: 2,
				sourceY: 0,
				sourceHeight: 20,
			});

			const image = new Image(
				data,
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 4, maxHeightCells: 2 },
				{ widthPx: 2, heightPx: 2 },
			);
			const lines = image.render(10);
			assert.strictEqual(lines.length, 2);
			assert.ok(lineAt(lines, 0).includes("\x1bP0;1;0q"));
			assert.strictEqual(lineAt(lines, 1), "");
			assert.strictEqual(image.render(10), lines, "same-width renders should reuse the cached control stream");
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("rebuilds same-width Image output after Sixel preparation is cleared", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 1, heightPx: 1 });
		try {
			const image = new Image(
				pngBase64(2, 4, solidRgba(2, 4, [0, 0, 255, 255])),
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2, maxHeightCells: 4 },
				{ widthPx: 2, heightPx: 4 },
			);
			const first = image.render(10);
			assert.strictEqual(getSixelRegistryStats().images, 1);
			clearSixelImages();
			assert.strictEqual(getSixelRegistryStats().images, 0);

			const second = image.render(10);
			assert.notStrictEqual(second, first, "cleared preparation must invalidate the cached lines");
			assert.strictEqual(getSixelRegistryStats().images, 1);
			assert.ok(lineAt(second, 0).includes("\x1bP0;1;0q"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("re-encodes a vertically cropped Sixel raster", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 1, heightPx: 4 });
		try {
			const data = pngBase64(2, 12, solidRgba(2, 12, [0, 0, 255, 255]));
			const result = renderImage(data, { widthPx: 2, heightPx: 12 }, { maxWidthCells: 2 });
			assert.ok(result);
			assert.strictEqual(result.rows, 3);
			const cropped = cropImageLine(result.sequence, 1, 1);
			assert.deepStrictEqual(getImageMetadata(cropped), {
				imageId: result.imageId,
				columns: 2,
				rows: 1,
				sourceY: 4,
				sourceHeight: 4,
			});
			assert.ok(cropped.includes('"1;1;2;4'));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("bounds source, decoded, target, and encoded Sixel work without large allocations", () => {
		assert.strictEqual(isSixelPngSourceSizeAllowed(Math.ceil(SIXEL_LIMITS.maxPngSourceBytes / 3) * 4), true);
		assert.strictEqual(isSixelPngSourceSizeAllowed(Math.ceil(SIXEL_LIMITS.maxPngSourceBytes / 3) * 4 + 1), false);
		assert.strictEqual(isSixelTargetSizeAllowed(SIXEL_LIMITS.maxTargetWidth, 1), true);
		assert.strictEqual(isSixelTargetSizeAllowed(SIXEL_LIMITS.maxTargetWidth + 1, 1), false);
		assert.strictEqual(
			isSixelTargetSizeAllowed(
				SIXEL_LIMITS.maxTargetWidth,
				Math.floor(SIXEL_LIMITS.maxTargetPixels / SIXEL_LIMITS.maxTargetWidth) + 1,
			),
			false,
		);
		assert.strictEqual(isSixelTargetSizeAllowed(1, SIXEL_LIMITS.maxTargetHeight + 1), false);

		const oversizedHeader = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedHeader);
		oversizedHeader.writeUInt32BE(13, 8);
		oversizedHeader.write("IHDR", 12, "ascii");
		oversizedHeader.writeUInt32BE(SIXEL_LIMITS.maxDecodedDimension + 1, 16);
		oversizedHeader.writeUInt32BE(1, 20);
		assert.strictEqual(decodePngRaster(oversizedHeader.toString("base64")), null);
		const pixelOverflowSide = Math.floor(Math.sqrt(SIXEL_LIMITS.maxDecodedPixels)) + 1;
		oversizedHeader.writeUInt32BE(pixelOverflowSide, 16);
		oversizedHeader.writeUInt32BE(pixelOverflowSide, 20);
		assert.strictEqual(decodePngRaster(oversizedHeader.toString("base64")), null);

		const small = { width: 1, height: 1, data: Uint8Array.of(255, 0, 0, 255) };
		const encoded = encodeSixelRaster(small);
		assert.strictEqual(encodeSixelRaster(small, encoded.length), encoded);
		assert.throws(() => encodeSixelRaster(small, encoded.length - 1), /output exceeds limit/);
	});

	it("reuses bounded prepared crop streams instead of requantizing identical ranges", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 1, heightPx: 1 });
		try {
			const result = renderImage(
				pngBase64(2, 3, solidRgba(2, 3, [40, 80, 120, 255])),
				{ widthPx: 2, heightPx: 3 },
				{ maxWidthCells: 2 },
			);
			assert.ok(result);
			const first = cropImageLine(result.sequence, 1, 1);
			const afterFirst = getSixelRegistryStats();
			const second = cropImageLine(result.sequence, 1, 1);
			assert.strictEqual(second, first);
			assert.deepStrictEqual(getSixelRegistryStats(), afterFirst);
			assert.strictEqual(afterFirst.cropStreams, 1);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("releases image resources and evicts registry and crop caches at hard count bounds", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 1, heightPx: 1 });
		try {
			const data = pngBase64(1, 2, solidRgba(1, 2, [100, 120, 140, 255]));
			const image = new Image(
				data,
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 1 },
				{ widthPx: 1, heightPx: 2 },
			);
			image.render(3);
			assert.strictEqual(getSixelRegistryStats().images, 1);
			image.dispose();
			assert.strictEqual(getSixelRegistryStats().images, 0);

			let oldestSequence = "";
			let newestSequence = "";
			for (let imageId = 1; imageId <= 65; imageId++) {
				const result = renderImage(data, { widthPx: 1, heightPx: 2 }, { maxWidthCells: 1, imageId });
				assert.ok(result);
				if (imageId === 1) oldestSequence = result.sequence;
				if (imageId === 65) newestSequence = result.sequence;
			}
			assert.strictEqual(getSixelRegistryStats().images, 64);
			assert.ok(!cropImageLine(oldestSequence, 1, 1).includes("\x1bP0;1;0q"));
			assert.ok(cropImageLine(newestSequence, 1, 1).includes("\x1bP0;1;0q"));

			const tall = renderImage(
				pngBase64(1, 130, solidRgba(1, 130, [20, 40, 60, 255])),
				{ widthPx: 1, heightPx: 130 },
				{ maxWidthCells: 1, imageId: 1000 },
			);
			assert.ok(tall);
			for (let row = 0; row < 129; row++) cropImageLine(tall.sequence, row, 1);
			assert.ok(getSixelRegistryStats().cropStreams <= 128);
			assert.ok(getSixelRegistryStats().cropStreamBytes <= 8 * 1024 * 1024);
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			assert.deepStrictEqual(getSixelRegistryStats(), {
				images: 0,
				preparedBytes: 0,
				cropStreams: 0,
				cropStreamBytes: 0,
			});
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back safely for malformed PNG data", () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			assert.strictEqual(renderImage("not-a-png", { widthPx: 10, heightPx: 10 }), null);
			const image = new Image(
				"not-a-png",
				"image/png",
				{ fallbackColor: (value) => `fallback:${value}` },
				{ filename: "broken.png" },
				{ widthPx: 10, heightPx: 10 },
			);
			assert.deepStrictEqual(image.render(20), ["fallback:[Image: broken.png [image/png] 10x10]"]);
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	describe("Sixel image protocol", () => {
		it("should detect a cursor-preserving Sixel sequence", () => {
			assert.strictEqual(isImageLine('\x1b7\x1bP0;1;0q"1;1;1;1?\x1b\\\x1b8'), true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			assert.strictEqual(longLine.length > 300000, true);
			assert.strictEqual(isImageLine(longLine), true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			assert.strictEqual(isImageLine(plainText), false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			assert.strictEqual(isImageLine(ansiText), false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in empty lines", () => {
			assert.strictEqual(isImageLine(""), false);
		});

		it("should not detect images in lines with newlines only", () => {
			assert.strictEqual(isImageLine("\n"), false);
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			assert.strictEqual(isImageLine(complexLine), true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks under tmux when the client forwards them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("disables hyperlinks under tmux when the client does not forward them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => false);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("checks tmux capability when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities(() => true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);

			const caps2 = detectCapabilities(() => false);
			assert.strictEqual(caps2.hyperlinks, false);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("does not disable Ghostty images solely because cmux is present", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables truecolor and hyperlinks for Windows Terminal outside multiplexers", () => {
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables truecolor without hyperlinks for JetBrains terminal", () => {
		withEnv({ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("does not inherit Windows Terminal truecolor through tmux", () => {
		withEnv({ WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			assert.strictEqual(caps.trueColor, false);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("trusts explicit truecolor hints through tmux", () => {
		withEnv({ COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
	});

	it("suppresses Kitty replies for delete commands", () => {
		assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			assert.ok(result);
			assert.ok(!result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("can opt renderImage into no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			assert.ok(result);
			assert.ok(result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("honors maxHeightCells by reducing rendered width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 10, heightPx: 100 }, { maxWidthCells: 10, maxHeightCells: 5 });
			assert.ok(result);
			assert.strictEqual(result.rows, 5);
			assert.ok(result.sequence.includes(",c=1,r=5"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("caps Image component height to a square pixel box by default", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 10 },
				{ widthPx: 10, heightPx: 100 },
			);
			const lines = image.render(12);
			assert.strictEqual(lines.length, 5);
			assert.ok(lineAt(lines, 0).includes(",c=1,r=5"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("places image sequence on first line with empty padding rows", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			const imageId = image.getImageId();
			assert.strictEqual(typeof imageId, "number");
			const imageLine = lineAt(lines, 0);
			assert.ok(imageLine.startsWith("\x1b_G"));
			assert.ok(imageLine.includes(",C=1,"));
			assert.ok(imageLine.includes(`,i=${imageId}`));
			assert.ok(imageLine.endsWith("\x1b\\"));
			assert.deepStrictEqual(lines.slice(1, lines.length), [""]);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(result.includes(styled));
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		assert.ok(result.includes("file:///home/user/README.md"));
		assert.ok(result.includes("README.md"));
	});
});
