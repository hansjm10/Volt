import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { Text } from "../src/components/text.ts";
import {
	concatRenderFrames,
	createRenderFrame,
	mapRenderFrameLines,
	padRenderFrameRows,
	prefixRenderFrame,
	type RenderFrame,
	sliceRenderFrame,
	spliceRenderFrameRows,
	translateRenderFrame,
} from "../src/render-frame.ts";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image.ts";

const sequence = "\x1b[2A\x1b]1337;File=inline=1:AAAA\x07";
const imageFrame = createRenderFrame(
	["", "", sequence],
	[
		{
			top: 0,
			anchor: 2,
			left: 0,
			columns: 4,
			rows: 3,
			protocol: "iterm2",
			sequence,
			exactSequence: true,
		},
	],
);

function expectITermPlacement(
	frame: RenderFrame,
	expected: { top: number; anchor: number; left: number; rows: number },
): void {
	const placement = frame.images.find((image) => image.protocol === "iterm2");
	assert.ok(placement);
	assert.deepStrictEqual(
		{ top: placement.top, anchor: placement.anchor, left: placement.left, rows: placement.rows },
		expected,
	);
	assert.ok(frame.lines[placement.anchor]?.includes("\x1b]1337;File="));
}

describe("render-frame composition", () => {
	it("composes real iTerm2 Image output through stacks and frame transforms", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2, maxHeightCells: 3 },
				{ widthPx: 20, heightPx: 30 },
			);
			const horizontal = new HStack([
				{ component: image, basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]).render(12);
			expectITermPlacement(horizontal, { top: 0, anchor: 2, left: 0, rows: 3 });

			const vertical = concatRenderFrames([createRenderFrame(["header"]), horizontal]);
			expectITermPlacement(vertical, { top: 1, anchor: 3, left: 0, rows: 3 });
			const prefixed = prefixRenderFrame(vertical, "│ ");
			expectITermPlacement(prefixed, { top: 1, anchor: 3, left: 2, rows: 3 });
			const spliced = spliceRenderFrameRows(prefixed, 1, 0, createRenderFrame(["inserted"]));
			expectITermPlacement(spliced, { top: 2, anchor: 4, left: 2, rows: 3 });
			const sliced = sliceRenderFrame(spliced, 1, 5);
			expectITermPlacement(sliced, { top: 1, anchor: 3, left: 2, rows: 3 });
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("translates placements through vertical, horizontal, slice, splice, and padding transforms", () => {
		const stacked = concatRenderFrames([createRenderFrame(["header"]), imageFrame, createRenderFrame(["tail"])]);
		assert.deepStrictEqual(
			stacked.images.map(({ top, anchor, left, rows }) => ({ top, anchor, left, rows })),
			[{ top: 1, anchor: 3, left: 0, rows: 3 }],
		);

		const prefixed = prefixRenderFrame(stacked, "│ ");
		assert.strictEqual(prefixed.images[0]?.left, 2);
		assert.ok(prefixed.lines[3]?.includes(sequence));

		const sliced = sliceRenderFrame(stacked, 1, 4);
		assert.deepStrictEqual(
			sliced.images.map(({ top, anchor, rows }) => ({ top, anchor, rows })),
			[{ top: 0, anchor: 2, rows: 3 }],
		);
		const partialITerm = sliceRenderFrame(imageFrame, 1);
		assert.deepStrictEqual(partialITerm.images, []);
		assert.ok(partialITerm.lines.every((line) => !line.includes("\x1b]1337;File=")));

		const spliced = spliceRenderFrameRows(stacked, 1, 0, createRenderFrame(["inserted"]));
		assert.deepStrictEqual(
			spliced.images.map(({ top, anchor }) => ({ top, anchor })),
			[{ top: 2, anchor: 4 }],
		);

		const padded = padRenderFrameRows(imageFrame, 2, 1);
		assert.deepStrictEqual(
			padded.images.map(({ top, anchor }) => ({ top, anchor })),
			[{ top: 2, anchor: 4 }],
		);

		const translated = translateRenderFrame(imageFrame, 3, 5);
		assert.deepStrictEqual(
			translated.images.map(({ top, anchor, left }) => ({ top, anchor, left })),
			[{ top: 3, anchor: 5, left: 5 }],
		);
	});

	it("invalidates Box caches when placement metadata changes without line changes", () => {
		let childFrame = imageFrame;
		const box = new Box(1, 0);
		box.addChild({
			render: () => childFrame,
			invalidate: () => {},
		});
		assert.strictEqual(box.render(20).images[0]?.left, 1);
		childFrame = translateRenderFrame(imageFrame, 0, 3);
		assert.strictEqual(box.render(20).images[0]?.left, 4);
	});

	it("rejects transforms that silently remove or split an image", () => {
		assert.throws(
			() => mapRenderFrameLines(imageFrame, (line) => line.replace(sequence, "")),
			/removed an image sequence/,
		);
		assert.throws(() => spliceRenderFrameRows(imageFrame, 1, 0, createRenderFrame(["inserted"])), /splits an image/);
	});
});
