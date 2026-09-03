import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	CURRENT_SESSION_SNAPSHOT_VERSION,
	CURRENT_SESSION_VERSION,
	SessionConversationStateUnavailableError,
	SessionManager,
	type SessionReference,
	summarizeSessionEntries,
} from "../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			beforeCreateRuntime?: (sessionManager: SessionManager) => Promise<void> | void;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `volt-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
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
							})),
						});
						extensionFactory(volt);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			await options?.beforeCreateRuntime?.(sessionManager);
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	const SNAPSHOT_TIMESTAMP = "2026-09-01T12:00:00.000Z";

	function writeSessionSnapshot(
		filePath: string,
		cwd: string,
		id: string,
		entries: readonly Record<string, unknown>[] = [],
	): void {
		writeFileSync(
			filePath,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
					id,
					timestamp: SNAPSHOT_TIMESTAMP,
					cwd,
				},
				...entries,
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
	}

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("rejects reinstalling the install-once agent tool hooks", async () => {
		const { runtime } = await createRuntimeForTest(() => {});

		// External wrappers (e.g. the SubagentManager turn budget) chain over
		// agent.beforeToolCall/agent.nextAction and rely on AgentSession
		// never reinstalling them; a reinstall must fail loudly instead of
		// silently dropping those wrappers.
		const session = runtime.session as unknown as { _installAgentToolHooks(): void };
		expect(() => session._installAgentToolHooks()).toThrow(/installed exactly once per AgentSession/);
	});

	it("executes tool calls from a functional message_end replacement", async () => {
		let replaced = false;
		const { runtime, faux } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("message_end", (event) => {
				if (replaced || event.message.role !== "assistant") return;
				replaced = true;
				return {
					message: {
						...event.message,
						content: [fauxToolCall("replacement_tool", { value: "rewritten" }, { id: "replacement-call" })],
						stopReason: "toolUse",
					},
				};
			});
		});
		const startedTools: string[] = [];
		runtime.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				startedTools.push(event.toolName);
			}
		});

		await runtime.session.prompt("hello");

		expect(startedTools).toContain("replacement_tool");
		expect(faux.state.callCount).toBe(2);
		const replacedMessage = runtime.session.messages.find(
			(message) =>
				message.role === "assistant" &&
				message.content.some((content) => content.type === "toolCall" && content.id === "replacement-call"),
		);
		expect(replacedMessage).toBeDefined();
	});

	it("fails the run when an extension replacement crosses an assistant role boundary", async () => {
		const { runtime } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				return {
					message: {
						role: "user",
						content: [{ type: "text", text: "invalid replacement" }],
						timestamp: Date.now(),
					},
				};
			});
		});

		await expect(runtime.session.prompt("hello")).rejects.toMatchObject({
			code: "extension_message_role_mismatch",
			expectedRole: "assistant",
			receivedRole: "user",
		});
	});

	it("fails the run when an extension replacement crosses a tool-result role boundary", async () => {
		const { runtime, faux } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("message_end", (event) => {
				if (event.message.role !== "toolResult") return;
				return {
					message: {
						role: "user",
						content: [{ type: "text", text: "invalid replacement" }],
						timestamp: Date.now(),
					},
				};
			});
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("missing_tool", {}, { id: "tool-result-mismatch" }), {
				stopReason: "toolUse",
			}),
		]);

		await expect(runtime.session.prompt("hello")).rejects.toMatchObject({
			code: "extension_message_role_mismatch",
			expectedRole: "toolResult",
			receivedRole: "user",
		});
		expect(faux.state.callCount).toBe(1);
	});

	it("fails the run when an extension replacement crosses a custom-message role boundary", async () => {
		const { runtime, faux } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("message_end", (event) => {
				if (event.message.role !== "custom") return;
				return {
					message: {
						role: "user",
						content: [{ type: "text", text: "invalid replacement" }],
						timestamp: Date.now(),
					},
				};
			});
		});

		await expect(
			runtime.session.sendCustomMessage(
				{ customType: "role-mismatch", content: "custom turn", display: true },
				{ triggerTurn: true },
			),
		).rejects.toMatchObject({
			code: "extension_message_role_mismatch",
			expectedRole: "custom",
			receivedRole: "user",
		});
		expect(faux.state.callCount).toBe(0);
	});

	it("uses a functional message_end replacement for retry classification", async () => {
		let replaced = false;
		const { runtime, faux } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("message_end", (event) => {
				if (replaced || event.message.role !== "assistant") return;
				replaced = true;
				return {
					message: {
						...event.message,
						stopReason: "error",
						errorMessage: "overloaded_error",
					},
				};
			});
		});
		runtime.session.settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		});
		const retryDecisions: Array<boolean | undefined> = [];
		runtime.session.subscribe((event) => {
			if (event.type === "agent_end") {
				retryDecisions.push(event.willRetry);
			}
		});

		await runtime.session.prompt("hello");

		expect(faux.state.callCount).toBe(2);
		expect(retryDecisions).toEqual([true, false]);
		expect(runtime.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("session_before_switch", (event) => {
				events.push(event);
			});
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionRef = runtime.session.sessionRef;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionRef = runtime.session.sessionRef;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionRef: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionRef: secondSessionRef },
			{ type: "session_start", reason: "new", previousSessionRef: originalSessionRef },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionRef!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionRef: originalSessionRef },
			{ type: "session_shutdown", reason: "resume", targetSessionRef: originalSessionRef },
			{ type: "session_start", reason: "resume", previousSessionRef: secondSessionRef },
		]);
	});

	it("replaces a reconciliation-required runtime without invoking old-generation extension hooks", async () => {
		let replacementHookCalls = 0;
		const { runtime } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("session_before_switch", () => {
				replacementHookCalls++;
			});
			volt.on("session_shutdown", () => {
				replacementHookCalls++;
			});
		});
		const previousSession = runtime.session;
		const authorityError = new SessionConversationStateUnavailableError({
			cause: new Error("injected unresolved replacement"),
		});
		const authorityStatus = {
			status: "reconciliation_required" as const,
			error: authorityError,
		};
		vi.spyOn(previousSession.sessionManager, "getConversationAuthorityStatus").mockReturnValue(authorityStatus);
		vi.spyOn(previousSession.sessionManager, "assertConversationAuthorityAvailable").mockImplementation(() => {
			throw authorityError;
		});

		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false, seeded: false });

		expect(runtime.session).not.toBe(previousSession);
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(replacementHookCalls).toBe(0);
	});

	it("applies new-session setup before constructing the replacement session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});

		const result = await runtime.newSession({
			setup: async (sessionManager) => {
				sessionManager.appendFastModeChange(true);
			},
		});

		expect(result).toEqual({ cancelled: false, seeded: false });
		expect(runtime.session.sessionManager.buildSessionContext().fastMode.enabled).toBe(true);
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.fastModeEnabled).toBe(true);
	});

	it("keeps live modified time aligned with stored message activity after metadata changes", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const manager = runtime.session.sessionManager;
		const messageTime = Date.now() - 60_000;
		manager.appendMessage({ role: "user", content: "activity baseline", timestamp: messageTime });
		runtime.session.setSessionName("renamed after activity");
		await manager.flush();

		const stored = (await SessionManager.list(runtime.cwd, manager.getSessionDir())).find(
			(session) => session.id === runtime.session.sessionId,
		);
		const live = runtime.getCurrentSessionSummary();

		expect(stored).toBeDefined();
		expect(live.modifiedAt).toBe(new Date(messageTime).toISOString());
		expect(live.modifiedAt).toBe(stored?.modified.toISOString());
	});

	it("builds live summaries from the cached projection without materializing history", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { bootstrapModel: false });
		const manager = runtime.session.sessionManager;
		const firstMessageTime = Date.now() - 3_000;
		const lastMessageTime = firstMessageTime + 1_000;
		manager.appendCustomMessageEntry(
			"test.displayed",
			"displayed fallback",
			true,
			undefined,
			firstMessageTime - 1_000,
		);
		manager.appendMessage({ role: "user", content: "first user", timestamp: firstMessageTime });
		manager.appendCustomMessageEntry("test.hidden", "hidden activity", false, undefined, lastMessageTime + 60_000);
		manager.appendMessage({ role: "user", content: "second user", timestamp: lastMessageTime });
		const expected = summarizeSessionEntries(manager.getEntries());
		expect(expected).toEqual({
			messageCount: 3,
			firstMessage: "first user",
			lastActivityTime: lastMessageTime,
		});

		const getEntries = vi.spyOn(manager, "getEntries").mockImplementation(() => {
			throw new Error("Live summaries must not materialize session entries");
		});
		try {
			expect(manager.getSessionEntrySummary()).toEqual(expected);
			expect(runtime.getCurrentSessionSummary()).toMatchObject({
				messageCount: 3,
				firstMessage: "first user",
				modifiedAt: new Date(lastMessageTime).toISOString(),
			});
			expect(getEntries).not.toHaveBeenCalled();
		} finally {
			getEntries.mockRestore();
		}
	});

	it("keeps live planning-only modified time aligned with the stored header fallback", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { bootstrapModel: false });
		const manager = runtime.session.sessionManager;
		const header = manager.getHeader();
		if (!header) throw new Error("Expected current session header");
		const createdAt = new Date(header.timestamp).toISOString();
		manager.appendPlanningState({ mode: "plan", plan: null });
		manager.appendCustomMessageEntry(
			"test.hidden-after-planning",
			"hidden activity",
			false,
			undefined,
			new Date(header.timestamp).getTime() + 60_000,
		);
		await manager.flush();

		const stored = (await SessionManager.list(runtime.cwd, manager.getSessionDir())).find(
			(session) => session.id === runtime.session.sessionId,
		);
		const live = runtime.getCurrentSessionSummary();

		expect(stored).toBeDefined();
		expect(stored?.messageCount).toBe(0);
		expect(live.modifiedAt).toBe(createdAt);
		expect(live.modifiedAt).toBe(stored?.modified.toISOString());
	});

	it("lists current-workspace sessions and switches by session id", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});

		runtime.session.setSessionName("First session");
		await runtime.session.prompt("first prompt");
		const firstSessionId = runtime.session.sessionId;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		runtime.session.setSessionName("Second session");
		await runtime.session.prompt("second prompt");
		const secondSessionId = runtime.session.sessionId;

		const foreignCwd = join(tempDir, "foreign-workspace");
		mkdirSync(foreignCwd, { recursive: true });
		const foreignSession = await SessionManager.create(foreignCwd, runtime.session.sessionManager.getSessionDir(), {
			id: "foreign-session",
		});
		foreignSession.appendMessage({ role: "user", content: "foreign prompt", timestamp: Date.now() });
		await foreignSession.flush();

		const sessions = await runtime.listSessions();
		expect(sessions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					current: false,
					firstMessage: "first prompt",
					messageCount: 2,
					sessionId: firstSessionId,
					sessionName: "First session",
				}),
				expect.objectContaining({
					current: true,
					firstMessage: "second prompt",
					messageCount: 2,
					sessionId: secondSessionId,
					sessionName: "Second session",
				}),
			]),
		);
		expect(sessions.some((session) => session.sessionId === "foreign-session")).toBe(false);
		expect(sessions.every((session) => !Object.hasOwn(session, "path"))).toBe(true);
		await expect(runtime.switchSessionById("foreign-session")).rejects.toThrow(
			"Session not found in current workspace: foreign-session",
		);

		const switchResult = await runtime.switchSessionById(firstSessionId);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session.sessionId).toBe(firstSessionId);
		expect(runtime.session.messages.find((message) => message.role === "user")).toMatchObject({
			content: [{ text: "first prompt", type: "text" }],
			role: "user",
		});
	});

	it("switches by exact id to a message-free session without listing it", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { bootstrapModel: false });
		runtime.session.setThinkingLevel("high", { persistDefault: false });
		runtime.session.setFastModeEnabled(true);
		const fastSessionId = runtime.session.sessionId;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect((await runtime.listSessions()).some((session) => session.sessionId === fastSessionId)).toBe(false);

		const switchResult = await runtime.switchSessionById(fastSessionId);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session.sessionId).toBe(fastSessionId);
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("high");
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionRef = runtime.session.sessionRef;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionRef).toEqual(originalSessionRef);

		events.length = 0;
		const otherDir = join(tmpdir(), `volt-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = await SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionRef = otherSession.getSessionRef();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionRef!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionRef).toEqual(originalSessionRef);
	});

	it.each([
		{
			name: "Fast mode",
			importedId: "invalid-fast-mode-import",
			entry: { type: "fast_mode_change", id: "invalid-fast", enabled: "yes" },
			error: "Fast mode entry invalid-fast has an invalid enabled state",
		},
		{
			name: "thinking-level",
			importedId: "invalid-thinking-level-import",
			entry: { type: "thinking_level_change", id: "invalid-thinking", thinkingLevel: "turbo" },
			error: "Thinking level entry invalid-thinking has an invalid thinking level",
		},
	])(
		"rejects a malformed $name import without replacing or poisoning the current session",
		async ({ importedId, entry, error }) => {
			const { runtime, tempDir } = await createRuntimeForTest(() => {});
			runtime.session.setThinkingLevel("high", { persistDefault: false });
			runtime.session.setFastModeEnabled(true);
			await runtime.session.sessionManager.flush();
			const currentSessionRef = runtime.session.sessionRef;
			if (!currentSessionRef) throw new Error("Expected current persisted session reference");
			const snapshotPath = join(tempDir, `${importedId}.jsonl`);
			const sessionDir = runtime.session.sessionManager.getSessionDir();
			writeSessionSnapshot(snapshotPath, tempDir, importedId, [
				{
					...entry,
					parentId: null,
					ordinal: 1,
					timestamp: SNAPSHOT_TIMESTAMP,
				},
			]);

			await expect(runtime.importFromJsonl(snapshotPath)).rejects.toThrow(error);

			expect(runtime.session.sessionRef).toEqual(currentSessionRef);
			expect(runtime.session.thinkingLevel).toBe("high");
			expect(runtime.session.fastModeEnabled).toBe(true);
			const sessions = await SessionManager.list(tempDir, sessionDir, undefined, {
				includeMessageFreeDurable: true,
			});
			expect(sessions.some((session) => session.id === importedId)).toBe(false);
			const reopened = await SessionManager.open(currentSessionRef);
			try {
				expect(reopened.buildSessionContext()).toMatchObject({
					thinkingLevel: "high",
					fastMode: { enabled: true },
				});
			} finally {
				await reopened.closePersistence();
			}
		},
	);

	it("discards a persisted import when snapshot replay fails", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		const importedId = "failed-replay-import";
		const snapshotPath = join(tempDir, `${importedId}.jsonl`);
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const currentSessionRef = runtime.session.sessionRef;
		writeSessionSnapshot(snapshotPath, tempDir, importedId, [
			{
				type: "message",
				id: "imported-message",
				parentId: null,
				ordinal: 1,
				timestamp: SNAPSHOT_TIMESTAMP,
				message: {
					role: "user",
					content: "partially replayed",
					timestamp: Date.parse(SNAPSHOT_TIMESTAMP),
				},
			},
			{
				type: "compaction",
				id: "bad-compaction",
				parentId: "imported-message",
				ordinal: 2,
				timestamp: SNAPSHOT_TIMESTAMP,
				summary: "summary",
				firstKeptEntryId: "missing-entry",
				tokensBefore: 1,
			},
		]);

		await expect(runtime.importFromJsonl(snapshotPath)).rejects.toThrow(
			"Compaction entry bad-compaction references an unavailable retained entry",
		);

		expect(runtime.session.sessionRef).toEqual(currentSessionRef);
		const sessions = await SessionManager.list(tempDir, sessionDir, undefined, {
			includeMessageFreeDurable: true,
		});
		expect(sessions.some((session) => session.id === importedId)).toBe(false);
	});

	it("discards a persisted import when replacement creation fails before installation", async () => {
		const importedId = "failed-preinstall-import";
		let preparedRef: SessionReference | undefined;
		const { runtime, tempDir } = await createRuntimeForTest(() => {}, {
			beforeCreateRuntime: (sessionManager) => {
				if (sessionManager.getSessionId() !== importedId) return;
				preparedRef = sessionManager.getSessionRef();
				throw new Error("injected import replacement creation failure");
			},
		});
		const snapshotPath = join(tempDir, `${importedId}.jsonl`);
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const currentSessionRef = runtime.session.sessionRef;
		writeSessionSnapshot(snapshotPath, tempDir, importedId);

		await expect(runtime.importFromJsonl(snapshotPath)).rejects.toThrow(
			"injected import replacement creation failure",
		);

		expect(runtime.session.sessionRef).toEqual(currentSessionRef);
		if (!preparedRef) throw new Error("Expected the imported manager reference to be captured");
		await expect(SessionManager.open(preparedRef)).rejects.toThrow(`Session not found: ${importedId}`);
		const sessions = await SessionManager.list(tempDir, sessionDir, undefined, {
			includeMessageFreeDurable: true,
		});
		expect(sessions.some((session) => session.id === importedId)).toBe(false);
	});

	it("preserves a persisted import when replacement fails after installation", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		const importedId = "failed-postinstall-import";
		const snapshotPath = join(tempDir, `${importedId}.jsonl`);
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const currentSessionRef = runtime.session.sessionRef;
		writeSessionSnapshot(snapshotPath, tempDir, importedId);
		const unsubscribe = runtime.subscribeSessionWillProject((session) => {
			if (session.sessionId === importedId) {
				throw new Error("injected installed import projection failure");
			}
		});

		try {
			await expect(runtime.importFromJsonl(snapshotPath)).rejects.toThrow(
				"injected installed import projection failure",
			);
		} finally {
			unsubscribe();
		}

		expect(runtime.session.sessionId).toBe(importedId);
		expect(runtime.session.sessionRef).not.toEqual(currentSessionRef);
		const importedRef = runtime.session.sessionRef;
		if (!importedRef) throw new Error("Expected the installed import reference");
		const sessions = await SessionManager.list(tempDir, sessionDir, undefined, {
			includeMessageFreeDurable: true,
		});
		expect(sessions.find((session) => session.id === importedId)?.ref).toEqual(importedRef);
		const reopened = await SessionManager.open(importedRef);
		try {
			expect(reopened.getSessionRef()).toEqual(importedRef);
		} finally {
			await reopened.closePersistence();
		}
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((volt: ExtensionAPI) => {
			volt.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionRef = runtime.session.sessionRef;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionRef: runtime.session.sessionRef },
			{ type: "session_start", reason: "fork", previousSessionRef },
		]);
		expect(runtime.session.sessionRef?.sessionId).toBe(runtime.session.sessionId);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true, seeded: false });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true, seeded: false });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionRef = runtime.session.sessionRef;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, seeded: false, selectedText: undefined });
		expect(runtime.session.sessionRef).not.toEqual(previousSessionRef);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(
			tmpdir(),
			`volt-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
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
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionRef).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, seeded: false, selectedText: undefined });
		expect(runtime.session.sessionRef).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `volt-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `volt-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
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
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		await otherRuntime.session.sessionManager.flush();
		const otherSessionRef = otherRuntime.session.sessionRef!;

		await runtime.switchSession(otherSessionRef);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
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
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		await otherRuntime.session.sessionManager.flush();
		const targetSessionRef = otherRuntime.session.sessionRef!;

		await runtime.switchSession(targetSessionRef);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
