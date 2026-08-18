import type { AssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, test } from "vitest";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40).lines;

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("labels visible and hidden thinking blocks", () => {
		initTheme("dark");
		const message = createAssistantMessage([{ type: "thinking", thinking: "Check the render hierarchy" }]);

		const visible = new AssistantMessageComponent(message).render(60).lines.join("\n");
		expect(visible).toContain(theme.italic(theme.fg("accent", "[thinking]")));
		expect(visible).toContain("Check the render hierarchy");

		const hidden = stripAnsi(new AssistantMessageComponent(message, true).render(60).lines.join("\n"));
		expect(hidden).toContain("[thinking] Thinking...");
		expect(hidden).not.toContain("Check the render hierarchy");
	});

	test("renders only the latest content after multiple updates before a frame", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();

		component.updateContent(createAssistantMessage([{ type: "text", text: "stale first draft" }]));
		component.updateContent(createAssistantMessage([{ type: "text", text: "stale second draft" }]));
		component.updateContent(createAssistantMessage([{ type: "text", text: "latest response" }]));

		const rendered = stripAnsi(component.render(60).lines.join("\n"));
		expect(rendered).toContain("latest response");
		expect(rendered).not.toContain("stale first draft");
		expect(rendered).not.toContain("stale second draft");
	});

	test("renders failure state as text instead of relying on error color", () => {
		initTheme("dark");

		const message = createAssistantMessage([{ type: "text", text: "Partial response" }]);
		message.stopReason = "error";
		message.errorMessage = "Provider disconnected";
		const rendered = new AssistantMessageComponent(message).render(60).lines.join("\n");

		expect(rendered).toContain("[failure] Provider disconnected");
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).lines.join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});
});
