import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionConversationStateUnavailableError, SessionManager } from "../../src/core/session-manager.ts";
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
		options?: { cwd?: string; bootstrapModel?: boolean; bootstrapThinkingLevel?: boolean },
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
			sessionManager: SessionManager.create(tempDir),
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
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
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
		writeFileSync(
			join(runtime.session.sessionManager.getSessionDir(), "2026-01-01T00-00-00-000Z_foreign-session.jsonl"),
			`${JSON.stringify({
				cwd: foreignCwd,
				id: "foreign-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				type: "session",
				version: 3,
			})}\n`,
		);

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
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `volt-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
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
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

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
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, seeded: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
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
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, seeded: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
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
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		await otherRuntime.session.sessionManager.flush();
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

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
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		await otherRuntime.session.sessionManager.flush();
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
