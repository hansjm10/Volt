import { setKeybindings, type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SubagentActivity, SubagentEvent } from "../src/core/subagents/index.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	type SubagentActivitySource,
	SubagentInspectorComponent,
} from "../src/modes/interactive/components/subagent-inspector.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class TestActivitySource implements SubagentActivitySource {
	activities: SubagentActivity[];
	private readonly listeners = new Set<() => void>();

	constructor(activities: SubagentActivity[]) {
		this.activities = activities;
	}

	listActivities(): readonly SubagentActivity[] {
		return this.activities;
	}

	subscribeActivities(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function event(sequence: number, value: SubagentEvent): SubagentActivity["events"][number] {
	return { sequence, timestamp: 1_000 + sequence, event: value };
}

function messageEvent(type: "message_start" | "message_end", role: "user" | "assistant", text: string): SubagentEvent {
	return {
		type,
		message: {
			role,
			content: [{ type: "text", text }],
		},
	} as SubagentEvent;
}

function createActivity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
	return {
		id: "sa_scout",
		sessionId: "session_scout",
		agent: { name: "scout", source: "user" },
		task: "Inspect the auth flow and report risks",
		status: "completed",
		startedAt: 1_000,
		updatedAt: 2_000,
		finishedAt: 2_000,
		abortRequested: false,
		events: [
			event(0, messageEvent("message_start", "user", "Inspect the auth flow and report risks")),
			event(1, messageEvent("message_end", "user", "Inspect the auth flow and report risks")),
			event(2, messageEvent("message_start", "assistant", "I will inspect the relevant files.")),
			event(3, messageEvent("message_end", "assistant", "I will inspect the relevant files.")),
			event(4, {
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "src/auth.ts" },
			}),
			event(5, {
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "export function authenticate()" }] },
				isError: false,
			}),
			event(6, messageEvent("message_start", "assistant", "The auth flow lacks replay protection.")),
			event(7, messageEvent("message_end", "assistant", "The auth flow lacks replay protection.")),
		],
		droppedEvents: 0,
		transcript: [],
		...overrides,
	};
}

function createFakeTui(rows = 40): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return {
		tui: {
			terminal: { rows },
			requestRender,
		} as unknown as TUI,
		requestRender,
	};
}

describe("SubagentInspectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("opens directly as a normal subagent conversation and switches agents", () => {
		const first = createActivity({ startedAt: 1_000, finishedAt: 2_000 });
		const second = createActivity({
			id: "sa_reviewer",
			sessionId: "session_reviewer",
			agent: { name: "reviewer", source: "project" },
			task: "Review the tests",
			status: "running",
			startedAt: 3_000,
			finishedAt: undefined,
			events: [
				event(0, messageEvent("message_start", "user", "Review the tests")),
				event(1, messageEvent("message_end", "user", "Review the tests")),
				event(2, messageEvent("message_start", "assistant", "I am checking the test suite.")),
			],
		});
		const source = new TestActivitySource([second, first]);
		const { tui } = createFakeTui();
		const close = vi.fn();
		const inspector = new SubagentInspectorComponent(source, tui, close);

		const running = stripAnsi(inspector.render(100).lines.join("\n"));
		expect(running).toContain("Subagents  1 running · 1 done");
		expect(running).toContain("Subagent B · reviewer");
		expect(running).toContain("● running");
		expect(running).toContain("Review the tests");
		expect(running).toContain("I am checking the test suite.");
		expect(running).not.toContain("Assistant");
		expect(running).not.toContain("args:");
		expect(running).not.toContain("session_reviewer");

		inspector.handleInput("\x1b[D");
		const completed = stripAnsi(inspector.render(100).lines.join("\n"));
		expect(completed).toContain("Subagent A · scout");
		expect(completed).toContain("I will inspect the relevant files.");
		expect(completed).toContain("read  src/auth.ts");
		expect(completed).toContain("The auth flow lacks replay protection.");
		expect(completed).not.toContain("export function authenticate()");

		inspector.handleInput("\x1b");
		expect(close).toHaveBeenCalledOnce();
	});

	it("refreshes a running conversation as new events arrive", () => {
		const running = createActivity({
			status: "running",
			finishedAt: undefined,
			events: [event(0, messageEvent("message_start", "user", "Inspect the auth flow and report risks"))],
		});
		const source = new TestActivitySource([running]);
		const { tui, requestRender } = createFakeTui(16);
		const inspector = new SubagentInspectorComponent(source, tui, () => {});

		source.activities = [
			createActivity({
				status: "completed",
				events: [
					...running.events,
					event(1, messageEvent("message_end", "user", "Inspect the auth flow and report risks")),
					event(2, messageEvent("message_start", "assistant", "Live result arrived")),
					event(3, messageEvent("message_end", "assistant", "Live result arrived")),
				],
			}),
		];
		source.emit();

		expect(requestRender).toHaveBeenCalled();
		const rendered = stripAnsi(inspector.render(80).lines.join("\n"));
		expect(rendered).toContain("Subagents  1 done");
		expect(rendered).toContain("✓ done");
		expect(rendered).toContain("Live result arrived");
	});

	it("fills and clips the dedicated view at narrow terminal sizes", () => {
		const source = new TestActivitySource([
			createActivity({
				task: "A very long delegated task with enough text to overflow a narrow terminal several times",
			}),
		]);
		const { tui } = createFakeTui(12);
		const inspector = new SubagentInspectorComponent(source, tui, () => {});
		const lines = inspector.render(24).lines;

		expect(lines).toHaveLength(12);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
});
