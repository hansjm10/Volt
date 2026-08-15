import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CountingComponent implements Component {
	renderCount = 0;

	render(_width: number): string[] {
		this.renderCount += 1;
		return ["frame"];
	}

	invalidate(): void {}
}

describe("TUI render suspension", () => {
	it("defers a pending normal render until the suspension is released", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new CountingComponent();
		tui.addChild(component);

		tui.requestRender();
		const suspension = tui.suspendRendering();
		await terminal.waitForRender();

		assert.equal(component.renderCount, 0);

		suspension.release();
		await terminal.waitForRender();

		assert.equal(component.renderCount, 1);
		tui.stop();
	});

	it("coalesces a pending forced render across nested suspensions", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new CountingComponent();
		tui.addChild(component);
		tui.requestRender();
		await terminal.waitForRender();
		const fullRedrawsBeforeSuspension = tui.getRenderMetrics().fullRedraws;

		tui.requestRender(true);
		const outerSuspension = tui.suspendRendering();
		const innerSuspension = tui.suspendRendering();
		tui.requestRender();
		await terminal.waitForRender();

		assert.equal(component.renderCount, 1);

		outerSuspension.release();
		await terminal.waitForRender();
		assert.equal(component.renderCount, 1);

		innerSuspension.release();
		await terminal.waitForRender();
		assert.equal(component.renderCount, 2);
		assert.equal(tui.getRenderMetrics().fullRedraws, fullRedrawsBeforeSuspension + 1);

		innerSuspension.release();
		await terminal.waitForRender();
		assert.equal(component.renderCount, 2);
		tui.stop();
	});
});
