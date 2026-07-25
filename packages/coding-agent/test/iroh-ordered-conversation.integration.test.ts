import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, isConversationTranscriptCommittedEvent } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { ConversationProjectionSnapshotBuilder } from "../src/core/rpc/conversation-projection-feed.ts";
import type { RpcConversationTranscriptItem } from "../src/core/rpc/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import {
	createTestSession as createIrohTestSession,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
} from "./iroh-stream-doubles.ts";

interface OrderedConversationFixture {
	readonly manager: SessionManager;
	readonly modePromise: Promise<void>;
	readonly recv: ManualIrohRecvStream;
	readonly runtimeHost: AgentSessionRuntime;
	readonly send: ManualIrohSendStream;
	readonly session: Pick<ReturnType<typeof createIrohTestSession>, "bindExtensions">;
	readonly sessionId: string;
	emit(event: object): void;
	close(): Promise<void>;
}

class GatedIrohSendStream extends ManualIrohSendStream {
	private gate: Promise<void> | undefined;
	private releaseGate: (() => void) | undefined;
	private signalBlockedWriteStarted: (() => void) | undefined;

	blockNextWrite(): Promise<void> {
		this.gate = new Promise<void>((resolve) => {
			this.releaseGate = resolve;
		});
		return new Promise<void>((resolve) => {
			this.signalBlockedWriteStarted = resolve;
		});
	}

	releaseBlockedWrite(): void {
		this.releaseGate?.();
		this.releaseGate = undefined;
	}

	override async writeAll(bytes: Array<number>): Promise<void> {
		const gate = this.gate;
		this.gate = undefined;
		if (gate) {
			this.signalBlockedWriteStarted?.();
			this.signalBlockedWriteStarted = undefined;
			await gate;
		}
		await super.writeAll(bytes);
	}
}

function projectAssistantEntry(entry: SessionEntry): RpcConversationTranscriptItem | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") {
		return undefined;
	}
	if (entry.ordinal === undefined) {
		throw new Error(`Committed entry ${entry.id} is missing its ordinal`);
	}
	return {
		entryId: entry.id,
		ordinal: entry.ordinal,
		createdAt: entry.timestamp,
		role: "assistant",
		text: entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join(""),
		truncated: false,
		stopReason: entry.message.stopReason,
	};
}

function createSnapshotBuilder(manager: SessionManager, sessionId: string): ConversationProjectionSnapshotBuilder {
	return ({ activeAssistant, branchEpoch }) => {
		const items = manager
			.getBranch()
			.map(projectAssistantEntry)
			.filter((entry): entry is RpcConversationTranscriptItem => entry !== undefined);
		const head = items.at(-1);
		return {
			conversation: { workspaceName: "scratch", sessionId },
			state: {
				thinkingLevel: "off",
				availableThinkingLevels: ["off"],
				fastModeEnabled: false,
				planning: { mode: "build", plan: null },
				isStreaming: activeAssistant !== null,
				isBusy: activeAssistant !== null,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionFile: manager.getSessionFile(),
				sessionId,
				autoCompactionEnabled: false,
				messageCount: items.length,
				pendingMessageCount: 0,
				steeringQueue: [],
				followUpQueue: [],
			},
			transcript: {
				workspaceName: "scratch",
				sessionId,
				items,
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch,
				head: head ? { entryId: head.entryId, ordinal: head.ordinal } : null,
			},
			activeAssistant,
			activeWorkflows: [],
		};
	};
}

async function createFixture(
	preload: (emit: (event: object) => void) => void,
	options: {
		send?: ManualIrohSendStream;
		isRpcGrantCurrent?: () => boolean | Promise<boolean>;
		onClientCapabilitiesChanged?: (features: string[]) => void;
		waitForPhysicalStartup?: boolean;
		configureRuntimeHost?: (runtimeHost: AgentSessionRuntime) => void;
		remoteCommandHandler?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	} = {},
): Promise<OrderedConversationFixture> {
	const root = mkdtempSync(join(tmpdir(), "volt-iroh-ordered-conversation-"));
	const workspacePath = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	const manager = SessionManager.create(workspacePath, sessionDir);
	const sessionId = manager.getSessionId();
	const listeners = new Set<(event: object) => void>();
	const session = {
		...createIrohTestSession(sessionId, null),
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		subscribe: vi.fn((listener: (event: object) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	};
	const runtimeHost = new AgentSessionRuntime(
		session as unknown as AgentSession,
		{ cwd: workspacePath, agentDir: undefined } as unknown as AgentSessionServices,
		async () => {
			throw new Error("session replacement is not used by this integration fixture");
		},
	);
	options.configureRuntimeHost?.(runtimeHost);
	const emit = (event: object): void => {
		for (const listener of [...listeners]) {
			listener(event);
		}
	};
	preload(emit);

	const recv = new ManualIrohRecvStream();
	const send = options.send ?? new ManualIrohSendStream();
	const modePromise = runIrohRemoteRpcMode(runtimeHost, {
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		disposeRuntimeOnClose: false,
		stream: { recv, send },
		workspacePath,
		buildConversationSnapshot: createSnapshotBuilder(manager, sessionId),
		projectConversationExternal: (event) => {
			if (!isConversationTranscriptCommittedEvent(event)) {
				return event;
			}
			const entry = projectAssistantEntry(event.entry);
			return entry ? { type: "transcript_entry", entry, final: true } : null;
		},
		...(options.onClientCapabilitiesChanged === undefined
			? {}
			: { onClientCapabilitiesChanged: options.onClientCapabilitiesChanged }),
		...(options.isRpcGrantCurrent === undefined ? {} : { isRpcGrantCurrent: options.isRpcGrantCurrent }),
		...(options.remoteCommandHandler === undefined ? {} : { remoteCommandHandler: options.remoteCommandHandler }),
	});
	void modePromise.catch(() => {});

	if (options.waitForPhysicalStartup !== false) {
		await vi.waitFor(() => {
			expect(parseWrittenObjects(send)[0]?.type).toBe("conversation_bootstrap");
		});
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());
	}

	return {
		manager,
		modePromise,
		recv,
		runtimeHost,
		send,
		session,
		sessionId,
		emit,
		async close() {
			recv.end();
			try {
				await modePromise;
			} finally {
				runtimeHost.conversationProjectionFeed.dispose();
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

function emitTextUpdate(emit: (event: object) => void, seq: number, text: string, delta: string): void {
	const snapshot = fauxAssistantMessage(text, { timestamp: seq });
	emit({
		type: "message_update",
		message: snapshot,
		assistantMessageEvent: {
			type: "text_delta",
			seq,
			contentIndex: 0,
			delta,
			snapshot,
			toolState: [],
		},
	});
}

describe("Iroh ordered conversation integration", () => {
	it("bootstraps a mid-stream attach before a contiguous live tail and persisted transcript commit", async () => {
		const fixture = await createFixture((emit) => {
			emit({ type: "message_start", message: fauxAssistantMessage([], { timestamp: 0 }) });
			emitTextUpdate(emit, 1, "H", "H");
			emitTextUpdate(emit, 2, "Hel", "el");
		});
		try {
			const initial = parseWrittenObjects(fixture.send)[0]!;
			expect(initial).toMatchObject({
				type: "conversation_bootstrap",
				reason: "bootstrap",
				delivery: { cursor: 0 },
				activeAssistant: {
					stream: { epoch: 1, seq: 2 },
					message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
				},
			});
			const subscriptionId = (initial.delivery as { subscriptionId: string }).subscriptionId;

			emitTextUpdate(fixture.emit, 3, "Hello", "lo");
			const finalMessage = fauxAssistantMessage("Hello", { timestamp: 4 });
			fixture.emit({ type: "message_end", message: finalMessage });
			const committedEntryId = fixture.manager.appendMessage(finalMessage);
			await fixture.manager.flush();

			const sessionFile = fixture.manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);
			expect(readFileSync(sessionFile!, "utf8")).toContain(`"id":"${committedEntryId}"`);

			await vi.waitFor(() => {
				expect(parseWrittenObjects(fixture.send).some((value) => value.type === "transcript_entry")).toBe(true);
			});
			const conversation = parseWrittenObjects(fixture.send).filter((value) => "delivery" in value);
			expect(conversation.map((value) => value.type)).toEqual([
				"conversation_bootstrap",
				"message_update",
				"message_end",
				"transcript_entry",
			]);
			expect(conversation.map((value) => value.delivery as { subscriptionId: string; cursor: number })).toEqual([
				{ subscriptionId, cursor: 0 },
				{ subscriptionId, cursor: 1 },
				{ subscriptionId, cursor: 2 },
				{ subscriptionId, cursor: 3 },
			]);

			const tail = conversation[1]!;
			expect(tail).toMatchObject({
				type: "message_update",
				stream: { epoch: 1, seq: 3 },
				assistantMessageEvent: { type: "text_delta", delta: "lo" },
			});
			expect(tail).not.toHaveProperty("message");
			expect(tail.assistantMessageEvent).not.toHaveProperty("snapshot");

			expect(conversation[3]).toMatchObject({
				type: "transcript_entry",
				entry: { entryId: committedEntryId, role: "assistant", text: "Hello", stopReason: "stop" },
				final: true,
			});
		} finally {
			await fixture.close();
		}
	});

	it("writes a correlated resync checkpoint before its RPC response on the same writer", async () => {
		const fixture = await createFixture((emit) => {
			emit({ type: "message_start", message: fauxAssistantMessage([], { timestamp: 0 }) });
			emitTextUpdate(emit, 1, "1\n2", "1\n2");
		});
		try {
			const initial = parseWrittenObjects(fixture.send)[0]!;
			const subscriptionId = (initial.delivery as { subscriptionId: string }).subscriptionId;
			fixture.recv.pushLine(
				JSON.stringify({
					id: "resync-1",
					type: "report_stream_discontinuity",
					sessionId: fixture.sessionId,
					subscriptionId,
					lastAppliedCursor: 0,
					reason: "cursor_gap",
				}),
			);

			await vi.waitFor(() => {
				expect(
					parseWrittenObjects(fixture.send).some(
						(value) => value.type === "response" && value.command === "report_stream_discontinuity",
					),
				).toBe(true);
			});
			const written = parseWrittenObjects(fixture.send);
			const checkpointIndex = written.findIndex(
				(value) => value.type === "conversation_bootstrap" && value.requestId === "resync-1",
			);
			const responseIndex = written.findIndex(
				(value) => value.type === "response" && value.command === "report_stream_discontinuity",
			);

			expect(checkpointIndex).toBe(1);
			expect(responseIndex).toBe(2);
			expect(written[checkpointIndex]).toMatchObject({
				type: "conversation_bootstrap",
				reason: "resync",
				requestId: "resync-1",
				delivery: { subscriptionId, cursor: 1 },
				activeAssistant: {
					stream: { epoch: 1, seq: 1 },
					message: { content: [{ type: "text", text: "1\n2" }] },
				},
			});
			expect(written[responseIndex]).toEqual({
				id: "resync-1",
				type: "response",
				command: "report_stream_discontinuity",
				success: true,
				data: { subscriptionId, requestId: "resync-1", checkpointCursor: 1 },
			});

			// The checkpoint is a new authoritative base, not a terminal snapshot.
			// Prove the same subscription continues with a contiguous live tail and
			// converges on the exact canonical entry persisted by SessionManager.
			emitTextUpdate(fixture.emit, 2, "1\n2\n3", "\n3");
			const finalMessage = fauxAssistantMessage("1\n2\n3", { timestamp: 3 });
			fixture.emit({ type: "message_end", message: finalMessage });
			const committedEntryId = fixture.manager.appendMessage(finalMessage);

			await vi.waitFor(() => {
				expect(
					parseWrittenObjects(fixture.send).some(
						(value) =>
							value.type === "transcript_entry" &&
							(value.entry as { entryId?: string } | undefined)?.entryId === committedEntryId,
					),
				).toBe(true);
			});
			const recoveredTail = parseWrittenObjects(fixture.send).filter(
				(value) =>
					"delivery" in value &&
					(value.delivery as { cursor?: number }).cursor !== undefined &&
					(value.delivery as { cursor: number }).cursor >= 1,
			);
			expect(recoveredTail.map((value) => value.type)).toEqual([
				"conversation_bootstrap",
				"message_update",
				"message_end",
				"transcript_entry",
			]);
			expect(recoveredTail.map((value) => (value.delivery as { cursor: number }).cursor)).toEqual([1, 2, 3, 4]);
			expect(recoveredTail[1]).toMatchObject({
				type: "message_update",
				stream: { epoch: 1, seq: 2 },
				assistantMessageEvent: { type: "text_delta", delta: "\n3" },
			});
			expect(recoveredTail[3]).toMatchObject({
				type: "transcript_entry",
				entry: {
					entryId: committedEntryId,
					text: "1\n2\n3",
					stopReason: "stop",
				},
				final: true,
			});
			const sessionFile = fixture.manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await fixture.manager.flush();
			const persisted = readFileSync(sessionFile!, "utf8");
			expect(persisted).toContain(`"id":"${committedEntryId}"`);
			expect(persisted).toContain('"text":"1\\n2\\n3"');
			expect(persisted).toContain('"stopReason":"stop"');
		} finally {
			await fixture.close();
		}
	});

	it("fences a stale grant rejection ahead of queued source frames and settles the stream", async () => {
		let grantCurrent = true;
		const send = new GatedIrohSendStream();
		const fixture = await createFixture(() => {}, {
			send,
			isRpcGrantCurrent: () => grantCurrent,
		});
		try {
			const blockedWriteStarted = send.blockNextWrite();
			fixture.emit({ type: "agent_start" });
			fixture.emit({ type: "turn_start" });
			await blockedWriteStarted;
			grantCurrent = false;
			fixture.recv.pushLine(JSON.stringify({ id: "stale-1", type: "get_state" }));

			await fixture.modePromise;
			expect(parseWrittenObjects(send).map((frame) => frame.type)).toEqual(["conversation_bootstrap"]);

			send.releaseBlockedWrite();
			await vi.waitFor(() =>
				expect(parseWrittenObjects(send).map((frame) => frame.type)).toEqual([
					"conversation_bootstrap",
					"agent_start",
				]),
			);

			const frames = parseWrittenObjects(send);
			expect(frames).not.toContainEqual(expect.objectContaining({ type: "turn_start" }));
			expect(frames).not.toContainEqual(expect.objectContaining({ id: "stale-1", type: "response" }));
			expect(send.finished).toBe(true);
		} finally {
			send.releaseBlockedWrite();
			await fixture.close();
		}
	});

	it("leases integrated host commands while interruption commands bypass the held session actor", async () => {
		let stableSessionCalls = 0;
		let markStableSessionEntered = () => {};
		const stableSessionEntered = new Promise<void>((resolve) => {
			markStableSessionEntered = resolve;
		});
		let releaseStableSession = () => {};
		let stableSessionGate = Promise.resolve();
		const blockStableSession = (): (() => void) => {
			stableSessionGate = new Promise<void>((resolve) => {
				releaseStableSession = resolve;
			});
			return releaseStableSession;
		};
		const remoteCommandHandler = vi.fn(async (command: Record<string, unknown>) => ({
			id: typeof command.id === "string" ? command.id : undefined,
			type: "response",
			command: command.type,
			success: true,
		}));
		const releaseOrdinaryCommand = blockStableSession();
		const fixture = await createFixture(() => {}, {
			remoteCommandHandler,
			configureRuntimeHost: (runtimeHost) => {
				const runWithStableSession = runtimeHost.runWithStableSession.bind(runtimeHost);
				runtimeHost.runWithStableSession = (async (operation) => {
					stableSessionCalls++;
					markStableSessionEntered();
					await stableSessionGate;
					return runWithStableSession(operation);
				}) as typeof runtimeHost.runWithStableSession;
			},
		});
		let releaseAbortBypass = () => {};
		try {
			fixture.recv.pushLine(JSON.stringify({ id: "host-leased", type: "list_sessions" }));
			await stableSessionEntered;
			expect(remoteCommandHandler).not.toHaveBeenCalled();

			releaseOrdinaryCommand();
			await vi.waitFor(() =>
				expect(parseWrittenObjects(fixture.send)).toContainEqual(
					expect.objectContaining({ id: "host-leased", command: "list_sessions", success: true }),
				),
			);
			expect(stableSessionCalls).toBe(1);

			releaseAbortBypass = blockStableSession();
			fixture.recv.pushLine(JSON.stringify({ id: "host-abort-bypass", type: "abort" }));
			await vi.waitFor(() =>
				expect(remoteCommandHandler).toHaveBeenCalledWith(
					expect.objectContaining({ id: "host-abort-bypass", type: "abort" }),
				),
			);
			expect(stableSessionCalls).toBe(1);
		} finally {
			releaseOrdinaryCommand();
			releaseAbortBypass();
			await fixture.close();
		}
	});

	it("retires on natural peer EOF without waiting for a blocked physical write", async () => {
		const send = new GatedIrohSendStream();
		let resolveCapabilitiesObserved = () => {};
		const capabilitiesObserved = new Promise<void>((resolve) => {
			resolveCapabilitiesObserved = resolve;
		});
		const fixture = await createFixture(() => {}, {
			send,
			onClientCapabilitiesChanged: () => resolveCapabilitiesObserved(),
		});
		let modeSettled = false;
		void fixture.modePromise.then(
			() => {
				modeSettled = true;
			},
			() => {
				modeSettled = true;
			},
		);
		try {
			const blockedWriteStarted = send.blockNextWrite();
			fixture.emit({ type: "agent_start" });
			await blockedWriteStarted;

			// The response is admitted to the ordered feed behind agent_start, but the
			// native writer cannot dequeue either it or any later record.
			fixture.recv.pushLine(
				JSON.stringify({ id: "caps-behind-blocked-write", type: "set_client_capabilities", features: [] }),
			);
			await capabilitiesObserved;
			await new Promise((resolve) => setImmediate(resolve));
			fixture.recv.end();

			await vi.waitFor(() => expect(modeSettled).toBe(true));
			expect(parseWrittenObjects(send).map((frame) => frame.type)).toEqual(["conversation_bootstrap"]);

			send.releaseBlockedWrite();
			await vi.waitFor(() =>
				expect(parseWrittenObjects(send).map((frame) => frame.type)).toEqual([
					"conversation_bootstrap",
					"agent_start",
				]),
			);
			expect(parseWrittenObjects(send)).not.toContainEqual(
				expect.objectContaining({ id: "caps-behind-blocked-write", type: "response" }),
			);
		} finally {
			send.releaseBlockedWrite();
			await fixture.close();
		}
	});

	it("starts ingress after bootstrap admission and retires on peer EOF while its physical write is blocked", async () => {
		const send = new GatedIrohSendStream();
		const bootstrapWriteStarted = send.blockNextWrite();
		let resolveCapabilitiesObserved = () => {};
		const capabilitiesObserved = new Promise<void>((resolve) => {
			resolveCapabilitiesObserved = resolve;
		});
		const fixture = await createFixture(() => {}, {
			send,
			waitForPhysicalStartup: false,
			onClientCapabilitiesChanged: () => resolveCapabilitiesObserved(),
		});
		let modeSettled = false;
		void fixture.modePromise.then(
			() => {
				modeSettled = true;
			},
			() => {
				modeSettled = true;
			},
		);
		try {
			await bootstrapWriteStarted;
			// Bootstrap already owns cursor zero even though no bytes have reached
			// the peer, so bounded input admission and RPC startup must be live.
			await vi.waitFor(() => expect(fixture.session.bindExtensions).toHaveBeenCalledOnce());
			fixture.recv.pushLine(
				JSON.stringify({ id: "caps-behind-bootstrap", type: "set_client_capabilities", features: [] }),
			);
			await capabilitiesObserved;

			fixture.recv.end();
			await vi.waitFor(() => expect(modeSettled).toBe(true));
			expect(parseWrittenObjects(send)).toEqual([]);

			send.releaseBlockedWrite();
			await vi.waitFor(() =>
				expect(parseWrittenObjects(send).map((frame) => frame.type)).toEqual(["conversation_bootstrap"]),
			);
			expect(parseWrittenObjects(send)).not.toContainEqual(
				expect.objectContaining({ id: "caps-behind-bootstrap", type: "response" }),
			);
		} finally {
			send.releaseBlockedWrite();
			await fixture.close();
		}
	});
});
