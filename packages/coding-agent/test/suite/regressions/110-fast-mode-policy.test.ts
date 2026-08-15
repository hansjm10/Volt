import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type FauxProviderRegistration, type Model, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { THINKING_FAST_MODE_ACTION_ID } from "../../../src/core/host-actions.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { buildRpcSessionState } from "../../../src/core/rpc/session-state.ts";
import { getUiActionDescriptors } from "../../../src/core/rpc/ui-actions.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";

interface TestRuntime {
	session: AgentSession;
	manager: SessionManager;
	settings: SettingsManager;
	modelRegistry: ModelRegistry;
	faux: FauxProviderRegistration;
	tempDir: string;
}

const runtimes: TestRuntime[] = [];

function registerModels(
	provider: "openai" | "openai-codex",
	models: Array<{ id: string; reasoning: boolean }>,
): { faux: FauxProviderRegistration; modelRegistry: ModelRegistry } {
	const faux = registerFauxProvider({
		provider,
		api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
		models,
	});
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(provider, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return { faux, modelRegistry };
}

async function createRuntime(options: {
	provider: "openai" | "openai-codex";
	models?: Array<{ id: string; reasoning: boolean }>;
	manager?: SessionManager;
	modelRegistry?: ModelRegistry;
	faux?: FauxProviderRegistration;
	explicitModel?: Model<string>;
	explicitThinking?: ThinkingLevel;
	settings?: SettingsManager;
	tempDir?: string;
}): Promise<TestRuntime> {
	const tempDir = options.tempDir ?? mkdtempSync(join(tmpdir(), "volt-issue-110-"));
	const registered =
		options.modelRegistry && options.faux
			? { modelRegistry: options.modelRegistry, faux: options.faux }
			: registerModels(
					options.provider,
					options.models ?? [{ id: `${options.provider}-reasoning`, reasoning: true }],
				);
	const manager = options.manager ?? SessionManager.create(tempDir, tempDir);
	const settings = options.settings ?? SettingsManager.inMemory({ defaultThinkingLevel: "medium" });
	const created = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: manager,
		settingsManager: settings,
		modelRegistry: registered.modelRegistry,
		authStorage: registered.modelRegistry.authStorage,
		resourceLoader: createTestResourceLoader(),
		disableMcp: true,
		model: options.explicitModel,
		thinkingLevel: options.explicitThinking,
		noTools: "all",
	});
	const runtime = {
		session: created.session,
		manager,
		settings,
		modelRegistry: registered.modelRegistry,
		faux: registered.faux,
		tempDir,
	};
	runtimes.push(runtime);
	return runtime;
}

function fastDescriptorEnabled(session: AgentSession): boolean | undefined {
	return getUiActionDescriptors(session, "primary").find((action) => action.id === THINKING_FAST_MODE_ACTION_ID)?.state
		?.value as boolean | undefined;
}

function settingsSnapshot(settings: SettingsManager): object {
	return {
		activeProfile: settings.getActiveProfile(),
		global: settings.getGlobalSettings(),
		project: settings.getProjectSettings(),
	};
}

afterEach(async () => {
	const tempDirs = new Set<string>();
	const fauxProviders = new Set<FauxProviderRegistration>();
	while (runtimes.length > 0) {
		const runtime = runtimes.pop()!;
		await runtime.session.dispose();
		tempDirs.add(runtime.tempDir);
		fauxProviders.add(runtime.faux);
	}
	for (const faux of fauxProviders) faux.unregister();
	for (const tempDir of tempDirs) rmSync(tempDir, { recursive: true, force: true });
});

describe("issue #110: durable Fast mode state", () => {
	it.each(["openai", "openai-codex"] as const)(
		"restores enabled state for %s sessions without changing thinking",
		async (provider) => {
			const first = await createRuntime({ provider, explicitThinking: "high" });
			const initialSettings = settingsSnapshot(first.settings);

			first.session.setFastModeEnabled(true);
			expect(first.session.fastModeEnabled).toBe(true);
			expect(first.session.thinkingLevel).toBe("high");
			expect(first.manager.buildSessionContext().fastMode).toEqual({ enabled: true });
			expect(buildRpcSessionState(first.session).fastModeEnabled).toBe(true);
			const sessionFile = first.manager.getSessionFile()!;
			await first.session.dispose();

			const resumed = await createRuntime({
				provider,
				manager: SessionManager.open(sessionFile, first.tempDir),
				modelRegistry: first.modelRegistry,
				faux: first.faux,
				settings: first.settings,
				tempDir: first.tempDir,
			});
			expect(resumed.session.fastModeEnabled).toBe(true);
			expect(resumed.session.thinkingLevel).toBe("high");
			expect(fastDescriptorEnabled(resumed.session)).toBe(true);

			resumed.session.setFastModeEnabled(false);
			expect(resumed.session.fastModeEnabled).toBe(false);
			expect(resumed.session.thinkingLevel).toBe("high");
			expect(settingsSnapshot(first.settings)).toEqual(initialSettings);
		},
	);

	it("keeps Fast enabled across explicit startup model and thinking overrides", async () => {
		const first = await createRuntime({
			provider: "openai",
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
			explicitThinking: "high",
		});
		first.session.setFastModeEnabled(true);
		const sessionFile = first.manager.getSessionFile()!;
		const secondModel = first.modelRegistry.find("openai", "second")!;
		await first.session.dispose();

		const resumed = await createRuntime({
			provider: "openai",
			manager: SessionManager.open(sessionFile, first.tempDir),
			modelRegistry: first.modelRegistry,
			faux: first.faux,
			settings: first.settings,
			tempDir: first.tempDir,
			explicitModel: secondModel,
			explicitThinking: "medium",
		});
		expect(resumed.session.model?.id).toBe("second");
		expect(resumed.session.thinkingLevel).toBe("medium");
		expect(resumed.session.fastModeEnabled).toBe(true);
		expect(resumed.manager.buildSessionContext().fastMode).toEqual({ enabled: true });
	});

	it("keeps separate sessions independent across reopen", async () => {
		const sharedSettings = SettingsManager.inMemory({ defaultThinkingLevel: "medium" });
		const first = await createRuntime({ provider: "openai", explicitThinking: "high", settings: sharedSettings });
		const second = await createRuntime({
			provider: "openai-codex",
			explicitThinking: "high",
			settings: sharedSettings,
		});
		first.session.setFastModeEnabled(true);
		const firstFile = first.manager.getSessionFile()!;
		const secondFile = second.manager.getSessionFile()!;
		await Promise.all([first.session.dispose(), second.session.dispose()]);

		const reopenedFirst = await createRuntime({
			provider: "openai",
			manager: SessionManager.open(firstFile, first.tempDir),
			modelRegistry: first.modelRegistry,
			faux: first.faux,
			settings: sharedSettings,
			tempDir: first.tempDir,
		});
		const reopenedSecond = await createRuntime({
			provider: "openai-codex",
			manager: SessionManager.open(secondFile, second.tempDir),
			modelRegistry: second.modelRegistry,
			faux: second.faux,
			settings: sharedSettings,
			tempDir: second.tempDir,
		});

		expect(reopenedFirst.session.fastModeEnabled).toBe(true);
		expect(reopenedFirst.session.thinkingLevel).toBe("high");
		expect(reopenedSecond.session.fastModeEnabled).toBe(false);
	});

	it("keeps Fast enabled through thinking, model, and scoped-model changes", async () => {
		const runtime = await createRuntime({
			provider: "openai",
			models: [
				{ id: "reasoning", reasoning: true },
				{ id: "non-reasoning", reasoning: false },
			],
			explicitThinking: "high",
		});
		const reasoningModel = runtime.modelRegistry.find("openai", "reasoning")!;
		const nonReasoningModel = runtime.modelRegistry.find("openai", "non-reasoning")!;
		const initialSettings = settingsSnapshot(runtime.settings);
		const fastStates: boolean[] = [];
		runtime.session.subscribe((event) => {
			if (event.type === "ui_action_state_changed") fastStates.push(event.state.value === true);
		});

		runtime.session.setFastModeEnabled(true);
		runtime.session.setThinkingLevel("medium", { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("medium");

		await runtime.session.setModel(nonReasoningModel, { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("off");

		await runtime.session.setModel(reasoningModel, { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("medium");

		runtime.session.setScopedModels([{ model: reasoningModel }]);
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(fastStates).toEqual([true]);
		expect(settingsSnapshot(runtime.settings)).toEqual(initialSettings);
	});

	it("restores branch-local Fast and thinking states before publishing navigation", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const branchPoint = runtime.manager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		runtime.session.setFastModeEnabled(true);
		const enabledLeaf = runtime.manager.getLeafId()!;

		runtime.manager.branch(branchPoint);
		runtime.session.setFastModeEnabled(false);
		runtime.session.setThinkingLevel("medium", { persistDefault: false });
		const generationSnapshots: Array<{ enabled: boolean; thinkingLevel: ThinkingLevel }> = [];
		runtime.session.subscribeConversationGenerationChanges(() => {
			generationSnapshots.push({
				enabled: runtime.session.fastModeEnabled,
				thinkingLevel: runtime.session.thinkingLevel,
			});
		});

		await runtime.session.navigateTree(enabledLeaf, { summarize: false });

		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("high");
		expect(fastDescriptorEnabled(runtime.session)).toBe(true);
		expect(generationSnapshots).toEqual([{ enabled: true, thinkingLevel: "high" }]);
	});

	it.each([
		{ initial: false, next: true, error: "injected enable failure" },
		{ initial: true, next: false, error: "injected disable failure" },
	])("keeps runtime state unchanged when a durable transition fails", async ({ initial, next, error }) => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		if (initial) runtime.session.setFastModeEnabled(true);
		const events: AgentSessionEvent[] = [];
		runtime.session.subscribe((event) => events.push(event));
		vi.spyOn(runtime.manager, "appendFastModeChange").mockImplementation(() => {
			throw new Error(error);
		});

		expect(() => runtime.session.setFastModeEnabled(next)).toThrow(error);
		expect(runtime.session.fastModeEnabled).toBe(initial);
		expect(runtime.session.thinkingLevel).toBe("high");
		expect(events).toEqual([]);
	});

	it("publishes one settled Fast event without thinking events or duplicate writes", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const firstEvents: AgentSessionEvent[] = [];
		const secondEvents: AgentSessionEvent[] = [];
		const baselineEntries = runtime.manager.getEntries().length;
		runtime.session.subscribe((event) => {
			firstEvents.push(event);
			if (event.type === "ui_action_state_changed") {
				expect(runtime.manager.buildSessionContext().fastMode).toEqual({ enabled: true });
				expect(runtime.session.thinkingLevel).toBe("high");
			}
		});
		runtime.session.subscribe((event) => secondEvents.push(event));

		runtime.session.setFastModeEnabled(true);
		runtime.session.setFastModeEnabled(true);

		expect(firstEvents).toEqual([
			{
				type: "ui_action_state_changed",
				action: "thinking.fast_mode",
				state: { type: "boolean", value: true, label: "Fast mode enabled" },
			},
		]);
		expect(secondEvents).toEqual(firstEvents);
		expect(runtime.manager.getEntries()).toHaveLength(baselineEntries + 1);
		expect(runtime.manager.getEntries().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
	});

	it("does not turn a committed transition into a failure when an event listener throws", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const observed: AgentSessionEvent[] = [];
		runtime.session.subscribe(() => {
			throw new Error("injected listener failure");
		});
		runtime.session.subscribe((event) => observed.push(event));

		expect(() => runtime.session.setFastModeEnabled(true)).not.toThrow();
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("high");
		expect(observed.filter((event) => event.type === "ui_action_state_changed")).toHaveLength(1);
	});
});
