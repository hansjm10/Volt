import { fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #25 trailing tool-result compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("advances beyond the previous boundary while preserving the latest tool batch", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", (event) => ({
						compaction: {
							summary: "updated summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("research the issue"));
		const previousBoundaryId = harness.sessionManager.appendMessage(assistantMsg("older retained work"));
		harness.sessionManager.appendCompaction("previous summary", previousBoundaryId, 250_000);

		const toolCall = fauxToolCall("read", { path: "large.txt" });
		const recentAssistantId = harness.sessionManager.appendMessage({
			...assistantMsg(""),
			content: [toolCall],
			stopReason: "toolUse",
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "x".repeat(100) }],
			isError: false,
			timestamp: Date.now(),
		});

		const result = await harness.session.compact();

		expect(result.firstKeptEntryId).toBe(recentAssistantId);
		expect(result.firstKeptEntryId).not.toBe(previousBoundaryId);
		expect(result.estimatedTokensAfter).toBeGreaterThan(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.estimatedTokensAfter).toBe(
			result.estimatedTokensAfter,
		);
		expect(harness.session.messages.at(-2)?.role).toBe("assistant");
		expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
	});
});
