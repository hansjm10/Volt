/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { FauxModelDefinition, FauxProviderRegistration, FauxResponseStep, Model } from "@hansjm10/volt-ai";
import { registerFauxProvider, streamSimple } from "@hansjm10/volt-ai";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.ts";
import { createAgentSessionTestControl, type LegacyPrepareDelivery } from "../agent-session-test-control.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	agentDir?: string;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
	prepareDelivery?: LegacyPrepareDelivery;
	withConfiguredAuth?: boolean;
	/** Inject a persisted manager when a test needs to exercise session reload behavior. */
	sessionManager?: SessionManager;
}

export interface Harness {
	session: AgentSession;
	control: ReturnType<typeof createAgentSessionTestControl>;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
	cleanupAsync: () => Promise<void>;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `volt-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
	}
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ??
		createTestResourceLoader({
			...(extensionsResult === undefined ? {} : { extensionsResult }),
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
		});

	const session = new AgentSession({
		sessionManager,
		model,
		thinkingLevel: "off",
		streamFn: streamSimple,
		convertToLlm,
		settingsManager,
		cwd: tempDir,
		agentDir: options.agentDir ?? tempDir,
		modelRegistry,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
	});
	const control = createAgentSessionTestControl(session);
	if (options.prepareDelivery) control.setPrepareDelivery(options.prepareDelivery);

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		control,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			if (sessionManager.isPersisted()) {
				throw new Error("Persisted harness cleanup must await cleanupAsync()");
			}
			session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
		async cleanupAsync() {
			session.dispose();
			fauxProvider.unregister();
			try {
				await session.waitForClosed();
			} finally {
				await rm(tempDir, {
					recursive: true,
					force: true,
					...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 50 } : {}),
				});
			}
		},
	};
}
