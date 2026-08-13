import type {
	Api,
	Context,
	Model,
	OpenAIResponsesCompat,
	Tool,
	ToolDefinitionFingerprint,
	ToolSetSnapshot,
} from "../types.ts";
import { fingerprintToolDefinition } from "./tool-state.ts";

type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

const OPENAI_TOOL_SEARCH_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

export interface DeferredToolPlacement {
	immediate: Tool[];
	deferred: Map<string, Tool>;
	/** Deferred definitions anchored after each transformed tool-result index. */
	anchors: Map<number, Tool[]>;
}

function hasUniqueNames(definitions: readonly ToolDefinitionFingerprint[]): boolean {
	return new Set(definitions.map((definition) => definition.name)).size === definitions.length;
}

function isValidSnapshot(snapshot: ToolSetSnapshot): boolean {
	return (
		Number.isFinite(snapshot.estimatedTokens) && snapshot.estimatedTokens >= 0 && hasUniqueNames(snapshot.definitions)
	);
}

function matchesExpectedState(
	base: readonly ToolDefinitionFingerprint[],
	added: ReadonlyMap<string, ToolDefinitionFingerprint>,
	candidate: readonly ToolDefinitionFingerprint[],
): boolean {
	if (!hasUniqueNames(candidate) || candidate.length !== base.length + added.size) return false;
	let baseIndex = 0;
	const seenAdded = new Set<string>();
	for (const definition of candidate) {
		const prior = base[baseIndex];
		if (definition.name === prior?.name) {
			if (definition.fingerprint !== prior.fingerprint) return false;
			baseIndex += 1;
			continue;
		}
		const expected = added.get(definition.name);
		if (!expected || expected.fingerprint !== definition.fingerprint || seenAdded.has(definition.name)) return false;
		seenAdded.add(definition.name);
	}
	return baseIndex === base.length && seenAdded.size === added.size;
}

/**
 * Resolve eager definitions, deferred definitions, and their transcript anchors.
 * Invalid, missing, reset, mismatched, duplicate, or previously used state stays eager.
 */
export function splitDeferredTools(
	context: Context,
	enabled: boolean,
	normalizeName: ToolNameNormalizer = identityToolName,
): DeferredToolPlacement {
	const tools = context.tools ?? [];
	const currentByName = new Map<string, { normalizedName: string; tool: Tool; fingerprint: string }>();
	const normalizedNames = new Set<string>();
	let currentIsValid = true;
	for (const tool of tools) {
		const normalizedName = normalizeName(tool.name);
		if (currentByName.has(tool.name) || normalizedNames.has(normalizedName)) currentIsValid = false;
		currentByName.set(tool.name, {
			normalizedName,
			tool,
			fingerprint: fingerprintToolDefinition(tool).fingerprint,
		});
		normalizedNames.add(normalizedName);
	}
	if (!enabled || !currentIsValid) {
		return { immediate: tools.slice(), deferred: new Map(), anchors: new Map() };
	}

	let activeState: ToolDefinitionFingerprint[] | undefined;
	const pendingAdditions = new Map<string, ToolDefinitionFingerprint>();
	const anchorIndexes = new Map<string, number>();
	const usedNames = new Set<string>();

	const resetState = (): void => {
		activeState = undefined;
		pendingAdditions.clear();
		anchorIndexes.clear();
	};

	for (const [messageIndex, message] of context.messages.entries()) {
		if (message.role === "assistant") {
			const snapshot = message.toolSetSnapshot;
			if (!snapshot || !isValidSnapshot(snapshot)) {
				resetState();
			} else {
				if (activeState && !matchesExpectedState(activeState, pendingAdditions, snapshot.definitions)) {
					anchorIndexes.clear();
				}
				activeState = snapshot.definitions.map((definition) => ({ ...definition }));
				pendingAdditions.clear();
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const toolName =
					tools.find((tool) => normalizeName(tool.name) === normalizeName(block.name))?.name ?? block.name;
				usedNames.add(toolName);
				anchorIndexes.delete(toolName);
			}
			continue;
		}
		if (message.role !== "toolResult" || !message.toolSetTransition) continue;
		const transition = message.toolSetTransition;
		if (transition.kind === "reset" || !activeState || !hasUniqueNames(transition.added)) {
			resetState();
			continue;
		}
		let valid = true;
		const activeNames = new Set(activeState.map((definition) => definition.name));
		for (const definition of transition.added) {
			const current = currentByName.get(definition.name);
			if (
				activeNames.has(definition.name) ||
				pendingAdditions.has(definition.name) ||
				!current ||
				current.fingerprint !== definition.fingerprint
			) {
				valid = false;
				break;
			}
		}
		if (!valid) {
			resetState();
			continue;
		}
		for (const definition of transition.added) {
			pendingAdditions.set(definition.name, { ...definition });
			anchorIndexes.set(definition.name, messageIndex);
		}
	}

	const currentDefinitions = tools.map(fingerprintToolDefinition);
	if (!activeState || !matchesExpectedState(activeState, pendingAdditions, currentDefinitions)) {
		return { immediate: tools.slice(), deferred: new Map(), anchors: new Map() };
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	const anchors = new Map<number, Tool[]>();
	for (const tool of tools) {
		const current = currentByName.get(tool.name)!;
		const anchorIndex = anchorIndexes.get(tool.name);
		if (anchorIndex === undefined || usedNames.has(tool.name)) {
			immediate.push(tool);
			continue;
		}
		deferred.set(current.normalizedName, tool);
		const anchored = anchors.get(anchorIndex) ?? [];
		anchored.push(tool);
		anchors.set(anchorIndex, anchored);
	}
	return { immediate, deferred, anchors };
}

/** Resolve first-party OpenAI tool-search support without changing generated model metadata. */
export function supportsOpenAIToolSearch<TApi extends Api>(model: Model<TApi>): boolean {
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	if (compat?.supportsToolSearch !== undefined) return compat.supportsToolSearch;
	const baseUrl = model.baseUrl.trim().replace(/\/+$/, "");
	if (model.provider === "openai" && model.api === "openai-responses" && baseUrl === OPENAI_BASE_URL) {
		return OPENAI_TOOL_SEARCH_MODELS.has(model.id);
	}
	if (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		baseUrl === OPENAI_CODEX_BASE_URL
	) {
		return OPENAI_TOOL_SEARCH_MODELS.has(model.id);
	}
	return false;
}
