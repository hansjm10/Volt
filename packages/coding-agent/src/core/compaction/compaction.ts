/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, Context, JsonValue, Model, SimpleStreamOptions, Usage } from "@hansjm10/volt-ai";
import { completeSimple, isContextOverflow } from "@hansjm10/volt-ai";
import { sleep } from "../../utils/sleep.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { isTransientProviderError } from "../provider-errors.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session-manager.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	getConversationCharBudget,
	getSummarizationOutputTokenBudget,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export type CompactionDetails = {
	readFiles: string[];
	modifiedFiles: string[];
};

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if volt-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = JsonValue> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Estimated context tokens after rebuilding from the new compaction boundary. */
	estimatedTokensAfter?: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface SummarizationRetryOptions {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Sum per-message token estimates, ignoring any usage data on the messages.
 * Use for rebuilt contexts (e.g. after compaction), where retained assistant
 * messages carry usage from the pre-compaction context that would be stale.
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		const estimated = estimateMessagesTokens(messages);
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "fast_mode_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Tool results are not valid cut points. If the budget lands in a trailing
			// result batch, retain the assistant that issued it so compaction still
			// advances while keeping the call and all of its results together.
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

const MIN_SUMMARIZATION_SOURCE_CHARS = 2048;
const DEFAULT_SUMMARIZATION_CONTEXT_WINDOW = 128_000;

function createSummarizationTokenPlan(
	model: Model<any>,
	requestedMaxTokens: number,
	outputCapacity: number,
	thinkingLevel: ThinkingLevel | undefined,
): { maxTokens: number; effectiveOutputTokens: number; thinkingLevel: ThinkingLevel | undefined } {
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		const thinkingBudget =
			thinkingLevel === "minimal"
				? 1024
				: thinkingLevel === "low"
					? 2048
					: thinkingLevel === "medium"
						? 8192
						: 16384;
		const maxTokens = Math.min(requestedMaxTokens, Math.max(0, outputCapacity - thinkingBudget));
		const effectiveOutputTokens = Math.min(
			maxTokens + thinkingBudget,
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);
		if (maxTokens >= 1 && effectiveOutputTokens <= outputCapacity) {
			return { maxTokens, effectiveOutputTokens, thinkingLevel };
		}
	}

	const maxTokens = Math.min(requestedMaxTokens, outputCapacity);
	return { maxTokens, effectiveOutputTokens: maxTokens, thinkingLevel: undefined };
}

async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
}

function getSummarizationText(response: AssistantMessage, operation: string): string {
	if (response.stopReason === "error") {
		throw new Error(`${operation} failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "aborted") {
		const error = new Error(`${operation} cancelled`);
		error.name = "AbortError";
		throw error;
	}
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function createSummarizationAbortError(operation: string): Error {
	const error = new Error(`${operation} cancelled`);
	error.name = "AbortError";
	return error;
}

async function completeSummarizationText(
	operation: string,
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn: StreamFn | undefined,
	retry: SummarizationRetryOptions | undefined,
): Promise<string> {
	const maxRetries = Math.max(0, Math.floor(retry?.maxRetries ?? 0));
	let retryCount = 0;

	while (true) {
		if (options.signal?.aborted) {
			throw createSummarizationAbortError(operation);
		}
		let response: AssistantMessage | undefined;
		try {
			response = await completeSummarization(model, context, options, streamFn);
			return getSummarizationText(response, operation);
		} catch (error) {
			if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
				throw createSummarizationAbortError(operation);
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			const contextOverflow = response !== undefined && isContextOverflow(response, model.contextWindow);
			if (retryCount >= maxRetries || contextOverflow || !isTransientProviderError(errorMessage)) {
				if (retryCount === 0) {
					throw error;
				}
				throw new Error(`${operation} failed after ${retryCount + 1} attempts: ${errorMessage}`, {
					cause: error,
				});
			}
			retryCount += 1;
			const delayMs = Math.min(
				Math.max(0, retry?.maxDelayMs ?? 0),
				Math.max(0, retry?.baseDelayMs ?? 0) * 2 ** (retryCount - 1),
			);
			try {
				await sleep(delayMs, options.signal);
			} catch {
				throw createSummarizationAbortError(operation);
			}
		}
	}
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: SummarizationRetryOptions,
): Promise<string> {
	const requestedMaxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it.
	// Leave model-specific room for instructions, prior summary, and output.
	const llmMessages = convertToLlm(currentMessages);
	const fixedPromptChars =
		SUMMARIZATION_SYSTEM_PROMPT.length + basePrompt.length + (previousSummary?.length ?? 0) + 128;
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
	const outputCapacity = getSummarizationOutputTokenBudget(
		contextWindow,
		Number.MAX_SAFE_INTEGER,
		fixedPromptChars + MIN_SUMMARIZATION_SOURCE_CHARS,
	);
	if (outputCapacity < 1) {
		throw new Error("Summarization instructions exceed the selected model context window");
	}
	const tokenPlan = createSummarizationTokenPlan(model, requestedMaxTokens, outputCapacity, thinkingLevel);
	const conversationText = serializeConversation(llmMessages, {
		maxChars: getConversationCharBudget(contextWindow, tokenPlan.effectiveOutputTokens, fixedPromptChars),
	});

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions = createSummarizationOptions(
		model,
		tokenPlan.maxTokens,
		apiKey,
		headers,
		env,
		signal,
		tokenPlan.thinkingLevel,
	);

	return completeSummarizationText(
		"Summarization",
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		streamFn,
		retry,
	);
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

const TURN_PREFIX_UPDATE_PROMPT = `The messages above are the next chronological part of a turn prefix that was too large to keep. Update the existing prefix summary in <previous-summary> tags.

Preserve useful details from the existing summary, incorporate the new work, and use this EXACT format:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done across all summarized prefix chunks]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Preserve exact file paths, function names, and error messages.`;

const SUMMARIZATION_CHUNK_MAX_CHARS = 75_000;

function getSummarizationChunkBudget(model: Model<any>): number {
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
	return Math.max(
		MIN_SUMMARIZATION_SOURCE_CHARS,
		Math.min(SUMMARIZATION_CHUNK_MAX_CHARS, Math.floor(contextWindow * 0.25)),
	);
}

function groupMessagesForSummarization(messages: AgentMessage[]): AgentMessage[][] {
	const groups: AgentMessage[][] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const group = [message];
		if (message.role === "assistant" && message.content.some((content) => content.type === "toolCall")) {
			while (messages[index + 1]?.role === "toolResult") {
				group.push(messages[index + 1]);
				index += 1;
			}
		}
		groups.push(group);
	}
	return groups;
}

function chunkMessagesForSummarization(messages: AgentMessage[], maxChars: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	let currentChars = 0;

	for (const group of groupMessagesForSummarization(messages)) {
		const groupChars = serializeConversation(convertToLlm(group), {
			maxChars: Number.MAX_SAFE_INTEGER,
		}).length;
		const separatorChars = current.length === 0 ? 0 : 2;
		if (current.length > 0 && currentChars + separatorChars + groupChars > maxChars) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(...group);
		currentChars += (currentChars === 0 ? 0 : 2) + groupChars;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks;
}

async function generateSummaryInChunks(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
	env: Record<string, string> | undefined,
	retry: SummarizationRetryOptions | undefined,
): Promise<string> {
	const chunks = chunkMessagesForSummarization(messages, getSummarizationChunkBudget(model));
	if (chunks.length === 0) {
		return generateSummary(
			[],
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
		);
	}
	let summary = previousSummary;
	for (const chunk of chunks) {
		summary = await generateSummary(
			chunk,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			summary,
			thinkingLevel,
			streamFn,
			env,
			retry,
		);
	}
	return summary ?? "No prior history.";
}

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: SummarizationRetryOptions,
): Promise<CompactionResult<CompactionDetails> & { details: CompactionDetails }> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Generate summaries and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const historySummary =
			messagesToSummarize.length > 0
				? await generateSummaryInChunks(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
						env,
						retry,
					)
				: "No prior history.";
		const turnPrefixSummary = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
		);
		// Merge into single summary
		summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
	} else {
		// Just generate history summary
		summary = await generateSummaryInChunks(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
		);
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: SummarizationRetryOptions,
): Promise<string> {
	const chunks = chunkMessagesForSummarization(messages, getSummarizationChunkBudget(model));
	let summary: string | undefined;
	for (const chunk of chunks) {
		summary = await generateTurnPrefixSummaryChunk(
			chunk,
			model,
			reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			summary,
			retry,
		);
	}
	return summary ?? "No earlier turn context.";
}

async function generateTurnPrefixSummaryChunk(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
	previousSummary: string | undefined,
	retry: SummarizationRetryOptions | undefined,
): Promise<string> {
	const requestedMaxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const basePrompt = previousSummary ? TURN_PREFIX_UPDATE_PROMPT : TURN_PREFIX_SUMMARIZATION_PROMPT;
	const fixedPromptChars =
		SUMMARIZATION_SYSTEM_PROMPT.length + basePrompt.length + (previousSummary?.length ?? 0) + 128;
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
	const outputCapacity = getSummarizationOutputTokenBudget(
		contextWindow,
		Number.MAX_SAFE_INTEGER,
		fixedPromptChars + MIN_SUMMARIZATION_SOURCE_CHARS,
	);
	if (outputCapacity < 1) {
		throw new Error("Summarization instructions exceed the selected model context window");
	}
	const tokenPlan = createSummarizationTokenPlan(model, requestedMaxTokens, outputCapacity, thinkingLevel);
	const conversationText = serializeConversation(llmMessages, {
		maxChars: getConversationCharBudget(contextWindow, tokenPlan.effectiveOutputTokens, fixedPromptChars),
	});
	const promptText = [
		`<conversation>\n${conversationText}\n</conversation>`,
		...(previousSummary ? [`<previous-summary>\n${previousSummary}\n</previous-summary>`] : []),
		basePrompt,
	].join("\n\n");
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	return completeSummarizationText(
		"Turn prefix summarization",
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, tokenPlan.maxTokens, apiKey, headers, env, signal, tokenPlan.thinkingLevel),
		streamFn,
		retry,
	);
}
