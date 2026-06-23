import type { ResolvedCommand } from "../extensions/types.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { Skill } from "../skills.ts";
import type { SourceInfo } from "../source-info.ts";
import type { UiActionArgumentDescriptor, UiActionDescriptor, UiActionListScope } from "./types.ts";

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
	promptTemplates: ReadonlyArray<PromptTemplate>;
	resourceLoader: Pick<ResourceLoader, "getSkills">;
}

export function getUiActionDescriptors(
	session: UiActionDiscoverySession,
	scope?: UiActionListScope,
): UiActionDescriptor[] {
	if (scope === "primary") {
		return [];
	}

	const extensionActions = session.extensionRunner
		.getRegisteredCommands()
		.map((command, index) => createExtensionCommandAction(command, index));
	const promptActions = session.promptTemplates.map((template, index) => createPromptTemplateAction(template, index));
	const skillActions = session.resourceLoader
		.getSkills()
		.skills.map((skill, index) => createSkillAction(skill, index));

	return [...extensionActions, ...promptActions, ...skillActions].slice(0, MAX_ACTIONS);
}

function createExtensionCommandAction(command: ResolvedCommand, index: number): UiActionDescriptor {
	const label = boundedDisplayString(command.invocationName, MAX_LABEL_LENGTH) ?? "Extension command";
	return {
		schemaVersion: 1,
		id: `extension.command.${opaqueId("ec", index)}`,
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
	};
}

function createPromptTemplateAction(template: PromptTemplate, index: number): UiActionDescriptor {
	const label = boundedDisplayString(template.name, MAX_LABEL_LENGTH) ?? "Prompt template";
	return {
		schemaVersion: 1,
		id: `prompt.template.${opaqueId("pt", index)}`,
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
	};
}

function createSkillAction(skill: Skill, index: number): UiActionDescriptor {
	const label = boundedDisplayString(skill.name, MAX_LABEL_LENGTH) ?? "Skill";
	return {
		schemaVersion: 1,
		id: `skill.${opaqueId("sk", index)}`,
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
	};
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

function opaqueId(prefix: string, index: number): string {
	return `${prefix}_${(index + 1).toString(36)}`;
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
