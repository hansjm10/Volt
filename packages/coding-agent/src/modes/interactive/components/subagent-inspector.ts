import {
	type Component,
	createRenderFrame,
	getKeybindings,
	Markdown,
	type RenderFrame,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import type { SubagentActivity, SubagentActivityEvent, SubagentActivityStatus } from "../../../core/subagents/index.ts";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { keyHint } from "./keybinding-hints.ts";
import { UserMessageComponent } from "./user-message.ts";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export interface SubagentActivitySource {
	listActivities(): readonly SubagentActivity[];
	subscribeActivities(listener: () => void): () => void;
}

interface MessageTimelineItem {
	kind: "message";
	role: "user" | "assistant";
	text: string;
	streaming: boolean;
}

interface ToolTimelineItem {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "running" | "completed" | "failed";
}

interface NoticeTimelineItem {
	kind: "notice";
	text: string;
}

type TimelineItem = MessageTimelineItem | ToolTimelineItem | NoticeTimelineItem;

function cleanTerminalText(value: string): string {
	return stripAnsi(value).replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return cleanTerminalText(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const value of content) {
		const block = asRecord(value);
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(cleanTerminalText(block.text));
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n").trim();
}

function extractMessage(value: unknown): { role: "user" | "assistant"; text: string } | undefined {
	const message = asRecord(value);
	if (!message) return undefined;
	const role = message.role === "custom" ? "user" : message.role;
	if (role !== "user" && role !== "assistant") return undefined;
	return { role, text: extractContentText(message.content) };
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	const record = asRecord(args);
	if (!record) return "";
	const preferredKeys =
		toolName === "bash"
			? ["command"]
			: toolName === "subagent"
				? ["agent", "task"]
				: ["path", "query", "symbol", "action", "tool", "server", "command"];
	for (const key of preferredKeys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return cleanTerminalText(value).replace(/\s+/g, " ");
		}
	}
	return "";
}

function formatDuration(activity: SubagentActivity): string {
	const elapsed = Math.max(0, (activity.finishedAt ?? Date.now()) - activity.startedAt);
	if (elapsed < 1_000) return "<1s";
	const seconds = Math.floor(elapsed / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function statusGlyph(status: SubagentActivityStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", "●");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "○");
	}
}

function statusLabel(status: SubagentActivityStatus): string {
	const color =
		status === "completed" ? "success" : status === "failed" ? "error" : status === "aborted" ? "warning" : "accent";
	const label = status === "completed" ? "done" : status === "aborted" ? "stopped" : status;
	return theme.fg(color, label);
}

function activitySummary(activities: readonly SubagentActivity[]): string {
	const counts = { running: 0, done: 0, failed: 0, stopped: 0 };
	for (const activity of activities) {
		if (activity.status === "running") counts.running += 1;
		else if (activity.status === "completed") counts.done += 1;
		else if (activity.status === "failed") counts.failed += 1;
		else counts.stopped += 1;
	}
	const parts: string[] = [];
	if (counts.running > 0) parts.push(theme.fg("warning", `${counts.running} running`));
	if (counts.done > 0) parts.push(theme.fg("success", `${counts.done} done`));
	if (counts.failed > 0) parts.push(theme.fg("error", `${counts.failed} failed`));
	if (counts.stopped > 0) parts.push(theme.fg("warning", `${counts.stopped} stopped`));
	return parts.join(theme.fg("dim", " · "));
}

function toolStatusGlyph(status: ToolTimelineItem["status"]): string {
	if (status === "running") return theme.fg("accent", "●");
	if (status === "failed") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function subagentDisplayLabel(index: number): string {
	let value = Math.max(0, index);
	let suffix = "";
	do {
		suffix = String.fromCharCode(65 + (value % 26)) + suffix;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);
	return `Subagent ${suffix}`;
}

function buildTimelineFromEvents(events: readonly SubagentActivityEvent[]): TimelineItem[] {
	const items: TimelineItem[] = [];
	const tools = new Map<string, ToolTimelineItem>();
	let activeMessage: MessageTimelineItem | undefined;

	for (const entry of events) {
		const event = entry.event;
		switch (event.type) {
			case "message_start": {
				const message = extractMessage(event.message);
				if (!message) break;
				activeMessage = { kind: "message", ...message, streaming: message.role === "assistant" };
				items.push(activeMessage);
				break;
			}
			case "message_update": {
				const message = extractMessage(event.message);
				if (!message) break;
				if (!activeMessage || activeMessage.role !== message.role) {
					activeMessage = { kind: "message", ...message, streaming: true };
					items.push(activeMessage);
				} else {
					activeMessage.text = message.text;
					activeMessage.streaming = true;
				}
				break;
			}
			case "message_end": {
				const message = extractMessage(event.message);
				if (!message) break;
				if (!activeMessage || activeMessage.role !== message.role) {
					items.push({ kind: "message", ...message, streaming: false });
				} else {
					activeMessage.text = message.text;
					activeMessage.streaming = false;
				}
				activeMessage = undefined;
				break;
			}
			case "tool_execution_start": {
				const item: ToolTimelineItem = {
					kind: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					status: "running",
				};
				items.push(item);
				tools.set(event.toolCallId, item);
				break;
			}
			case "tool_execution_end": {
				let item = tools.get(event.toolCallId);
				if (!item) {
					item = {
						kind: "tool",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: undefined,
						status: "running",
					};
					items.push(item);
					tools.set(event.toolCallId, item);
				}
				item.status = event.isError ? "failed" : "completed";
				break;
			}
			case "auto_retry_start":
				items.push({
					kind: "notice",
					text: `Retrying ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
				});
				break;
			case "compaction_start":
				items.push({ kind: "notice", text: "Compacting context…" });
				break;
		}
	}
	return items;
}

function buildTimelineFromTranscript(transcript: SubagentActivity["transcript"]): TimelineItem[] {
	const items: TimelineItem[] = [];
	const tools = new Map<string, ToolTimelineItem>();
	for (const value of transcript) {
		const record = asRecord(value);
		if (!record) continue;
		const message = extractMessage(record);
		if (message) items.push({ kind: "message", ...message, streaming: false });
		if (record.role === "assistant" && Array.isArray(record.content)) {
			for (const blockValue of record.content) {
				const block = asRecord(blockValue);
				if (!block || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string")
					continue;
				const tool: ToolTimelineItem = {
					kind: "tool",
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					status: "completed",
				};
				items.push(tool);
				tools.set(block.id, tool);
			}
		}
		if (record.role === "toolResult" && typeof record.toolCallId === "string") {
			const tool = tools.get(record.toolCallId);
			if (tool) tool.status = record.isError === true ? "failed" : "completed";
		}
	}
	return items;
}

function appendWrapped(
	lines: string[],
	prefix: string,
	text: string,
	width: number,
	color: (value: string) => string = (value) => value,
): void {
	const safePrefix = truncateToWidth(prefix, width, "");
	const prefixWidth = visibleWidth(safePrefix);
	const available = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(color(cleanTerminalText(text)), available);
	for (let index = 0; index < wrapped.length; index += 1) {
		const linePrefix = index === 0 ? safePrefix : " ".repeat(prefixWidth);
		lines.push(truncateToWidth(`${linePrefix}${wrapped[index] ?? ""}`, width, ""));
	}
}

export class SubagentInspectorComponent implements Component {
	private activities: readonly SubagentActivity[] = [];
	private selectedIndex = 0;
	private detailScroll = 0;
	private followTail = true;
	private lastDetailMaxScroll = 0;
	private lastDetailPageSize = 1;
	private readonly source: SubagentActivitySource;
	private readonly tui: TUI;
	private readonly onClose: () => void;
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(source: SubagentActivitySource, tui: TUI, onClose: () => void, initialActivityId?: string) {
		this.source = source;
		this.tui = tui;
		this.onClose = onClose;
		this.refreshActivities();
		const requestedIndex = initialActivityId
			? this.activities.findIndex((activity) => activity.id === initialActivityId)
			: -1;
		let runningIndex = -1;
		for (let index = 0; index < this.activities.length; index += 1) {
			if (this.activities[index]?.status === "running") runningIndex = index;
		}
		this.selectedIndex =
			requestedIndex >= 0
				? requestedIndex
				: runningIndex >= 0
					? runningIndex
					: Math.max(0, this.activities.length - 1);
		this.unsubscribe = this.source.subscribeActivities(() => {
			this.refreshActivities();
			this.tui.requestRender();
		});
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}

	render(width: number): RenderFrame {
		const safeWidth = Math.max(1, width);
		const rows = this.terminalRows();
		const header = this.renderHeader(safeWidth);
		const footer = this.renderFooter(safeWidth);
		const pageSize = Math.max(1, rows - header.length - footer.length);
		this.lastDetailPageSize = pageSize;

		const activity = this.activities[this.selectedIndex];
		const content = activity
			? this.buildConversationLines(activity, safeWidth)
			: [theme.fg("muted", truncateToWidth("No subagents have run in this session.", safeWidth, ""))];
		const maxScroll = Math.max(0, content.length - pageSize);
		this.lastDetailMaxScroll = maxScroll;
		if (this.followTail) this.detailScroll = maxScroll;
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
		const body = content.slice(this.detailScroll, this.detailScroll + pageSize);
		while (body.length < pageSize) body.push("");
		return createRenderFrame([...header, ...body, ...footer]);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.subagents.open") || keybindings.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (keybindings.matches(data, "app.subagents.previous")) {
			this.switchActivity(-1);
		} else if (keybindings.matches(data, "app.subagents.next")) {
			this.switchActivity(1);
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.scrollDetail(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.scrollDetail(1);
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollDetail(-Math.max(1, this.lastDetailPageSize - 2));
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollDetail(Math.max(1, this.lastDetailPageSize - 2));
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private refreshActivities(): void {
		const selectedId = this.activities[this.selectedIndex]?.id;
		this.activities = [...this.source.listActivities()].sort(
			(left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id),
		);
		if (selectedId) {
			const nextIndex = this.activities.findIndex((activity) => activity.id === selectedId);
			if (nextIndex >= 0) this.selectedIndex = nextIndex;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.activities.length - 1)));
	}

	private switchActivity(delta: number): void {
		if (this.activities.length === 0) return;
		this.selectedIndex =
			(((this.selectedIndex + delta) % this.activities.length) + this.activities.length) % this.activities.length;
		this.detailScroll = 0;
		this.followTail = this.activities[this.selectedIndex]?.status === "running";
	}

	private scrollDetail(delta: number): void {
		if (delta < 0) this.followTail = false;
		this.detailScroll = Math.max(0, Math.min(this.lastDetailMaxScroll, this.detailScroll + delta));
		if (delta > 0 && this.detailScroll >= this.lastDetailMaxScroll) this.followTail = true;
	}

	private terminalRows(): number {
		return Math.max(6, this.tui.terminal.rows || 24);
	}

	private renderHeader(width: number): string[] {
		const activity = this.activities[this.selectedIndex];
		const position = this.activities.length > 0 ? `${this.selectedIndex + 1}/${this.activities.length}` : "0/0";
		const summary = activitySummary(this.activities);
		const overview = truncateToWidth(
			`${theme.bold(theme.fg("accent", "Subagents"))}${summary ? `  ${summary}` : ""}`,
			width,
			"",
		);
		if (!activity) {
			return [overview];
		}
		const label = theme.bold(theme.fg("text", subagentDisplayLabel(this.selectedIndex)));
		const name = theme.fg("muted", ` · ${cleanTerminalText(activity.agent.name)}`);
		const state = `${statusGlyph(activity.status)} ${statusLabel(activity.status)}`;
		return [
			overview,
			truncateToWidth(
				`${label}${name}  ${state}${theme.fg("dim", ` · ${formatDuration(activity)} · ${position}`)}`,
				width,
				"",
			),
		];
	}

	private renderFooter(width: number): string[] {
		const scroll = this.lastDetailMaxScroll > 0 ? `  ${keyHint("tui.select.up", "scroll")}` : "";
		const following =
			this.followTail && this.activities[this.selectedIndex]?.status === "running"
				? theme.fg("dim", "  following")
				: "";
		return [
			truncateToWidth(
				`${keyHint("app.subagents.previous", "previous")}  ${keyHint("app.subagents.next", "next")}${scroll}  ${keyHint("app.subagents.open", "main")}${following}`,
				width,
				"",
			),
		];
	}

	private buildConversationLines(activity: SubagentActivity, width: number): string[] {
		const lines: string[] = [];
		if (activity.task) lines.push(...new UserMessageComponent(activity.task, getMarkdownTheme()).render(width).lines);

		let timeline = buildTimelineFromEvents(activity.events);
		if (timeline.length === 0 && activity.transcript.length > 0)
			timeline = buildTimelineFromTranscript(activity.transcript);
		if (activity.droppedEvents > 0) {
			timeline.unshift({ kind: "notice", text: `${activity.droppedEvents} older updates are not shown` });
		}

		for (const item of timeline) {
			if (item.kind === "message") {
				if (!item.text || item.role === "user") continue;
				lines.push("");
				lines.push(...new Markdown(item.text, 1, 0, getMarkdownTheme()).render(width).lines);
				continue;
			}
			if (item.kind === "notice") {
				lines.push("");
				appendWrapped(lines, "  ", item.text, width, (value) => theme.fg("warning", value));
				continue;
			}

			lines.push("");
			const summary = summarizeToolArgs(item.toolName, item.args);
			appendWrapped(
				lines,
				"  ",
				`${toolStatusGlyph(item.status)} ${theme.bold(theme.fg("toolTitle", item.toolName))}${summary ? theme.fg("muted", `  ${summary}`) : ""}`,
				width,
			);
		}

		if (timeline.length === 0) {
			lines.push("");
			appendWrapped(lines, "  ", "Waiting for a response…", width, (value) => theme.fg("muted", value));
		}
		if (activity.error) {
			lines.push("");
			appendWrapped(lines, "  ", activity.error, width, (value) => theme.fg("error", value));
		}
		return lines;
	}
}
