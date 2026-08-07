import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #3688 tree cancellation compaction state", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("clears branch summary state when session_before_tree cancels navigation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		const currentLeafId = harness.sessionManager.appendMessage(userMsg("second"));

		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);

		const result = await harness.session.navigateTree(targetId, { summarize: false });

		expect(result).toEqual({ cancelled: true });
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);
	});

	it("rejects invalid extension summaries before moving the active leaf", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_tree", () => ({
						summary: {
							summary: "invalid branch summary",
							details: { shared: new SharedArrayBuffer(1) } as never,
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		const currentLeafId = harness.sessionManager.appendMessage(userMsg("second"));

		await expect(harness.session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
			"Extension session_before_tree output",
		);
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});
});
