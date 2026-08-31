/**
 * Shared manual Iroh stream doubles and session/boot helpers for Iroh remote RPC tests.
 *
 * These implement the simple blocking-read semantics used by the notification and
 * model RPC suites. Other Iroh suites (transport, core, handshake) keep their own
 * doubles on purpose: they exercise different transport semantics (read-size
 * tracking, deferred/failing writes, non-blocking handshake reads) that would
 * change test behavior if folded into one implementation.
 */

import { Buffer } from "node:buffer";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import { expect, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, PromptPreflightResult } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { ConversationProjectionFeed } from "../src/core/rpc/conversation-projection-feed.ts";
import type { IrohBytes, IrohRecvStreamLike, IrohSendStreamLike } from "../src/core/rpc/index.ts";
import type { RpcConversationAuthority } from "../src/core/rpc/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

type QueuedIrohRead = { type: "data"; bytes: IrohBytes } | { type: "end" };

export class ManualIrohRecvStream implements IrohRecvStreamLike {
	private readonly queue: QueuedIrohRead[] = [];
	private readonly readers: Array<(value: IrohBytes | undefined) => void> = [];

	read(_sizeLimit: number): Promise<IrohBytes | undefined> {
		const queued = this.queue.shift();
		if (queued) {
			return Promise.resolve(queued.type === "data" ? queued.bytes : undefined);
		}
		return new Promise((resolve) => {
			this.readers.push(resolve);
		});
	}

	pushLine(line: string): void {
		this.enqueue({ type: "data", bytes: Buffer.from(`${line}\n`, "utf8") });
	}

	end(): void {
		this.enqueue({ type: "end" });
	}

	stop(_errorCode: bigint): void {
		this.end();
	}

	private enqueue(queued: QueuedIrohRead): void {
		const reader = this.readers.shift();
		if (!reader) {
			this.queue.push(queued);
			return;
		}
		reader(queued.type === "data" ? queued.bytes : undefined);
	}
}

export class ManualIrohSendStream implements IrohSendStreamLike {
	readonly writes: Array<Array<number>> = [];
	finished = false;

	async writeAll(bytes: Array<number>): Promise<void> {
		this.writes.push(bytes);
	}

	async finish(): Promise<void> {
		this.finished = true;
	}

	writtenText(): string {
		return this.writes.map((bytes) => Buffer.from(bytes).toString("utf8")).join("");
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWrittenObjects(send: ManualIrohSendStream): Array<Record<string, unknown>> {
	return send
		.writtenText()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed)) {
				throw new Error("Expected JSON object");
			}
			return parsed;
		});
}

export function getCurrentConversationAuthority(send: ManualIrohSendStream): RpcConversationAuthority {
	const bootstrap = parseWrittenObjects(send)
		.slice()
		.reverse()
		.find((record) => record.type === "conversation_bootstrap");
	const conversation = bootstrap?.conversation;
	const delivery = bootstrap?.delivery;
	const transcript = bootstrap?.transcript;
	if (!isRecord(conversation) || !isRecord(delivery) || !isRecord(transcript)) {
		throw new Error("Conversation bootstrap authority is unavailable");
	}
	if (
		typeof conversation.sessionId !== "string" ||
		typeof delivery.subscriptionId !== "string" ||
		typeof transcript.branchEpoch !== "string"
	) {
		throw new Error("Conversation bootstrap authority is malformed");
	}
	return {
		sessionId: conversation.sessionId,
		subscriptionId: delivery.subscriptionId,
		branchEpoch: transcript.branchEpoch,
	};
}

export function withCurrentConversationAuthority<T extends object>(
	send: ManualIrohSendStream,
	command: T,
): T & { conversationAuthority: RpcConversationAuthority } {
	return { ...command, conversationAuthority: getCurrentConversationAuthority(send) };
}

export function createTestSession(sessionId: string, leafId: string | null) {
	const session = {
		leafId,
		autoCompactionEnabled: false,
		bindExtensions: vi.fn(async () => {}),
		followUpMode: "all" as const,
		gitContextProvider: {
			getSnapshot: () => null,
			retainObservation: () => () => undefined,
		},
		isCompacting: false,
		isStreaming: false,
		messages: [] as AgentMessage[],
		model: undefined,
		modelRegistry: { authStorage: {} },
		pendingMessageCount: 0,
		prompt: vi.fn(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
			},
		),
		sessionFile: `/sessions/${sessionId}.jsonl`,
		sessionId,
		sessionManager: {
			flush: vi.fn(async () => {}),
			getBranch: vi.fn((): object[] => []),
			getClientInput: vi.fn(() => undefined),
			getBranchWindow: ({
				beforeEntryId,
				maxEntries,
				lookbackEntries = 0,
			}: {
				beforeEntryId?: string;
				maxEntries: number;
				lookbackEntries?: number;
			}) => {
				const branch = session.sessionManager.getBranch() as SessionEntry[];
				const endIndex =
					beforeEntryId === undefined ? branch.length : branch.findIndex((entry) => entry.id === beforeEntryId);
				if (endIndex < 0) return undefined;
				const entryStart = Math.max(0, endIndex - maxEntries);
				const lookbackStart = Math.max(0, entryStart - lookbackEntries);
				return {
					entries: branch.slice(entryStart, endIndex),
					lookback: branch.slice(lookbackStart, entryStart),
					hasEarlier: lookbackStart > 0,
					visitedEntries: endIndex - lookbackStart + (lookbackStart > 0 ? 1 : 0),
				};
			},
			getLeafEntry: (): SessionEntry | undefined => (session.sessionManager.getBranch() as SessionEntry[]).at(-1),
			getLeafId: (): string | null => session.leafId,
			getSessionId: (): string => sessionId,
			getStartingGitContext: () => undefined,
		},
		settingsManager: { flush: vi.fn(async () => {}) },
		steeringMode: "all" as const,
		subscribe: vi.fn((_handler: (event: AgentSessionEvent) => void) => () => {}),
		thinkingLevel: "off" as const,
		fastModeEnabled: false,
		getPlanningState: () => ({ mode: "build" as const, plan: null }),
		waitForIdle: vi.fn(async () => {}),
		activeToolExecutions: new Map(),
		subscribeRuntimeEvents: vi.fn((_handler: () => Promise<void> | void) => () => {}),
	};
	return session;
}

type TestIrohConversationOptions = Pick<
	Parameters<typeof runIrohRemoteRpcMode>[1],
	"buildConversationSnapshot" | "hostNodeId" | "projectConversationExternal"
>;

interface TestConversationRuntimeHost {
	conversationProjectionFeed?: ConversationProjectionFeed;
	publishConversationProjectionEvent?: (event: object) => void;
	session: AgentSessionRuntime["session"];
}

/** Install the runtime-owned ordered feed surface omitted by lightweight test doubles. */
export function createTestIrohConversationOptions(runtimeHost: AgentSessionRuntime): TestIrohConversationOptions {
	const testHost = runtimeHost as unknown as TestConversationRuntimeHost;
	let feed = testHost.conversationProjectionFeed;
	if (!feed) {
		feed = new ConversationProjectionFeed({
			subscribe: (listener) => testHost.session.subscribe((event) => listener(event)),
		});
		Object.defineProperty(testHost, "conversationProjectionFeed", {
			configurable: true,
			value: feed,
			writable: true,
		});
	}
	if (!testHost.publishConversationProjectionEvent) {
		Object.defineProperty(testHost, "publishConversationProjectionEvent", {
			configurable: true,
			value: (event: object) => feed.publishExternal(event),
			writable: true,
		});
	}

	return {
		hostNodeId: "a".repeat(64),
		buildConversationSnapshot: ({ activeAssistant, branchEpoch }) => {
			const session = testHost.session;
			return {
				conversation: { workspaceName: "test", sessionId: session.sessionId },
				state: {
					thinkingLevel: session.thinkingLevel,
					availableThinkingLevels: [session.thinkingLevel],
					fastModeEnabled: session.fastModeEnabled,
					planning:
						typeof session.getPlanningState === "function"
							? session.getPlanningState()
							: { mode: "build", plan: null },
					gitContext: session.gitContextProvider.getSnapshot(),
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					steeringQueue: [],
					followUpQueue: [],
				},
				transcript: {
					sessionId: session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 1,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			};
		},
		projectConversationExternal: (event) => event,
	};
}

export async function startIrohRpcMode(
	runtimeHost: AgentSessionRuntime,
	startupSession: Pick<AgentSession, "bindExtensions"> | Pick<ReturnType<typeof createTestSession>, "bindExtensions">,
	options: Partial<Parameters<typeof runIrohRemoteRpcMode>[1]> = {},
) {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	const conversationOptions = createTestIrohConversationOptions(runtimeHost);
	const modePromise = runIrohRemoteRpcMode(runtimeHost, {
		...options,
		buildConversationSnapshot: options.buildConversationSnapshot ?? conversationOptions.buildConversationSnapshot,
		hostNodeId: options.hostNodeId ?? conversationOptions.hostNodeId,
		projectConversationExternal:
			options.projectConversationExternal ?? conversationOptions.projectConversationExternal,
		rpcGrant: options.rpcGrant ?? createIrohRemotePresetAccess("full").rpcGrant,
		disposeRuntimeOnClose: false,
		stream: { recv, send },
		workspacePath: "/workspace",
	});
	await vi.waitFor(() => expect(startupSession.bindExtensions).toHaveBeenCalledOnce());
	const bootstrap = parseWrittenObjects(send)[0];
	expect(bootstrap).toMatchObject({
		type: "conversation_bootstrap",
		delivery: { cursor: 0 },
		conversation: { sessionId: runtimeHost.session.sessionId },
		reason: "bootstrap",
	});
	return { modePromise, recv, send };
}

export function createTestModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}
