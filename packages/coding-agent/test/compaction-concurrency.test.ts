import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionPreparation, compact } from "../src/core/compaction/compaction.ts";

const fauxRegistrations: FauxProviderRegistration[] = [];

afterEach(() => {
	while (fauxRegistrations.length > 0) {
		fauxRegistrations.pop()?.unregister();
	}
});

function createPreparation(): CompactionPreparation {
	const history: AgentMessage = { role: "user", content: "history", timestamp: Date.now() };
	const prefix: AgentMessage = { role: "user", content: "prefix", timestamp: Date.now() };
	return {
		firstKeptEntryId: "entry-keep",
		messagesToSummarize: [history],
		turnPrefixMessages: [prefix],
		isSplitTurn: true,
		tokensBefore: 1000,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
	};
}

function createFaux(): FauxProviderRegistration {
	const faux = registerFauxProvider();
	fauxRegistrations.push(faux);
	return faux;
}

describe("split-turn compaction requests", () => {
	it("serializes history and turn-prefix summaries", async () => {
		const faux = createFaux();
		let activeRequests = 0;
		let maxActiveRequests = 0;
		let releaseHistory!: () => void;
		const historyReleased = new Promise<void>((resolve) => {
			releaseHistory = resolve;
		});
		let markHistoryStarted!: () => void;
		const historyStarted = new Promise<void>((resolve) => {
			markHistoryStarted = resolve;
		});
		const requestOrder: string[] = [];
		faux.setSimpleResponses([
			async () => {
				activeRequests++;
				maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
				requestOrder.push("history-start");
				markHistoryStarted();
				await historyReleased;
				requestOrder.push("history-end");
				activeRequests--;
				return fauxAssistantMessage("history summary");
			},
			() => {
				activeRequests++;
				maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
				requestOrder.push("prefix-start");
				activeRequests--;
				return fauxAssistantMessage("prefix summary");
			},
		]);

		const compaction = compact(createPreparation(), faux.getModel(), "test-key");
		await historyStarted;
		expect(faux.state.simpleCallCount).toBe(1);
		releaseHistory();
		const result = await compaction;

		expect(result.summary).toContain("history summary");
		expect(result.summary).toContain("prefix summary");
		expect(faux.state.simpleCallCount).toBe(2);
		expect(maxActiveRequests).toBe(1);
		expect(requestOrder).toEqual(["history-start", "history-end", "prefix-start"]);
	});

	it("does not start the turn-prefix summary after cancellation", async () => {
		const faux = createFaux();
		let markHistoryStarted!: () => void;
		const historyStarted = new Promise<void>((resolve) => {
			markHistoryStarted = resolve;
		});
		faux.setSimpleResponses([
			(_context, options) => {
				markHistoryStarted();
				return new Promise<never>((_resolve, reject) => {
					const abort = (): void => {
						const error = new Error("cancelled");
						error.name = "AbortError";
						reject(error);
					};
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				});
			},
			fauxAssistantMessage("prefix summary"),
		]);
		const controller = new AbortController();

		const compaction = compact(
			createPreparation(),
			faux.getModel(),
			"test-key",
			undefined,
			undefined,
			controller.signal,
		);
		await historyStarted;
		controller.abort();

		await expect(compaction).rejects.toMatchObject({ name: "AbortError" });
		expect(faux.state.simpleCallCount).toBe(1);
		expect(faux.getPendingSimpleResponseCount()).toBe(1);
	});

	it("retries the history summary before starting the turn-prefix summary", async () => {
		const faux = createFaux();
		faux.setSimpleResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
			fauxAssistantMessage("history summary"),
			fauxAssistantMessage("prefix summary"),
		]);

		const result = await compact(
			createPreparation(),
			faux.getModel(),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
		);

		expect(result.summary).toContain("history summary");
		expect(result.summary).toContain("prefix summary");
		expect(faux.state.simpleCallCount).toBe(3);
		expect(faux.getPendingSimpleResponseCount()).toBe(0);
	});
});
