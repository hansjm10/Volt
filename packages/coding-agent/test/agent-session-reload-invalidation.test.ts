/**
 * Tests that session.reload() invalidates the previous extension generation.
 *
 * The documented ctx contract says a captured volt/ctx must not be used after
 * `await ctx.reload()`. Before this fix, reload() replaced the runner without
 * invalidating it, so old-generation closures stayed fully operational against
 * the live session (including re-registering stale provider closures).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { ExtensionAPI } from "../src/index.ts";

describe("AgentSession reload invalidates the previous extension generation", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("stale volt from before reload throws; the new generation keeps working", async () => {
		const tempDir = join(tmpdir(), `volt-reload-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});

		// Reload rebuilds the API provider registry (resetApiProviders), which
		// drops registerFauxProvider's global stream registration. Provide the
		// stream via the extension ProviderConfig instead so each generation
		// re-registers it, mirroring how real custom-API extensions work.
		const replies = ["first reply", "second reply"];
		let replyIndex = 0;
		const streamReply = (): EventStream<AssistantMessageEvent, AssistantMessage> => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Unexpected event type");
				},
			);
			const message = fauxAssistantMessage(replies[Math.min(replyIndex++, replies.length - 1)]);
			queueMicrotask(() => {
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		// The factory runs once per extension generation (startup and each
		// reload); capture every volt instance in order.
		const voltGenerations: ExtensionAPI[] = [];

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(volt: ExtensionAPI) => {
							voltGenerations.push(volt);
							volt.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								streamSimple: () => streamReply(),
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: await SessionManager.create(tempDir),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(voltGenerations).toHaveLength(1);
		const oldVolt = voltGenerations[0];

		// Pin a name so session auto-naming (a fire-and-forget completeSimple on
		// the first prompt) cannot consume one of the scripted replies.
		runtime.session.setSessionName("reload invalidation test");

		await runtime.session.prompt("first");

		await runtime.session.reload();

		expect(voltGenerations).toHaveLength(2);

		// The pre-reload generation must be stale now.
		expect(() => oldVolt.sendUserMessage("stale message")).toThrow(/stale after session replacement or reload/);

		// The session itself is still live and the new generation works.
		await runtime.session.prompt("second");
		const texts = runtime.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join(""),
			);
		expect(texts).toEqual(["first reply", "second reply"]);
	});
});
