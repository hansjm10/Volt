import { randomBytes } from "node:crypto";
import type { ResolvedCommand } from "../extensions/types.ts";
import { BUILTIN_HOST_ACTION_REGISTRY } from "../host-actions.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { Skill } from "../skills.ts";
import type { SourceInfo } from "../source-info.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationQueueBehavior,
	UiActionInvocationResponse,
	UiActionListScope,
	UiActionStreamingBehavior,
} from "./types.ts";

const MAX_ACTIONS = 200;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_SOURCE_LABEL_LENGTH = 80;
const MAX_HINT_LENGTH = 160;
const REDACTED_PATH = "[redacted path]";

export interface UiActionDiscoverySession {
	extensionRunner: {
		getRegisteredCommands(): ResolvedCommand[];
	};
	isCompacting?: boolean;
	isStreaming?: boolean;
	promptTemplates: ReadonlyArray<PromptTemplate>;
	resourceLoader: Pick<ResourceLoader, "getSkills">;
}

export interface UiActionInvocationPlan {
	promptText: string;
	promptStreamingBehavior?: UiActionInvocationQueueBehavior;
	response: UiActionInvocationResponse;
}

export interface UiActionDescriptorOptions {
	remoteSafeOnly?: boolean;
}

interface UiActionCatalogState {
	fingerprint: string;
	token: string;
}

interface UiActionCatalogEntry {
	descriptor: UiActionDescriptor;
	promptName: string;
	source: "extension" | "prompt" | "skill";
}

const catalogStates = new WeakMap<UiActionDiscoverySession, UiActionCatalogState>();

export function getUiActionDescriptors(
	session: UiActionDiscoverySession,
	scope?: UiActionListScope,
	options: UiActionDescriptorOptions = {},
): UiActionDescriptor[] {
	if (scope === "primary") {
		return [];
	}

	const descriptors = [
		...BUILTIN_HOST_ACTION_REGISTRY.getDescriptors({
			session: {
				isCompacting: session.isCompacting ?? false,
				isStreaming: session.isStreaming ?? false,
			},
		}),
		...getUiActionCatalog(session).map((entry) => entry.descriptor),
	];

	return descriptors.filter((descriptor) => !options.remoteSafeOnly || descriptor.remoteSafe).slice(0, MAX_ACTIONS);
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

	const rawArguments = getRawArguments(options.args);
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
			remoteSafe: true,
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

function getRawArguments(args: unknown): string {
	if (args === undefined) {
		return "";
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("UI action args must be an object");
	}
	const record = args as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((key) => key !== "arguments");
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
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
