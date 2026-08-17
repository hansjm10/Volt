import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { getStaticIrohRemoteRpcFilterResult as getIrohRemoteRpcFilterResult } from "../src/core/remote/iroh/rpc-command-filter.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS } from "../src/core/remote/iroh/transcript-text.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../src/core/remote/iroh/worktree-rpc.ts";
import { getDefaultSessionDir, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	createRemoteConversationTranscriptEntry,
	createRemoteConversationTranscriptPage,
	handleIntegratedConversationRpcCommand,
	INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES,
	LEASE_DRAINING_RETRY_AFTER_MS,
	REMOTE_TOOL_OUTPUT_MAX_SCALARS,
	REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES,
	REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES,
	REMOTE_TRANSCRIPT_PROJECTION_VERSION,
	REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES,
	type RemoteSessionRuntimeState,
	TURN_INITIATING_RPC_TYPES,
} from "../src/daemon/conversation-commands.ts";

function createAuthorization(options: { workspacePath?: string } = {}): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: options.workspacePath ?? "/tmp/ws" },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

function createRuntime(sessionId = "s-1"): ConversationCommandRuntime {
	return {
		session: {
			sessionId,
			sessionManager: createSessionManager([]),
		},
		listSessions: async () => [],
	};
}

function createSessionManager(branch: SessionEntry[]): ConversationCommandRuntime["session"]["sessionManager"] {
	return {
		getBranch: () => branch,
		getLeafEntry: () => {
			const leaf = branch.at(-1);
			return leaf === undefined || leaf.ordinal !== undefined ? leaf : { ...leaf, ordinal: branch.length };
		},
		getBranchWindow: ({ beforeEntryId, maxEntries, lookbackEntries = 0 }) => {
			const endIndex =
				beforeEntryId === undefined ? branch.length : branch.findIndex((entry) => entry.id === beforeEntryId);
			if (endIndex < 0) return undefined;
			const entryStart = Math.max(0, endIndex - maxEntries);
			const lookbackStart = Math.max(0, entryStart - lookbackEntries);
			return {
				entries: branch.slice(entryStart, endIndex),
				lookback: branch.slice(lookbackStart, entryStart),
				hasEarlier: lookbackStart > 0,
				visitedEntries: endIndex - lookbackStart,
			};
		},
	};
}

function createContext(
	options: {
		isDraining?: () => boolean;
		isTurnAdmissionClosed?: () => boolean;
		isSubagentSession?: () => boolean;
		stateManager?: IrohRemoteHostStateManager;
		onWorkspaceUnregistered?: (workspaceName: string) => Promise<void>;
		webSearchKey?: ConversationCommandContext["webSearchKey"];
		createWorktreeBackend?: ConversationCommandContext["createWorktreeBackend"];
		listRuntimeStates?: ConversationCommandContext["listRuntimeStates"];
		agentDir?: string;
	} = {},
): ConversationCommandContext {
	return {
		stateManager: options.stateManager ?? new IrohRemoteHostStateManager(),
		sessionListCursors: new Map(),
		sessionListCursorTtlMs: 60_000,
		...(options.isDraining === undefined ? {} : { isDraining: options.isDraining }),
		...(options.isTurnAdmissionClosed === undefined ? {} : { isTurnAdmissionClosed: options.isTurnAdmissionClosed }),
		...(options.isSubagentSession === undefined ? {} : { isSubagentSession: options.isSubagentSession }),
		...(options.onWorkspaceUnregistered === undefined
			? {}
			: { onWorkspaceUnregistered: options.onWorkspaceUnregistered }),
		...(options.webSearchKey === undefined ? {} : { webSearchKey: options.webSearchKey }),
		...(options.createWorktreeBackend === undefined ? {} : { createWorktreeBackend: options.createWorktreeBackend }),
		...(options.listRuntimeStates === undefined ? {} : { listRuntimeStates: options.listRuntimeStates }),
		...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
	};
}

function createFakeWebSearchKeyService(): {
	service: NonNullable<ConversationCommandContext["webSearchKey"]>;
	calls: Array<string | null>;
} {
	const calls: Array<string | null> = [];
	let stored: string | null = null;
	return {
		service: {
			set(apiKey: string | null) {
				calls.push(apiKey);
				stored = apiKey;
			},
			get configured() {
				return stored !== null;
			},
		},
		calls,
	};
}

describe("handleIntegratedConversationRpcCommand", () => {
	it("rejects the unsupported command set", async () => {
		for (const type of INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "1", type },
				createAuthorization(),
				createContext(),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toMatchObject({
				id: "1",
				type: "response",
				command: type,
				success: false,
				error: "unsupported_remote_command",
			});
		}
	});

	it("does not intercept abort — the rpc mode stops the turn with the stream open", async () => {
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "1", type: "abort" },
			createAuthorization(),
			createContext({ isDraining: () => true }),
			createRuntime(),
		);
		expect(response).toBeUndefined();
	});

	it("rejects turn-initiating commands while the lease is draining", async () => {
		for (const type of TURN_INITIATING_RPC_TYPES) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "42", type, message: "hi" },
				createAuthorization(),
				createContext({ isDraining: () => true }),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toEqual({
				id: "42",
				type: "response",
				command: type,
				success: false,
				error: {
					code: "lease_draining",
					message: "Handing off to the desktop TUI; retry shortly.",
					retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS,
				},
			});
		}
	});

	it("rejects new turns against the daemon's closed shutdown epoch", async () => {
		for (const type of TURN_INITIATING_RPC_TYPES) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "shutdown-turn", type, message: "hi" },
				createAuthorization(),
				createContext({ isTurnAdmissionClosed: () => true }),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toEqual({
				id: "shutdown-turn",
				type: "response",
				command: type,
				success: false,
				error: {
					code: "host_shutdown",
					message: "The host is shutting down; reconnect after it restarts.",
				},
			});
		}
	});

	it("keeps abort and observation available after turn admission closes", async () => {
		const context = createContext({ isTurnAdmissionClosed: () => true });
		const abort = await handleIntegratedConversationRpcCommand(
			{ id: "shutdown-abort", type: "abort" },
			createAuthorization(),
			context,
			createRuntime(),
		);
		expect(abort).toBeUndefined();

		const transcript = (await handleIntegratedConversationRpcCommand(
			{ id: "shutdown-read", type: "get_transcript" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(transcript).toMatchObject({ command: "get_transcript", success: true });
	});

	it("lets read-only commands through while draining", async () => {
		const transcript = (await handleIntegratedConversationRpcCommand(
			{ id: "2", type: "get_transcript" },
			createAuthorization(),
			createContext({ isDraining: () => true }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(transcript).toMatchObject({ command: "get_transcript", success: true });

		// get_state is handled by the rpc mode itself: pass-through.
		const state = await handleIntegratedConversationRpcCommand(
			{ id: "3", type: "get_state" },
			createAuthorization(),
			createContext({ isDraining: () => true }),
			createRuntime(),
		);
		expect(state).toBeUndefined();
	});

	it("rejects turn-initiating commands on subagent sessions", async () => {
		for (const type of TURN_INITIATING_RPC_TYPES) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "7", type, message: "hi" },
				createAuthorization(),
				createContext({ isSubagentSession: () => true }),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toEqual({
				id: "7",
				type: "response",
				command: type,
				success: false,
				error: {
					code: "subagent_session_read_only",
					message: "Subagent sessions are observe-only; prompt the parent agent instead.",
				},
			});
		}
	});

	it("retags malformed invocation ids across daemon admission failures", async () => {
		const cases = [
			{
				command: { type: "invoke_ui_action", action: "session.new" },
				context: createContext({ isDraining: () => true }),
				code: "lease_draining",
			},
			{
				command: { id: " padded ", type: "invoke_ui_action", action: "session.new" },
				context: createContext({ isTurnAdmissionClosed: () => true }),
				code: "host_shutdown",
			},
			{
				command: { id: "é".repeat(129), type: "invoke_ui_action", action: "session.new" },
				context: createContext({ isSubagentSession: () => true }),
				code: "subagent_session_read_only",
			},
		];

		for (const { command, context, code } of cases) {
			const response = (await handleIntegratedConversationRpcCommand(
				command,
				createAuthorization(),
				context,
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).not.toHaveProperty("id");
			expect(response).toMatchObject({
				type: "response",
				command: "invalid",
				success: false,
				error: { code },
			});
		}
	});

	it("lets observation and abort through on subagent sessions", async () => {
		// abort passes through to the rpc mode so a phone can still stop the run.
		const abort = await handleIntegratedConversationRpcCommand(
			{ id: "8", type: "abort" },
			createAuthorization(),
			createContext({ isSubagentSession: () => true }),
			createRuntime(),
		);
		expect(abort).toBeUndefined();

		const transcript = (await handleIntegratedConversationRpcCommand(
			{ id: "9", type: "get_transcript" },
			createAuthorization(),
			createContext({ isSubagentSession: () => true }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(transcript).toMatchObject({ command: "get_transcript", success: true });
	});

	it("does not reject prompts on non-subagent sessions", async () => {
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "10", type: "prompt", clientMessageId: "client-10", message: "hi" },
			createAuthorization(),
			createContext({ isSubagentSession: () => false }),
			createRuntime(),
		);
		expect(response).toBeUndefined();
	});

	it("does not reject prompts when the lease is not draining", async () => {
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "4", type: "prompt", clientMessageId: "client-4", message: "hi" },
			createAuthorization(),
			createContext({ isDraining: () => false }),
			createRuntime(),
		);
		expect(response).toBeUndefined();
	});

	it("rejects commands scoped to the wrong workspace or session", async () => {
		const wrongWorkspace = (await handleIntegratedConversationRpcCommand(
			{ id: "5", type: "get_transcript", workspaceName: "other" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(wrongWorkspace).toMatchObject({ success: false, error: "session_mismatch" });

		const wrongSession = (await handleIntegratedConversationRpcCommand(
			{ id: "6", type: "get_transcript", sessionId: "other" },
			createAuthorization(),
			createContext(),
			createRuntime("s-1"),
		)) as Record<string, unknown>;
		expect(wrongSession).toMatchObject({ success: false, error: "session_mismatch" });
	});

	it("projects sanitized, truncated tool output onto transcript tool items", async () => {
		const branch = [
			{
				type: "message",
				id: "e-call",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/tmp/ws/README.md" } }],
				},
			},
			{
				type: "message",
				id: "e-result",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: `README at /tmp/ws/README.md\n${"x".repeat(9_000)}` }],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "11", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		const tool = response.data.items.find((item) => item.role === "tool");
		expect(tool).toBeDefined();
		const output = tool?.output as string;
		expect(output).toContain("README at /workspace/README.md");
		expect(output).not.toContain("/tmp/ws");
		expect(Array.from(output)).toHaveLength(REMOTE_TOOL_OUTPUT_MAX_SCALARS);
		expect(tool?.outputTruncated).toBe(true);
	});

	it("preserves ordered assistant parts, stop reason, ordinals, and transcript head", async () => {
		const branch = [
			{
				type: "message",
				id: "assistant-1",
				ordinal: 7,
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "inspect /tmp/ws/src", redacted: false },
						{ type: "text", text: "first" },
						{ type: "thinking", thinking: "secret", redacted: true, thinkingSignature: "opaque" },
						{ type: "text", text: " second" },
					],
					stopReason: "aborted",
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "parts", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: Record<string, unknown> };

		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({
			projectionVersion: REMOTE_TRANSCRIPT_PROJECTION_VERSION,
			branchEpoch: "s-1",
			head: { entryId: "assistant-1", ordinal: 7 },
			items: [
				{
					entryId: "assistant-1",
					ordinal: 7,
					role: "assistant",
					text: "first second",
					stopReason: "aborted",
					parts: [
						{ type: "thinking", text: "inspect /workspace/src", truncated: false },
						{ type: "text", text: "first", truncated: false },
						{ type: "thinking", text: "", redacted: true },
						{ type: "text", text: " second", truncated: false },
					],
				},
			],
		});
		expect(JSON.stringify(response)).not.toContain("opaque");
		expect(JSON.stringify(response)).not.toContain("/tmp/ws");
	});

	it.each(["stop", "aborted"] as const)(
		"preserves empty canonical assistant parts for %s terminal entries",
		(stopReason) => {
			const entry = {
				type: "message",
				id: `assistant-empty-parts-${stopReason}`,
				ordinal: 8,
				timestamp: "2026-07-19T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "",
							redacted: false,
							thinkingSignature: "opaque-signature",
						},
						{ type: "text", text: "visible" },
						{ type: "text", text: "" },
					],
					stopReason,
				},
			} as unknown as SessionEntry;
			const runtime: ConversationCommandRuntime = {
				session: { sessionId: "s-empty-parts", sessionManager: createSessionManager([entry]) },
				listSessions: async () => [],
			};

			const live = createRemoteConversationTranscriptEntry(entry, createAuthorization(), runtime);
			const bootstrap = createRemoteConversationTranscriptPage(createAuthorization(), runtime);

			expect(live).toEqual({
				entryId: entry.id,
				ordinal: 8,
				createdAt: "2026-07-19T00:00:00.000Z",
				role: "assistant",
				text: "visible",
				truncated: false,
				parts: [
					{ type: "thinking", text: "", truncated: false },
					{ type: "text", text: "visible", truncated: false },
					{ type: "text", text: "", truncated: false },
				],
				stopReason,
			});
			expect(bootstrap?.items).toEqual([live]);
			expect(JSON.stringify(live)).not.toContain("opaque-signature");
		},
	);

	it("persists and echoes client message identity across sanitized live and bootstrap projections", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-client-message-id-"));
		const workspacePath = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		mkdirSync(workspacePath, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		try {
			const manager = SessionManager.create(workspacePath, sessionDir);
			manager.reserveClientInput("client-message-42", "prompt", {
				message: `Read ${workspacePath}/fixture.txt`,
			});
			manager.transitionClientInput("client-message-42", "started");
			manager.appendMessage({
				role: "user",
				clientMessageId: "client-message-42",
				content: [{ type: "text", text: `Read ${workspacePath}/fixture.txt` }],
				timestamp: 1,
			});
			const entry = manager.getLeafEntry()!;
			// Session files are intentionally deferred until conversation content
			// beyond the first user prompt exists.
			manager.appendCustomMessageEntry("test.flush", "flush", true);
			const runtime: ConversationCommandRuntime = {
				session: { sessionId: manager.getSessionId(), sessionManager: manager },
				listSessions: async () => [],
			};
			const authorization = createAuthorization({ workspacePath });

			const live = createRemoteConversationTranscriptEntry(entry, authorization, runtime);
			const bootstrap = createRemoteConversationTranscriptPage(authorization, runtime);

			expect(live).toMatchObject({
				entryId: entry.id,
				role: "user",
				clientMessageId: "client-message-42",
				text: "Read /workspace/fixture.txt",
			});
			expect(bootstrap?.items).toEqual([live]);
			await manager.flush();
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain('"clientMessageId":"client-message-42"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves identity-only aborted assistant truth in live entries and bootstrap", () => {
		const manager = SessionManager.inMemory("/tmp/ws");
		manager.appendMessage({
			role: "assistant",
			content: [],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: 1,
		});
		const entry = manager.getLeafEntry()!;
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-zero-token-abort", sessionManager: manager },
			listSessions: async () => [],
		};

		const live = createRemoteConversationTranscriptEntry(entry, createAuthorization(), runtime);
		const bootstrap = createRemoteConversationTranscriptPage(createAuthorization(), runtime);
		expect(live).toMatchObject({
			entryId: entry.id,
			ordinal: entry.ordinal,
			role: "assistant",
			text: "",
			stopReason: "aborted",
		});
		expect(bootstrap?.items).toEqual([live]);
	});

	it("omits compaction entries whose sanitized system text is empty", () => {
		const emptyCompaction = {
			type: "compaction",
			id: "empty-compaction",
			ordinal: 1,
			parentId: null,
			timestamp: "2026-07-18T00:00:00.000Z",
			summary: "\u0000\u0007",
			firstKeptEntryId: "kept-entry",
			tokensBefore: 1,
		} as unknown as SessionEntry;
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-empty-compaction", sessionManager: createSessionManager([emptyCompaction]) },
			listSessions: async () => [],
		};
		const authorization = createAuthorization();

		expect(createRemoteConversationTranscriptEntry(emptyCompaction, authorization, runtime)).toBeUndefined();
		expect(createRemoteConversationTranscriptPage(authorization, runtime)).toMatchObject({
			head: { entryId: "empty-compaction", ordinal: 1 },
			items: [],
		});
	});

	it("bounds large Unicode bootstrap pages by serialized UTF-8 bytes without pagination gaps", () => {
		const branch = Array.from({ length: 120 }, (_, index) => ({
			type: "message",
			id: `assistant-${index}`,
			ordinal: index + 1,
			timestamp: new Date(index + 1).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "🧪".repeat(12_000) }],
				stopReason: "stop",
			},
		})) as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-unicode", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const newest = createRemoteConversationTranscriptPage(createAuthorization(), runtime);
		expect(newest).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(newest), "utf8")).toBeLessThanOrEqual(
			REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES,
		);
		expect(newest?.items.length).toBeGreaterThan(0);
		expect(newest?.items.length).toBeLessThan(100);
		expect(newest?.items.at(-1)?.entryId).toBe("assistant-119");
		expect(newest?.head).toEqual({ entryId: "assistant-119", ordinal: 120 });
		expect(newest?.hasMore).toBe(true);
		expect(newest?.nextBeforeEntryId).toBe(newest?.items[0]?.entryId);

		const oldestNewestPageIndex = Number(newest?.items[0]?.entryId.split("-").at(-1));
		const older = createRemoteConversationTranscriptPage(createAuthorization(), runtime, {
			beforeEntryId: newest?.nextBeforeEntryId ?? undefined,
		});
		expect(older).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(older), "utf8")).toBeLessThanOrEqual(
			REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES,
		);
		expect(older?.items.at(-1)?.entryId).toBe(`assistant-${oldestNewestPageIndex - 1}`);
		expect(older?.head).toEqual({ entryId: "assistant-119", ordinal: 120 });
		expect(older?.items.some((item) => item.entryId === newest?.items[0]?.entryId)).toBe(false);
	});

	it("correlates remote pagination to the current epoch and server-issued cursors", async () => {
		const branch = Array.from({ length: 300 }, (_, index) => ({
			type: "message",
			id: `user-${index}`,
			ordinal: index + 1,
			timestamp: new Date(index + 1).toISOString(),
			message: { role: "user", content: [{ type: "text", text: `message ${index}` }] },
		})) as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-pagination", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};
		let branchEpoch = "epoch-a";
		const issued = new Set<string>();
		const context: ConversationCommandContext = {
			...createContext(),
			getConversationBranchEpoch: () => branchEpoch,
			isConversationTranscriptCursorValid: (cursor) => issued.has(cursor),
			registerConversationTranscriptCursor: (cursor) => {
				if (cursor !== null) issued.add(cursor);
			},
		};

		const first = (await handleIntegratedConversationRpcCommand(
			{ id: "page-1", type: "get_transcript", branchEpoch },
			createAuthorization(),
			context,
			runtime,
		)) as { success: boolean; data: { branchEpoch: string; nextBeforeEntryId: string } };
		expect(first).toMatchObject({ success: true, data: { branchEpoch: "epoch-a" } });
		expect(issued.has(first.data.nextBeforeEntryId)).toBe(true);

		const arbitrary = (await handleIntegratedConversationRpcCommand(
			{
				id: "page-arbitrary",
				type: "get_transcript",
				branchEpoch,
				beforeEntryId: "abandoned-branch-entry",
			},
			createAuthorization(),
			context,
			runtime,
		)) as Record<string, unknown>;
		expect(arbitrary).toMatchObject({ success: false, error: "invalid_cursor" });

		const older = (await handleIntegratedConversationRpcCommand(
			{
				id: "page-2",
				type: "get_transcript",
				branchEpoch,
				beforeEntryId: first.data.nextBeforeEntryId,
			},
			createAuthorization(),
			context,
			runtime,
		)) as Record<string, unknown>;
		expect(older).toMatchObject({ success: true, data: { branchEpoch: "epoch-a" } });

		branchEpoch = "epoch-b";
		const stale = (await handleIntegratedConversationRpcCommand(
			{
				id: "page-stale",
				type: "get_transcript",
				branchEpoch: "epoch-a",
				beforeEntryId: first.data.nextBeforeEntryId,
			},
			createAuthorization(),
			context,
			runtime,
		)) as Record<string, unknown>;
		expect(stale).toMatchObject({ success: false, error: "stale_branch_epoch" });
	});

	it("projects only a bounded recent source window for cursor-zero bootstrap", () => {
		const storedBranch = Array.from({ length: 10_000 }, (_, index) => ({
			type: "message",
			id: `user-${index}`,
			ordinal: index + 1,
			timestamp: new Date(index + 1).toISOString(),
			message: { role: "user", content: [{ type: "text", text: `message ${index}` }] },
		})) as unknown as SessionEntry[];
		let entryReads = 0;
		const branch = new Proxy(storedBranch, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) {
					entryReads++;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-long", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const page = createRemoteConversationTranscriptPage(createAuthorization(), runtime);
		expect(page?.items).toHaveLength(100);
		expect(page?.items[0]?.entryId).toBe("user-9900");
		expect(page?.items.at(-1)?.entryId).toBe("user-9999");
		expect(page?.head).toEqual({ entryId: "user-9999", ordinal: 10_000 });
		expect(entryReads).toBeLessThan(1_200);
	});

	it("walks a very deep branch with bounded ancestor work", () => {
		const manager = SessionManager.inMemory("/tmp/ws");
		for (let index = 0; index < 50_000; index++) {
			manager.appendCustomEntry("deep-history", { index });
		}
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "tail" }], timestamp: 1 });
		const getBranch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
			throw new Error("full branch materialization is forbidden");
		});
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-deep", sessionManager: manager },
			listSessions: async () => [],
		};

		const window = manager.getBranchWindow({
			maxEntries: 800,
			lookbackEntries: REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES,
		});
		const page = createRemoteConversationTranscriptPage(createAuthorization(), runtime);

		expect(window?.visitedEntries).toBe(800 + REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES);
		expect(window?.hasEarlier).toBe(true);
		expect(page?.items).toEqual([expect.objectContaining({ role: "user", text: "tail" })]);
		expect(page?.head).toEqual({ entryId: manager.getLeafEntry()?.id, ordinal: 50_001 });
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("fails closed when the active transcript head lacks a positive commit ordinal", () => {
		const entry = {
			type: "message",
			id: "missing-ordinal",
			parentId: null,
			timestamp: "2026-07-17T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		} as unknown as SessionEntry;
		const runtime: ConversationCommandRuntime = {
			session: {
				sessionId: "s-missing-ordinal",
				sessionManager: {
					getBranch: () => [entry],
					getLeafEntry: () => entry,
					getBranchWindow: () => ({
						entries: [entry],
						lookback: [],
						hasEarlier: false,
						visitedEntries: 1,
					}),
				},
			},
			listSessions: async () => [],
		};

		expect(() => createRemoteConversationTranscriptPage(createAuthorization(), runtime)).toThrow(
			/missing its positive commit ordinal/,
		);
	});

	it("uses bounded tool-call metadata lookup for each newly committed transcript entry", () => {
		const storedBranch = Array.from({ length: 9_998 }, (_, index) => ({
			type: "message",
			id: `user-${index}`,
			parentId: index === 0 ? null : `user-${index - 1}`,
			timestamp: new Date(index + 1).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "filler" }] },
		})) as unknown as SessionEntry[];
		storedBranch.push(
			{
				type: "message",
				id: "tool-call",
				parentId: "user-9997",
				timestamp: new Date(9_999).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-recent", name: "read", arguments: { path: "/tmp/ws/file" } }],
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "tool-result",
				parentId: "tool-call",
				timestamp: new Date(10_000).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tc-recent",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "second line" }],
				},
			} as unknown as SessionEntry,
		);
		let entryReads = 0;
		const branch = new Proxy(storedBranch, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) {
					entryReads++;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-tool", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const item = createRemoteConversationTranscriptEntry(storedBranch.at(-1)!, createAuthorization(), runtime);
		expect(item).toMatchObject({ role: "tool", toolName: "read", path: "/workspace/file" });
		expect(entryReads).toBeLessThanOrEqual(REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES + 4);
	});

	it("projects standard subagent registry tool metadata for integrated Iroh transcripts", async () => {
		const branch = [
			{
				type: "message",
				id: "e-registry-call",
				parentId: null,
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "tc-registry",
							name: "subagent_registry",
							arguments: { list: true, cursor: 50 },
						},
					],
				},
			},
			{
				type: "message",
				id: "e-registry-result",
				parentId: "e-registry-call",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-registry",
					toolName: "subagent_registry",
					isError: false,
					content: [{ type: "text", text: "bounded registry page" }],
					details: {
						mode: "list",
						status: "completed",
						summary: { total: 120, returned: 50, nextCursor: 20 },
					},
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "12", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		expect(response.data.items).toContainEqual(
			expect.objectContaining({
				entryId: "e-registry-result",
				role: "tool",
				toolName: "subagent_registry",
				args: { list: true, cursor: 50 },
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 120, returned: 50, nextCursor: 20 },
				},
			}),
		);
	});

	it("bounds remote subagent detail traversal across wide sibling arrays", () => {
		const wide = (label: string): Array<Record<string, unknown>> => {
			const value = Array.from({ length: 64 }, (_, index) => ({
				subagentId: `${label}-${index}`,
				status: "running",
			}));
			value.length = 10_000;
			Object.defineProperty(value, 64, {
				get: () => {
					throw new Error(`${label} omitted tail was traversed`);
				},
			});
			return value;
		};
		const tasks: Array<Record<string, unknown>> = [];
		tasks.length = 1;
		Object.defineProperty(tasks, 0, {
			get: () => {
				throw new Error("remote global subagent node budget was exceeded");
			},
		});
		const inputTasks = Array.from({ length: 64 }, (_, index) => ({ agent: `agent-${index}`, task: `task-${index}` }));
		inputTasks.length = 10_000;
		Object.defineProperty(inputTasks, 64, {
			get: () => {
				throw new Error("remote subagent input tail was traversed");
			},
		});
		const callEntry = {
			type: "message",
			id: "subagent-call-entry",
			ordinal: 1,
			parentId: null,
			timestamp: "2026-07-17T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "subagent-call", name: "subagent", arguments: { tasks: inputTasks } }],
			},
		} as unknown as SessionEntry;
		const entry = {
			type: "message",
			id: "subagent-result",
			ordinal: 2,
			parentId: "subagent-call-entry",
			timestamp: "2026-07-17T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "subagent-call",
				toolName: "subagent",
				isError: false,
				content: [{ type: "text", text: "running" }],
				details: { childSessions: wide("session"), children: wide("child"), tasks },
			},
		} as unknown as SessionEntry;
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-subagent-wide", sessionManager: createSessionManager([callEntry, entry]) },
			listSessions: async () => [],
		};

		const projected = createRemoteConversationTranscriptEntry(entry, createAuthorization(), runtime);
		expect(projected?.details?.childSessions as unknown[] | undefined).toHaveLength(64);
		expect(projected?.details?.children as unknown[] | undefined).toHaveLength(64);
		expect(projected?.details).not.toHaveProperty("tasks");
		expect(projected?.args?.tasks as unknown[] | undefined).toHaveLength(64);
	});

	it("advertises imageCount on tool transcript items with image results", async () => {
		const branch = [
			{
				type: "message",
				id: "e-call",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "logo.png" } }],
				},
			},
			{
				type: "message",
				id: "e-image-result",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
				},
			},
			{
				type: "message",
				id: "e-text-result",
				timestamp: "2026-07-06T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "plain text" }],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "21", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		const toolItems = response.data.items.filter((item) => item.role === "tool");
		expect(toolItems[0]).toEqual(
			expect.objectContaining({ entryId: "e-image-result", role: "tool", toolName: "read", imageCount: 1 }),
		);
		expect(toolItems[1]).not.toHaveProperty("imageCount");
		// The transcript page itself stays text-only; images are fetched per entry.
		expect(JSON.stringify(response)).not.toContain("aW1hZ2U=");
	});

	it("serves get_message_images for a tool result entry", async () => {
		const branch = [
			{
				type: "message",
				id: "e-image-result",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
					],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "22", type: "get_message_images", entryId: "e-image-result" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: Record<string, unknown> };
		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({
			entryId: "e-image-result",
			totalImages: 1,
			images: [{ type: "image", data: "dG9vbA==", mimeType: "image/png", index: 0 }],
			nextImageIndex: null,
		});
	});

	it("advertises imageCount on user transcript items and keeps image-only user messages", async () => {
		const branch = [
			{
				type: "message",
				id: "e-images",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see screenshots" },
						{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg" },
						{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
					],
				},
			},
			{
				type: "message",
				id: "e-image-only",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "image", data: "b25seQ==", mimeType: "image/jpeg" }],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "20", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		expect(response.data.items).toEqual([
			expect.objectContaining({ entryId: "e-images", role: "user", text: "see screenshots", imageCount: 2 }),
			expect.objectContaining({ entryId: "e-image-only", role: "user", text: "", imageCount: 1 }),
		]);
		// The transcript page itself stays text-only; images are fetched per entry.
		expect(JSON.stringify(response)).not.toContain("Zmlyc3Q=");
	});

	it("serves get_message_images for a user entry with workspace and session identity", async () => {
		const branch = [
			{
				type: "message",
				id: "e-images",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see screenshots" },
						{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg" },
						{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
					],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "21", type: "get_message_images", entryId: "e-images" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			id: "21",
			command: "get_message_images",
			success: true,
			data: {
				workspaceName: "ws",
				sessionId: "s-1",
				entryId: "e-images",
				totalImages: 2,
				images: [
					{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg", index: 0 },
					{ type: "image", data: "c2Vjb25k", mimeType: "image/png", index: 1 },
				],
				nextImageIndex: null,
			},
		});

		const paged = (await handleIntegratedConversationRpcCommand(
			{ id: "22", type: "get_message_images", entryId: "e-images", startImageIndex: 1 },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { data: { images: Array<{ index: number }> } };
		expect(paged.data.images.map((image) => image.index)).toEqual([1]);
	});

	it("rejects get_message_images for unknown entries and invalid arguments", async () => {
		const unknownEntry = (await handleIntegratedConversationRpcCommand(
			{ id: "23", type: "get_message_images", entryId: "missing" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(unknownEntry).toMatchObject({ success: false, error: "unknown_entry" });

		const missingEntryId = (await handleIntegratedConversationRpcCommand(
			{ id: "24", type: "get_message_images" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(missingEntryId).toMatchObject({ success: false, error: "invalid_cursor" });

		const badIndex = (await handleIntegratedConversationRpcCommand(
			{ id: "25", type: "get_message_images", entryId: "e-1", startImageIndex: -2 },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(badIndex).toMatchObject({ success: false, error: "invalid_request" });
	});

	it("joins worktree bindings onto list_sessions summaries (worktrees.v1)", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "ws", path: "/tmp/ws" });
		await stateManager.upsertWorktree({
			id: "fix-login",
			workspaceName: "ws",
			path: "/tmp/agent/worktrees/--ws--/fix-login",
			sourceRootRelativePath: "Volt",
			branch: "volt/fix-login",
			createdAt: 1,
			sessionIds: [],
		});
		await stateManager.bindWorktreeSession("ws", "fix-login", "s-worktree");
		const runtime = createRuntime("s-worktree");
		runtime.listSessions = async () => [
			{
				sessionId: "s-worktree",
				sessionName: "worktree session",
				firstMessage: "hi",
				createdAt: new Date(1).toISOString(),
				modifiedAt: new Date(2).toISOString(),
				messageCount: 1,
				cwd: "/tmp/agent/worktrees/--ws--/fix-login/packages/coding-agent",
			},
			{
				sessionId: "s-plain",
				sessionName: "plain session",
				firstMessage: "hi",
				createdAt: new Date(1).toISOString(),
				modifiedAt: new Date(1).toISOString(),
				messageCount: 1,
			},
		];

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "7", type: "list_sessions" },
			createAuthorization(),
			createContext({ stateManager }),
			runtime,
		)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		const bySession = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
		expect(bySession.get("s-worktree")?.worktreeId).toBe("fix-login");
		expect(bySession.get("s-worktree")?.workingDirectory).toBe("Volt/packages/coding-agent");
		expect(bySession.get("s-plain")).not.toHaveProperty("worktreeId");
		// Ids only — no checkout path may reach the wire.
		expect(JSON.stringify(response)).not.toContain("/tmp/agent/worktrees");
	});

	it("includes parent workspace sessions when the active runtime cwd is a subfolder", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-conversation-list-"));
		try {
			const workspacePath = join(tempDir, "repo");
			const subfolderPath = join(workspacePath, "packages", "app");
			const agentDir = join(tempDir, "agent");
			mkdirSync(subfolderPath, { recursive: true });
			const sessionDir = getDefaultSessionDir(workspacePath, agentDir);
			writeFileSync(
				join(sessionDir, "root-session.jsonl"),
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "s-root",
					timestamp: new Date(1).toISOString(),
					cwd: workspacePath,
				})}\n`,
			);
			const runtime = createRuntime("s-subfolder");
			runtime.listSessions = async () => [
				{
					sessionId: "s-subfolder",
					sessionName: "subfolder session",
					firstMessage: "hi",
					createdAt: new Date(2).toISOString(),
					modifiedAt: new Date(3).toISOString(),
					messageCount: 1,
					cwd: subfolderPath,
				},
			];

			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "7", type: "list_sessions" },
				createAuthorization({ workspacePath }),
				createContext({ agentDir }),
				runtime,
			)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };

			expect(response.success).toBe(true);
			const bySessionId = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
			expect(bySessionId.get("s-root")).toBeDefined();
			expect(bySessionId.get("s-subfolder")?.workingDirectory).toBe("packages/app");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("adds optional daemon runtime ownership to list_sessions entries", async () => {
		const runtime = createRuntime();
		runtime.listSessions = async () =>
			["s-tui", "s-active", "s-detached", "s-draining", "s-saved"].map((sessionId, index) => ({
				sessionId,
				sessionName: sessionId,
				firstMessage: "hi",
				createdAt: new Date(index + 1).toISOString(),
				modifiedAt: new Date(index + 1).toISOString(),
				messageCount: 1,
			}));
		const runtimeStates = new Map<string, RemoteSessionRuntimeState>([
			["s-tui", "tui-owned"],
			["s-active", "daemon-active"],
			["s-detached", "daemon-detached"],
			["s-draining", "daemon-draining"],
		]);
		const listRuntimeStates = vi.fn(async () => runtimeStates);

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "runtime-states", type: "list_sessions" },
			createAuthorization(),
			createContext({ listRuntimeStates }),
			runtime,
		)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };

		expect(response.success).toBe(true);
		expect(listRuntimeStates).toHaveBeenCalledOnce();
		expect(listRuntimeStates).toHaveBeenCalledWith("ws");
		const bySessionId = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
		expect(bySessionId.get("s-tui")?.runtimeState).toBe("tui-owned");
		expect(bySessionId.get("s-active")?.runtimeState).toBe("daemon-active");
		expect(bySessionId.get("s-detached")?.runtimeState).toBe("daemon-detached");
		expect(bySessionId.get("s-draining")?.runtimeState).toBe("daemon-draining");
		expect(bySessionId.get("s-saved")).not.toHaveProperty("runtimeState");
	});

	it("carries the subagent origin marker on list_sessions entries", async () => {
		const runtime = createRuntime();
		runtime.listSessions = async () => [
			{
				sessionId: "s-user",
				sessionName: "user session",
				firstMessage: "hi",
				createdAt: new Date(1).toISOString(),
				modifiedAt: new Date(1).toISOString(),
				messageCount: 1,
			},
			{
				sessionId: "s-subagent",
				sessionName: "delegated run",
				firstMessage: "task",
				createdAt: new Date(2).toISOString(),
				modifiedAt: new Date(2).toISOString(),
				messageCount: 1,
				origin: "subagent" as const,
			},
		];

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "origin", type: "list_sessions" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };

		expect(response.success).toBe(true);
		const bySessionId = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
		expect(bySessionId.get("s-subagent")?.origin).toBe("subagent");
		expect(bySessionId.get("s-user")).not.toHaveProperty("origin");
	});

	it("serves list_sessions with the current session summary", async () => {
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "7", type: "list_sessions" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as { success: boolean; data: { sessions: unknown[] } };
		expect(response.success).toBe(true);
		expect(response.data.sessions).toEqual([]);
	});

	it("only unregisters the stream-bound workspace and runs the cleanup hook", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "ws", path: "/tmp/ws" });
		await stateManager.upsertWorkspace({ name: "other", path: "/tmp/other" });
		const cleanedUp: string[] = [];
		const context = createContext({
			stateManager,
			onWorkspaceUnregistered: async (workspaceName) => {
				cleanedUp.push(workspaceName);
			},
		});

		// A client bound to "ws" may not unregister an unrelated workspace by name.
		const otherWorkspace = (await handleIntegratedConversationRpcCommand(
			{ id: "8", type: "unregister_workspace", workspaceName: "other" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(otherWorkspace).toMatchObject({ success: false, error: "session_mismatch" });
		expect(cleanedUp).toEqual([]);

		// The legacy/undocumented `name` field is not honored; only `workspaceName` is.
		const legacyField = (await handleIntegratedConversationRpcCommand(
			{ id: "9", type: "unregister_workspace", name: "ws" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(legacyField).toMatchObject({ success: false, error: "session_mismatch" });
		expect(cleanedUp).toEqual([]);

		// Unregistering the bound workspace succeeds and fires the cleanup hook for it.
		const removed = (await handleIntegratedConversationRpcCommand(
			{ id: "10", type: "unregister_workspace", workspaceName: "ws" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(removed).toMatchObject({ success: true });
		expect(cleanedUp).toEqual(["ws"]);
	});

	it("stores a trimmed web-search key and reports configured without echoing the key", async () => {
		const { service, calls } = createFakeWebSearchKeyService();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "30", type: "set_web_search_key", apiKey: "  brave-key-123  " },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toEqual({
			id: "30",
			type: "response",
			command: "set_web_search_key",
			success: true,
			data: { webSearch: { configured: true } },
		});
		expect(calls).toEqual(["brave-key-123"]);
		expect(JSON.stringify(response)).not.toContain("brave-key-123");
	});

	it("clears the web-search key when apiKey is null, omitted, or blank", async () => {
		for (const command of [
			{ id: "31", type: "set_web_search_key", apiKey: null },
			{ id: "32", type: "set_web_search_key" },
			{ id: "33", type: "set_web_search_key", apiKey: "   " },
		]) {
			const { service, calls } = createFakeWebSearchKeyService();
			const response = (await handleIntegratedConversationRpcCommand(
				command,
				createAuthorization(),
				createContext({ webSearchKey: service }),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toEqual({
				id: command.id,
				type: "response",
				command: "set_web_search_key",
				success: true,
				data: { webSearch: { configured: false } },
			});
			expect(calls).toEqual([null]);
		}
	});

	it("rejects set_web_search_key when apiKey is not a string or null", async () => {
		const { service, calls } = createFakeWebSearchKeyService();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "34", type: "set_web_search_key", apiKey: 42 },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			id: "34",
			command: "set_web_search_key",
			success: false,
			error: "set_web_search_key requires apiKey to be a string or null",
		});
		expect(calls).toEqual([]);
	});

	it("reports web-search key status from the service via get_web_search_status", async () => {
		const { service } = createFakeWebSearchKeyService();
		const unconfigured = (await handleIntegratedConversationRpcCommand(
			{ id: "35", type: "get_web_search_status" },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(unconfigured).toEqual({
			id: "35",
			type: "response",
			command: "get_web_search_status",
			success: true,
			data: { webSearch: { configured: false } },
		});

		service.set("brave-key");
		const configured = (await handleIntegratedConversationRpcCommand(
			{ id: "36", type: "get_web_search_status" },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(configured).toMatchObject({ success: true, data: { webSearch: { configured: true } } });
	});

	it("rejects web-search key commands when no service is available", async () => {
		for (const type of ["set_web_search_key", "get_web_search_status"]) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "37", type },
				createAuthorization(),
				createContext(),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toMatchObject({
				id: "37",
				command: type,
				success: false,
				error: "unsupported_remote_command",
			});
		}
	});
});

describe("final assistant entry full-content projection (#85)", () => {
	function assistantEntry(id: string, ordinal: number, content: unknown[], stopReason = "stop"): SessionEntry {
		return {
			type: "message",
			id,
			ordinal,
			timestamp: new Date(ordinal).toISOString(),
			message: { role: "assistant", content, stopReason },
		} as unknown as SessionEntry;
	}

	function userEntry(id: string, ordinal: number, text: string): SessionEntry {
		return {
			type: "message",
			id,
			ordinal,
			timestamp: new Date(ordinal).toISOString(),
			message: { role: "user", content: [{ type: "text", text }] },
		} as unknown as SessionEntry;
	}

	function transcriptRuntime(branch: SessionEntry[], sessionId = "s-final"): ConversationCommandRuntime {
		return {
			session: { sessionId, sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};
	}

	const longText = `Full transcript of /tmp/ws/report.md\n${"m".repeat(40_000)}END_MARK`;

	it("serves the branch-latest assistant message in full on head pages and truncates older ones", () => {
		const branch = [
			assistantEntry("assistant-old", 1, [{ type: "text", text: `old ${"o".repeat(30_000)}OLD_END` }]),
			userEntry("user-1", 2, "continue"),
			assistantEntry("assistant-final", 3, [{ type: "text", text: longText }]),
			userEntry("user-2", 4, "queued prompt after completion"),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const finalItem = page?.items.find((item) => item.entryId === "assistant-final");
		expect(finalItem?.truncated).toBe(false);
		expect(finalItem?.text.endsWith("END_MARK")).toBe(true);
		expect(finalItem?.text).toContain("/workspace/report.md");
		expect(finalItem?.text).not.toContain("/tmp/ws");
		expect(finalItem?.parts).toEqual([expect.objectContaining({ type: "text", truncated: false })]);

		const olderItem = page?.items.find((item) => item.entryId === "assistant-old");
		expect(olderItem?.truncated).toBe(true);
		expect(Array.from(olderItem?.text ?? "")).toHaveLength(12_000);
		expect(olderItem?.text.endsWith("OLD_END")).toBe(false);
	});

	it("keeps multi-part text and thinking content complete within the cumulative budget", () => {
		const branch = [
			assistantEntry("assistant-final", 1, [
				{ type: "thinking", thinking: `think ${"t".repeat(20_000)}THINK_END`, redacted: false },
				{ type: "text", text: `part one ${"a".repeat(20_000)}` },
				{ type: "text", text: `${"b".repeat(20_000)}PART_TWO_END` },
			]),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const item = page?.items[0];
		expect(item?.truncated).toBe(false);
		expect(item?.text.endsWith("PART_TWO_END")).toBe(true);
		expect(item?.parts?.map((part) => part.truncated)).toEqual([false, false, false]);
		expect(item?.parts?.[0]?.text.endsWith("THINK_END")).toBe(true);
	});

	it("falls back to default truncation when the final entry exceeds the elevated byte budget", () => {
		const overBudget = "x".repeat(REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES + 1);
		const branch = [assistantEntry("assistant-final", 1, [{ type: "text", text: overBudget }])];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const item = page?.items[0];
		expect(item?.truncated).toBe(true);
		expect(Array.from(item?.text ?? "")).toHaveLength(12_000);
	});

	it("serves an at-budget final entry in full while keeping the page within its byte budget", () => {
		const half = REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES / 2;
		const branch = [
			...Array.from({ length: 60 }, (_, index) =>
				assistantEntry(`assistant-${index}`, index + 1, [{ type: "text", text: "y".repeat(30_000) }]),
			),
			assistantEntry("assistant-final", 61, [
				{ type: "text", text: "z".repeat(half) },
				{ type: "text", text: `${"z".repeat(half - 10)}AT_BUDGET` },
			]),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const finalItem = page?.items.at(-1);
		expect(finalItem?.entryId).toBe("assistant-final");
		expect(finalItem?.truncated).toBe(false);
		expect(finalItem?.text.endsWith("AT_BUDGET")).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
			REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES,
		);
	});

	it("serves an exactly-at-budget final entry with a trailing empty text part in full", () => {
		const atBudget = `${"z".repeat(REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES - 9)}AT_BUDGET`;
		const branch = [
			assistantEntry("assistant-final", 1, [
				{ type: "text", text: atBudget },
				{ type: "text", text: "" },
			]),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const item = page?.items[0];
		expect(item?.truncated).toBe(false);
		expect(item?.text.endsWith("AT_BUDGET")).toBe(true);
		expect(item?.parts?.map((part) => part.truncated)).toEqual([false, false]);
	});

	it("falls back to default truncation when a part after an exactly-at-budget prefix overflows the budget", () => {
		const atBudget = "x".repeat(REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES);
		const branch = [
			assistantEntry("assistant-final", 1, [
				{ type: "text", text: atBudget },
				{ type: "text", text: "!" },
			]),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const item = page?.items[0];
		expect(item?.truncated).toBe(true);
		expect(Array.from(item?.text ?? "")).toHaveLength(12_000);
	});

	it("skips an identity-only aborted head assistant entry so the last real answer ships in full", () => {
		const branch = [
			assistantEntry("assistant-answer", 1, [{ type: "text", text: longText }]),
			userEntry("user-1", 2, "another prompt"),
			assistantEntry("assistant-aborted", 3, [], "aborted"),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		const aborted = page?.items.find((item) => item.entryId === "assistant-aborted");
		expect(aborted?.stopReason).toBe("aborted");
		const answer = page?.items.find((item) => item.entryId === "assistant-answer");
		expect(answer?.truncated).toBe(false);
		expect(answer?.text.endsWith("END_MARK")).toBe(true);
	});

	it("skips a tool-call-only head assistant entry so the last real answer ships in full", () => {
		const branch = [
			assistantEntry("assistant-answer", 1, [{ type: "text", text: longText }]),
			userEntry("user-1", 2, "another prompt"),
			assistantEntry(
				"assistant-toolcall",
				3,
				[{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.txt" } }],
				"toolUse",
			),
		];
		const page = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));

		expect(page?.items.some((item) => item.entryId === "assistant-toolcall")).toBe(false);
		const answer = page?.items.find((item) => item.entryId === "assistant-answer");
		expect(answer?.truncated).toBe(false);
		expect(answer?.text.endsWith("END_MARK")).toBe(true);
	});

	it("does not elevate entries on cursor-paged history", () => {
		const branch = [
			assistantEntry("assistant-big", 1, [{ type: "text", text: `big ${"p".repeat(30_000)}BIG_END` }]),
			...Array.from({ length: 150 }, (_, index) => userEntry(`user-${index}`, index + 2, `message ${index}`)),
		];
		const newest = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch));
		expect(newest?.items.some((item) => item.entryId === "assistant-big")).toBe(false);
		expect(newest?.nextBeforeEntryId).toBeDefined();

		const older = createRemoteConversationTranscriptPage(createAuthorization(), transcriptRuntime(branch), {
			beforeEntryId: newest?.nextBeforeEntryId ?? undefined,
		});
		const bigItem = older?.items.find((item) => item.entryId === "assistant-big");
		expect(bigItem?.truncated).toBe(true);
		expect(Array.from(bigItem?.text ?? "")).toHaveLength(12_000);
	});

	it("serves the head assistant commit in full on the live lane and truncates non-head commits", () => {
		const headBranch = [
			userEntry("user-1", 1, "go"),
			assistantEntry("assistant-final", 2, [{ type: "text", text: longText }]),
		];
		const live = createRemoteConversationTranscriptEntry(
			headBranch[1]!,
			createAuthorization(),
			transcriptRuntime(headBranch),
		);
		expect(live?.truncated).toBe(false);
		expect(live?.text.endsWith("END_MARK")).toBe(true);

		const nonHeadBranch = [
			assistantEntry("assistant-final", 1, [{ type: "text", text: longText }]),
			userEntry("user-after", 2, "next prompt"),
			assistantEntry("assistant-next", 3, [{ type: "text", text: "short" }]),
		];
		const replayed = createRemoteConversationTranscriptEntry(
			nonHeadBranch[0]!,
			createAuthorization(),
			transcriptRuntime(nonHeadBranch),
		);
		expect(replayed?.truncated).toBe(true);
		expect(Array.from(replayed?.text ?? "")).toHaveLength(12_000);
	});
});

describe("worktree RPCs on conversation streams (worktrees.v1)", () => {
	const HOST_CHECKOUT_PATH = "/tmp/agent/worktrees/--ws--/fix-login";

	function createWorktreeBackend(): {
		backend: IrohRemoteWorktreeRpcBackend;
		createdFor: string[];
	} {
		const createdFor: string[] = [];
		const record = {
			id: "fix-login",
			workspaceName: "ws",
			path: HOST_CHECKOUT_PATH,
			branch: "volt/fix-login",
			baseRef: "main",
			createdAt: 1,
			sessionIds: [],
		};
		return {
			createdFor,
			backend: {
				createWorktree: vi.fn(async () => ({ ok: true as const, worktree: record })),
				listWorktrees: vi.fn(async () => ({
					ok: true as const,
					worktrees: [{ ...record, available: true, dirty: false, aheadBehind: { ahead: 1, behind: 0 } }],
				})),
				removeWorktree: vi.fn(async () => ({ ok: true as const, stoppedRuntimeCount: 0, closedStreamCount: 0 })),
			},
		};
	}

	function createWorktreeContext(backend?: IrohRemoteWorktreeRpcBackend): ConversationCommandContext {
		return createContext(backend === undefined ? {} : { createWorktreeBackend: () => backend });
	}

	it("create_worktree succeeds scoped to the stream workspace with no paths on the wire", async () => {
		const { backend } = createWorktreeBackend();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "1", type: "create_worktree", workspaceName: "ws", worktreeName: "fix-login" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			id: "1",
			type: "response",
			command: "create_worktree",
			success: true,
			data: { worktree: { id: "fix-login", branch: "volt/fix-login" } },
		});
		expect(backend.createWorktree).toHaveBeenCalledWith("ws", { id: "fix-login" });
		expect(JSON.stringify(response)).not.toContain(HOST_CHECKOUT_PATH);
	});

	it("list_worktrees returns summaries with aheadBehind and no paths", async () => {
		const { backend } = createWorktreeBackend();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "2", type: "list_worktrees", workspaceName: "ws" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			success: true,
			data: {
				worktrees: [{ id: "fix-login", available: true, dirty: false, aheadBehind: { ahead: 1, behind: 0 } }],
			},
		});
		expect(JSON.stringify(response)).not.toContain(HOST_CHECKOUT_PATH);
	});

	it("rejects cross-workspace requests with session_mismatch", async () => {
		const { backend } = createWorktreeBackend();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "3", type: "create_worktree", workspaceName: "other" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({ success: false, error: "session_mismatch" });
		expect(backend.createWorktree).not.toHaveBeenCalled();
	});

	it("fails with unsupported_remote_command when no daemon backend exists", async () => {
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "4", type: "list_worktrees", workspaceName: "ws" },
			createAuthorization(),
			createWorktreeContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({ success: false, error: "unsupported_remote_command" });
	});

	it("keeps remove_worktree off conversation streams", async () => {
		// The inbound passthrough filter admits create/list but not remove.
		const allowed = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "5", type: "create_worktree", workspaceName: "ws" }),
		);
		expect(allowed).toMatchObject({ allowed: true });
		const listAllowed = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "5", type: "list_worktrees", workspaceName: "ws" }),
		);
		expect(listAllowed).toMatchObject({ allowed: true });
		const removed = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "5", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login" }),
		);
		expect(removed).toMatchObject({ allowed: false });

		// Even if a remove reached the host handler, it is not dispatched there.
		const { backend } = createWorktreeBackend();
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "6", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		);
		expect(response).toBeUndefined();
		expect(backend.removeWorktree).not.toHaveBeenCalled();
	});
});

describe("get_transcript_entry_text (#86)", () => {
	function entry(id: string, ordinal: number, message: Record<string, unknown>): SessionEntry {
		return {
			type: "message",
			id,
			ordinal,
			timestamp: new Date(ordinal).toISOString(),
			message,
		} as unknown as SessionEntry;
	}

	function transcriptRuntime(branch: SessionEntry[], sessionId = "s-entry-text"): ConversationCommandRuntime {
		return {
			session: { sessionId, sessionManager: createSessionManager(branch) },
			listSessions: async () => [],
		};
	}

	async function fetchChunk(
		runtime: ConversationCommandRuntime,
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return (await handleIntegratedConversationRpcCommand(
			{ type: "get_transcript_entry_text", ...command },
			createAuthorization(),
			createContext(),
			runtime,
		)) as Record<string, unknown>;
	}

	it("pages the remainder of a truncated non-head assistant entry in order", async () => {
		const canonical = `Report at /tmp/ws/notes.md\n${"m".repeat(30_000)}END_MARK`;
		const branch = [
			entry("assistant-old", 1, {
				role: "assistant",
				content: [{ type: "text", text: canonical }],
				stopReason: "stop",
			}),
			entry("user-1", 2, { role: "user", content: [{ type: "text", text: "continue" }] }),
			entry("assistant-final", 3, {
				role: "assistant",
				content: [{ type: "text", text: "short" }],
				stopReason: "stop",
			}),
		];
		const runtime = transcriptRuntime(branch);

		const page = createRemoteConversationTranscriptPage(createAuthorization(), runtime);
		const oldItem = page?.items.find((item) => item.entryId === "assistant-old");
		expect(oldItem?.truncated).toBe(true);
		expect(Array.from(oldItem?.text ?? "")).toHaveLength(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS);

		const chunks: string[] = [];
		let offset: number | null | undefined;
		let response = await fetchChunk(runtime, { id: "c-0", entryId: "assistant-old" });
		for (let guard = 0; guard < 8; guard++) {
			expect(response).toMatchObject({
				id: expect.any(String),
				type: "response",
				command: "get_transcript_entry_text",
				success: true,
			});
			const data = (response as { data: Record<string, unknown> }).data;
			expect(data.workspaceName).toBe("ws");
			expect(data.sessionId).toBe("s-entry-text");
			expect(data.entryId).toBe("assistant-old");
			chunks.push(data.text as string);
			offset = data.nextOffset as number | null;
			expect(data.truncated).toBe(offset !== null);
			if (offset === null) break;
			expect(offset).toBe((data.offset as number) + Array.from(data.text as string).length);
			response = await fetchChunk(runtime, { id: `c-${offset}`, entryId: "assistant-old", offset });
		}
		expect(offset).toBeNull();

		const reconstructed = chunks.join("");
		expect(chunks.length).toBe(3);
		expect(Array.from(chunks[0]!)).toHaveLength(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS);
		// The projected (truncated) item text is a prefix of the continuation stream.
		expect(reconstructed.startsWith(oldItem?.text ?? "?")).toBe(true);
		expect(reconstructed.startsWith("Report at /workspace/notes.md")).toBe(true);
		expect(reconstructed).not.toContain("/tmp/ws");
		expect(reconstructed.endsWith("END_MARK")).toBe(true);
		const lastData = (response as { data: Record<string, unknown> }).data;
		expect(lastData.totalScalars).toBe(Array.from(reconstructed).length);
	});

	it("never splits an astral scalar across a chunk boundary", async () => {
		const canonical = `${"a".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS - 1)}\u{1F600}b`;
		const branch = [entry("e-astral", 1, { role: "user", content: [{ type: "text", text: canonical }] })];
		const runtime = transcriptRuntime(branch);

		const first = (await fetchChunk(runtime, { id: "1", entryId: "e-astral" })) as {
			data: { text: string; nextOffset: number | null; totalScalars: number };
		};
		expect(Array.from(first.data.text)).toHaveLength(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS);
		expect(first.data.text.endsWith("\u{1F600}")).toBe(true);
		expect(first.data.nextOffset).toBe(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS);
		expect(first.data.totalScalars).toBe(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS + 1);

		const rest = (await fetchChunk(runtime, {
			id: "2",
			entryId: "e-astral",
			offset: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
		})) as { data: { text: string; truncated: boolean; nextOffset: number | null } };
		expect(rest.data).toMatchObject({ text: "b", truncated: false, nextOffset: null });
	});

	it("serves the long-form lane for each projectable entry kind", async () => {
		const longOutput = `tool output from /tmp/ws/build.log\n${"o".repeat(10_000)}OUT_END`;
		const branch = [
			entry("e-user", 1, { role: "user", content: [{ type: "text", text: "user says /tmp/ws/a.txt" }] }),
			entry("e-tool", 2, {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: longOutput }],
			}),
			entry("e-bash", 3, { role: "bashExecution", command: "make", output: "built ok", exitCode: 0 }),
			{
				type: "compaction",
				id: "e-compaction",
				ordinal: 4,
				timestamp: new Date(4).toISOString(),
				summary: "Compacted: work in /tmp/ws so far",
				firstKeptEntryId: "e-user",
			} as unknown as SessionEntry,
			{
				type: "custom_message",
				id: "e-review",
				ordinal: 5,
				timestamp: new Date(5).toISOString(),
				customType: "review",
				display: true,
				content: [{ type: "text", text: "review verdict" }],
			} as unknown as SessionEntry,
		];
		const runtime = transcriptRuntime(branch);

		// The tool output lane is truncated on transcript pages but complete here.
		const page = createRemoteConversationTranscriptPage(createAuthorization(), runtime);
		const toolItem = page?.items.find((item) => item.entryId === "e-tool");
		expect(toolItem?.outputTruncated).toBe(true);

		const expectations: Array<[string, string]> = [
			["e-user", "user says /workspace/a.txt"],
			["e-tool", `tool output from /workspace/build.log\n${"o".repeat(10_000)}OUT_END`],
			["e-bash", "built ok"],
			["e-compaction", "Compacted: work in /workspace so far"],
			["e-review", "review verdict"],
		];
		for (const [entryId, expected] of expectations) {
			const response = (await fetchChunk(runtime, { id: entryId, entryId })) as {
				success: boolean;
				data: { text: string; truncated: boolean; nextOffset: number | null; totalScalars: number };
			};
			expect(response.success, entryId).toBe(true);
			expect(response.data.text, entryId).toBe(expected);
			expect(response.data.truncated, entryId).toBe(false);
			expect(response.data.nextOffset, entryId).toBeNull();
			expect(response.data.totalScalars, entryId).toBe(Array.from(expected).length);
		}
	});

	it("serves an empty terminal page for a projectable entry without text", async () => {
		const branch = [entry("e-aborted", 1, { role: "assistant", content: [], stopReason: "aborted" })];
		const runtime = transcriptRuntime(branch);

		const empty = (await fetchChunk(runtime, { id: "1", entryId: "e-aborted" })) as Record<string, unknown>;
		expect(empty).toMatchObject({
			success: true,
			data: { text: "", truncated: false, nextOffset: null, totalScalars: 0, offset: 0 },
		});

		const outOfBounds = await fetchChunk(runtime, { id: "2", entryId: "e-aborted", offset: 1 });
		expect(outOfBounds).toMatchObject({ success: false, error: "invalid_cursor" });
	});

	it("rejects unknown entries, non-projectable entries, and invalid arguments", async () => {
		const branch = [
			entry("e-user", 1, { role: "user", content: [{ type: "text", text: "hello world" }] }),
			{
				type: "custom_message",
				id: "e-hidden",
				ordinal: 2,
				timestamp: new Date(2).toISOString(),
				customType: "note",
				display: false,
				content: [{ type: "text", text: "hidden" }],
			} as unknown as SessionEntry,
		];
		const runtime = transcriptRuntime(branch);

		expect(await fetchChunk(runtime, { id: "1", entryId: "missing" })).toMatchObject({
			success: false,
			error: "unknown_entry",
		});
		expect(await fetchChunk(runtime, { id: "2", entryId: "e-hidden" })).toMatchObject({
			success: false,
			error: "unknown_entry",
		});
		expect(await fetchChunk(runtime, { id: "3" })).toMatchObject({ success: false, error: "invalid_cursor" });
		expect(await fetchChunk(runtime, { id: "4", entryId: "e-user", offset: -1 })).toMatchObject({
			success: false,
			error: "invalid_request",
		});
		expect(await fetchChunk(runtime, { id: "5", entryId: "e-user", offset: 1.5 })).toMatchObject({
			success: false,
			error: "invalid_request",
		});
		expect(await fetchChunk(runtime, { id: "6", entryId: "e-user", offset: "3" })).toMatchObject({
			success: false,
			error: "invalid_request",
		});
		// offset === totalScalars is past the final scalar of a non-empty entry.
		expect(await fetchChunk(runtime, { id: "7", entryId: "e-user", offset: 11 })).toMatchObject({
			success: false,
			error: "invalid_cursor",
		});
	});

	it("enforces workspace and session identity like get_transcript", async () => {
		const runtime = transcriptRuntime([
			entry("e-user", 1, { role: "user", content: [{ type: "text", text: "hello" }] }),
		]);

		const sessionMismatch = (await handleIntegratedConversationRpcCommand(
			{ id: "1", type: "get_transcript_entry_text", entryId: "e-user", sessionId: "other-session" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as Record<string, unknown>;
		expect(sessionMismatch).toMatchObject({ success: false, error: "session_mismatch" });

		const workspaceMismatch = (await handleIntegratedConversationRpcCommand(
			{ id: "2", type: "get_transcript_entry_text", entryId: "e-user", workspaceName: "other-ws" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as Record<string, unknown>;
		expect(workspaceMismatch).toMatchObject({ success: false, error: "session_mismatch" });

		const scoped = (await handleIntegratedConversationRpcCommand(
			{ id: "3", type: "get_transcript_entry_text", entryId: "e-user", sessionId: "s-entry-text" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as Record<string, unknown>;
		expect(scoped).toMatchObject({ success: true, data: { text: "hello" } });
	});
});
