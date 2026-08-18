import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (
		reason: "overflow" | "threshold",
		willRetry: boolean,
		continueAfterCompaction?: boolean,
	) => Promise<boolean>;
};

interface RecordedCompactionEvent {
	type: "session_before_compact" | "session_compact";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

function recordingExtension(recorded: RecordedCompactionEvent[]): ExtensionFactory {
	return (volt) => {
		volt.on("session_before_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
			return {
				compaction: {
					summary: "summary from extension",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		});
		volt.on("session_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
		});
	};
}

async function createCompactionHarness(recorded: RecordedCompactionEvent[]): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [recordingExtension(recorded)],
	});
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return harness;
}

async function createThresholdHarness(recorded: RecordedCompactionEvent[], tools?: AgentTool[]): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
		settings: { compaction: { reserveTokens: 15_000, keepRecentTokens: 1 } },
		...(tools === undefined ? {} : { tools }),
		extensionFactories: [recordingExtension(recorded)],
	});
}

function expectCompactionEvents(
	harness: Harness,
	recorded: RecordedCompactionEvent[],
	reason: RecordedCompactionEvent["reason"],
	willRetry: boolean,
): void {
	expect(recorded).toEqual([
		{ type: "session_before_compact", reason, willRetry },
		{ type: "session_compact", reason, willRetry },
	]);
	const completionEvents = harness.eventsOfType("compaction_end");
	expect(completionEvents).toHaveLength(1);
	expect(completionEvents[0]).toMatchObject({ reason, aborted: false, willRetry });
}

const LARGE_PROMPT = "x".repeat(30_000);

describe("regression #239: compaction reason on extension events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports manual reason for compact()", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);

		await harness.session.compact();

		expectCompactionEvents(harness, recorded, "manual", false);
	});

	it("reports threshold reason for auto-compaction", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		expectCompactionEvents(harness, recorded, "threshold", false);
	});

	it("reports overflow reason and willRetry for overflow recovery", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("overflow", true);

		expectCompactionEvents(harness, recorded, "overflow", true);
	});

	it("reports threshold continuation as a retry", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false, true)).resolves.toBe(true);

		expectCompactionEvents(harness, recorded, "threshold", true);
	});

	it("continues after an empty length-limited response and reports retry metadata", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createThresholdHarness(recorded);
		harnesses.push(harness);
		let continuationRetainedLengthStop = true;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "length" }),
			(context) => {
				continuationRetainedLengthStop = context.messages.some(
					(message) => message.role === "assistant" && message.stopReason === "length",
				);
				return fauxAssistantMessage("continued after compaction");
			},
		]);

		await harness.session.prompt(LARGE_PROMPT);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(continuationRetainedLengthStop).toBe(false);
		expectCompactionEvents(harness, recorded, "threshold", true);
	});

	it("reports no retry when a length-limited response has visible output", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createThresholdHarness(recorded);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("partial answer", { stopReason: "length" })]);

		await harness.session.prompt(LARGE_PROMPT);

		expect(harness.faux.state.callCount).toBe(1);
		expectCompactionEvents(harness, recorded, "threshold", false);
	});

	it("reports retry metadata when proactive threshold compaction resumes a tool turn", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		let toolRunCount = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Return a test value",
			parameters: Type.Object({}),
			execute: async () => {
				toolRunCount += 1;
				return { content: [{ type: "text", text: "tool result" }], details: {} };
			},
		};
		const harness = await createThresholdHarness(recorded, [echoTool]);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after proactive compaction"),
		]);

		await harness.session.prompt(LARGE_PROMPT);

		expect(toolRunCount).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expectCompactionEvents(harness, recorded, "threshold", true);
	});
});
