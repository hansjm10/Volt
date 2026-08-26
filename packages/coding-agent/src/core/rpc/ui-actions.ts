import { randomBytes } from "node:crypto";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type { ResolvedCommand } from "../extensions/types.ts";
import { BUILTIN_HOST_ACTION_REGISTRY, type HostActionDescriptorContext } from "../host-actions.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { listBaseBranches } from "../review.ts";
import type { Skill } from "../skills.ts";
import type { SourceInfo } from "../source-info.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationQueueBehavior,
	UiActionInvocationResponse,
	UiActionListScope,
	UiActionOptionDescriptor,
	UiActionStreamingBehavior,
} from "./types.ts";
import { validateUiActionArgs } from "./ui-action-args.ts";

const MAX_ACTIONS = 200;
const MAX_COMPLETIONS = 50;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_SOURCE_LABEL_LENGTH = 80;
const MAX_HINT_LENGTH = 160;
const REDACTED_PATH = "[redacted path]";

export interface UiActionDiscoverySession {
	extensionRunner: {
		getRegisteredCommands(): ResolvedCommand[];
	};
	isBusy?: boolean;
	isCompacting?: boolean;
	isStreaming?: boolean;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled?: boolean;
	promptTemplates: ReadonlyArray<PromptTemplate>;
	resourceLoader: Pick<ResourceLoader, "getSkills">;
	sessionManager: { getCwd(): string };
}

export interface UiActionInvocationPlan {
	promptText: string;
	promptStreamingBehavior?: UiActionInvocationQueueBehavior;
	response: UiActionInvocationResponse;
}

export interface UiActionDescriptorOptions {
	remoteSafeOnly?: boolean;
	/** Advertise review actions as detached workflows (see HostActionDescriptorContext). */
	detachedReviews?: boolean;
}

interface UiActionCatalogState {
	fingerprint: string;
	token: string;
}

interface UiActionCatalogEntry {
	descriptor: UiActionDescriptor;
	promptName: string;
	source: "extension" | "prompt" | "skill";
	command?: ResolvedCommand;
}

const catalogStates = new WeakMap<UiActionDiscoverySession, UiActionCatalogState>();

export function getUiActionDescriptors(
	session: UiActionDiscoverySession,
	scope?: UiActionListScope,
	options: UiActionDescriptorOptions = {},
): UiActionDescriptor[] {
	const builtinDescriptors = BUILTIN_HOST_ACTION_REGISTRY.getDescriptors(
		createHostActionDescriptorContext(session, options),
	);
	const normalizedScope = normalizeUiActionListScope(scope);
	const descriptors =
		normalizedScope === "primary"
			? builtinDescriptors
			: [...builtinDescriptors, ...getUiActionCatalog(session).map((entry) => entry.descriptor)];

	return descriptors
		.filter((descriptor) => matchesUiActionScope(descriptor, normalizedScope))
		.filter((descriptor) => !options.remoteSafeOnly || descriptor.remoteSafe)
		.slice(0, MAX_ACTIONS);
}

function createHostActionDescriptorContext(
	session: UiActionDiscoverySession,
	options: UiActionDescriptorOptions,
): HostActionDescriptorContext {
	return {
		session: {
			isBusy: session.isBusy ?? session.isStreaming ?? false,
			isCompacting: session.isCompacting ?? false,
			isStreaming: session.isStreaming ?? false,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			fastModeEnabled: session.fastModeEnabled,
		},
		detachedReviews: options.detachedReviews,
	};
}

function normalizeUiActionListScope(scope: UiActionListScope | undefined): UiActionListScope {
	return scope === "primary" || scope === "palette" || scope === "all" ? scope : "all";
}

function matchesUiActionScope(descriptor: UiActionDescriptor, scope: UiActionListScope): boolean {
	const kind = descriptor.presentation?.kind;
	switch (scope) {
		case "all":
			return true;
		case "primary":
			return descriptor.source === "builtin" && (kind === "card" || kind === "toggle");
		case "palette":
			return kind === "palette";
		default:
			return true;
	}
}

export function createUiActionInvocationPlan(
	session: UiActionDiscoverySession & { isStreaming: boolean },
	options: {
		action: string;
		args?: unknown;
		requireRemoteSafe?: boolean;
		streamingBehavior?: unknown;
	},
): UiActionInvocationPlan {
	if (typeof options.action !== "string" || options.action.length === 0) {
		throw new Error("UI action id must be a non-empty string");
	}

	const entry = getUiActionCatalog(session).find((candidate) => candidate.descriptor.id === options.action);
	if (!entry) {
		throw new Error(`UI action not available: ${options.action}`);
	}
	if (options.requireRemoteSafe && !entry.descriptor.remoteSafe) {
		throw new Error(`UI action not available over remote host: ${options.action}`);
	}
	if (!entry.descriptor.enabled) {
		throw new Error(entry.descriptor.disabledReason ?? `UI action is disabled: ${options.action}`);
	}

	const rawArguments = getRawArguments(options.args, entry.descriptor.args ?? []);
	const promptText = createPromptText(entry.promptName, rawArguments);
	if (entry.source === "extension") {
		return {
			promptText,
			response: {
				action: entry.descriptor.id,
				status: "handled",
			},
		};
	}

	if (!session.isStreaming) {
		return {
			promptText,
			response: {
				action: entry.descriptor.id,
				status: "accepted",
			},
		};
	}

	const streamingBehavior = getQueueBehavior(options.streamingBehavior, entry.descriptor.streamingBehavior);
	return {
		promptText,
		promptStreamingBehavior: streamingBehavior,
		response: {
			action: entry.descriptor.id,
			status: "queued",
			queuedAs: streamingBehavior,
		},
	};
}

export async function getUiActionCompletions(
	session: UiActionDiscoverySession,
	options: {
		action: string;
		argument: string;
		prefix?: unknown;
		requireRemoteSafe?: boolean;
	},
): Promise<UiActionOptionDescriptor[]> {
	if (typeof options.action !== "string" || options.action.length === 0) {
		throw new Error("UI action id must be a non-empty string");
	}
	if (typeof options.argument !== "string" || options.argument.length === 0) {
		throw new Error("UI action argument name must be a non-empty string");
	}
	if (options.prefix !== undefined && typeof options.prefix !== "string") {
		throw new Error("UI action completion prefix must be a string");
	}

	// Completions ignore availability (`enabled`), matching the catalog path
	// below, so the descriptor context's busy/detached state never gates them.
	const builtinDescriptor = BUILTIN_HOST_ACTION_REGISTRY.getDescriptor(
		options.action,
		createHostActionDescriptorContext(session, {}),
	);
	if (builtinDescriptor) {
		if (options.requireRemoteSafe && !builtinDescriptor.remoteSafe) {
			throw new Error(`UI action not available over remote host: ${options.action}`);
		}
		const argument = (builtinDescriptor.args ?? []).find((candidate) => candidate.name === options.argument);
		if (!argument) {
			throw new Error(`UI action argument not available: ${options.argument}`);
		}
		if (argument.completion !== "gitBranches") {
			return [];
		}
		return getGitBranchCompletions(session.sessionManager.getCwd(), options.prefix ?? "");
	}

	const entry = getUiActionCatalog(session).find((candidate) => candidate.descriptor.id === options.action);
	if (!entry) {
		throw new Error(`UI action not available: ${options.action}`);
	}
	if (options.requireRemoteSafe && !entry.descriptor.remoteSafe) {
		throw new Error(`UI action not available over remote host: ${options.action}`);
	}

	const argument = (entry.descriptor.args ?? []).find((candidate) => candidate.name === options.argument);
	if (!argument) {
		throw new Error(`UI action argument not available: ${options.argument}`);
	}
	if (argument.completion !== "commandArguments" || !entry.command?.getArgumentCompletions) {
		return [];
	}

	const completions = await entry.command.getArgumentCompletions(options.prefix ?? "");
	return (completions ?? [])
		.map((completion) => ({
			value: boundedDisplayString(completion.value, MAX_LABEL_LENGTH) ?? "",
			label: boundedDisplayString(completion.label, MAX_LABEL_LENGTH),
			description: boundedDisplayString(completion.description, MAX_DESCRIPTION_LENGTH),
		}))
		.filter((completion) => completion.value.length > 0)
		.slice(0, MAX_COMPLETIONS);
}

/**
 * Serves the `gitBranches` completion source: logical base branches from the
 * workspace (the same collapsed local/upstream set as the TUI /review picker),
 * case-insensitively prefix-filtered and bounded.
 */
async function getGitBranchCompletions(cwd: string, prefix: string): Promise<UiActionOptionDescriptor[]> {
	const branches = await listBaseBranches(cwd);
	if (!Array.isArray(branches)) {
		// Not a git repository (or git failed): serve no candidates instead of erroring.
		return [];
	}
	const normalizedPrefix = prefix.toLowerCase();
	return (
		branches
			.filter((branch) => branch.toLowerCase().startsWith(normalizedPrefix))
			// Keep only values that survive display bounding unchanged: a truncated or
			// redacted name would be an invalid completion value. Legal git refnames
			// under the label limit always pass; longer ones are deliberately omitted.
			.filter((branch) => boundedDisplayString(branch, MAX_LABEL_LENGTH) === branch)
			.slice(0, MAX_COMPLETIONS)
			.map((branch) => ({ value: branch }))
	);
}

function getUiActionCatalog(session: UiActionDiscoverySession): UiActionCatalogEntry[] {
	const token = getCatalogToken(session);
	const extensionActions = session.extensionRunner
		.getRegisteredCommands()
		.map((command, index) => createExtensionCommandAction(command, index, token));
	const promptActions = session.promptTemplates.map((template, index) =>
		createPromptTemplateAction(template, index, token),
	);
	const skillActions = session.resourceLoader
		.getSkills()
		.skills.map((skill, index) => createSkillAction(skill, index, token));

	return [...extensionActions, ...promptActions, ...skillActions].slice(0, MAX_ACTIONS);
}

function createExtensionCommandAction(command: ResolvedCommand, index: number, token: string): UiActionCatalogEntry {
	const label = boundedDisplayString(command.invocationName, MAX_LABEL_LENGTH) ?? "Extension command";
	return {
		promptName: command.invocationName,
		source: "extension",
		command,
		descriptor: {
			schemaVersion: 1,
			id: `extension.command.${opaqueId("ec", token, index)}`,
			label,
			description: boundedDisplayString(command.description, MAX_DESCRIPTION_LENGTH),
			source: "extension",
			...safeSourceFields(command.sourceInfo),
			category: "extension",
			presentation: { kind: "palette", group: "Extensions" },
			args: [rawArgumentsDescriptor(command.getArgumentCompletions ? "commandArguments" : undefined)],
			enabled: true,
			disabledReason: null,
			destructive: false,
			requiresConfirmation: false,
			streamingBehavior: "immediate",
			remoteSafe: command.remoteSafe === true,
			slash: {
				name: command.invocationName,
				example: `/${command.invocationName}`,
			},
		},
	};
}

function createPromptTemplateAction(template: PromptTemplate, index: number, token: string): UiActionCatalogEntry {
	const label = boundedDisplayString(template.name, MAX_LABEL_LENGTH) ?? "Prompt template";
	return {
		promptName: template.name,
		source: "prompt",
		descriptor: {
			schemaVersion: 1,
			id: `prompt.template.${opaqueId("pt", token, index)}`,
			label,
			description: boundedDisplayString(template.description, MAX_DESCRIPTION_LENGTH),
			source: "prompt",
			...safeSourceFields(template.sourceInfo),
			category: "prompt",
			presentation: { kind: "palette", group: "Prompts" },
			args: [rawArgumentsDescriptor(undefined, template.argumentHint)],
			enabled: true,
			disabledReason: null,
			destructive: false,
			requiresConfirmation: false,
			streamingBehavior: ["queueSteer", "queueFollowUp"],
			remoteSafe: true,
			slash: {
				name: template.name,
				example: `/${template.name}`,
			},
		},
	};
}

function createSkillAction(skill: Skill, index: number, token: string): UiActionCatalogEntry {
	const label = boundedDisplayString(skill.name, MAX_LABEL_LENGTH) ?? "Skill";
	return {
		promptName: `skill:${skill.name}`,
		source: "skill",
		descriptor: {
			schemaVersion: 1,
			id: `skill.${opaqueId("sk", token, index)}`,
			label,
			description: boundedDisplayString(skill.description, MAX_DESCRIPTION_LENGTH),
			source: "skill",
			...safeSourceFields(skill.sourceInfo),
			category: "skill",
			presentation: { kind: "palette", group: "Skills" },
			args: [rawArgumentsDescriptor()],
			enabled: true,
			disabledReason: null,
			destructive: false,
			requiresConfirmation: false,
			streamingBehavior: ["queueSteer", "queueFollowUp"],
			remoteSafe: true,
			slash: {
				name: `skill:${skill.name}`,
				example: `/skill:${skill.name}`,
			},
		},
	};
}

function getCatalogToken(session: UiActionDiscoverySession): string {
	const fingerprint = getCatalogFingerprint(session);
	const existing = catalogStates.get(session);
	if (existing?.fingerprint === fingerprint) {
		return existing.token;
	}
	const next = {
		fingerprint,
		token: randomBytes(6).toString("hex"),
	};
	catalogStates.set(session, next);
	return next.token;
}

function getCatalogFingerprint(session: UiActionDiscoverySession): string {
	return JSON.stringify({
		commands: session.extensionRunner.getRegisteredCommands().map((command) => ({
			description: command.description,
			invocationName: command.invocationName,
			name: command.name,
			remoteSafe: command.remoteSafe === true,
			sourceInfo: sourceFingerprint(command.sourceInfo),
		})),
		prompts: session.promptTemplates.map((template) => ({
			argumentHint: template.argumentHint,
			content: template.content,
			description: template.description,
			filePath: template.filePath,
			name: template.name,
			sourceInfo: sourceFingerprint(template.sourceInfo),
		})),
		skills: session.resourceLoader.getSkills().skills.map((skill) => ({
			baseDir: skill.baseDir,
			description: skill.description,
			disableModelInvocation: skill.disableModelInvocation,
			filePath: skill.filePath,
			name: skill.name,
			sourceInfo: sourceFingerprint(skill.sourceInfo),
		})),
	});
}

function sourceFingerprint(sourceInfo: SourceInfo): Record<string, string | undefined> {
	return {
		baseDir: sourceInfo.baseDir,
		origin: sourceInfo.origin,
		path: sourceInfo.path,
		scope: sourceInfo.scope,
		source: sourceInfo.source,
	};
}

function getRawArguments(args: unknown, descriptors: ReadonlyArray<UiActionArgumentDescriptor>): string {
	const record = validateUiActionArgs(args, descriptors);
	const unknownKeys = Object.keys(record).filter((key) => key !== "arguments");
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported prompt-like UI action argument: ${unknownKeys[0]}`);
	}
	const value = record.arguments;
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value !== "string") {
		throw new Error('UI action argument "arguments" must be a string');
	}
	return value;
}

function createPromptText(promptName: string, rawArguments: string): string {
	return rawArguments.length > 0 ? `/${promptName} ${rawArguments}` : `/${promptName}`;
}

function getQueueBehavior(
	requested: unknown,
	allowed: UiActionDescriptor["streamingBehavior"],
): UiActionInvocationQueueBehavior {
	if (requested !== "steer" && requested !== "followUp") {
		throw new Error("UI action requires streamingBehavior ('steer' or 'followUp') while the agent is streaming");
	}
	const requiredBehavior = requested === "steer" ? "queueSteer" : "queueFollowUp";
	if (!streamingBehaviorIncludes(allowed, requiredBehavior)) {
		throw new Error(`UI action cannot be queued as ${requested}`);
	}
	return requested;
}

function streamingBehaviorIncludes(
	allowed: UiActionDescriptor["streamingBehavior"],
	behavior: UiActionStreamingBehavior,
): boolean {
	if (Array.isArray(allowed)) {
		return allowed.includes(behavior);
	}
	return allowed === behavior;
}

function rawArgumentsDescriptor(
	completion?: UiActionArgumentDescriptor["completion"],
	hint?: string,
): UiActionArgumentDescriptor {
	const boundedHint = boundedDisplayString(hint, MAX_HINT_LENGTH);
	return {
		name: "arguments",
		label: "Arguments",
		type: "string",
		required: false,
		...(boundedHint ? { hint: boundedHint, placeholder: boundedHint } : {}),
		...(completion ? { completion } : {}),
	};
}

function safeSourceFields(
	sourceInfo: SourceInfo,
): Pick<UiActionDescriptor, "sourceScope" | "sourceOrigin" | "sourceLabel"> {
	return {
		sourceScope: sourceInfo.scope,
		sourceOrigin: sourceInfo.origin,
		sourceLabel: boundedDisplayString(getSafeSourceLabel(sourceInfo), MAX_SOURCE_LABEL_LENGTH),
	};
}

function getSafeSourceLabel(sourceInfo: SourceInfo): string {
	if (sourceInfo.origin === "package") {
		return "Package";
	}

	switch (sourceInfo.scope) {
		case "project":
			return "Project";
		case "user":
			return "User";
		case "temporary":
			return "Temporary";
	}
}

function opaqueId(prefix: string, token: string, index: number): string {
	return `${prefix}_${token}_${(index + 1).toString(36)}`;
}

function boundedDisplayString(value: string | undefined, maxLength: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = redactPathLikeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) {
		return undefined;
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function redactPathLikeText(value: string): string {
	return value
		.replace(/(^|[\s("'`<])file:\/\/[^\s"'`<>]+/g, `$1${REDACTED_PATH}`)
		.replace(/(^|[\s("'`<])~[^\s"'`<>]*\/[^\s"'`<>]+/g, `$1${REDACTED_PATH}`)
		.replace(/(^|[\s("'`<])[A-Za-z]:[\\/][^\s"'`<>]+/g, `$1${REDACTED_PATH}`)
		.replace(/(^|[\s("'`<])\/(?:[^\s"'`<>/]+\/)+[^\s"'`<>]*/g, `$1${REDACTED_PATH}`);
}
