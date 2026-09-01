import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { createTestAgentSessionRuntimeConfig, createTestResourceLoader } from "../../utilities.ts";

describe("regression #5596: missing configured theme export", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		initTheme("dark");
	});

	it("exports with the active fallback theme when the configured theme is missing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-5596-"));
		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("hello")]);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
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

		const settingsManager = SettingsManager.inMemory({ theme: "missing-theme" });
		const sessionManager = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		const session = new AgentSession({
			...createTestAgentSessionRuntimeConfig({ model, apiKey: "faux-key" }),
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			session.dispose();
			await session.waitForClosed();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		await session.prompt("hi");
		initTheme(settingsManager.getTheme());

		const outputPath = join(tempDir, "export.html");
		await expect(session.exportToHtml(outputPath)).resolves.toBe(outputPath);
		expect(existsSync(outputPath)).toBe(true);
		expect(settingsManager.getTheme()).toBe("missing-theme");
	});
});
