/**
 * Tests that AgentSession.dispose() fully severs its generation:
 *
 * - the extension runner becomes inert (no handlers run, no extension_error
 *   reaches bound listeners such as the RPC extension_error stream)
 * - the shared extension runner ref used by the Agent's onPayload /
 *   transformContext hooks is cleared
 * - queued steering/follow-up messages are drained so the post-run
 *   continuation loop can never call agent.continue() after dispose
 *
 * Regression for a production bug where an iOS client reconnect replaced the
 * host session while the old agent run was still active; the old run's next
 * provider request executed a before_provider_request handler on the disposed
 * (invalidated) runner, and the stale-ctx error was streamed to the live
 * remote client as extension_error.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@hansjm10/volt-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionError } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentSession dispose inertness", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-dispose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: { extensionRunnerRef?: { current?: ExtensionRunner } }) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;

		// Stream hangs until aborted, mimicking an in-flight provider request.
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, streamOptions) => {
				streamCalls++;
				const signal = streamOptions?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", seq: 0, snapshot: createAssistantMessage(""), toolState: [] });
					const checkAbort = () => {
						if (signal?.aborted) {
							stream.push({
								type: "error",
								seq: 1,
								reason: "aborted",
								error: createAssistantMessage("Aborted", "aborted"),
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const handlerCalls: string[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				(volt) => {
					volt.on("before_provider_request", (event, ctx) => {
						handlerCalls.push("before_provider_request");
						// Touching the ctx throws when the runner generation is stale.
						void ctx.model;
						return event.payload;
					});
				},
			],
			tempDir,
		);

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			extensionRunnerRef: options?.extensionRunnerRef,
		});

		const extensionErrors: ExtensionError[] = [];
		await session.bindExtensions({
			onError: (error) => {
				extensionErrors.push(error);
			},
		});

		return {
			agent,
			handlerCalls,
			extensionErrors,
			getStreamCalls: () => streamCalls,
		};
	}

	it("never leaks extension_error from a disposed runner to bound listeners", async () => {
		const { handlerCalls, extensionErrors } = await createSession();
		const runner = session.extensionRunner;

		// Control: while live, the handler runs and the payload passes through.
		await runner.emitBeforeProviderRequest({ value: 1 });
		expect(handlerCalls).toEqual(["before_provider_request"]);
		expect(extensionErrors).toEqual([]);

		session.dispose();

		// The disposed generation is inert: the handler must not run (its stale
		// ctx would throw), and no extension_error may reach the listener,
		// which in production is the live RPC transport to a remote client.
		const payload = { value: 2 };
		const result = await runner.emitBeforeProviderRequest(payload);
		expect(result).toBeUndefined();
		expect(handlerCalls).toEqual(["before_provider_request"]);
		expect(extensionErrors).toEqual([]);
		expect(runner.hasHandlers("before_provider_request")).toBe(false);
	});

	it("clears the shared runner ref, drains queues, and never continues after dispose", async () => {
		const ref: { current?: ExtensionRunner } = {};
		const { agent, getStreamCalls } = await createSession({ extensionRunnerRef: ref });

		expect(ref.current).toBe(session.extensionRunner);

		const promptPromise = session.prompt("First message").catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);
		expect(getStreamCalls()).toBe(1);

		// Queue a steering message; without dispose() draining queues, the
		// post-run continuation would call agent.continue() and issue a fresh
		// provider request from a dead session.
		agent.steer({ role: "user", content: [{ type: "text", text: "steer me" }], timestamp: Date.now() });
		expect(agent.hasQueuedMessages()).toBe(true);

		session.dispose();

		expect(ref.current).toBeUndefined();
		expect(agent.hasQueuedMessages()).toBe(false);

		await promptPromise;
		// Give any (buggy) continuation a chance to fire before asserting.
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(getStreamCalls()).toBe(1);

		// dispose() is idempotent.
		expect(() => session.dispose()).not.toThrow();
	});
});
