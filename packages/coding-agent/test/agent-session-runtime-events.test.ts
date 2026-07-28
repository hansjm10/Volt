import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `volt-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
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
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
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

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("treats switching to the current session path as a clean no-op", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_before_switch", (event) => {
				events.push(event);
			});
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
		});
		const originalSession = runtimeHost.session;
		const currentSessionFile = originalSession.sessionFile;
		expect(currentSessionFile).toBeDefined();
		const prepare = vi.fn(async () => undefined);
		const rebind = vi.fn(async () => {});
		const replaced = vi.fn();
		runtimeHost.setPrepareSessionReplacement(prepare);
		runtimeHost.setRebindSession(rebind);
		const detach = runtimeHost.subscribeSessionReplaced(replaced);
		const publish = vi.spyOn(runtimeHost.conversationProjectionFeed, "commitSourceRebind");
		events.length = 0;

		await expect(runtimeHost.switchSession(currentSessionFile!)).resolves.toEqual({
			cancelled: false,
			seeded: false,
		});

		expect(runtimeHost.session).toBe(originalSession);
		expect(events).toEqual([]);
		expect(prepare).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
		expect(rebind).not.toHaveBeenCalled();
		expect(replaced).not.toHaveBeenCalled();
		detach();
	});

	it("rejects session replacement and fork commands while an agent run owns the persistence leaf", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("active branch");
		const originalSession = runtimeHost.session;
		const userEntryId = originalSession.getUserMessagesForForking()[0]?.entryId;
		expect(userEntryId).toBeDefined();

		const targetManager = SessionManager.create(runtimeHost.cwd, originalSession.sessionManager.getSessionDir());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		targetManager.appendMessage(fauxAssistantMessage("target assistant"));
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		expect(targetFile).toBeDefined();

		vi.spyOn(originalSession, "isStreaming", "get").mockReturnValue(true);
		const expectedError = "Cannot change sessions while an agent run is active; abort or wait for it to finish";
		await expect(runtimeHost.newSession()).rejects.toThrow(expectedError);
		await expect(runtimeHost.switchSession(targetFile!)).rejects.toThrow(expectedError);
		await expect(runtimeHost.switchSessionById(targetManager.getSessionId())).rejects.toThrow(expectedError);
		await expect(runtimeHost.fork(userEntryId!)).rejects.toThrow(expectedError);
		expect(runtimeHost.session).toBe(originalSession);
	});

	it("rejects session replacement and fork commands while bash owns the persistence leaf", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("active branch");
		const originalSession = runtimeHost.session;
		const userEntryId = originalSession.getUserMessagesForForking()[0]?.entryId;
		expect(userEntryId).toBeDefined();

		const targetManager = SessionManager.create(runtimeHost.cwd, originalSession.sessionManager.getSessionDir());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		targetManager.appendMessage(fauxAssistantMessage("target assistant"));
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		expect(targetFile).toBeDefined();

		let releaseBash!: () => void;
		const bashGate = new Promise<void>((resolve) => {
			releaseBash = resolve;
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				await bashGate;
				onData(Buffer.from("held output"));
				return { exitCode: 0 };
			},
		};
		const bash = originalSession.executeBash("held command", undefined, { operations });
		expect(originalSession.isBashRunning).toBe(true);

		const expectedError = "Cannot change sessions while a bash run is active; abort or wait for it to finish";
		await expect(runtimeHost.newSession()).rejects.toThrow(expectedError);
		await expect(runtimeHost.switchSession(targetFile!)).rejects.toThrow(expectedError);
		await expect(runtimeHost.switchSessionById(targetManager.getSessionId())).rejects.toThrow(expectedError);
		await expect(runtimeHost.fork(userEntryId!)).rejects.toThrow(expectedError);
		expect(runtimeHost.session).toBe(originalSession);

		releaseBash();
		await expect(bash).resolves.toMatchObject({ output: "held output", exitCode: 0 });
		expect(originalSession.messages.at(-1)).toMatchObject({
			role: "bashExecution",
			command: "held command",
			output: "held output",
		});
	});

	it("starts one revision-fenced retained-context plan execution", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		runtimeHost.session.setAgentMode("plan");
		const draft = runtimeHost.session.updatePlan({
			title: "Retain context",
			summary: "Execute in the current session.",
			steps: [{ text: "Implement the change" }],
		});
		const ready = runtimeHost.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Retain context",
			summary: "Execute in the current session.",
		});

		const started = await runtimeHost.executePlan(ready.id, ready.revision, "retain_context");
		expect(started).toMatchObject({
			selectedSessionId: runtimeHost.session.sessionId,
			started: true,
			planning: { mode: "build", plan: { phase: "active" } },
		});
		await runtimeHost.session.waitForIdle();

		const executionEntries = runtimeHost.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-execution");
		expect(executionEntries).toHaveLength(1);

		const retry = await runtimeHost.executePlan(ready.id, ready.revision, "retain_context");
		expect(retry.started).toBe(false);
		expect(
			runtimeHost.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-execution"),
		).toHaveLength(1);
	});

	it("hands a ready plan to a clean linked execution session exactly once", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("Source-only conversation");
		const sourceManager = runtimeHost.session.sessionManager;
		const sourceSessionId = runtimeHost.session.sessionId;
		const sourceSessionFile = runtimeHost.session.sessionFile;
		expect(sourceSessionFile).toBeDefined();

		runtimeHost.session.setAgentMode("plan");
		const draft = runtimeHost.session.updatePlan({
			title: "Clear context",
			summary: "Execute from only the approved plan.",
			steps: [{ text: "Implement the isolated change" }],
		});
		const ready = runtimeHost.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Clear context",
			summary: "Execute from only the approved plan.",
		});

		const started = await runtimeHost.executePlan(ready.id, ready.revision, "new_session");
		expect(started.started).toBe(true);
		expect(started.selectedSessionId).not.toBe(sourceSessionId);
		expect(runtimeHost.session.sessionId).toBe(started.selectedSessionId);
		await runtimeHost.session.waitForIdle();

		expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBe(sourceSessionFile);
		expect(runtimeHost.session.planningState).toMatchObject({
			mode: "build",
			plan: {
				id: ready.id,
				phase: "active",
				execution: {
					approvedRevision: ready.revision,
					strategy: "new_session",
					sourceSessionId,
					targetSessionId: started.selectedSessionId,
				},
			},
		});
		expect(sourceManager.buildSessionContext().planning).toMatchObject({
			mode: "build",
			plan: {
				id: ready.id,
				phase: "handed_off",
				execution: { targetSessionId: started.selectedSessionId },
			},
		});

		const childBranch = runtimeHost.session.sessionManager.getBranch();
		expect(
			childBranch.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "Source-only conversation",
			),
		).toBe(false);
		expect(
			childBranch.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-execution"),
		).toHaveLength(1);

		const retry = await runtimeHost.executePlan(ready.id, ready.revision, "new_session");
		expect(retry).toMatchObject({ selectedSessionId: started.selectedSessionId, started: false });
	});

	it("rejects session replacement and fork commands while manual compaction owns the persistence leaf", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("first branch turn");
		await runtimeHost.session.prompt("second branch turn");
		const originalSession = runtimeHost.session;
		const userEntryId = originalSession.getUserMessagesForForking()[0]?.entryId;
		expect(userEntryId).toBeDefined();

		const targetManager = SessionManager.create(runtimeHost.cwd, originalSession.sessionManager.getSessionDir());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		targetManager.appendMessage(fauxAssistantMessage("target assistant"));
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		expect(targetFile).toBeDefined();

		let notifyCompactionStarted!: () => void;
		const compactionStarted = new Promise<void>((resolve) => {
			notifyCompactionStarted = resolve;
		});
		let releaseCompaction!: () => void;
		const compactionGate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const runner = originalSession.extensionRunner;
		const originalHasHandlers = runner.hasHandlers.bind(runner);
		vi.spyOn(runner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact" || originalHasHandlers(eventType),
		);
		const originalEmit = runner.emit.bind(runner);
		vi.spyOn(runner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") {
				notifyCompactionStarted();
				await compactionGate;
				return {
					compaction: {
						summary: "held compaction summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return originalEmit(event);
		});

		const compaction = originalSession.compact();
		await compactionStarted;
		expect(originalSession.hasActiveSessionMutation).toBe(true);
		const expectedError = "Cannot change sessions while a session mutation is active; wait for it to finish";
		try {
			await expect(runtimeHost.newSession()).rejects.toThrow(expectedError);
			await expect(runtimeHost.switchSession(targetFile!)).rejects.toThrow(expectedError);
			await expect(runtimeHost.switchSessionById(targetManager.getSessionId())).rejects.toThrow(expectedError);
			await expect(runtimeHost.fork(userEntryId!)).rejects.toThrow(expectedError);
			expect(runtimeHost.session).toBe(originalSession);
		} finally {
			releaseCompaction();
		}
		await expect(compaction).resolves.toMatchObject({ summary: "held compaction summary" });
		expect(originalSession.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			1,
		);
	});

	it("never reconnects agent events when manual compaction settles after disposal", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("first branch turn");
		await runtimeHost.session.prompt("second branch turn");
		const originalSession = runtimeHost.session;
		const subscribe = vi.spyOn(originalSession.agent, "subscribe");

		let notifyCompactionStarted!: () => void;
		const compactionStarted = new Promise<void>((resolve) => {
			notifyCompactionStarted = resolve;
		});
		let releaseCompaction!: () => void;
		const compactionGate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const runner = originalSession.extensionRunner;
		const originalHasHandlers = runner.hasHandlers.bind(runner);
		vi.spyOn(runner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact" || originalHasHandlers(eventType),
		);
		const originalEmit = runner.emit.bind(runner);
		vi.spyOn(runner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") {
				notifyCompactionStarted();
				await compactionGate;
				return {
					compaction: {
						summary: "must not commit",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return originalEmit(event);
		});

		const compaction = originalSession.compact();
		await compactionStarted;
		const disposal = originalSession.dispose();
		releaseCompaction();

		await expect(compaction).rejects.toThrow("Compaction cancelled");
		await disposal;
		expect(subscribe).not.toHaveBeenCalled();
		expect(originalSession.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("rejects a different session file that collides on the current session ID", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
		});
		await runtimeHost.session.prompt("persist current session");
		const originalSession = runtimeHost.session;
		const currentSessionFile = originalSession.sessionFile;
		expect(currentSessionFile).toBeDefined();
		await originalSession.sessionManager.flush();
		const collisionFile = join(runtimeHost.cwd, "same-id-collision.jsonl");
		copyFileSync(currentSessionFile!, collisionFile);
		const prepare = vi.fn(async () => undefined);
		const rebind = vi.fn(async () => {});
		const replaced = vi.fn();
		runtimeHost.setPrepareSessionReplacement(prepare);
		runtimeHost.setRebindSession(rebind);
		const detach = runtimeHost.subscribeSessionReplaced(replaced);
		const publish = vi.spyOn(runtimeHost.conversationProjectionFeed, "commitSourceRebind");
		events.length = 0;

		await expect(runtimeHost.switchSession(collisionFile)).rejects.toThrow(
			"Cannot replace the current session with a different file using the same session ID",
		);

		expect(runtimeHost.session).toBe(originalSession);
		expect(events).toEqual([]);
		expect(prepare).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
		expect(rebind).not.toHaveBeenCalled();
		expect(replaced).not.toHaveBeenCalled();
		detach();
	});

	it("reserves replacement ownership before invalidating the old runtime", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		runtimeHost.setPrepareSessionReplacement(async () => {
			phases.push("prepare");
			return {
				async commit() {
					phases.push("commit");
				},
				async finalize() {
					phases.push("finalize");
				},
				async rollback() {
					phases.push("rollback");
				},
				async dispose() {
					phases.push("dispose");
				},
			};
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebind");
		});
		const commitSourceRebind = runtimeHost.conversationProjectionFeed.commitSourceRebind.bind(
			runtimeHost.conversationProjectionFeed,
		);
		vi.spyOn(runtimeHost.conversationProjectionFeed, "commitSourceRebind").mockImplementation(() => {
			phases.push("publish");
			commitSourceRebind();
		});

		await runtimeHost.newSession();
		expect(phases).toEqual(["prepare", "session_shutdown", "commit", "publish", "finalize", "rebind"]);
	});

	it("leaves the old runtime live when replacement ownership preflight rejects", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		const originalSessionId = originalSession.sessionId;
		runtimeHost.setPrepareSessionReplacement(async () => {
			throw new Error("target lease occupied");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("target lease occupied");
		expect(runtimeHost.session).toBe(originalSession);
		expect(runtimeHost.session.sessionId).toBe(originalSessionId);
		await expect(runtimeHost.session.prompt("still alive")).resolves.toBeUndefined();
	});

	it("serializes complete structural operations and rejects a queued stale derivation", async () => {
		const shutdownReasons: string[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", (event) => {
				shutdownReasons.push(event.reason);
			});
		});
		let releasePreparation!: () => void;
		let markPreparationStarted!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve;
		});
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let preparationCount = 0;
		runtimeHost.setPrepareSessionReplacement(async () => {
			preparationCount++;
			markPreparationStarted();
			await preparationGate;
			return undefined;
		});

		const first = runtimeHost.newSession();
		await preparationStarted;
		const queuedFromOldSession = runtimeHost.newSession();
		releasePreparation();

		await first;
		await expect(queuedFromOldSession).rejects.toThrow("Stale agent session structural operation");
		expect(preparationCount).toBe(1);
		expect(shutdownReasons).toEqual(["new"]);
	});

	it("leases a stable session across streams and supports nested structural replacement", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releasePreparation!: () => void;
		let markPreparationStarted!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve;
		});
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let prepareCount = 0;
		runtimeHost.setPrepareSessionReplacement(async () => {
			prepareCount++;
			if (prepareCount === 1) {
				markPreparationStarted();
				await preparationGate;
			}
			return undefined;
		});

		const replacement = runtimeHost.newSession();
		await preparationStarted;
		expect(runtimeHost.isSessionOperationInProgress).toBe(true);
		let stableReadStarted = false;
		const stableRead = runtimeHost.runWithStableSession((session) => {
			stableReadStarted = true;
			return session.sessionId;
		});
		await Promise.resolve();
		expect(stableReadStarted).toBe(false);

		releasePreparation();
		await replacement;
		expect(await stableRead).toBe(runtimeHost.session.sessionId);
		expect(runtimeHost.isSessionOperationInProgress).toBe(false);

		const nestedSourceSession = runtimeHost.session;
		const nestedResult = await runtimeHost.runWithStableSession(async (leasedSession) => {
			await runtimeHost.newSession();
			return { leasedSession, replacementSession: runtimeHost.session };
		});
		expect(nestedResult.leasedSession).toBe(nestedSourceSession);
		expect(nestedResult.replacementSession).not.toBe(nestedSourceSession);
	});

	it("rejects interruption acquisition while a replacement generation is unpublished", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		let releasePublication = (): void => {};
		let markPublicationStarted = (): void => {};
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const detach = runtimeHost.subscribeSessionWillProject(async () => {
			markPublicationStarted();
			await publicationGate;
		});

		const replacement = runtimeHost.newSession();
		await publicationStarted;
		const duringReplacement = vi.fn();
		expect(() => runtimeHost.runSessionInterruption(duringReplacement)).toThrow(
			"Agent session generation is changing; retry the interruption",
		);
		expect(duringReplacement).not.toHaveBeenCalled();

		releasePublication();
		await replacement;
		const replacementSession = runtimeHost.session;
		expect(replacementSession).not.toBe(originalSession);
		const afterPublication = vi.fn();
		runtimeHost.runSessionInterruption(afterPublication);
		expect(afterPublication).toHaveBeenCalledOnce();
		expect(afterPublication).toHaveBeenCalledWith(replacementSession);
		detach();
	});

	it("recursively drains fire-and-forget actor children before advancing the lifecycle FIFO", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releaseChild = () => {};
		let markChildStarted = () => {};
		const childStarted = new Promise<void>((resolve) => {
			markChildStarted = resolve;
		});
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let releaseGrandchild = () => {};
		let markGrandchildStarted = () => {};
		const grandchildStarted = new Promise<void>((resolve) => {
			markGrandchildStarted = resolve;
		});
		const grandchildGate = new Promise<void>((resolve) => {
			releaseGrandchild = resolve;
		});

		let rootSettled = false;
		const root = runtimeHost
			.runWithStableSession(async () => {
				void runtimeHost.runWithStableSession(async () => {
					markChildStarted();
					await childGate;
					void runtimeHost.runWithStableSession(async () => {
						markGrandchildStarted();
						await grandchildGate;
					});
				});
				await childStarted;
			})
			.then(() => {
				rootSettled = true;
			});
		await childStarted;

		let followingStarted = false;
		const following = runtimeHost.runWithStableSession(() => {
			followingStarted = true;
		});
		try {
			releaseChild();
			await grandchildStarted;
			await Promise.resolve();
			expect(rootSettled).toBe(false);
			expect(followingStarted).toBe(false);
		} finally {
			releaseChild();
			releaseGrandchild();
		}
		await root;
		await following;
		expect(rootSettled).toBe(true);
		expect(followingStarted).toBe(true);
	});

	it("revokes actor authority from detached descendants after their parent settles", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let triggerDetached = () => {};
		const detachedTrigger = new Promise<void>((resolve) => {
			triggerDetached = resolve;
		});
		let detachedOperation: Promise<void> | undefined;
		let detachedStarted = false;

		await runtimeHost.runWithStableSession(() => {
			void detachedTrigger.then(() => {
				detachedOperation = runtimeHost.runWithStableSession(() => {
					detachedStarted = true;
				});
			});
		});

		let releaseBlocker = () => {};
		let markBlockerStarted = () => {};
		const blockerStarted = new Promise<void>((resolve) => {
			markBlockerStarted = resolve;
		});
		const blockerGate = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		const blocker = runtimeHost.runWithStableSession(async () => {
			markBlockerStarted();
			await blockerGate;
		});
		await blockerStarted;
		try {
			triggerDetached();
			await vi.waitFor(() => expect(detachedOperation).toBeDefined());
			expect(detachedStarted).toBe(false);
		} finally {
			releaseBlocker();
		}
		await blocker;
		await detachedOperation;
		expect(detachedStarted).toBe(true);
	});

	it("orders disposal after an admitted replacement and exposes its drain barrier", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releasePublication!: () => void;
		let markPublicationStarted!: () => void;
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		runtimeHost.subscribeSessionWillProject(async () => {
			markPublicationStarted();
			await publicationGate;
		});

		const replacement = runtimeHost.newSession();
		await publicationStarted;
		let drainSettled = false;
		const drain = runtimeHost.waitForSessionOperations().then(() => {
			drainSettled = true;
		});
		let disposeSettled = false;
		const disposal = runtimeHost.dispose().then(() => {
			disposeSettled = true;
		});
		await Promise.resolve();
		expect(drainSettled).toBe(false);
		expect(disposeSettled).toBe(false);
		await expect(runtimeHost.newSession()).rejects.toThrow(/no longer accepting structural operations/);

		releasePublication();
		await replacement;
		await drain;
		await disposal;
		expect(drainSettled).toBe(true);
		expect(disposeSettled).toBe(true);
	});

	it("handles recovered-input failure without retiring the runtime or leaking payloads", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const warning =
			"Recovered client input processing failed after its durable dispatch boundary; it was not automatically replayed.";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const resume = vi
			.spyOn(runtimeHost.session, "resumeRecoveredClientInputs")
			.mockRejectedValueOnce(new Error("secret queued message contents"))
			.mockResolvedValueOnce();

		const recovery = runtimeHost.startRecoveredClientInputs();
		await expect(recovery).rejects.toThrow("secret queued message contents");
		expect(runtimeHost.diagnostics).toContainEqual({ type: "warning", message: warning });
		expect(warn).toHaveBeenCalledWith(warning);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("secret queued message contents"));
		expect(runtimeHost.session).toBeDefined();
		const retry = runtimeHost.startRecoveredClientInputs();
		expect(retry).not.toBe(recovery);
		await retry;
		expect(runtimeHost.startRecoveredClientInputs()).toBe(retry);
		expect(resume).toHaveBeenCalledTimes(2);
	});

	it("aborts and joins an active recovered-input task during runtime disposal", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releaseRecovery = (): void => {};
		const recoveryGate = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		vi.spyOn(runtimeHost.session, "resumeRecoveredClientInputs").mockReturnValue(recoveryGate);
		const abort = vi.spyOn(runtimeHost.session, "abort").mockResolvedValue();
		void runtimeHost.startRecoveredClientInputs();

		let disposeSettled = false;
		const disposal = runtimeHost.dispose().then(() => {
			disposeSettled = true;
		});
		await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
		await Promise.resolve();
		expect(disposeSettled).toBe(false);

		releaseRecovery();
		await disposal;
		expect(disposeSettled).toBe(true);
	});

	it("captures recovery ownership synchronously before same-tick disposal", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releaseRecovery = (): void => {};
		const recoveryGate = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		const resume = vi.spyOn(runtimeHost.session, "resumeRecoveredClientInputs").mockReturnValue(recoveryGate);
		const recovery = runtimeHost.startRecoveredClientInputs();
		// Regression: the old implementation deferred this call, allowing dispose
		// to abort first and recovery to capture the post-abort generation.
		expect(resume).toHaveBeenCalledOnce();
		const disposal = runtimeHost.dispose();

		releaseRecovery();
		await recovery;
		await disposal;
	});

	it("drains WAL-bearing replacement input before withSession can submit fresh work", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		const targetManager = SessionManager.create(runtimeHost.cwd, runtimeHost.session.sessionManager.getSessionDir());
		targetManager.reserveClientInput("replacement-older", "steer", { message: "older durable input" });
		targetManager.markClientInputQueued("replacement-older", {
			delivery: "steer",
			message: "older durable input",
		});
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		expect(targetFile).toBeDefined();
		faux.setResponses([fauxAssistantMessage("older done"), fauxAssistantMessage("fresh done")]);
		await runtimeHost.startRecoveredClientInputs();
		const phases: string[] = [];

		const switchResult = await runtimeHost.switchSession(targetFile!, {
			withSession: async (ctx) => {
				phases.push(runtimeHost.session.sessionManager.getClientInput("replacement-older")?.state ?? "missing");
				await ctx.sendUserMessage("fresh callback input");
			},
		});
		expect(switchResult).toEqual({ cancelled: false, seeded: true });

		const userTexts = runtimeHost.session.messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join(""),
			);
		expect(phases).toEqual(["completed"]);
		expect(userTexts).toEqual(["older durable input", "fresh callback input"]);
	});

	it("skips fresh replacement callbacks and fences new input when WAL recovery fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const targetManager = SessionManager.create(runtimeHost.cwd, runtimeHost.session.sessionManager.getSessionDir());
		targetManager.reserveClientInput("replacement-retry", "steer", { message: "older durable input" });
		targetManager.markClientInputQueued("replacement-retry", {
			delivery: "steer",
			message: "older durable input",
		});
		await targetManager.flush();
		await runtimeHost.startRecoveredClientInputs();
		const withSession = vi.fn(async () => {});
		const replay = vi
			.spyOn(AgentSession.prototype, "resumeRecoveredClientInputs")
			.mockRejectedValueOnce(new Error("injected recovery failure"));
		try {
			const result = await runtimeHost.switchSession(targetManager.getSessionFile()!, { withSession });
			// The replacement applied, but the skipped callback must be surfaced so
			// callers cannot mistake the non-cancelled result for a completed seed.
			expect(result).toEqual({ cancelled: false, seeded: false });
			expect(withSession).not.toHaveBeenCalled();
			await expect(
				runtimeHost.session.prompt("fresh", { clientMessageId: "fresh-after-failed-recovery" }),
			).rejects.toThrow("Recovered client input must finish replaying");
			expect(runtimeHost.session.sessionManager.getClientInput("fresh-after-failed-recovery")).toBeUndefined();
		} finally {
			replay.mockRestore();
		}
	});

	it("rejects structural replacement instead of orphaning acknowledged durable queue input", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		await originalSession.steer("must stay with old conversation", undefined, "replacement-queued-input");

		await expect(runtimeHost.newSession()).rejects.toThrow(
			"Cannot replace the session while durable client input is still queued",
		);
		expect(runtimeHost.session).toBe(originalSession);
		expect(originalSession.sessionManager.getClientInput("replacement-queued-input")?.state).toBe("accepted");
		expect(originalSession.sessionManager.getRecoverableQueuedClientInputs()).toHaveLength(1);
		expect(originalSession.getSteeringMessages().map((entry) => entry.text)).toEqual([
			"must stay with old conversation",
		]);
	});

	it("rechecks durable queue state after an in-flight prompt admission settles", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		let releaseAdmission!: () => void;
		const admissionGate = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		await runtimeHost.runWithStableSession((stableSession) => {
			const admission = (async () => {
				await admissionGate;
				await stableSession.steer("queued during hook", undefined, "late-admission-queue");
			})();
			runtimeHost.trackClientInputAdmission(stableSession, admission);
		});

		const replacement = runtimeHost.newSession();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(runtimeHost.session).toBe(originalSession);
		releaseAdmission();
		await expect(replacement).rejects.toThrow(
			"Cannot replace the session while durable client input is still queued",
		);
		expect(runtimeHost.session).toBe(originalSession);
		expect(originalSession.sessionManager.getClientInput("late-admission-queue")?.state).toBe("accepted");
	});

	it("blocks session replacement from an identified extension command after dispatch starts", async () => {
		let replacementError: Error | undefined;
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.registerCommand("replace-current", {
				handler: async (_args, ctx) => {
					try {
						await ctx.newSession();
					} catch (error) {
						replacementError = error instanceof Error ? error : new Error(String(error));
						throw error;
					}
				},
			});
		});
		const originalSession = runtimeHost.session;
		await originalSession.bindExtensions({
			commandContextActions: {
				waitForIdle: () => originalSession.waitForIdle(),
				newSession: (options) => runtimeHost.newSession(options),
				fork: async (entryId, options) => {
					const result = await runtimeHost.fork(entryId, options);
					return { cancelled: result.cancelled, seeded: result.seeded };
				},
				navigateTree: async (targetId, options) => {
					const result = await originalSession.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options) => runtimeHost.switchSession(sessionPath, options),
				reload: () => originalSession.reload(),
			},
		});
		const prepare = vi.fn(async () => undefined);
		const rebind = vi.fn(async () => {});
		runtimeHost.setPrepareSessionReplacement(prepare);
		runtimeHost.setRebindSession(rebind);

		await expect(
			originalSession.prompt("/replace-current", { clientMessageId: "extension-replacement-fence" }),
		).resolves.toBeUndefined();

		expect(replacementError?.message).toBe(
			"Cannot replace the session while a durable client input outcome is ambiguous",
		);
		expect(runtimeHost.session).toBe(originalSession);
		expect(originalSession.sessionManager.getClientInput("extension-replacement-fence")?.state).toBe("completed");
		expect(prepare).not.toHaveBeenCalled();
		expect(rebind).not.toHaveBeenCalled();
	});

	it("fences the old feed before staging transcript commits and swapping the runtime session", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		vi.spyOn(SessionManager.prototype, "subscribeEntries").mockImplementationOnce(() => {
			expect(runtimeHost.session).toBe(originalSession);
			expect(() =>
				runtimeHost.conversationProjectionFeed.attach({
					write: () => {},
					buildSnapshot: () => {
						throw new Error("replacement generation must remain unpublished");
					},
				}),
			).toThrow(/awaiting host ownership rekey/);
			throw new Error("transcript subscription failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("transcript subscription failed");
		expect(runtimeHost.session).toBe(originalSession);
		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("disposed feed must not snapshot");
				},
			}),
		).toThrow(/disposed/);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured volt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("notifies independent co-attached replacement listeners", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const first: string[] = [];
		const second: string[] = [];
		const detachFirst = runtimeHost.subscribeSessionReplaced((session) => {
			first.push(session.sessionId);
		});
		runtimeHost.subscribeSessionReplaced((session) => {
			second.push(session.sessionId);
		});

		await runtimeHost.newSession();
		const replacementID = runtimeHost.session.sessionId;
		detachFirst();
		await runtimeHost.newSession();

		expect(first).toEqual([replacementID]);
		expect(second).toEqual([replacementID, runtimeHost.session.sessionId]);
	});

	it("keeps an attached conversation projection healthy while host-only input WAL is committed", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const writes: object[] = [];
		const subscription = runtimeHost.conversationProjectionFeed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
				conversation: { workspaceName: "test", sessionId: runtimeHost.session.sessionId },
				state: {
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					fastModeEnabled: false,
					planning: { mode: "build", plan: null },
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: runtimeHost.session.sessionId,
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
					steeringQueue: [],
					followUpQueue: [],
				},
				transcript: {
					sessionId: runtimeHost.session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			}),
			projectExternal: (event) => ({
				type: "visible-transcript-commit",
				entryType: (event as { entry: { type: string } }).entry.type,
			}),
		});
		await subscription.ready;
		const bootstrapCount = writes.length;
		const manager = runtimeHost.session.sessionManager;

		manager.reserveClientInput("runtime-private-wal", "prompt", { message: "runtime private WAL" });
		manager.transitionClientInput("runtime-private-wal", "started");
		await subscription.flush();
		expect(writes).toHaveLength(bootstrapCount);

		manager.appendPlanningState({ mode: "plan", plan: null });
		await subscription.flush();
		expect(writes).toHaveLength(bootstrapCount);

		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible" }],
			clientMessageId: "runtime-private-wal",
			timestamp: Date.now(),
		});
		await subscription.flush();
		expect(writes.at(-1)).toMatchObject({
			type: "visible-transcript-commit",
			entryType: "message",
			delivery: { subscriptionId: subscription.subscriptionId },
		});

		subscription.requestCheckpoint({
			requestId: "still-healthy",
			lastAppliedCursor: 0,
			reason: "cursor_gap",
		});
		await subscription.flush();
		expect(writes.at(-1)).toMatchObject({ type: "conversation_bootstrap", reason: "resync" });
		subscription.detach();
	});

	it("does not publish a replacement generation before host ownership rekeys", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const phases: string[] = [];
		const writes: object[] = [];
		let releaseRekey!: () => void;
		let markRekeyStarted!: () => void;
		const rekeyStarted = new Promise<void>((resolve) => {
			markRekeyStarted = resolve;
		});
		const rekeyGate = new Promise<void>((resolve) => {
			releaseRekey = resolve;
		});
		const subscription = runtimeHost.conversationProjectionFeed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
				conversation: { workspaceName: "test", sessionId: runtimeHost.session.sessionId },
				state: {
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					fastModeEnabled: false,
					planning: { mode: "build", plan: null },
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: runtimeHost.session.sessionId,
					autoCompactionEnabled: true,
					messageCount: runtimeHost.session.agent.state.messages.length,
					pendingMessageCount: 0,
					steeringQueue: [],
					followUpQueue: [],
				},
				transcript: {
					sessionId: runtimeHost.session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			}),
		});
		await subscription.ready;
		const initialWriteCount = writes.length;
		const detachWillProject = runtimeHost.subscribeSessionWillProject(async () => {
			phases.push("ownership-rekey-started");
			markRekeyStarted();
			await rekeyGate;
			phases.push("ownership-rekeyed");
		});
		const detachReplaced = runtimeHost.subscribeSessionReplaced(() => {
			phases.push("session-rebound");
		});

		const replacement = runtimeHost.newSession();
		await rekeyStarted;
		expect(writes).toHaveLength(initialWriteCount);
		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must remain fenced");
				},
			}),
		).toThrow(/awaiting host ownership rekey/);

		releaseRekey();
		await replacement;
		await subscription.flush();
		expect(phases).toEqual(["ownership-rekey-started", "ownership-rekeyed", "session-rebound"]);
		expect(writes.at(-1)).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			conversation: { sessionId: runtimeHost.session.sessionId },
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});

		detachWillProject();
		detachReplaced();
		subscription.detach();
	});

	it("disposes replacement ownership exactly once when a pre-publication barrier fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const ownershipPhases: string[] = [];
		runtimeHost.setPrepareSessionReplacement(async () => ({
			async commit() {
				ownershipPhases.push("commit");
			},
			async finalize() {
				ownershipPhases.push("finalize");
			},
			async rollback() {
				ownershipPhases.push("rollback");
			},
			async dispose() {
				ownershipPhases.push("dispose");
			},
		}));
		const subscription = runtimeHost.conversationProjectionFeed.attach({
			write: () => {},
			buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
				conversation: { workspaceName: "test", sessionId: runtimeHost.session.sessionId },
				state: {
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					fastModeEnabled: false,
					planning: { mode: "build", plan: null },
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: runtimeHost.session.sessionId,
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
					steeringQueue: [],
					followUpQueue: [],
				},
				transcript: {
					sessionId: runtimeHost.session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			}),
		});
		await subscription.ready;
		const detach = runtimeHost.subscribeSessionWillProject(() => {
			// Real hosts release/dispose their old lease before rejecting this barrier.
			throw new Error("target lease occupied");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("target lease occupied");
		await expect(subscription.flush()).rejects.toThrow(/closed/);
		expect(ownershipPhases).toEqual(["commit", "dispose"]);
		detach();

		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must not build from a disposed replacement");
				},
			}),
		).toThrow(/disposed/);
	});

	it("disposes committed replacement ownership when post-publication rebind fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const ownershipPhases: string[] = [];
		runtimeHost.setPrepareSessionReplacement(async () => ({
			async commit() {
				ownershipPhases.push("commit");
			},
			async finalize() {
				ownershipPhases.push("finalize");
			},
			async rollback() {
				ownershipPhases.push("rollback");
			},
			async dispose() {
				ownershipPhases.push("dispose");
			},
		}));
		runtimeHost.setRebindSession(async () => {
			throw new Error("rebind failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("rebind failed");
		expect(ownershipPhases).toEqual(["commit", "finalize", "dispose"]);
		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must not build from a disposed replacement");
				},
			}),
		).toThrow(/disposed/);
	});

	it("keeps the source session active when fork destination persistence fails", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
		});
		await runtimeHost.session.prompt("source prompt");
		const originalSession = runtimeHost.session;
		const originalSessionId = originalSession.sessionId;
		const targetEntry = originalSession.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!targetEntry) {
			throw new Error("Expected an assistant entry to fork");
		}
		const destinationFailure = new Error("ENOSPC: fork destination write failed");
		const originalFlush = SessionManager.prototype.flush;
		const flush = vi.spyOn(SessionManager.prototype, "flush").mockImplementation(function (this: SessionManager) {
			if (this.getSessionId() !== originalSessionId) {
				return Promise.reject(destinationFailure);
			}
			return originalFlush.call(this);
		});

		try {
			await expect(runtimeHost.fork(targetEntry.id, { position: "at" })).rejects.toBe(destinationFailure);
		} finally {
			flush.mockRestore();
		}

		expect(runtimeHost.session).toBe(originalSession);
		expect(events).toEqual([]);
		await expect(originalSession.prompt("source still works")).resolves.toBeUndefined();
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((volt) => {
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

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true, seeded: false });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true, seeded: false });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
