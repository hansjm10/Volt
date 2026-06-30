import { Buffer } from "node:buffer";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/volt-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/volt-ai";
import { Container, Markdown, Text } from "@earendil-works/volt-tui";
import { type Static, Type } from "typebox";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { SessionStats } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type {
	SubagentDefinition,
	SubagentDefinitionSource,
	SubagentEvent,
	SubagentHandle,
	SubagentResult,
	SubagentStartByNameOptions,
} from "../subagents/index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS = 8;
export const DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY = 4;

const subagentTaskSchema = Type.Object({
	agent: Type.String({ description: "Name of the subagent to invoke" }),
	task: Type.String({ description: "Task prompt to send to the subagent" }),
});

const subagentSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the subagent to invoke for single mode" })),
	task: Type.Optional(Type.String({ description: "Task prompt to send to the subagent for single mode" })),
	tasks: Type.Optional(
		Type.Array(subagentTaskSchema, {
			description: "Parallel mode tasks. Each item is { agent, task }.",
			minItems: 1,
			maxItems: DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS,
		}),
	),
	chain: Type.Optional(
		Type.Array(subagentTaskSchema, {
			description: "Chain mode steps. Each item is { agent, task }; task may include {previous}.",
			minItems: 1,
		}),
	),
});

export type SubagentToolTaskInput = Static<typeof subagentTaskSchema>;
export type SubagentToolInput = Static<typeof subagentSchema>;
export type SubagentToolMode = "single" | "parallel" | "chain";
export type SubagentToolStatus = "running" | "completed" | "failed" | "aborted";
export type SubagentToolOverallStatus = SubagentToolStatus | "partial";

export interface SubagentToolUsageDetails {
	turns: number;
	messages: {
		user: number;
		assistant: number;
		toolCalls: number;
		toolResults: number;
		total: number;
	};
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

export interface SubagentToolOutputDetails {
	text?: string;
	bytes: number;
	truncated: boolean;
	omittedBytes?: number;
	maxBytes: number;
}

export interface SubagentToolErrorDetails {
	message: string;
}

export interface SubagentToolAgentDetails {
	name: string;
	source?: SubagentDefinitionSource;
}

export interface SubagentToolTaskDetails {
	index: number;
	subagentId?: string;
	sessionId?: string;
	agent: SubagentToolAgentDetails;
	status: SubagentToolStatus;
	usage?: SubagentToolUsageDetails;
	output?: SubagentToolOutputDetails;
	error?: SubagentToolErrorDetails;
}

export interface SubagentToolDetails {
	mode: SubagentToolMode;
	status: SubagentToolOverallStatus;
	/** Present for single mode for backward-compatible consumers. */
	subagentId?: string;
	/** Present for single mode for backward-compatible consumers. */
	sessionId?: string;
	/** Present for single mode for backward-compatible consumers. */
	agent?: SubagentToolAgentDetails;
	/** Present for single mode for backward-compatible consumers. */
	usage?: SubagentToolUsageDetails;
	/** Present for single mode for backward-compatible consumers. */
	output?: SubagentToolOutputDetails;
	/** Present for single mode for backward-compatible consumers. */
	error?: SubagentToolErrorDetails;
	summary?: {
		total: number;
		completed: number;
		failed: number;
		aborted: number;
		running?: number;
		maxTasks?: number;
		maxConcurrency?: number;
		stoppedAt?: number;
	};
	tasks?: SubagentToolTaskDetails[];
	steps?: SubagentToolTaskDetails[];
}

export interface SubagentToolManager {
	getDefinition(agentName: string): SubagentDefinition;
	startByName(agentName: string, options?: SubagentStartByNameOptions): Promise<SubagentHandle>;
}

export interface SubagentToolOptions {
	manager: SubagentToolManager;
	/** Return the parent/session tool policy to clamp child tools at execution time. */
	getAllowedTools?: () => string[] | undefined;
	maxOutputBytes?: number;
}

interface NormalizedSubagentTaskInput {
	index: number;
	agent: string;
	task: string;
}

interface NormalizedSubagentToolInput {
	mode: SubagentToolMode;
	tasks: NormalizedSubagentTaskInput[];
}

interface TruncatedText {
	text: string;
	bytes: number;
	truncated: boolean;
	omittedBytes?: number;
}

interface SubagentTaskExecutionResult {
	details: SubagentToolTaskDetails;
	outputText: string;
	rawOutput: string;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message as { role?: unknown }).role === "assistant" &&
		"content" in message &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

function getAssistantText(message: AssistantMessage | undefined): string {
	return (message?.content ?? [])
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getLastAssistantMessage(result: SubagentResult): AssistantMessage | undefined {
	for (let i = result.event.messages.length - 1; i >= 0; i--) {
		const message = result.event.messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return undefined;
}

function summarizeStats(stats: SessionStats | undefined): SubagentToolUsageDetails | undefined {
	if (!stats) {
		return undefined;
	}
	return {
		turns: stats.assistantMessages,
		messages: {
			user: stats.userMessages,
			assistant: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			toolResults: stats.toolResults,
			total: stats.totalMessages,
		},
		tokens: stats.tokens,
		cost: stats.cost,
		...(stats.contextUsage ? { contextUsage: stats.contextUsage } : {}),
	};
}

function getStatus(message: AssistantMessage | undefined): SubagentToolStatus {
	if (message?.stopReason === "aborted") {
		return "aborted";
	}
	if (message?.stopReason === "error") {
		return "failed";
	}
	return "completed";
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncateModelVisibleOutput(text: string, maxBytes: number): TruncatedText {
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= maxBytes) {
		return { text, bytes: originalBytes, truncated: false };
	}

	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	const truncatedBytes = Buffer.byteLength(truncated, "utf8");
	const omittedBytes = originalBytes - truncatedBytes;
	return {
		text: `${truncated}\n\n[Subagent output truncated: ${omittedBytes} bytes omitted.]`,
		bytes: originalBytes,
		truncated: true,
		omittedBytes,
	};
}

function createOutputDetails(truncated: TruncatedText, maxOutputBytes: number): SubagentToolOutputDetails {
	return {
		text: truncated.text,
		bytes: truncated.bytes,
		truncated: truncated.truncated,
		...(truncated.omittedBytes !== undefined ? { omittedBytes: truncated.omittedBytes } : {}),
		maxBytes: maxOutputBytes,
	};
}

function createTaskDetails(options: {
	index: number;
	definition: SubagentDefinition | undefined;
	agentName: string;
	handle: SubagentHandle | undefined;
	status: SubagentToolStatus;
	stats: SessionStats | undefined;
	output: TruncatedText;
	maxOutputBytes: number;
	errorMessage?: string;
}): SubagentToolTaskDetails {
	return {
		index: options.index,
		...(options.handle ? { subagentId: options.handle.id, sessionId: options.handle.sessionId } : {}),
		agent: {
			name: options.definition?.name ?? options.agentName,
			...(options.definition ? { source: options.definition.source } : {}),
		},
		status: options.status,
		...(options.stats ? { usage: summarizeStats(options.stats) } : {}),
		output: createOutputDetails(options.output, options.maxOutputBytes),
		...(options.errorMessage ? { error: { message: options.errorMessage } } : {}),
	};
}

function createRunningTaskDetails(options: {
	index: number;
	definition: SubagentDefinition | undefined;
	agentName: string;
	handle: SubagentHandle | undefined;
}): SubagentToolTaskDetails {
	return {
		index: options.index,
		...(options.handle ? { subagentId: options.handle.id, sessionId: options.handle.sessionId } : {}),
		agent: {
			name: options.definition?.name ?? options.agentName,
			...(options.definition ? { source: options.definition.source } : {}),
		},
		status: "running",
	};
}

function createSingleDetails(task: SubagentToolTaskDetails): SubagentToolDetails {
	return {
		mode: "single",
		subagentId: task.subagentId,
		sessionId: task.sessionId,
		agent: task.agent,
		status: task.status,
		usage: task.usage,
		output: task.output,
		error: task.error,
	};
}

function summarizeTaskDetails(
	tasks: SubagentToolTaskDetails[],
	options: {
		includeParallelLimits?: boolean;
		stoppedAt?: number;
	} = {},
): NonNullable<SubagentToolDetails["summary"]> {
	const completed = tasks.filter((task) => task.status === "completed").length;
	const failed = tasks.filter((task) => task.status === "failed").length;
	const aborted = tasks.filter((task) => task.status === "aborted").length;
	const running = tasks.filter((task) => task.status === "running").length;
	return {
		total: tasks.length,
		completed,
		failed,
		aborted,
		...(running > 0 ? { running } : {}),
		...(options.includeParallelLimits
			? {
					maxTasks: DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS,
					maxConcurrency: DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY,
				}
			: {}),
		...(options.stoppedAt !== undefined ? { stoppedAt: options.stoppedAt } : {}),
	};
}

function getAggregateStatus(summary: NonNullable<SubagentToolDetails["summary"]>): SubagentToolOverallStatus {
	const running = summary.running ?? 0;
	if (running > 0) {
		return summary.completed === 0 && summary.failed === 0 && summary.aborted === 0 ? "running" : "partial";
	}
	if (summary.completed === summary.total) {
		return "completed";
	}
	if (summary.aborted === summary.total) {
		return "aborted";
	}
	if (summary.completed === 0) {
		return "failed";
	}
	return "partial";
}

function createParallelDetails(results: SubagentTaskExecutionResult[]): SubagentToolDetails {
	const tasks = results.map((result) => result.details);
	const summary = summarizeTaskDetails(tasks, { includeParallelLimits: true });
	return {
		mode: "parallel",
		status: getAggregateStatus(summary),
		summary,
		tasks,
	};
}

function createChainDetails(results: SubagentTaskExecutionResult[]): SubagentToolDetails {
	const steps = results.map((result) => result.details);
	const failedStep = steps.find((step) => step.status !== "completed");
	const summary = summarizeTaskDetails(steps, failedStep ? { stoppedAt: failedStep.index } : {});
	return {
		mode: "chain",
		status: getAggregateStatus(summary),
		summary,
		steps,
	};
}

function createParallelProgressDetails(tasks: SubagentToolTaskDetails[]): SubagentToolDetails {
	const taskSnapshot = tasks.slice();
	const summary = summarizeTaskDetails(taskSnapshot, { includeParallelLimits: true });
	return {
		mode: "parallel",
		status: getAggregateStatus(summary),
		summary,
		tasks: taskSnapshot,
	};
}

function createChainProgressDetails(steps: SubagentToolTaskDetails[], total: number): SubagentToolDetails {
	const stepSnapshot = steps.slice();
	const baseSummary = summarizeTaskDetails(stepSnapshot);
	const summary = {
		...baseSummary,
		total,
	};
	return {
		mode: "chain",
		status: getAggregateStatus(summary),
		summary,
		steps: stepSnapshot,
	};
}

function formatParallelSummary(results: SubagentTaskExecutionResult[], details: SubagentToolDetails): string {
	const summary = details.summary;
	if (!summary) {
		return "Parallel subagents: no tasks ran";
	}

	const statusParts = [`${summary.completed}/${summary.total} completed`];
	if (summary.failed > 0) {
		statusParts.push(`${summary.failed} failed`);
	}
	if (summary.aborted > 0) {
		statusParts.push(`${summary.aborted} aborted`);
	}

	const taskSummaries = results.map((result, index) => {
		const taskNumber = index + 1;
		const agentName = result.details.agent.name;
		return `### ${taskNumber}. ${agentName} — ${result.details.status}\n\n${result.outputText}`;
	});

	return `Parallel subagents: ${statusParts.join(", ")}\n\n${taskSummaries.join("\n\n---\n\n")}`;
}

function formatChainFailureSummary(results: SubagentTaskExecutionResult[]): string {
	const failed = results.find((result) => result.details.status !== "completed");
	if (!failed) {
		return results.at(-1)?.outputText ?? "(no output)";
	}
	const stepNumber = failed.details.index + 1;
	return `Chain stopped at step ${stepNumber} (${failed.details.agent.name}) — ${failed.details.status}:\n\n${failed.outputText}`;
}

function describeSubagentProgressEvent(event: SubagentEvent): string | undefined {
	switch (event.type) {
		case "agent_start":
			return "started";
		case "tool_execution_start":
			return `tool ${event.toolName} started`;
		case "tool_execution_end":
			return `tool ${event.toolName} ${event.isError ? "failed" : "completed"}`;
		case "message_end":
			return "message completed";
		default:
			return undefined;
	}
}

function formatProgressContent(details: SubagentToolDetails, message: string | undefined): string {
	const suffix = message ? ` — ${message}` : "";
	if (details.mode === "single") {
		return `Subagent ${details.agent?.name ?? "..."}: ${details.status}${suffix}`;
	}
	return `Subagent ${details.mode}: ${formatSummary(details)}${suffix}`;
}

function normalizeSubagentToolInput(params: SubagentToolInput): NormalizedSubagentToolInput {
	const hasSingleField = params.agent !== undefined || params.task !== undefined;
	const hasTasksField = params.tasks !== undefined;
	const hasChainField = params.chain !== undefined;
	const modeCount = Number(hasSingleField) + Number(hasTasksField) + Number(hasChainField);
	if (modeCount !== 1) {
		throw new Error(
			"Invalid subagent input: provide exactly one mode, either { agent, task }, { tasks }, or { chain }.",
		);
	}

	if (hasSingleField) {
		const agent = params.agent?.trim();
		const task = params.task;
		if (!agent || !task || task.trim().length === 0) {
			throw new Error("Invalid subagent input: single mode requires non-empty agent and task.");
		}
		return { mode: "single", tasks: [{ index: 0, agent, task }] };
	}

	if (hasTasksField) {
		if (!params.tasks || params.tasks.length === 0) {
			throw new Error("Invalid subagent input: parallel mode requires at least one task.");
		}
		if (params.tasks.length > DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS) {
			throw new Error(
				`Too many parallel subagent tasks (${params.tasks.length}). Max is ${DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS}.`,
			);
		}

		return {
			mode: "parallel",
			tasks: params.tasks.map((task, index) => {
				const agent = task.agent.trim();
				if (!agent || task.task.trim().length === 0) {
					throw new Error(`Invalid subagent input: parallel task ${index + 1} requires non-empty agent and task.`);
				}
				return { index, agent, task: task.task };
			}),
		};
	}

	if (!params.chain || params.chain.length === 0) {
		throw new Error("Invalid subagent input: chain mode requires at least one step.");
	}

	return {
		mode: "chain",
		tasks: params.chain.map((step, index) => {
			const agent = step.agent.trim();
			if (!agent || step.task.trim().length === 0) {
				throw new Error(`Invalid subagent input: chain step ${index + 1} requires non-empty agent and task.`);
			}
			return { index, agent, task: step.task };
		}),
	};
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	signal: AbortSignal | undefined,
): Promise<TOut[]> {
	if (items.length === 0) {
		return [];
	}

	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: Array<TOut | undefined> = new Array(items.length);
	let nextIndex = 0;

	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const current = nextIndex;
			nextIndex += 1;
			if (current >= items.length) {
				return;
			}
			results[current] = await fn(items[current], current);
		}
	});

	await Promise.all(workers);
	return results.map((result, index) => {
		if (result === undefined) {
			throw new Error(`Parallel subagent task ${index + 1} did not produce a result`);
		}
		return result;
	});
}

function truncatePreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized || "...";
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatTokens(count: number): string {
	if (count < 1_000) {
		return String(count);
	}
	if (count < 1_000_000) {
		return `${Math.round(count / 1_000)}k`;
	}
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageSummary(usage: SubagentToolUsageDetails | undefined): string {
	if (!usage) {
		return "";
	}
	const parts: string[] = [];
	if (usage.turns > 0) {
		parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	}
	if (usage.tokens.input > 0) {
		parts.push(`↑${formatTokens(usage.tokens.input)}`);
	}
	if (usage.tokens.output > 0) {
		parts.push(`↓${formatTokens(usage.tokens.output)}`);
	}
	if (usage.tokens.cacheRead > 0) {
		parts.push(`R${formatTokens(usage.tokens.cacheRead)}`);
	}
	if (usage.tokens.cacheWrite > 0) {
		parts.push(`W${formatTokens(usage.tokens.cacheWrite)}`);
	}
	if (usage.cost > 0) {
		parts.push(`$${usage.cost.toFixed(4)}`);
	}
	return parts.join(" ");
}

function aggregateUsage(items: readonly SubagentToolTaskDetails[]): SubagentToolUsageDetails | undefined {
	const withUsage = items.filter((item) => item.usage);
	if (withUsage.length === 0) {
		return undefined;
	}
	return withUsage.reduce<SubagentToolUsageDetails>(
		(total, item) => {
			const usage = item.usage;
			if (!usage) {
				return total;
			}
			total.turns += usage.turns;
			total.messages.user += usage.messages.user;
			total.messages.assistant += usage.messages.assistant;
			total.messages.toolCalls += usage.messages.toolCalls;
			total.messages.toolResults += usage.messages.toolResults;
			total.messages.total += usage.messages.total;
			total.tokens.input += usage.tokens.input;
			total.tokens.output += usage.tokens.output;
			total.tokens.cacheRead += usage.tokens.cacheRead;
			total.tokens.cacheWrite += usage.tokens.cacheWrite;
			total.tokens.total += usage.tokens.total;
			total.cost += usage.cost;
			return total;
		},
		{
			turns: 0,
			messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
	);
}

function statusIcon(status: SubagentToolOverallStatus, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
		case "aborted":
			return theme.fg("error", "✗");
		case "running":
			return theme.fg("accent", "…");
		case "partial":
			return theme.fg("warning", "◐");
	}
	return theme.fg("muted", "?");
}

function statusText(status: SubagentToolOverallStatus, theme: Theme): string {
	const color =
		status === "completed" ? "success" : status === "partial" || status === "running" ? "warning" : "error";
	return theme.fg(color, status);
}

function formatAgent(
	agent: SubagentToolAgentDetails | undefined,
	fallbackName: string | undefined,
	theme: Theme,
): string {
	const name = agent?.name ?? fallbackName ?? "...";
	return theme.fg("accent", name) + (agent?.source ? theme.fg("muted", ` (${agent.source})`) : "");
}

function getTextContent(result: AgentToolResult<SubagentToolDetails>): string {
	return result.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getTaskInput(
	args: SubagentToolInput | undefined,
	mode: SubagentToolMode,
	index: number,
): SubagentToolTaskInput | undefined {
	if (!args) {
		return undefined;
	}
	if (mode === "single") {
		return args.agent && args.task ? { agent: args.agent, task: args.task } : undefined;
	}
	return mode === "parallel" ? args.tasks?.[index] : args.chain?.[index];
}

function formatCallLines(args: SubagentToolInput | undefined, theme: Theme): string[] {
	if (args?.chain && args.chain.length > 0) {
		const lines = [
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", `chain (${args.chain.length} steps)`)}`,
		];
		for (const [index, step] of args.chain.slice(0, 3).entries()) {
			lines.push(
				`${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("dim", truncatePreview(step.task, 60))}`,
			);
		}
		if (args.chain.length > 3) {
			lines.push(theme.fg("muted", `... +${args.chain.length - 3} more`));
		}
		return lines;
	}

	if (args?.tasks && args.tasks.length > 0) {
		const lines = [
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}`,
		];
		for (const task of args.tasks.slice(0, 3)) {
			lines.push(`${theme.fg("accent", task.agent)} ${theme.fg("dim", truncatePreview(task.task, 60))}`);
		}
		if (args.tasks.length > 3) {
			lines.push(theme.fg("muted", `... +${args.tasks.length - 3} more`));
		}
		return lines;
	}

	return [
		`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args?.agent ?? "...")}`,
		theme.fg("dim", truncatePreview(args?.task, 80)),
	];
}

function formatSummary(details: SubagentToolDetails): string {
	const summary = details.summary;
	if (!summary) {
		return details.status;
	}
	const parts = [`${summary.completed}/${summary.total} completed`];
	if (summary.failed > 0) {
		parts.push(`${summary.failed} failed`);
	}
	if (summary.aborted > 0) {
		parts.push(`${summary.aborted} aborted`);
	}
	if ((summary.running ?? 0) > 0) {
		parts.push(`${summary.running ?? 0} running`);
	}
	return parts.join(", ");
}

function outputWarning(output: SubagentToolOutputDetails | undefined, theme: Theme): string | undefined {
	if (!output?.truncated) {
		return undefined;
	}
	return theme.fg("warning", `[Truncated: ${output.omittedBytes ?? 0} bytes omitted]`);
}

function addOutput(container: Container, output: string, theme: Theme): void {
	container.addChild(
		new Markdown(output || "(no output)", 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("toolOutput", text),
		}),
	);
}

function addTaskDetails(options: {
	container: Container;
	theme: Theme;
	label: string;
	item: SubagentToolTaskDetails;
	input: SubagentToolTaskInput | undefined;
	expanded: boolean;
}): void {
	const { container, theme, label, item, input, expanded } = options;
	const usage = formatUsageSummary(item.usage);
	container.addChild(
		new Text(
			`${statusIcon(item.status, theme)} ${theme.fg("muted", `${label} ${item.index + 1}:`)} ${formatAgent(item.agent, input?.agent, theme)} ${statusText(item.status, theme)}${usage ? theme.fg("dim", `  ${usage}`) : ""}`,
			0,
			0,
		),
	);

	if (!expanded) {
		const taskPreview = truncatePreview(input?.task, 80);
		if (taskPreview !== "...") {
			container.addChild(new Text(theme.fg("dim", `  ${taskPreview}`), 0, 0));
		}
		if (item.error?.message) {
			container.addChild(new Text(theme.fg("error", `  ${truncatePreview(item.error.message, 100)}`), 0, 0));
		}
		return;
	}

	if (input?.task) {
		container.addChild(new Text(`${theme.fg("muted", "Task:")} ${theme.fg("dim", input.task)}`, 0, 0));
	}
	if (item.error?.message) {
		container.addChild(new Text(theme.fg("error", `Error: ${item.error.message}`), 0, 0));
	}
	const warning = outputWarning(item.output, theme);
	if (warning) {
		container.addChild(new Text(warning, 0, 0));
	}
	if (item.output?.text) {
		addOutput(container, item.output.text, theme);
	}
}

function renderSubagentResult(
	result: AgentToolResult<SubagentToolDetails>,
	expanded: boolean,
	theme: Theme,
	args: SubagentToolInput | undefined,
): Container {
	const container = new Container();
	const details = result.details;
	if (!details) {
		container.addChild(new Text(theme.fg("toolOutput", getTextContent(result) || "(no output)"), 0, 0));
		return container;
	}

	if (details.mode === "single") {
		const input = getTaskInput(args, "single", 0);
		const usage = formatUsageSummary(details.usage);
		container.addChild(
			new Text(
				`${statusIcon(details.status, theme)} ${formatAgent(details.agent, input?.agent, theme)} ${statusText(details.status, theme)}${usage ? theme.fg("dim", `  ${usage}`) : ""}`,
				0,
				0,
			),
		);
		const taskPreview = truncatePreview(input?.task, 100);
		if (taskPreview !== "...") {
			container.addChild(new Text(theme.fg("dim", taskPreview), 0, 0));
		}
		if (details.error?.message) {
			container.addChild(new Text(theme.fg("error", `Error: ${details.error.message}`), 0, 0));
		}
		if (expanded) {
			const warning = outputWarning(details.output, theme);
			if (warning) {
				container.addChild(new Text(warning, 0, 0));
			}
			const outputText = details.output?.text ?? getTextContent(result);
			addOutput(container, outputText || "(no output)", theme);
		}
		return container;
	}

	const items = details.mode === "chain" ? (details.steps ?? []) : (details.tasks ?? []);
	container.addChild(
		new Text(
			`${statusIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold(`subagent ${details.mode}`))} ${theme.fg("accent", formatSummary(details))}`,
			0,
			0,
		),
	);
	const totalUsage = formatUsageSummary(aggregateUsage(items));
	if (totalUsage) {
		container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
	}

	const visibleItems = expanded ? items : items.slice(0, 5);
	for (const item of visibleItems) {
		addTaskDetails({
			container,
			theme,
			label: details.mode === "chain" ? "Step" : "Task",
			item,
			input: getTaskInput(args, details.mode, item.index),
			expanded,
		});
	}
	if (!expanded && items.length > visibleItems.length) {
		container.addChild(new Text(theme.fg("muted", `... +${items.length - visibleItems.length} more`), 0, 0));
	}
	return container;
}

export function createSubagentToolDefinition(
	_options: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails> {
	const options = _options;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES;
	return {
		name: "subagent",
		label: "subagent",
		description: [
			"Delegate tasks to named Volt subagents with isolated context windows. A built-in general subagent is always available for ad hoc tasks.",
			"Modes: single { agent, task }, parallel { tasks: [{ agent, task }, ...] }, or chain { chain: [{ agent, task }, ...] }.",
			`Parallel mode runs up to ${DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS} tasks with max concurrency ${DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY}.`,
			"Chain mode runs sequentially, replacing {previous} with the prior successful step output and stopping at the first failed step.",
			"Child subagent tools are clamped to the current parent/session tool policy.",
		].join(" "),
		promptSnippet: "Delegate tasks to named isolated subagents",
		promptGuidelines: [
			"Use subagent when a named specialized agent should handle focused work in an isolated context.",
			"Use the built-in general subagent for ad hoc delegation when no specialized definition is required.",
			"Use parallel mode only for independent tasks whose outputs can be combined after all children finish.",
			"Use chain mode only when each step depends on the prior successful output via {previous}.",
		],
		parameters: subagentSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params,
			signal,
			onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
		): Promise<AgentToolResult<SubagentToolDetails>> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const normalized = normalizeSubagentToolInput(params);
			const activeHandles = new Set<SubagentHandle>();
			const disposedHandles = new Set<SubagentHandle>();
			let acceptingUpdates = true;
			let abortReject: (error: Error) => void = () => undefined;
			const abortPromise = new Promise<never>((_resolve, reject) => {
				abortReject = reject;
			});

			const emitToolUpdate = (details: SubagentToolDetails, text: string): void => {
				if (!onUpdate || !acceptingUpdates || signal?.aborted) {
					return;
				}
				onUpdate({ content: [{ type: "text", text }], details });
			};
			const emitProgressUpdate = (details: SubagentToolDetails, message: string | undefined): void => {
				emitToolUpdate(details, formatProgressContent(details, message));
			};
			const emitFinalUpdate = (result: AgentToolResult<SubagentToolDetails>): void => {
				emitToolUpdate(result.details, getTextContent(result) || "(no output)");
			};

			const disposeHandle = async (handle: SubagentHandle): Promise<void> => {
				if (disposedHandles.has(handle)) {
					return;
				}
				disposedHandles.add(handle);
				await handle.dispose().catch(() => undefined);
			};
			const abortHandle = async (handle: SubagentHandle): Promise<void> => {
				await handle.abort().catch(() => undefined);
				await disposeHandle(handle);
			};
			const abortActiveHandles = async (): Promise<void> => {
				await Promise.all(Array.from(activeHandles, (handle) => abortHandle(handle)));
			};
			const onAbort = () => {
				void abortActiveHandles().finally(() => {
					abortReject(new Error("Operation aborted"));
				});
			};

			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const runTask = async (
					task: NormalizedSubagentTaskInput,
					captureTaskErrors: boolean,
					onProgress?: (details: SubagentToolTaskDetails, message: string | undefined) => void,
				): Promise<SubagentTaskExecutionResult> => {
					let handle: SubagentHandle | undefined;
					let definition: SubagentDefinition | undefined;
					let unsubscribeEvents: (() => void) | undefined;
					try {
						if (signal?.aborted) {
							throw new Error("Operation aborted");
						}
						definition = options.manager.getDefinition(task.agent);
						const startPromise = options.manager.startByName(task.agent, {
							allowedTools: options.getAllowedTools?.(),
						});
						void startPromise
							.then((startedHandle) => {
								if (signal?.aborted && handle !== startedHandle) {
									void abortHandle(startedHandle);
								}
							})
							.catch(() => undefined);
						handle = await Promise.race([startPromise, abortPromise]);
						activeHandles.add(handle);
						if (signal?.aborted) {
							await abortHandle(handle);
							throw new Error("Operation aborted");
						}
						const runningDetails = createRunningTaskDetails({
							index: task.index,
							definition,
							agentName: task.agent,
							handle,
						});
						unsubscribeEvents = handle.onEvent((event) => {
							const message = describeSubagentProgressEvent(event);
							if (message) {
								onProgress?.(runningDetails, message);
							}
						});
						onProgress?.(runningDetails, "started");
						const completion = handle.waitForEnd();
						await Promise.race([handle.prompt(task.task), abortPromise]);
						const result = await Promise.race([completion, abortPromise]);
						const assistantMessage = getLastAssistantMessage(result);
						const status = getStatus(assistantMessage);
						const errorMessage = status === "completed" ? undefined : assistantMessage?.errorMessage;
						const rawOutput = getAssistantText(assistantMessage) || errorMessage || "(no output)";
						const output = truncateModelVisibleOutput(rawOutput, maxOutputBytes);
						const stats = await Promise.race([handle.getSessionStats().catch(() => undefined), abortPromise]);
						return {
							outputText: output.text,
							rawOutput,
							details: createTaskDetails({
								index: task.index,
								definition,
								agentName: task.agent,
								handle,
								status,
								stats,
								output,
								maxOutputBytes,
								errorMessage,
							}),
						};
					} catch (error) {
						if (signal?.aborted) {
							throw error;
						}
						if (!captureTaskErrors) {
							throw error;
						}
						const errorMessage = getErrorMessage(error);
						const output = truncateModelVisibleOutput(errorMessage, maxOutputBytes);
						return {
							outputText: output.text,
							rawOutput: errorMessage,
							details: createTaskDetails({
								index: task.index,
								definition,
								agentName: task.agent,
								handle,
								status: "failed",
								stats: undefined,
								output,
								maxOutputBytes,
								errorMessage,
							}),
						};
					} finally {
						unsubscribeEvents?.();
						if (handle) {
							activeHandles.delete(handle);
							await disposeHandle(handle);
						}
					}
				};

				if (normalized.mode === "single") {
					const result = await runTask(normalized.tasks[0], false, (details, message) => {
						emitProgressUpdate(createSingleDetails(details), message);
					});
					const finalResult: AgentToolResult<SubagentToolDetails> = {
						content: [{ type: "text", text: result.outputText }],
						details: createSingleDetails(result.details),
					};
					emitFinalUpdate(finalResult);
					return finalResult;
				}

				if (normalized.mode === "chain") {
					const results: SubagentTaskExecutionResult[] = [];
					let previousOutput = "";
					for (const step of normalized.tasks) {
						const result = await runTask(
							{ ...step, task: step.task.replace(/\{previous\}/g, previousOutput) },
							true,
							(details, message) => {
								emitProgressUpdate(
									createChainProgressDetails(
										[...results.map((completed) => completed.details), details],
										normalized.tasks.length,
									),
									message,
								);
							},
						);
						results.push(result);
						emitProgressUpdate(createChainDetails(results), undefined);
						if (result.details.status !== "completed") {
							const finalResult: AgentToolResult<SubagentToolDetails> = {
								content: [{ type: "text", text: formatChainFailureSummary(results) }],
								details: createChainDetails(results),
							};
							emitFinalUpdate(finalResult);
							return finalResult;
						}
						previousOutput = result.rawOutput;
					}
					const finalResult: AgentToolResult<SubagentToolDetails> = {
						content: [{ type: "text", text: results.at(-1)?.outputText ?? "(no output)" }],
						details: createChainDetails(results),
					};
					emitFinalUpdate(finalResult);
					return finalResult;
				}

				const parallelProgressTasks = normalized.tasks.map((task) =>
					createRunningTaskDetails({
						index: task.index,
						definition: undefined,
						agentName: task.agent,
						handle: undefined,
					}),
				);
				const emitParallelTaskUpdate = (details: SubagentToolTaskDetails, message: string | undefined): void => {
					parallelProgressTasks[details.index] = details;
					emitProgressUpdate(createParallelProgressDetails(parallelProgressTasks), message);
				};
				const results = await mapWithConcurrencyLimit(
					normalized.tasks,
					DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY,
					async (task) => {
						const result = await runTask(task, true, emitParallelTaskUpdate);
						emitParallelTaskUpdate(result.details, undefined);
						return result;
					},
					signal,
				);
				const details = createParallelDetails(results);
				const finalResult: AgentToolResult<SubagentToolDetails> = {
					content: [{ type: "text", text: formatParallelSummary(results, details) }],
					details,
				};
				emitFinalUpdate(finalResult);
				return finalResult;
			} catch (error) {
				acceptingUpdates = false;
				if (signal?.aborted) {
					await abortActiveHandles();
				}
				throw error;
			} finally {
				acceptingUpdates = false;
				signal?.removeEventListener("abort", onAbort);
				await Promise.all(Array.from(activeHandles, (handle) => disposeHandle(handle)));
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCallLines(args, theme).join("\n"));
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options.expanded, theme, context.args);
		},
	};
}

export function createSubagentTool(
	_cwd: string,
	options: SubagentToolOptions,
): AgentTool<typeof subagentSchema, SubagentToolDetails> {
	return wrapToolDefinition(createSubagentToolDefinition(options));
}
