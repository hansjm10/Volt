import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClientInputConflictError,
	ClientInputOutcomeAmbiguousError,
	QueueClearPersistenceError,
} from "../src/core/agent-session.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import {
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	createClientInputSemanticDigest,
	getDefaultSessionDir,
	isValidClientMessageId,
	type SessionEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	createRemoteConversationTranscriptPage,
	listRemoteWorkspaceSessionSummaries,
} from "../src/daemon/conversation-commands.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

function createTempDir(): string {
	const tempDir = join(tmpdir(), `volt-client-input-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

function createAuthorization(workspacePath: string): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-idempotency-test",
			label: "test",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

describe("durable client input idempotency", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("joins concurrent prompt duplicates and replays completed admission without another model run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("only once")]);

		const options = { clientMessageId: "client-prompt-1" } as const;
		const original = harness.session.prompt("hello", options);
		const duplicate = harness.session.prompt("hello", options);
		await Promise.all([original, duplicate]);

		expect(getUserTexts(harness)).toEqual(["hello"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.sessionManager.getClientInput("client-prompt-1")).toMatchObject({
			command: "prompt",
			state: "completed",
		});

		await harness.session.prompt("hello", options);
		expect(getUserTexts(harness)).toEqual(["hello"]);
	});

	it("rejects reuse of an id for a different semantic input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("original", { clientMessageId: "client-conflict" });

		await expect(harness.session.prompt("different", { clientMessageId: "client-conflict" })).rejects.toBeInstanceOf(
			ClientInputConflictError,
		);
		expect(getUserTexts(harness)).toEqual(["original"]);
	});

	it("removes a live admission when its conversation authority expires during receipt flush", async () => {
		const manager = SessionManager.inMemory();
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("retry completed")]);
		let releaseFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		const flush = vi.spyOn(manager, "flush").mockImplementationOnce(() => flushGate);
		let authorityCurrent = true;

		const first = harness.session.prompt("authority race", {
			clientMessageId: "authority-race",
			assertConversationGenerationCurrent: () => {
				if (!authorityCurrent) throw new Error("stale conversation authority");
			},
		});
		await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
		authorityCurrent = false;
		releaseFlush();
		await expect(first).rejects.toThrow("stale conversation authority");

		await expect(
			harness.session.prompt("authority race", { clientMessageId: "authority-race" }),
		).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["authority race"]);
	});

	it("fences an identified prompt receipt flush against concurrent abort", async () => {
		const manager = SessionManager.inMemory();
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("retry completed")]);
		let releaseFlush!: () => void;
		let markFlushEntered!: () => void;
		const flushEntered = new Promise<void>((resolve) => {
			markFlushEntered = resolve;
		});
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		vi.spyOn(manager, "flush").mockImplementationOnce(() => {
			markFlushEntered();
			return flushGate;
		});

		const promptOutcome = harness.session
			.prompt("abort receipt race", { clientMessageId: "abort-receipt-race" })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await flushEntered;
		await expect(harness.session.abort()).resolves.toBeUndefined();
		releaseFlush();

		expect(await promptOutcome).toMatchObject({
			message: "Client input admission was aborted before its receipt became durable",
		});
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(manager.getClientInput("abort-receipt-race")?.state).toBe("accepted");

		await expect(
			harness.session.prompt("abort receipt race", { clientMessageId: "abort-receipt-race" }),
		).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["abort receipt race"]);
	});

	it("includes exact ordered image bytes and streaming behavior in the semantic identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("image done"), fauxAssistantMessage("behavior done")]);
		const firstImage = { type: "image" as const, mimeType: "image/png", data: "Zmlyc3Q=" };
		const secondImage = { type: "image" as const, mimeType: "image/jpeg", data: "c2Vjb25k" };

		await harness.session.prompt("images", {
			clientMessageId: "client-images",
			images: [firstImage, secondImage],
		});
		await expect(
			harness.session.prompt("images", {
				clientMessageId: "client-images",
				images: [secondImage, firstImage],
			}),
		).rejects.toBeInstanceOf(ClientInputConflictError);
		await expect(
			harness.session.prompt("images", {
				clientMessageId: "client-images",
				images: [firstImage, { ...secondImage, data: "Y2hhbmdlZA==" }],
			}),
		).rejects.toBeInstanceOf(ClientInputConflictError);

		await harness.session.prompt("behavior", {
			clientMessageId: "client-behavior",
			streamingBehavior: "steer",
		});
		await expect(
			harness.session.prompt("behavior", {
				clientMessageId: "client-behavior",
				streamingBehavior: "followUp",
			}),
		).rejects.toBeInstanceOf(ClientInputConflictError);
	});

	it("replays a definitive preflight failure instead of dispatching a retry", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		const first = harness.session.prompt("cannot start", { clientMessageId: "client-failed" });
		await expect(first).rejects.toThrow("No API key found");
		const failedRecord = harness.sessionManager.getClientInput("client-failed");
		expect(failedRecord).toMatchObject({ command: "prompt", state: "failed" });

		await expect(harness.session.prompt("cannot start", { clientMessageId: "client-failed" })).rejects.toThrow(
			"No API key found",
		);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("keeps transport-owned identity when an extension replaces a user message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						return { message: { ...event.message, clientMessageId: "extension-hijack" } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("identity", { clientMessageId: "transport-owned" });

		const user = harness.session.messages.find((message) => message.role === "user");
		expect(user?.clientMessageId).toBe("transport-owned");
		expect(harness.sessionManager.getClientInput("transport-owned")?.state).toBe("completed");
		expect(harness.sessionManager.getClientInput("extension-hijack")).toBeUndefined();
	});

	it("fails closed when an extension changes the role of a transport-identified user message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						return { message: fauxAssistantMessage("role changed") } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});

		await expect(
			harness.session.prompt("identified", { clientMessageId: "role-change-rejected" }),
		).rejects.toMatchObject({ code: "extension_message_role_mismatch" });
		expect(harness.sessionManager.getClientInput("role-change-rejected")?.state).toBe("failed");
		expect(terminalOutcomes).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		await expect(harness.session.prompt("identified", { clientMessageId: "role-change-rejected" })).rejects.toThrow(
			"cannot change the role",
		);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("emits a terminal outcome when an admitted queued input fails during dequeue", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait-for-dequeue-failure",
			label: "Wait",
			description: "Wait for queued input admission",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (
							event.message.role !== "user" ||
							event.message.clientMessageId !== "queued-role-change-rejected"
						) {
							return;
						}
						return { message: fauxAssistantMessage("role changed after admission") } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait-for-dequeue-failure", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool finished"),
			fauxAssistantMessage("must not run"),
		]);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.prompt("fail after dequeue", {
			clientMessageId: "queued-role-change-rejected",
			streamingBehavior: "followUp",
		});
		expect(harness.sessionManager.getClientInput("queued-role-change-rejected")?.state).toBe("accepted");
		releaseTool();

		await expect(run).rejects.toMatchObject({ code: "extension_message_role_mismatch" });
		expect(harness.sessionManager.getClientInput("queued-role-change-rejected")?.state).toBe("failed");
		expect(harness.sessionManager.getClientInputRecoveryPlan()).toEqual({ kind: "idle", records: [] });
		expect(terminalOutcomes).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId: "queued-role-change-rejected",
				outcome: "failed",
				reason: "dispatch_failed",
			},
		]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("persists an ambiguous boundary before a handled command side effect", async () => {
		let sideEffects = 0;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("once", {
						handler: async () => {
							sideEffects++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const transition = harness.sessionManager.transitionClientInput.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "transitionClientInput").mockImplementation((id, state, error) => {
			if (id === "handled-command-once" && state === "completed") {
				throw new Error("injected crash before handled terminal commit");
			}
			return transition(id, state, error);
		});

		await expect(harness.session.prompt("/once", { clientMessageId: "handled-command-once" })).rejects.toThrow(
			"injected crash",
		);
		expect(sideEffects).toBe(1);
		expect(harness.sessionManager.getClientInput("handled-command-once")?.state).toBe("started");
		await expect(harness.session.prompt("/once", { clientMessageId: "handled-command-once" })).rejects.toBeInstanceOf(
			ClientInputOutcomeAmbiguousError,
		);
		expect(sideEffects).toBe(1);
	});

	it("persists an ambiguous boundary before a handled input-hook side effect", async () => {
		let sideEffects = 0;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", () => {
						sideEffects++;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const transition = harness.sessionManager.transitionClientInput.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "transitionClientInput").mockImplementation((id, state, error) => {
			if (id === "handled-input-once" && state === "completed") {
				throw new Error("injected crash before input terminal commit");
			}
			return transition(id, state, error);
		});

		await expect(
			harness.session.prompt("handled by hook", { clientMessageId: "handled-input-once" }),
		).rejects.toThrow("injected crash");
		expect(sideEffects).toBe(1);
		expect(harness.sessionManager.getClientInput("handled-input-once")?.state).toBe("started");
		await expect(
			harness.session.prompt("handled by hook", { clientMessageId: "handled-input-once" }),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
		expect(sideEffects).toBe(1);
	});

	it.each([{ boundary: "command" as const }, { boundary: "input_hook" as const }])(
		"does not cross a persisted $boundary dispatch boundary after concurrent abort",
		async ({ boundary }) => {
			let sideEffects = 0;
			const clientMessageId = `abort-${boundary}-dispatch`;
			const harness = await createHarness({
				extensionFactories: [
					(volt) => {
						if (boundary === "command") {
							volt.registerCommand("side-effect", {
								handler: async () => {
									sideEffects++;
								},
							});
							return;
						}
						volt.on("input", () => {
							sideEffects++;
							return { action: "handled" };
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
			let releaseDispatch!: () => void;
			let markDispatchEntered!: () => void;
			const dispatchEntered = new Promise<void>((resolve) => {
				markDispatchEntered = resolve;
			});
			const dispatchGate = new Promise<void>((resolve) => {
				releaseDispatch = resolve;
			});
			let dispatchGated = false;
			vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
				const watermark = originalFlush();
				if (!dispatchGated && harness.sessionManager.getClientInput(clientMessageId)?.state === "started") {
					dispatchGated = true;
					markDispatchEntered();
					return watermark.then(() => dispatchGate);
				}
				return watermark;
			});

			const promptOutcome = harness.session
				.prompt(boundary === "command" ? "/side-effect" : "handle in input hook", { clientMessageId })
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			await dispatchEntered;
			const abort = harness.session.abort();
			releaseDispatch();
			await abort;

			expect(await promptOutcome).toMatchObject({
				message: "Client input was aborted while persisting its dispatch boundary",
			});
			expect(sideEffects).toBe(0);
			expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("failed");
			expect(harness.sessionManager.getClientInputRecoveryPlan()).toEqual({ kind: "idle", records: [] });
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("enqueues duplicate steer and follow-up inputs once and rejects cross-command id reuse", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});

		await Promise.all([
			harness.session.steer("steer once", undefined, "client-steer"),
			harness.session.steer("steer once", undefined, "client-steer"),
		]);
		await Promise.all([
			harness.session.followUp("follow once", undefined, "client-follow"),
			harness.session.followUp("follow once", undefined, "client-follow"),
		]);

		expect(harness.session.getSteeringMessages()).toMatchObject([
			{ queueEntryId: expect.stringMatching(/^local-queue:/), clientMessageId: "client-steer", text: "steer once" },
		]);
		expect(harness.session.getFollowUpMessages()).toMatchObject([
			{
				queueEntryId: expect.stringMatching(/^local-queue:/),
				clientMessageId: "client-follow",
				text: "follow once",
			},
		]);
		await expect(harness.session.followUp("steer once", undefined, "client-steer")).rejects.toBeInstanceOf(
			ClientInputConflictError,
		);

		await harness.session.clearQueue();
		expect(harness.sessionManager.getClientInput("client-steer")?.state).toBe("failed");
		expect(harness.sessionManager.getClientInput("client-follow")?.state).toBe("failed");
		expect(terminalOutcomes).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId: "client-steer",
				outcome: "failed",
				reason: "queue_cleared",
			},
			{
				type: "client_input_outcome",
				clientMessageId: "client-follow",
				outcome: "failed",
				reason: "queue_cleared",
			},
		]);
	});

	it("revokes runtime queue ownership before awaiting cleared-input durability", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.steer("must not dequeue", undefined, "clear-before-flush");
		let releaseFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		vi.spyOn(harness.sessionManager, "flush").mockReturnValue(flushGate);

		const clearing = harness.session.clearQueue();
		try {
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.sessionManager.getClientInput("clear-before-flush")?.state).toBe("failed");
		} finally {
			releaseFlush();
		}
		await clearing;
	});

	it.each([
		{ command: "steer" as const, clientMessageId: "clear-pending-steer" },
		{ command: "followUp" as const, clientMessageId: "clear-pending-follow" },
	])(
		"keeps a pending $command admission visible to concurrent queue clearing",
		async ({ command, clientMessageId }) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
			let releaseQueueFlush!: () => void;
			let markQueueFlushEntered!: () => void;
			const queueFlushEntered = new Promise<void>((resolve) => {
				markQueueFlushEntered = resolve;
			});
			const queueFlushGate = new Promise<void>((resolve) => {
				releaseQueueFlush = resolve;
			});
			let queueFlushGated = false;
			vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
				const watermark = originalFlush();
				if (!queueFlushGated && harness.sessionManager.getClientInput(clientMessageId)?.queuedInput !== undefined) {
					queueFlushGated = true;
					markQueueFlushEntered();
					return watermark.then(() => queueFlushGate);
				}
				return watermark;
			});

			const queueOutcome = (
				command === "steer"
					? harness.session.steer("clear pending admission", undefined, clientMessageId)
					: harness.session.followUp("clear pending admission", undefined, clientMessageId)
			).then(
				() => undefined,
				(error: unknown) => error,
			);
			await queueFlushEntered;
			try {
				await expect(harness.session.clearQueue()).resolves.toEqual({ steering: [], followUp: [] });
				expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("failed");
			} finally {
				releaseQueueFlush();
			}

			expect(await queueOutcome).toMatchObject({
				message: "Queued input admission was cleared before runtime publication",
			});
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("cancels runtime-only queued input without awaiting unrelated durability", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Local TUI-style queue entries have no durable client identity, so clearing
		// them records nothing and must not inherit an earlier persistence failure.
		await harness.session.steer("steered draft");
		await harness.session.followUp("follow-up draft");

		const flush = vi.spyOn(harness.sessionManager, "flush").mockRejectedValue(new Error("ENOSPC"));
		try {
			await expect(harness.session.clearQueue()).resolves.toEqual({
				steering: ["steered draft"],
				followUp: ["follow-up draft"],
			});
			expect(flush).not.toHaveBeenCalled();
		} finally {
			flush.mockRestore();
		}
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("carries the cleared queue text on the error when cancellation cannot be persisted", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.steer("steered draft", undefined, "clear-steer-flush-failure");
		await harness.session.followUp("follow-up draft", undefined, "clear-follow-flush-failure");

		const flushFailure = new Error("ENOSPC: no space left on device");
		const flush = vi.spyOn(harness.sessionManager, "flush").mockRejectedValue(flushFailure);
		let thrown: unknown;
		try {
			await harness.session.clearQueue();
		} catch (error) {
			thrown = error;
		} finally {
			flush.mockRestore();
		}

		// The runtime queues are revoked before durability is awaited, so the error
		// holds the only surviving copy of what the user typed.
		expect(thrown).toBeInstanceOf(QueueClearPersistenceError);
		const persistenceError = thrown as QueueClearPersistenceError;
		expect(persistenceError.steering).toEqual(["steered draft"]);
		expect(persistenceError.followUp).toEqual(["follow-up draft"]);
		expect(persistenceError.cause).toBe(flushFailure);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("revokes identified queues when terminal persistence rejects synchronously", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		await harness.session.steer("restore steer", undefined, "clear-closed-steer");
		await harness.session.followUp("restore follow-up", undefined, "clear-closed-follow");
		await manager.closePersistence();

		let thrown: unknown;
		try {
			await harness.session.clearQueue();
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(QueueClearPersistenceError);
		const persistenceError = thrown as QueueClearPersistenceError;
		expect(persistenceError.cause).toMatchObject({ message: "Session persistence is closed" });
		expect(persistenceError.steering).toEqual(["restore steer"]);
		expect(persistenceError.followUp).toEqual(["restore follow-up"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		await expect(harness.session.steer("restore steer", undefined, "clear-closed-steer")).rejects.toThrow(
			"Session persistence is closed",
		);
		await expect(harness.session.followUp("restore follow-up", undefined, "clear-closed-follow")).rejects.toThrow(
			"Session persistence is closed",
		);
	});

	it("keeps local runtime queue identities outside the forgeable client ID domain", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.steer("local queued input");
		const localQueueId = harness.session.getSteeringMessages()[0]?.queueEntryId;
		if (!localQueueId) throw new Error("missing local queue identity");
		expect(localQueueId).toMatch(/^local-queue:/);
		expect(isValidClientMessageId(localQueueId)).toBe(false);

		await expect(harness.session.steer("forged remote collision", undefined, localQueueId)).rejects.toThrow(
			"Client input id must match",
		);
		expect(harness.session.getSteeringMessages().map((entry) => entry.text)).toEqual(["local queued input"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it.each([
		{ command: "steer" as const, clientMessageId: "failed-steer-enqueue" },
		{ command: "followUp" as const, clientMessageId: "failed-follow-enqueue" },
	])(
		"rolls back projection admission when agent-core $command enqueue fails",
		async ({ command, clientMessageId }) => {
			const tempDir = createTempDir();
			tempDirs.push(tempDir);
			const manager = SessionManager.create(tempDir, tempDir);
			const harness = await createHarness({ sessionManager: manager });
			harnesses.push(harness);
			const queueUpdates: unknown[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "queue_update") queueUpdates.push(event);
			});
			vi.spyOn(harness.session.agent, command).mockImplementation(() => {
				throw new Error(`injected ${command} enqueue failure`);
			});

			await expect(
				command === "steer"
					? harness.session.steer("must not project", undefined, clientMessageId)
					: harness.session.followUp("must not project", undefined, clientMessageId),
			).rejects.toThrow(`injected ${command} enqueue failure`);
			expect(manager.getClientInput(clientMessageId)).toMatchObject({ state: "failed" });
			expect(manager.getRecoverableQueuedClientInputs()).toEqual([]);
			await manager.flush();
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(queueUpdates).toEqual([]);
			expect(
				readFileSync(manager.getSessionFile()!, "utf8")
					.trim()
					.split("\n")
					.map((line) => (JSON.parse(line) as { type: string }).type),
			).toEqual(["session", "client_input_receipt", "client_input_queued", "client_input_state"]);
		},
	);

	it("keeps durable and core queue admission authoritative when a projection listener throws", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") throw new Error("injected projection listener failure");
		});

		await expect(harness.session.steer("survives observer", undefined, "observer-safe")).resolves.toBeUndefined();
		expect(manager.getClientInput("observer-safe")).toMatchObject({ state: "accepted" });
		expect(manager.getRecoverableQueuedClientInputs()).toMatchObject([
			{ clientMessageId: "observer-safe", queuedInput: { delivery: "steer", message: "survives observer" } },
		]);
		expect(harness.session.getSteeringMessages()).toMatchObject([
			{
				queueEntryId: expect.stringMatching(/^local-queue:/),
				clientMessageId: "observer-safe",
				text: "survives observer",
			},
		]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("commits pass-through and transformed input-hook queues back to exact recoverable payloads", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for queued hook admission",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			sessionManager,
			tools: [waitTool],
			extensionFactories: [
				(volt) => {
					volt.on("input", (event) =>
						event.text === "queued transform"
							? { action: "transform", text: "queued transformed", images: event.images }
							: { action: "continue" },
					);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after tool"),
			fauxAssistantMessage("pass done"),
			fauxAssistantMessage("transform done"),
		]);

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.prompt("queued pass", {
			clientMessageId: "hook-queue-pass",
			streamingBehavior: "followUp",
		});
		await harness.session.prompt("queued transform", {
			clientMessageId: "hook-queue-transform",
			streamingBehavior: "followUp",
		});
		expect(harness.sessionManager.getClientInput("hook-queue-pass")?.state).toBe("accepted");
		expect(harness.sessionManager.getClientInput("hook-queue-transform")?.state).toBe("accepted");
		await harness.sessionManager.flush();
		const reopened = SessionManager.open(
			harness.sessionManager.getSessionFile()!,
			harness.sessionManager.getSessionDir(),
		);
		expect(reopened.getRecoverableQueuedClientInputs()).toMatchObject([
			{ clientMessageId: "hook-queue-pass", queuedInput: { message: "queued pass" } },
			{ clientMessageId: "hook-queue-transform", queuedInput: { message: "queued transformed" } },
		]);

		releaseTool();
		await run;
		await harness.sessionManager.flush();
		for (const clientMessageId of ["hook-queue-pass", "hook-queue-transform"]) {
			expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
			const entries = readFileSync(harness.sessionManager.getSessionFile()!, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as SessionEntry);
			const states = entries
				.filter((entry) => entry.type === "client_input_state" && entry.clientMessageId === clientMessageId)
				.map((entry) => (entry.type === "client_input_state" ? entry.state : undefined));
			// Input-hook dispatch and later queue consumption are distinct
			// side-effectful attempts separated by durable queue re-admission.
			expect(states).toEqual(["started", "started"]);
			// The canonical identified user entry is itself the durable completion
			// boundary; no redundant client_input_state terminal marker is required.
			expect(
				entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.clientMessageId === clientMessageId,
				),
			).toBe(true);
			const completed = SessionManager.open(
				harness.sessionManager.getSessionFile()!,
				harness.sessionManager.getSessionDir(),
			);
			expect(completed.getClientInput(clientMessageId)?.state).toBe("completed");
		}
	});

	it("persists the dispatch boundary before dequeued input reaches extension hooks", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test gate",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		let stateImmediatelyAfterClear: string | undefined;
		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				event.message.clientMessageId === "client-consuming"
			) {
				void harness.session.clearQueue();
				stateImmediatelyAfterClear = harness.sessionManager.getClientInput("client-consuming")?.state;
			}
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("consume me", undefined, "client-consuming");
		releaseTool();
		await run;

		expect(stateImmediatelyAfterClear).toBe("started");
		expect(harness.sessionManager.getClientInput("client-consuming")?.state).toBe("completed");
	});

	it.each([
		{ command: "steer" as const, clientMessageId: "steer-dispatch-flush-failure" },
		{ command: "followUp" as const, clientMessageId: "follow-dispatch-flush-failure" },
	])("fences a dequeued $command when its started boundary is not durable", async ({ command, clientMessageId }) => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait-for-dispatch-flush-failure",
			label: "Wait",
			description: "Wait for queued dispatch",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait-for-dispatch-flush-failure", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("current turn done"),
			fauxAssistantMessage("queued turn must not run"),
		]);
		const run = harness.session.prompt("start").catch(() => {});
		await toolStarted;
		const queuedText = `${command} must not run`;
		await (command === "steer"
			? harness.session.steer(queuedText, undefined, clientMessageId)
			: harness.session.followUp(queuedText, undefined, clientMessageId));

		const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
		const dispatchFailure = new Error(`injected ${command} dispatch flush failure`);
		let rejectedDispatch = false;
		vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
			if (!rejectedDispatch && harness.sessionManager.getClientInput(clientMessageId)?.state === "started") {
				rejectedDispatch = true;
				return Promise.reject(dispatchFailure);
			}
			return originalFlush();
		});

		releaseTool();
		await vi.waitFor(() => expect(rejectedDispatch).toBe(true));
		await run;
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(false));

		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("started");
		expect(getUserTexts(harness)).not.toContain(queuedText);
		await expect(
			command === "steer"
				? harness.session.steer(queuedText, undefined, clientMessageId)
				: harness.session.followUp(queuedText, undefined, clientMessageId),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
	});

	it("does not publish a dequeued message after concurrent queue clearing", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the dequeue race",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const publishedClientIds: string[] = [];
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(volt) => {
					volt.on("message_start", (event) => {
						if (event.message.role === "user" && event.message.clientMessageId) {
							publishedClientIds.push(event.message.clientMessageId);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const run = harness.session.prompt("start").catch(() => {});
		await toolStarted;
		await harness.session.steer("cancel during dequeue", undefined, "clear-dequeue-race");

		const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
		let releaseDispatch!: () => void;
		let markDispatchEntered!: () => void;
		const dispatchEntered = new Promise<void>((resolve) => {
			markDispatchEntered = resolve;
		});
		const dispatchGate = new Promise<void>((resolve) => {
			releaseDispatch = resolve;
		});
		let dispatchGated = false;
		vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
			const watermark = originalFlush();
			if (!dispatchGated && harness.sessionManager.getClientInput("clear-dequeue-race")?.state === "started") {
				dispatchGated = true;
				markDispatchEntered();
				return watermark.then(() => dispatchGate);
			}
			return watermark;
		});

		releaseTool();
		await dispatchEntered;
		try {
			await harness.session.clearQueue();
		} finally {
			releaseDispatch();
		}
		await run;

		expect(publishedClientIds).not.toContain("clear-dequeue-race");
		expect(harness.sessionManager.getClientInput("clear-dequeue-race")?.state).toBe("failed");
		expect(getUserTexts(harness)).not.toContain("cancel during dequeue");
	});

	it("starts an accepted-but-not-started receipt after JSONL reload", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("client-accepted", "prompt", { message: "resume me" });
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		const reopened = SessionManager.open(sessionFile!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("resumed")]);

		await harness.session.prompt("resume me", { clientMessageId: "client-accepted" });
		expect(getUserTexts(harness)).toEqual(["resume me"]);
		expect(reopened.getClientInput("client-accepted")?.state).toBe("completed");
	});

	it("reloads exact queued inputs in durable admission order and deduplicates the queue record", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const image = { type: "image" as const, mimeType: "image/png", data: "b3JpZ2luYWw=" };
		manager.reserveClientInput("queued-a", "steer", { message: "original a", images: [image] });
		manager.reserveClientInput("queued-b", "prompt", {
			message: "original b",
			streamingBehavior: "followUp",
		});
		manager.markClientInputQueued("queued-b", {
			delivery: "follow_up",
			message: "expanded b",
		});
		manager.markClientInputQueued("queued-a", {
			delivery: "steer",
			message: "expanded a",
			images: [image],
		});
		manager.markClientInputQueued("queued-a", {
			delivery: "steer",
			message: "expanded a",
			images: [image],
		});
		image.data = "bXV0YXRlZA==";
		await manager.flush();

		const queuedEntries = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string })
			.filter((entry) => entry.type === "client_input_queued");
		expect(queuedEntries).toHaveLength(2);
		expect(() =>
			manager.markClientInputQueued("queued-a", {
				delivery: "steer",
				message: "conflicting expansion",
			}),
		).toThrow("conflicting queued payload");

		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		expect(reopened.getRecoverableQueuedClientInputs()).toMatchObject([
			{
				clientMessageId: "queued-b",
				command: "prompt",
				state: "accepted",
				input: { message: "original b", images: [], streamingBehavior: "followUp" },
				queuedInput: { delivery: "follow_up", message: "expanded b", images: [] },
			},
			{
				clientMessageId: "queued-a",
				command: "steer",
				state: "accepted",
				input: {
					message: "original a",
					images: [{ type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" }],
				},
				queuedInput: {
					delivery: "steer",
					message: "expanded a",
					images: [{ type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" }],
				},
			},
		]);
	});

	it("fences later durable queue entries behind an ambiguous started predecessor", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("ambiguous-a", "steer", { message: "older a" });
		manager.markClientInputQueued("ambiguous-a", { delivery: "steer", message: "older a" });
		manager.reserveClientInput("queued-b", "follow_up", { message: "later b" });
		manager.markClientInputQueued("queued-b", { delivery: "follow_up", message: "later b" });
		manager.transitionClientInput("ambiguous-a", "started");
		await manager.flush();

		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
			kind: "blocked",
			blocker: { clientMessageId: "ambiguous-a", state: "started" },
			records: [{ clientMessageId: "queued-b", state: "accepted" }],
		});
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		expect(harness.session.getFollowUpMessages()).toMatchObject([{ clientMessageId: "queued-b", text: "later b" }]);
		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toBeInstanceOf(
			ClientInputOutcomeAmbiguousError,
		);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reopened.getClientInput("queued-b")?.state).toBe("accepted");

		await expect(harness.session.prompt("fresh c", { clientMessageId: "fresh-c" })).rejects.toThrow(
			"Ambiguous recovered client input",
		);
		expect(reopened.getClientInput("fresh-c")).toBeUndefined();
		await expect(harness.session.steer("older a", undefined, "ambiguous-a")).rejects.toBeInstanceOf(
			ClientInputOutcomeAmbiguousError,
		);
		await expect(harness.session.followUp("later b", undefined, "queued-b")).resolves.toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("restores every still-accepted queue after recovered dispatch fails before canonical append", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("recover-steer", "steer", { message: "steer original" });
		manager.markClientInputQueued("recover-steer", { delivery: "steer", message: "steer expanded" });
		manager.reserveClientInput("recover-follow", "follow_up", { message: "follow original" });
		manager.markClientInputQueued("recover-follow", { delivery: "follow_up", message: "follow expanded" });
		await manager.flush();
		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_runAgentPrompt(): Promise<void>;
		};
		internals._runAgentPrompt = async () => {
			throw new Error("injected failure before canonical append");
		};

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow(
			"injected failure before canonical append",
		);
		expect(reopened.getClientInput("recover-steer")?.state).toBe("accepted");
		expect(reopened.getClientInput("recover-follow")?.state).toBe("accepted");
		expect(reopened.getRecoverableQueuedClientInputs()).toHaveLength(2);
		expect(harness.session.getSteeringMessages()).toMatchObject([
			{
				queueEntryId: expect.stringMatching(/^local-queue:/),
				clientMessageId: "recover-steer",
				text: "steer expanded",
			},
		]);
		expect(harness.session.getFollowUpMessages()).toMatchObject([
			{
				queueEntryId: expect.stringMatching(/^local-queue:/),
				clientMessageId: "recover-follow",
				text: "follow expanded",
			},
		]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("does not let a failed recovered dispatch replay outrank its durable ambiguity fence", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("recover-started", "steer", { message: "recover me" });
		manager.markClientInputQueued("recover-started", { delivery: "steer", message: "recover me" });
		await manager.flush();
		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_handleAgentEvent(event: object): Promise<unknown>;
			_runAgentPrompt(message: object): Promise<void>;
		};
		internals._runAgentPrompt = async (message) => {
			await internals._handleAgentEvent({ type: "message_start", message });
			throw new Error("injected failure after message_start before canonical append");
		};

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow(
			"injected failure after message_start before canonical append",
		);
		expect(reopened.getClientInput("recover-started")?.state).toBe("started");
		expect(reopened.buildSessionContext().messages).toEqual([]);
		await expect(harness.session.steer("recover me", undefined, "recover-started")).rejects.toMatchObject({
			code: "client_input_outcome_ambiguous",
		});
	});

	it("rejects and restores recovery when prompt entry is cancelled without throwing", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("recover-silent-cancel", "steer", { message: "original" });
		manager.markClientInputQueued("recover-silent-cancel", { delivery: "steer", message: "expanded" });
		await manager.flush();
		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		const internals = harness.session as unknown as { _runAgentPrompt(): Promise<void> };
		internals._runAgentPrompt = async () => {};

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow(
			"stopped before its canonical user message committed",
		);
		expect(reopened.getClientInput("recover-silent-cancel")?.state).toBe("accepted");
		expect(reopened.getRecoverableQueuedClientInputs()).toHaveLength(1);
		expect(harness.session.getSteeringMessages()).toMatchObject([
			{
				queueEntryId: expect.stringMatching(/^local-queue:/),
				clientMessageId: "recover-silent-cancel",
				text: "expanded",
			},
		]);
	});

	it("does not resurrect recovered input after its canonical append commits", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("recover-committed", "steer", { message: "original" });
		manager.markClientInputQueued("recover-committed", { delivery: "steer", message: "expanded" });
		await manager.flush();
		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_handleAgentEvent(event: object): Promise<unknown>;
			_runAgentPrompt(): Promise<void>;
		};
		internals._runAgentPrompt = async () => {
			await internals._handleAgentEvent({
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "text", text: "expanded" }],
					clientMessageId: "recover-committed",
					timestamp: Date.now(),
				},
			});
			await internals._handleAgentEvent({
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "expanded" }],
					clientMessageId: "recover-committed",
					timestamp: Date.now(),
				},
			});
			throw new Error("injected failure after canonical append");
		};

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow(
			"injected failure after canonical append",
		);
		expect(reopened.getClientInput("recover-committed")?.state).toBe("completed");
		expect(reopened.getRecoverableQueuedClientInputs()).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(reopened.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "expanded" }], clientMessageId: "recover-committed" },
		]);
		await expect(harness.session.steer("original", undefined, "recover-committed")).resolves.toBeUndefined();
		expect(reopened.buildSessionContext().messages).toHaveLength(1);
	});

	it("fails closed before persisting an oversized queued replay payload", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("queued-oversized", "steer", { message: "small original" });
		await manager.flush();

		expect(() =>
			manager.markClientInputQueued("queued-oversized", {
				delivery: "steer",
				message: "\0".repeat(400 * 1024),
			}),
		).toThrow("serialized limit");
		expect(manager.getClientInput("queued-oversized")?.state).toBe("accepted");
		expect(manager.getClientInput("queued-oversized")?.queuedInput).toBeUndefined();
		expect(manager.getRecoverableQueuedClientInputs()).toEqual([]);
	});

	it("bounds aggregate outstanding receipt and queued payload memory", () => {
		const manager = SessionManager.inMemory();
		const nearMaximumMessage = "x".repeat(512 * 1024 - 1024);
		let aggregateError: Error | undefined;
		for (let index = 0; index < 128; index++) {
			const clientMessageId = `aggregate-${index}`;
			try {
				manager.reserveClientInput(clientMessageId, "steer", { message: nearMaximumMessage });
				manager.markClientInputQueued(clientMessageId, {
					delivery: "steer",
					message: nearMaximumMessage,
				});
			} catch (error) {
				aggregateError = error instanceof Error ? error : new Error(String(error));
				break;
			}
		}

		expect(aggregateError?.message).toContain("aggregate limit");
		expect(manager.getRecoverableQueuedClientInputs().length).toBeGreaterThan(1);
		expect(manager.getRecoverableQueuedClientInputs().length).toBeLessThan(128);
	});

	it("caps tiny live receipts while input preflight is stalled", async () => {
		let releasePreflight!: () => void;
		let enteredPreflight = 0;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", async () => {
						enteredPreflight++;
						await preflightGate;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);

		const admitted = Array.from({ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES }, (_, index) =>
			harness.session.prompt("x", { clientMessageId: `slow-preflight-${index}` }),
		);
		const overflow = harness.session.prompt("x", { clientMessageId: "slow-preflight-overflow" });
		const overflowError = overflow.then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.waitFor(() => expect(enteredPreflight).toBeGreaterThan(0));
		expect(await overflowError).toMatchObject({
			message: `Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES}-entry limit`,
		});
		expect(harness.sessionManager.getClientInput("slow-preflight-overflow")).toBeUndefined();

		releasePreflight();
		await expect(Promise.all(admitted)).resolves.toHaveLength(CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES);
		expect(harness.sessionManager.getClientInput("slow-preflight-0")?.state).toBe("completed");
		expect(
			harness.sessionManager.getClientInput(`slow-preflight-${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES - 1}`)?.state,
		).toBe("completed");
	});

	it("fails closed when a v5 recovery file exceeds the outstanding receipt count cap", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionFile = join(tempDir, "outstanding-count-overflow-v5.jsonl");
		const timestamp = new Date().toISOString();
		const input = { message: "x", images: [] };
		const semanticDigest = createClientInputSemanticDigest("prompt", input);
		const receipts = Array.from({ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES + 1 }, (_, index) => ({
			type: "client_input_receipt",
			id: `receipt-${index}`,
			parentId: null,
			timestamp,
			ordinal: index + 1,
			clientMessageId: `count-overflow-${index}`,
			command: "prompt",
			semanticDigest,
			input,
		}));
		writeFileSync(
			sessionFile,
			`${[{ type: "session", version: 5, id: "outstanding-count-overflow-v5", timestamp, cwd: tempDir }, ...receipts]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		expect(() => SessionManager.open(sessionFile, tempDir)).toThrow(
			`Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES}-entry limit`,
		);
	});

	it("counts a started receipt's original payload when it is durably re-admitted to the queue", () => {
		const manager = SessionManager.inMemory();
		const nearMaximumMessage = "x".repeat(512 * 1024 - 1024);
		for (let index = 0; index < 32; index++) {
			manager.reserveClientInput(`started-budget-${index}`, "steer", { message: nearMaximumMessage });
		}
		manager.transitionClientInput("started-budget-0", "started");

		expect(() =>
			manager.markClientInputQueued("started-budget-0", {
				delivery: "steer",
				message: "q".repeat(64 * 1024),
			}),
		).toThrow("aggregate limit");
		expect(manager.getClientInput("started-budget-0")?.state).toBe("started");
		expect(manager.getClientInput("started-budget-0")?.queuedInput).toBeUndefined();
	});

	it("blocks fresh input from overtaking a durable queue restored after restart", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("recovered-older", "steer", { message: "older" });
		manager.markClientInputQueued("recovered-older", { delivery: "steer", message: "older" });
		await manager.flush();
		const reopened = SessionManager.open(manager.getSessionFile()!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);

		await expect(harness.session.prompt("fresh", { clientMessageId: "fresh-after-recovery" })).rejects.toThrow(
			"Recovered client input must finish replaying",
		);
		expect(reopened.getClientInput("fresh-after-recovery")).toBeUndefined();
		// An idempotent retry of the older receipt still joins its original
		// accepted outcome instead of creating or reordering work.
		await expect(harness.session.steer("older", undefined, "recovered-older")).resolves.toBeUndefined();

		await harness.session.clearQueue();
		harness.setResponses([fauxAssistantMessage("fresh done")]);
		await expect(harness.session.prompt("fresh", { clientMessageId: "fresh-after-clear" })).resolves.toBeUndefined();
		expect(reopened.getClientInput("fresh-after-clear")?.state).toBe("completed");
	});

	it("admits only canonical bounded ASCII client identities", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.inMemory();
		const maximumId = `client:${"x".repeat(249)}`;

		expect(maximumId).toHaveLength(256);
		expect(isValidClientMessageId(maximumId)).toBe(true);
		expect(manager.reserveClientInput(maximumId, "prompt", { message: "valid" }).record.state).toBe("accepted");
		for (const invalidId of [
			"",
			"-starts-with-punctuation",
			"contains space",
			"contains\ttab",
			"contains\nnewline",
			'contains"quote',
			"contains\\backslash",
			"é",
			`client-${"x".repeat(250)}`,
		]) {
			expect(isValidClientMessageId(invalidId)).toBe(false);
			expect(() => manager.reserveClientInput(invalidId, "prompt", { message: "invalid" })).toThrow(
				"Client input id must match",
			);
		}
	});

	it("fails closed when a durable receipt contains a noncanonical escaped identity", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionFile = join(tempDir, "invalid-identity-v5.jsonl");
		const timestamp = new Date().toISOString();
		const invalidId = `client-${"\0".repeat(40)}`;
		const input = { message: "must not reload", images: [] };
		const validManager = SessionManager.inMemory();
		const semanticDigest = validManager.reserveClientInput("digest-source", "prompt", input).record.semanticDigest;
		writeFileSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, id: "invalid-identity-v5", timestamp, cwd: tempDir },
				{
					type: "client_input_receipt",
					id: "invalid-identity-receipt",
					parentId: null,
					timestamp,
					ordinal: 1,
					clientMessageId: invalidId,
					command: "prompt",
					semanticDigest,
					input,
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		expect(Buffer.byteLength(invalidId, "utf8")).toBeLessThanOrEqual(256);
		expect(JSON.stringify(invalidId).length).toBeGreaterThan(invalidId.length);
		expect(() => SessionManager.open(sessionFile, tempDir)).toThrow("Client input id must match");
	});

	it("migrates a v4 session by dropping unreplayable legacy WAL and preserving canonical transcript", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionFile = join(tempDir, "legacy-v4.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			sessionFile,
			`${[
				{ type: "session", version: 4, id: "legacy-v4", timestamp, cwd: tempDir },
				{
					type: "client_input_receipt",
					id: "legacy-receipt",
					parentId: null,
					timestamp,
					ordinal: 1,
					clientMessageId: "legacy-client-id",
					command: "prompt",
					semanticDigest: "legacy-digest-without-payload",
				},
				{
					type: "client_input_state",
					id: "legacy-started",
					parentId: null,
					timestamp,
					ordinal: 2,
					receiptId: "legacy-receipt",
					clientMessageId: "legacy-client-id",
					state: "started",
				},
				{
					type: "message",
					id: "canonical-user",
					parentId: null,
					timestamp,
					ordinal: 3,
					message: {
						role: "user",
						content: [{ type: "text", text: "canonical survives" }],
						clientMessageId: "legacy-client-id",
						timestamp: Date.now(),
					},
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const onDiskBeforeOpen = readFileSync(sessionFile, "utf8");

		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getHeader()?.version).toBe(5);
		expect(reopened.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "canonical survives" }] },
		]);
		expect(reopened.getClientInput("legacy-client-id")).toBeUndefined();
		// Readers project the current schema in memory but never rewrite another
		// lease owner's file. The first actual writer commits the migration.
		expect(readFileSync(sessionFile, "utf8")).toBe(onDiskBeforeOpen);
		reopened.appendCustomMessageEntry("migration-test", "writer acquired", true);
		await reopened.flush();
		expect(
			readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { type: string }).type),
		).toEqual(["session", "message", "custom_message"]);
	});

	it("fails closed when a v5 durable receipt is missing its replay payload", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionFile = join(tempDir, "invalid-v5.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, id: "invalid-v5", timestamp, cwd: tempDir },
				{
					type: "client_input_receipt",
					id: "invalid-receipt",
					parentId: null,
					timestamp,
					ordinal: 1,
					clientMessageId: "missing-payload",
					command: "steer",
					semanticDigest: "invalid",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		expect(() => SessionManager.open(sessionFile, tempDir)).toThrow("receipt payload is invalid");
	});

	it("fails closed for invalid v5 WAL state, error, and commit ordinal fields", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("wal-fields", "steer", { message: "original" });
		manager.markClientInputQueued("wal-fields", { delivery: "steer", message: "queued" });
		manager.transitionClientInput("wal-fields", "started");
		await manager.flush();
		const entries = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const stateIndex = entries.findIndex((entry) => entry.type === "client_input_state");
		const queuedIndex = entries.findIndex((entry) => entry.type === "client_input_queued");
		expect(stateIndex).toBeGreaterThan(0);
		expect(queuedIndex).toBeGreaterThan(0);

		for (const [name, mutate, expected] of [
			[
				"invalid-state",
				(copy: Array<Record<string, unknown>>) => {
					copy[stateIndex]!.state = "bogus";
				},
				"invalid state",
			],
			[
				"invalid-error",
				(copy: Array<Record<string, unknown>>) => {
					copy[stateIndex]!.error = "not allowed for started";
				},
				"invalid error",
			],
			[
				"missing-ordinal",
				(copy: Array<Record<string, unknown>>) => {
					delete copy[queuedIndex]!.ordinal;
				},
				"invalid commit ordinal",
			],
		] as const) {
			const copy = structuredClone(entries);
			mutate(copy);
			const candidate = join(tempDir, `${name}.jsonl`);
			writeFileSync(candidate, `${copy.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			expect(() => SessionManager.open(candidate, tempDir)).toThrow(expected);
		}
	});

	it("fails closed when a committed interior JSONL line could hide a dispatch boundary", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("interior-corruption", "steer", { message: "original" });
		manager.markClientInputQueued("interior-corruption", { delivery: "steer", message: "queued" });
		manager.transitionClientInput("interior-corruption", "started");
		manager.appendCustomMessageEntry("later-valid-entry", "later", true);
		await manager.flush();
		const lines = readFileSync(manager.getSessionFile()!, "utf8").trim().split("\n");
		const stateIndex = lines.findIndex(
			(line) => (JSON.parse(line) as { type: string }).type === "client_input_state",
		);
		expect(stateIndex).toBeGreaterThan(0);
		lines[stateIndex] = '{"type":"client_input_state"';
		writeFileSync(manager.getSessionFile()!, `${lines.join("\n")}\n`);

		expect(() => SessionManager.open(manager.getSessionFile()!, tempDir)).toThrow(
			/JSONL is malformed at committed line/,
		);
	});

	it("fails closed for a started receipt with no terminal record after JSONL reload", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("client-started", "prompt", { message: "do not replay" });
		manager.transitionClientInput("client-started", "started");
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const reopened = SessionManager.open(sessionFile!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await expect(
			harness.session.prompt("do not replay", { clientMessageId: "client-started" }),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("infers completion from the canonical user entry when rebuilding the all-entry index", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("client-canonical", "prompt", { message: "committed" });
		manager.transitionClientInput("client-canonical", "started");
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "committed" }],
			clientMessageId: "client-canonical",
			timestamp: Date.now(),
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const reopened = SessionManager.open(sessionFile!, tempDir);
		expect(reopened.getClientInput("client-canonical")?.state).toBe("completed");
		expect(reopened.buildSessionContext().messages).toHaveLength(1);
	});

	it.each([
		{ boundary: "missing", expected: "has no matching durable receipt" },
		{ boundary: "accepted", expected: "requires a started receipt; found accepted" },
		{ boundary: "failed", expected: "requires a started receipt; found failed" },
		{ boundary: "completed", expected: "requires a started receipt; found completed" },
		{ boundary: "duplicate", expected: "requires a started receipt; found completed" },
		{ boundary: "reordered", expected: "has no matching durable receipt" },
	])("rejects a $boundary canonical boundary when reopening v5", ({ boundary, expected }) => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionFile = join(tempDir, `canonical-${boundary}-v5.jsonl`);
		const timestamp = new Date().toISOString();
		const clientMessageId = `canonical-${boundary}`;
		const input = { message: "canonical", images: [] };
		const semanticDigest = createClientInputSemanticDigest("prompt", input);
		let ordinal = 0;
		const nextBase = (id: string) => ({
			id,
			parentId: null,
			timestamp,
			ordinal: ++ordinal,
		});
		const receipt = () => ({
			type: "client_input_receipt",
			...nextBase(`${boundary}-receipt`),
			clientMessageId,
			command: "prompt",
			semanticDigest,
			input,
		});
		const state = (value: "started" | "completed" | "failed") => ({
			type: "client_input_state",
			...nextBase(`${boundary}-${value}`),
			receiptId: `${boundary}-receipt`,
			clientMessageId,
			state: value,
		});
		const canonical = (suffix = "canonical") => ({
			type: "message",
			...nextBase(`${boundary}-${suffix}`),
			message: {
				role: "user",
				content: [{ type: "text", text: "canonical" }],
				clientMessageId,
				timestamp: Date.now(),
			},
		});
		const entries: object[] = [];
		switch (boundary) {
			case "missing":
				entries.push(canonical());
				break;
			case "accepted":
				entries.push(receipt(), canonical());
				break;
			case "failed":
				entries.push(receipt(), state("started"), state("failed"), canonical());
				break;
			case "completed":
				entries.push(receipt(), state("started"), state("completed"), canonical());
				break;
			case "duplicate":
				entries.push(receipt(), state("started"), canonical("first"), canonical("second"));
				break;
			case "reordered":
				entries.push(canonical(), receipt(), state("started"));
				break;
		}
		writeFileSync(
			sessionFile,
			`${[{ type: "session", version: 5, id: `canonical-${boundary}-v5`, timestamp, cwd: tempDir }, ...entries]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		expect(() => SessionManager.open(sessionFile, tempDir)).toThrow(expected);
	});

	it("replays completed and failed terminal outcomes after reopening the JSONL", async () => {
		const completedDir = createTempDir();
		const failedDir = createTempDir();
		tempDirs.push(completedDir, failedDir);

		const completed = SessionManager.create(completedDir, completedDir);
		completed.reserveClientInput("persisted-complete", "prompt", { message: "already done" });
		completed.transitionClientInput("persisted-complete", "started");
		completed.appendMessage({
			role: "user",
			content: [{ type: "text", text: "already done" }],
			clientMessageId: "persisted-complete",
			timestamp: Date.now(),
		});
		await completed.flush();
		const reopenedCompleted = SessionManager.open(completed.getSessionFile()!, completedDir);
		const completedHarness = await createHarness({ sessionManager: reopenedCompleted });
		harnesses.push(completedHarness);
		completedHarness.setResponses([fauxAssistantMessage("must remain unused")]);
		await completedHarness.session.prompt("already done", { clientMessageId: "persisted-complete" });
		expect(completedHarness.getPendingResponseCount()).toBe(1);
		expect(reopenedCompleted.buildSessionContext().messages).toHaveLength(1);

		const failed = SessionManager.create(failedDir, failedDir);
		failed.reserveClientInput("persisted-failed", "prompt", { message: "still failed" });
		failed.transitionClientInput("persisted-failed", "started");
		failed.transitionClientInput("persisted-failed", "failed", "persisted precommit failure");
		await failed.flush();
		const reopenedFailed = SessionManager.open(failed.getSessionFile()!, failedDir);
		const failedHarness = await createHarness({ sessionManager: reopenedFailed });
		harnesses.push(failedHarness);
		failedHarness.setResponses([fauxAssistantMessage("must remain unused")]);
		await expect(
			failedHarness.session.prompt("still failed", { clientMessageId: "persisted-failed" }),
		).rejects.toThrow("persisted precommit failure");
		expect(failedHarness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(failedHarness)).toEqual([]);
	});

	it("keeps host WAL out of every public conversation and bootstrap projection", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const observedEntryTypes: string[] = [];
		manager.subscribeEntries((entry) => observedEntryTypes.push(entry.type));
		const receipt = manager.reserveClientInput("private-wal", "prompt", { message: "visible later" });
		manager.transitionClientInput("private-wal", "started");
		await manager.flush();
		const persistedTypes = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { type: string }).type);
		expect(persistedTypes).toEqual(["session", "client_input_receipt", "client_input_state"]);

		expect(observedEntryTypes).toEqual([]);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getEntry(receipt.record.receiptId)).toBeUndefined();
		expect(manager.getChildren(receipt.record.receiptId)).toEqual([]);
		expect(manager.getBranch()).toEqual([]);
		expect(manager.getBranch(receipt.record.receiptId)).toEqual([]);
		expect(manager.getBranchWindow({ maxEntries: 10 })).toMatchObject({ entries: [], lookback: [] });
		expect(manager.getBranchWindow({ maxEntries: 10, beforeEntryId: receipt.record.receiptId })).toBeUndefined();
		expect(manager.getTree()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getLabel(receipt.record.receiptId)).toBeUndefined();
		expect(manager.buildSessionContext().messages).toEqual([]);
		expect(projectSessionTranscript(manager).items).toEqual([]);
		expect(() => manager.branch(receipt.record.receiptId)).toThrow(`Entry ${receipt.record.receiptId} not found`);
		expect(() => manager.branchWithSummary(receipt.record.receiptId, "hidden")).toThrow(
			`Entry ${receipt.record.receiptId} not found`,
		);
		expect(() => manager.appendLabelChange(receipt.record.receiptId, "hidden")).toThrow(
			`Entry ${receipt.record.receiptId} not found`,
		);

		const runtime = {
			session: { sessionId: manager.getSessionId(), sessionManager: manager },
			listSessions: async () => [],
		} satisfies ConversationCommandRuntime;
		const bootstrapBefore = createRemoteConversationTranscriptPage(createAuthorization(tempDir), runtime);
		expect(bootstrapBefore).toMatchObject({ items: [], head: null });

		const userEntryId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible later" }],
			clientMessageId: "private-wal",
			timestamp: Date.now(),
		});
		expect(observedEntryTypes).toEqual(["message"]);
		expect(manager.getEntries()).toHaveLength(1);
		expect(manager.getBranch()).toHaveLength(1);
		expect(manager.getTree()).toHaveLength(1);
		const bootstrapAfter = createRemoteConversationTranscriptPage(createAuthorization(tempDir), runtime);
		expect(bootstrapAfter).toMatchObject({
			items: [{ entryId: userEntryId, role: "user", clientMessageId: "private-wal" }],
			head: { entryId: userEntryId },
		});
		await manager.flush();
	});

	it("keeps WAL-only files out of local and remote session enumeration until canonical content commits", async () => {
		const agentDir = createTempDir();
		const workspaceDir = join(agentDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		tempDirs.push(agentDir);
		const sessionDir = getDefaultSessionDir(workspaceDir, agentDir);
		const manager = SessionManager.create(workspaceDir, sessionDir);
		manager.reserveClientInput("private-list-wal", "prompt", { message: "visible later" });
		manager.transitionClientInput("private-list-wal", "started");
		manager.transitionClientInput("private-list-wal", "failed", "preflight rejected");
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		expect(await SessionManager.list(workspaceDir, sessionDir)).toEqual([]);
		expect(await SessionManager.listAll(sessionDir)).toEqual([]);
		const context: ConversationCommandContext = {
			stateManager: new IrohRemoteHostStateManager(),
			sessionListCursors: new Map(),
			sessionListCursorTtlMs: 60_000,
			agentDir,
		};
		expect(await listRemoteWorkspaceSessionSummaries(createAuthorization(workspaceDir), context)).toEqual([]);

		// Enumeration purity does not weaken recovery: an explicit reopen still
		// sees the terminal receipt and can deterministically replay its outcome.
		const reopened = SessionManager.open(sessionFile!, sessionDir);
		expect(reopened.getClientInput("private-list-wal")).toMatchObject({
			state: "failed",
			error: "preflight rejected",
		});
		reopened.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible later" }],
			timestamp: Date.now(),
		});
		await reopened.flush();

		expect(await SessionManager.list(workspaceDir, sessionDir)).toMatchObject([
			{ id: manager.getSessionId(), messageCount: 1, firstMessage: "visible later" },
		]);
		expect(await SessionManager.listAll(sessionDir)).toHaveLength(1);
		expect(await listRemoteWorkspaceSessionSummaries(createAuthorization(workspaceDir), context)).toMatchObject([
			{ session: { sessionId: manager.getSessionId(), messageCount: 1, title: "visible later" } },
		]);
	});

	it("does not copy recoverable input WAL into a forked conversation", async () => {
		const sourceDir = createTempDir();
		const targetDir = createTempDir();
		tempDirs.push(sourceDir, targetDir);
		const source = SessionManager.create(sourceDir, sourceDir);
		source.reserveClientInput("source-queued", "follow_up", { message: "source only" });
		source.markClientInputQueued("source-queued", {
			delivery: "follow_up",
			message: "source only",
		});
		await source.flush();

		const fork = SessionManager.forkFrom(source.getSessionFile()!, targetDir, targetDir);
		await fork.flush();
		expect(fork.getClientInput("source-queued")).toBeUndefined();
		expect(fork.getRecoverableQueuedClientInputs()).toEqual([]);
		expect(
			readFileSync(fork.getSessionFile()!, "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { type: string }).type),
		).toEqual(["session"]);
	});

	it("drops transport identity with WAL when forking or extracting a completed conversation", async () => {
		const sourceDir = createTempDir();
		const forkDir = createTempDir();
		tempDirs.push(sourceDir, forkDir);
		const source = SessionManager.create(sourceDir, sourceDir);
		source.reserveClientInput("source-canonical", "prompt", { message: "source canonical" });
		source.transitionClientInput("source-canonical", "started");
		source.appendMessage({
			role: "user",
			content: [{ type: "text", text: "source canonical" }],
			clientMessageId: "source-canonical",
			timestamp: Date.now(),
		});
		const assistantId = source.appendMessage(fauxAssistantMessage("source answer"));
		await source.flush();

		const fork = SessionManager.forkFrom(source.getSessionFile()!, forkDir, forkDir);
		await fork.flush();
		expect(fork.buildSessionContext().messages[0]).not.toHaveProperty("clientMessageId");
		expect(() => SessionManager.open(fork.getSessionFile()!, forkDir)).not.toThrow();

		const extractedFile = source.createBranchedSession(assistantId);
		expect(extractedFile).toBeDefined();
		expect(source.buildSessionContext().messages[0]).not.toHaveProperty("clientMessageId");
		expect(() => SessionManager.open(extractedFile!, sourceDir)).not.toThrow();
	});

	it("fail-stops a dirty manager after an uncertain persistence failure", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		mkdirSync(manager.getSessionFile()!);

		expect(manager.reserveClientInput("uncertain", "prompt", { message: "uncertain" }).record.state).toBe("accepted");
		await expect(manager.flush()).rejects.toThrow();
		expect(manager.getEntries()).toEqual([]);
		expect(() => manager.reserveClientInput("later", "prompt", { message: "later" })).toThrow(
			"Session persistence is fail-stopped after an uncertain write",
		);
		await expect(manager.flush()).rejects.toThrow();

		const freshManager = SessionManager.create(tempDir, tempDir);
		expect(freshManager.reserveClientInput("fresh", "prompt", { message: "fresh" }).record.state).toBe("accepted");
		await freshManager.flush();
	});
});
