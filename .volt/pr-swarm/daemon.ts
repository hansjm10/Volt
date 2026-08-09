import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type * as IrohNative from "@number0/iroh/index.js";
import {
	AuthStorage,
	createIrohRemoteSanitizedReconnectTicket,
	createIrohRpcTransport,
	decodeIrohRemoteTicketPayload,
	IrohRemoteClientEngine,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_CONVERSATION_STREAMS_FEATURE,
	IROH_REMOTE_MULTI_STREAMS_FEATURE,
	IROH_REMOTE_PLANNING_STATE_FEATURE,
	IROH_REMOTE_WORKTREES_FEATURE,
	type IrohRemoteConversationTarget,
	type IrohRemoteRpcCapability,
	type IrohRemoteTicketPayload,
	type RpcClientEvent,
	type RpcCommand,
	type RpcResponse,
	type RpcReviewWorkflowResultResponse,
	type RpcSessionState,
	RpcTransportClient,
	serializeJsonLine,
} from "@hansjm10/volt-coding-agent";
import { VERSION, getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { IROH_REMOTE_AGENT_SETTLED_FEATURE } from "../../packages/coding-agent/src/core/remote/iroh/protocol.ts";
import { createDaemonClient, type DaemonClient } from "../../packages/coding-agent/src/daemon/control-client.ts";
import {
	CONTROL_PAIR_CANCEL_CAPABILITY,
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlEvent,
	type ControlResponse,
	type ControlWorktreeStatus,
} from "../../packages/coding-agent/src/daemon/control-protocol.ts";
import { formatIrohLoadError, loadIrohModule } from "../../packages/coding-agent/src/daemon/iroh-native.ts";
import { probeDaemon, readPublishedDaemonEndpoint } from "../../packages/coding-agent/src/daemon/spawn.ts";
import { writeDurableAtomicFile } from "../../packages/coding-agent/src/utils/durable-atomic-write.ts";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
} from "../../packages/coding-agent/src/utils/private-files.ts";

export const SWARM_ALLOWED_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "inspect", "lsp"] as const;
export const SWARM_RPC_CAPABILITIES = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"worktrees.manage.v1",
] as const satisfies readonly IrohRemoteRpcCapability[];

const CLIENT_STATE_FILE = "client.json";
const RELAY_TOKEN_FILE = "relay-token.json";
const PAIR_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 120_000;
const REVIEW_TIMEOUT_MS = 60 * 60 * 1_000;

export interface StoredClientCredentials {
	version: 1;
	clientSecretKey: number[];
	clientNodeId: string;
	hostNodeId: string;
	workspace: string;
	reconnectTicket: string;
}

export interface StoredRelayToken {
	version: 1;
	hostNodeId: string;
	token: string;
}

interface ConversationAuthority {
	sessionId: string;
	subscriptionId: string;
	branchEpoch: string;
}

export interface PlanningSnapshot {
	mode: "build" | "plan";
	plan: null | {
		id: string;
		revision: number;
		phase: "draft" | "ready" | "active" | "completed" | "handed_off";
		title?: string;
		summary?: string;
		steps: Array<{ id: string; text: string; status: string; note?: string }>;
	};
}

export interface ReviewInvocation {
	workflowId: string;
	result: RpcReviewWorkflowResultResponse;
}

export interface AgentConversation {
	readonly sessionId: string;
	getState(): Promise<RpcSessionState>;
	promptAndWait(message: string, timeoutMs?: number): Promise<void>;
	steer(message: string): Promise<void>;
	setAgentMode(mode: "build" | "plan"): Promise<PlanningSnapshot>;
	executePlan(planId: string, expectedRevision: number): Promise<{ planning: PlanningSnapshot; selectedSessionId: string; started: boolean }>;
	invokeReview(action: "review.pr" | "review.commit", args: Record<string, string | number | boolean>): Promise<ReviewInvocation>;
	getReviewResult(runId: string): Promise<RpcReviewWorkflowResultResponse>;
	publishReview(runId: string): Promise<{ inlineFindingIds: string[]; summaryOnlyFindingIds: string[] }>;
	waitForIdle(timeoutMs?: number): Promise<void>;
	close(): Promise<void>;
}

export interface DaemonRuntimeAdapter {
	start(): Promise<void>;
	assertModelAuthentication(sessionId: string): Promise<void>;
	openConversation(sessionId: string, worktreeId?: string, resume?: boolean): Promise<AgentConversation>;
	createWorktree(options: {
		workspaceName: string;
		worktreeName: string;
		branch: string;
		baseRef: string;
	}): Promise<ControlWorktreeStatus>;
	listWorktrees(workspaceName: string): Promise<ControlWorktreeStatus[]>;
	removeWorktree(workspaceName: string, worktreeId: string): Promise<void>;
	steerSession(sessionId: string, message: string): Promise<boolean>;
	getWorkspacePath(): string;
	close(): Promise<void>;
}

interface VoltDaemonAdapterOptions {
	workspaceName: string;
	swarmDir: string;
	agentDir?: string;
	clientLabel?: string;
}

interface PendingPairing {
	fullTicket: string;
	payload: IrohRemoteTicketPayload;
	secretKey: number[];
	clientNodeId: string;
}

type RpcCommandBody = RpcCommand extends infer Command
	? Command extends { id?: string }
		? Omit<Command, "id">
		: never
	: never;

type SuccessfulRpcResponse = Extract<RpcResponse, { success: true }>;

class SwarmRpcClient extends RpcTransportClient {
	private authority?: ConversationAuthority;
	private readonly authorityWaiters = new Set<{
		resolve: (authority: ConversationAuthority) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}>();

	protected override handleLine(line: string): void {
		try {
			const value = JSON.parse(line) as unknown;
			const authority = parseBootstrapAuthority(value);
			if (authority) this.setAuthority(authority);
		} catch {
			// The base client owns malformed-line handling and correlation failure.
		}
		super.handleLine(line);
	}

	async waitForAuthority(timeoutMs = 30_000): Promise<ConversationAuthority> {
		if (this.authority) return this.authority;
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.authorityWaiters.delete(waiter);
					reject(new Error("Timed out waiting for conversation bootstrap authority"));
				}, timeoutMs),
			};
			this.authorityWaiters.add(waiter);
		});
	}

	async sendAuthorized<Data>(command: RpcCommandBody): Promise<Data> {
		const authority = await this.waitForAuthority();
		const send = (this as unknown as {
			send(command: RpcCommandBody): Promise<RpcResponse>;
		}).send;
		const response = await send.call(this, { ...command, conversationAuthority: authority } as RpcCommandBody);
		if (!response.success) throw new Error(response.error);
		return (response as SuccessfulRpcResponse & { data?: unknown }).data as Data;
	}

	private setAuthority(authority: ConversationAuthority): void {
		this.authority = authority;
		for (const waiter of this.authorityWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(authority);
		}
		this.authorityWaiters.clear();
	}
}

class IrohAgentConversation implements AgentConversation {
	readonly sessionId: string;
	private readonly client: SwarmRpcClient;
	private readonly closeNative: () => Promise<void>;

	constructor(sessionId: string, client: SwarmRpcClient, closeNative: () => Promise<void>) {
		this.sessionId = sessionId;
		this.client = client;
		this.closeNative = closeNative;
	}

	getState(): Promise<RpcSessionState> {
		return this.client.getState();
	}

	async promptAndWait(message: string, timeoutMs = 30 * 60 * 1_000): Promise<void> {
		await this.client.sendAuthorized({ type: "prompt", clientMessageId: `swarm-${randomUUID()}`, message });
		await this.client.waitForIdle(timeoutMs);
	}

	async steer(message: string): Promise<void> {
		await this.client.sendAuthorized({ type: "steer", clientMessageId: `swarm-${randomUUID()}`, message });
	}

	setAgentMode(mode: "build" | "plan"): Promise<PlanningSnapshot> {
		return this.client.sendAuthorized({ type: "set_agent_mode", mode });
	}

	executePlan(
		planId: string,
		expectedRevision: number,
	): Promise<{ planning: PlanningSnapshot; selectedSessionId: string; started: boolean }> {
		return this.client.sendAuthorized({
			type: "plan_execute",
			planId,
			expectedRevision,
			strategy: "retain_context",
		});
	}

	async invokeReview(
		action: "review.pr" | "review.commit",
		args: Record<string, string | number | boolean>,
	): Promise<ReviewInvocation> {
		let workflowId: string | undefined;
		let settle: ((error?: Error) => void) | undefined;
		const terminal = new Promise<void>((resolve, reject) => {
			settle = (error) => (error ? reject(error) : resolve());
		});
		const unsubscribe = this.client.onEvent((event: RpcClientEvent) => {
			if (event.type !== "workflow_end" || event.workflowId !== workflowId) return;
			if (event.status === "failed" || event.status === "cancelled") {
				settle?.(new Error(event.message ?? `Review workflow ${event.status}`));
			} else {
				settle?.();
			}
		});
		try {
			const response = await this.client.sendAuthorized<{
				action: string;
				status: string;
				workflowId?: string;
			}>({ type: "invoke_ui_action", action, args });
			if (response.status !== "accepted" || !response.workflowId) {
				throw new Error(`Review action ${action} was not accepted`);
			}
			workflowId = response.workflowId;
			await withTimeout(terminal, REVIEW_TIMEOUT_MS, `Timed out waiting for review workflow ${workflowId}`);
			const result = await this.client.getReviewResult(workflowId);
			return { workflowId, result };
		} finally {
			unsubscribe();
		}
	}

	getReviewResult(runId: string): Promise<RpcReviewWorkflowResultResponse> {
		return this.client.getReviewResult(runId);
	}

	publishReview(runId: string): Promise<{ inlineFindingIds: string[]; summaryOnlyFindingIds: string[] }> {
		return this.client.sendAuthorized({ type: "publish_review", runId, confirmed: true });
	}

	waitForIdle(timeoutMs?: number): Promise<void> {
		return this.client.waitForIdle(timeoutMs);
	}

	async close(): Promise<void> {
		await this.client.stop();
		await this.closeNative();
	}
}

export class VoltDaemonAdapter implements DaemonRuntimeAdapter {
	private readonly workspaceName: string;
	private readonly swarmDir: string;
	private readonly agentDir: string;
	private readonly clientLabel: string;
	private daemon?: DaemonClient;
	private status?: Extract<ControlResponse, { type: "status_result" }>;
	private workspacePath?: string;
	private iroh?: typeof IrohNative;
	private endpoint?: IrohNative.Endpoint;
	private connection?: IrohNative.Connection;
	private ticketPayload?: IrohRemoteTicketPayload;
	private credentials?: StoredClientCredentials;
	private pendingPairing?: PendingPairing;
	private readonly conversations = new Map<string, AgentConversation>();
	private pairingEvents: ControlEvent[] = [];

	constructor(options: VoltDaemonAdapterOptions) {
		this.workspaceName = options.workspaceName;
		this.swarmDir = options.swarmDir;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.clientLabel = options.clientLabel ?? "Volt PR swarm PoC";
	}

	async start(): Promise<void> {
		ensurePrivateDirectorySync(this.swarmDir);
		const probe = await probeDaemon(this.agentDir);
		if (!probe.healthy) throw new Error(`voltd must already be healthy; current state: ${probe.state}`);
		const loaded = loadIrohModule();
		if (!loaded.iroh) throw new Error(formatIrohLoadError(loaded.error));
		this.iroh = loaded.iroh as unknown as typeof IrohNative;
		this.daemon = createDaemonClient({
			socketPath: probe.socketPath,
			...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
			client: "cli",
			version: VERSION,
			reconnect: false,
			capabilities: [CONTROL_WORKTREES_CAPABILITY, CONTROL_PAIR_CANCEL_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
			refreshEndpoint: () => readPublishedDaemonEndpoint(this.agentDir),
			onEvent: (event) => this.pairingEvents.push(event),
		});
		await this.daemon.connect();
		this.status = requireResponseType(await this.daemon.request({ type: "status" }), "status_result");
		const listedClients = requireResponseType(await this.daemon.request({ type: "clients_list" }), "clients_result");
		assertExactSet(
			listedClients.clients.map((client) => client.clientNodeId),
			this.status.clients.map((client) => client.clientNodeId),
			"voltd client list",
		);
		for (const capability of [CONTROL_PAIR_CANCEL_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY]) {
			if (!this.status.capabilities?.includes(capability)) throw new Error(`voltd is missing control capability ${capability}`);
		}
		const workspace = this.status.workspaces.find((candidate) => candidate.name === this.workspaceName);
		if (!workspace) throw new Error(`voltd workspace is not registered: ${this.workspaceName}`);
		this.workspacePath = workspace.path;
		const storedPairing = loadSwarmPairingCredentials(this.swarmDir);
		this.credentials = storedPairing?.credentials;
		if (this.credentials && storedPairing) {
			if (this.credentials.workspace !== this.workspaceName) {
				throw new Error(`Stored swarm identity is paired to workspace ${this.credentials.workspace}`);
			}
			assertClientStatus(this.status, this.credentials.clientNodeId, workspace.allowedTools);
			this.ticketPayload = storedPairing.payload;
			await this.bindEndpoint(this.credentials.clientSecretKey);
		} else {
			await this.beginFirstPairing();
		}
	}

	getWorkspacePath(): string {
		if (!this.workspacePath) throw new Error("Daemon adapter has not started");
		return this.workspacePath;
	}

	async assertModelAuthentication(sessionId: string): Promise<void> {
		const conversation = await this.openConversation(sessionId, undefined, false);
		try {
			const state = await conversation.getState();
			if (!state.model?.provider) throw new Error("The daemon session has no selected model");
			const auth = AuthStorage.create();
			if (!auth.hasAuth(state.model.provider)) {
				throw new Error(`Model authentication is not configured for provider ${state.model.provider}`);
			}
		} finally {
			await conversation.close();
		}
	}

	async openConversation(sessionId: string, worktreeId?: string, resume = false): Promise<AgentConversation> {
		if (!this.iroh || !this.endpoint || !this.ticketPayload) throw new Error("Daemon adapter has not started");
		if (!this.connection) {
			const endpointTicket = this.iroh.EndpointTicket.fromString(this.ticketPayload.irohTicket);
			const ticketNodeId = endpointTicket.endpointAddr().id().toString();
			if (this.ticketPayload.nodeId && ticketNodeId !== this.ticketPayload.nodeId) {
				throw new Error(`host_identity_mismatch: expected ${this.ticketPayload.nodeId}, got ${ticketNodeId}`);
			}
			this.connection = await withTimeout(
				this.endpoint.connect(endpointTicket.endpointAddr(), Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"))),
				30_000,
				"Timed out connecting to the voltd Iroh endpoint",
			);
			const remoteId = this.connection.remoteId().toString();
			if (this.ticketPayload.nodeId && remoteId !== this.ticketPayload.nodeId) {
				throw new Error(`host_identity_mismatch: expected ${this.ticketPayload.nodeId}, got ${remoteId}`);
			}
		}
		const stream = await this.connection.openBi();
		const engine = new IrohRemoteClientEngine({ clientLabel: this.clientLabel, clientNodeId: this.endpoint.id().toString() });
		const target: IrohRemoteConversationTarget = resume
			? { target: "session", sessionId }
			: { target: "new", sessionId, ...(worktreeId === undefined ? {} : { worktreeId }) };
		const hello = { ...engine.createHello(this.ticketPayload), conversation: target };
		await stream.send.writeAll(Array.from(Buffer.from(serializeJsonLine(hello), "utf8")));
		const handshake = await engine.readHandshakeResponse(stream.recv, { expectedHostNodeId: this.ticketPayload.nodeId });
		if (!handshake.response.success) {
			throw new Error(`${handshake.response.outcome ?? "handshake_failed"}: ${handshake.response.error}`);
		}
		assertHandshake(handshake.response, this.workspaceName, sessionId, worktreeId, resume, this.ticketPayload);
		const transport = createIrohRpcTransport({ stream, initialInput: handshake.initialInput });
		const client = new SwarmRpcClient({ transport, requestTimeoutMs: RPC_TIMEOUT_MS });
		await client.start();
		await client.waitForAuthority();
		const actualSessionId = handshake.response.conversation!.sessionId;
		const conversation = new IrohAgentConversation(actualSessionId, client, async () => {});
		this.conversations.set(actualSessionId, conversation);
		if (this.pendingPairing) await this.finishFirstPairing();
		return conversation;
	}

	async createWorktree(options: {
		workspaceName: string;
		worktreeName: string;
		branch: string;
		baseRef: string;
	}): Promise<ControlWorktreeStatus> {
		const daemon = this.requireDaemon();
		const response = await daemon.request({ type: "worktree_create", ...options });
		return requireResponseType(response, "worktree_result").worktree;
	}

	async listWorktrees(workspaceName: string): Promise<ControlWorktreeStatus[]> {
		const response = await this.requireDaemon().request({ type: "worktree_list", workspaceName });
		return requireResponseType(response, "worktrees_result").worktrees;
	}

	async removeWorktree(workspaceName: string, worktreeId: string): Promise<void> {
		const response = await this.requireDaemon().request({ type: "worktree_remove", workspaceName, worktreeId });
		requireResponseType(response, "ok");
	}

	async steerSession(sessionId: string, message: string): Promise<boolean> {
		const existing = this.conversations.get(sessionId);
		if (existing) {
			await existing.steer(message);
			return true;
		}
		try {
			const resumed = await this.openConversation(sessionId, undefined, true);
			await resumed.steer(message);
			return true;
		} catch {
			return false;
		}
	}

	async close(): Promise<void> {
		for (const conversation of this.conversations.values()) await conversation.close().catch(() => {});
		this.conversations.clear();
		this.connection?.close(0n, Array.from(Buffer.from("pr-swarm shutdown", "utf8")));
		this.connection = undefined;
		await this.endpoint?.close().catch(() => {});
		this.endpoint = undefined;
		await this.daemon?.close().catch(() => {});
		this.daemon = undefined;
	}

	private requireDaemon(): DaemonClient {
		if (!this.daemon) throw new Error("Daemon adapter has not started");
		return this.daemon;
	}

	private async beginFirstPairing(): Promise<void> {
		if (!this.iroh) throw new Error("Native Iroh adapter is unavailable");
		const secretBuilder = this.iroh.Endpoint.builder();
		this.iroh.presetMinimal(secretBuilder);
		secretBuilder.relayMode(this.iroh.RelayMode.disabled());
		const temporaryEndpoint = await secretBuilder.bind();
		const secretKey = temporaryEndpoint.secretKey().toBytes();
		const clientNodeId = temporaryEndpoint.id().toString();
		await temporaryEndpoint.close();
		this.pairingEvents = [];
		const response = await this.requireDaemon().request({
			type: "pair_request",
			workspaceName: this.workspaceName,
			allowedTools: [...SWARM_ALLOWED_TOOLS],
			rpcCapabilities: [...SWARM_RPC_CAPABILITIES],
		});
		if (response.type === "error") throw new Error(`${response.code}: ${response.message}`);
		const started = requireResponseType(response, "pair_started");
		const ticket = await this.waitForPairingTicket(started.requestId);
		const payload = decodeIrohRemoteTicketPayload(ticket);
		if (payload.workspace !== this.workspaceName) throw new Error("Pairing ticket workspace mismatch");
		if (!payload.nodeId) throw new Error("Pairing ticket omitted host node identity");
		this.pendingPairing = { fullTicket: ticket, payload, secretKey, clientNodeId };
		this.ticketPayload = payload;
		await this.bindEndpoint(secretKey);
	}

	private async waitForPairingTicket(requestId: string): Promise<string> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < PAIR_TIMEOUT_MS) {
			const event = this.pairingEvents.find(
				(candidate) => candidate.type === "pairing_progress" && candidate.requestId === requestId && candidate.phase === "ticket",
			);
			if (event?.type === "pairing_progress" && event.ticket) return event.ticket;
			const failed = this.pairingEvents.find(
				(candidate) => candidate.type === "pairing_progress" && candidate.requestId === requestId && candidate.phase === "failed",
			);
			if (failed?.type === "pairing_progress") throw new Error(failed.error ?? "Pairing failed");
			await delay(25);
		}
		await this.requireDaemon().request({ type: "pair_cancel", requestId }).catch(() => undefined);
		throw new Error("Timed out waiting for voltd pairing ticket");
	}

	private async bindEndpoint(secretKey: number[]): Promise<void> {
		if (!this.iroh || !this.ticketPayload) throw new Error("Iroh endpoint configuration is unavailable");
		const payload = this.ticketPayload;
		const builder = this.iroh.Endpoint.builder();
		if ((payload.relayMode ?? "disabled") === "development") {
			this.iroh.presetN0(builder);
		} else if (payload.relayMode === "production") {
			this.iroh.presetN0DisableRelay(builder);
			if (!payload.relayUrls?.length) throw new Error("Production reconnect ticket omitted relay URLs");
			if (payload.relayAuthToken) {
				const relayMap = this.iroh.RelayMap.empty();
				for (const url of payload.relayUrls) relayMap.insert({ url, authToken: payload.relayAuthToken });
				builder.relayMode(this.iroh.RelayMode.custom(relayMap));
			} else {
				builder.relayMode(this.iroh.RelayMode.customFromUrls(payload.relayUrls));
			}
		} else {
			this.iroh.presetMinimal(builder);
			builder.relayMode(this.iroh.RelayMode.disabled());
		}
		builder.secretKey(secretKey);
		builder.alpns([Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"))]);
		this.endpoint = await withTimeout(builder.bind(), 30_000, "Timed out binding the Iroh client endpoint");
		if ((payload.relayMode ?? "disabled") !== "disabled") {
			await withTimeout(this.endpoint.online(), 30_000, "Timed out bringing the Iroh client endpoint online");
		}
	}

	private async finishFirstPairing(): Promise<void> {
		const pending = this.pendingPairing;
		if (!pending || !this.ticketPayload?.nodeId) return;
		const credentials = await persistSwarmPairingCredentials({
			swarmDir: this.swarmDir,
			fullTicket: pending.fullTicket,
			clientSecretKey: pending.secretKey,
			clientNodeId: pending.clientNodeId,
			workspace: this.workspaceName,
		});
		this.credentials = credentials;
		this.pendingPairing = undefined;
		const status = requireResponseType(await this.requireDaemon().request({ type: "status" }), "status_result");
		const workspace = status.workspaces.find((candidate) => candidate.name === this.workspaceName);
		assertClientStatus(status, credentials.clientNodeId, workspace?.allowedTools);
	}
}

function assertHandshake(
	response: Extract<Awaited<ReturnType<IrohRemoteClientEngine["readHandshakeResponse"]>>["response"], { success: true }>,
	workspaceName: string,
	requestedSessionId: string,
	worktreeId: string | undefined,
	resume: boolean,
	ticketPayload: IrohRemoteTicketPayload,
): void {
	const requiredFeatures = [
		IROH_REMOTE_MULTI_STREAMS_FEATURE,
		IROH_REMOTE_CONVERSATION_STREAMS_FEATURE,
		IROH_REMOTE_WORKTREES_FEATURE,
		IROH_REMOTE_AGENT_SETTLED_FEATURE,
		IROH_REMOTE_PLANNING_STATE_FEATURE,
	];
	for (const feature of requiredFeatures) if (!response.features?.includes(feature)) throw new Error(`Host is missing ${feature}`);
	if (response.workspace !== workspaceName) throw new Error("Handshake workspace mismatch");
	if (response.remoteHost) {
		if (response.remoteHost.hostNodeId && response.remoteHost.hostNodeId !== ticketPayload.nodeId) {
			throw new Error("Handshake remote-host identity mismatch");
		}
		if (response.remoteHost.relayMode && response.remoteHost.relayMode !== (ticketPayload.relayMode ?? "disabled")) {
			throw new Error("Handshake remote-host relay mode drifted");
		}
		if (
			ticketPayload.relayMode === "production" &&
			JSON.stringify(response.remoteHost.relayUrls ?? []) !== JSON.stringify(ticketPayload.relayUrls ?? [])
		) {
			throw new Error("Handshake remote-host relay URLs drifted");
		}
	}
	const conversation = response.conversation;
	if (!conversation) throw new Error("Handshake omitted conversation binding");
	if (conversation.sessionId !== requestedSessionId) throw new Error("Handshake returned a different session binding");
	if (resume) {
		if (conversation.target !== "session" || conversation.selection !== "resumed") throw new Error("Session resume was not honored");
	} else {
		if (conversation.target !== "new" || !["created", "resumed"].includes(conversation.selection)) {
			throw new Error("New deterministic session binding was not honored");
		}
		if (conversation.worktreeId !== worktreeId) throw new Error("Handshake returned a different worktree binding");
	}
}

function assertClientStatus(
	status: Extract<ControlResponse, { type: "status_result" }>,
	clientNodeId: string,
	workspaceTools: string[] | undefined,
): void {
	if (status.revokedClients?.some((client) => client.clientNodeId === clientNodeId)) {
		throw new Error("Stored PR swarm client identity has been revoked");
	}
	const client = status.clients.find((candidate) => candidate.clientNodeId === clientNodeId);
	if (!client) throw new Error("Stored PR swarm client identity is not registered; refusing to re-pair automatically");
	assertExactSet(client.allowedTools ?? [], SWARM_ALLOWED_TOOLS, "paired client tools");
	assertExactSet(client.rpcGrant?.capabilities ?? [], SWARM_RPC_CAPABILITIES, "paired client RPC capabilities");
	if (client.usesDefaultTools !== false) throw new Error("PR swarm client unexpectedly tracks the daemon default tool grant");
	assertEffectiveTools(status.remotePolicy?.allowTools ?? undefined, workspaceTools);
}

function assertEffectiveTools(daemonTools: string[] | undefined, workspaceTools: string[] | undefined): void {
	for (const [label, values] of [
		["daemon", daemonTools],
		["workspace", workspaceTools],
	] as const) {
		if (!values) continue;
		const granted = new Set(values);
		for (const required of SWARM_ALLOWED_TOOLS) {
			if (!granted.has(required)) throw new Error(`${label} effective tool ceiling is missing ${required}`);
		}
	}
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
	if (actual.length !== expected.length || expected.some((entry) => !actual.includes(entry))) {
		throw new Error(`${label} drifted; expected exactly ${expected.join(",")}`);
	}
}

function parseBootstrapAuthority(value: unknown): ConversationAuthority | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== "conversation_bootstrap") return undefined;
	const delivery = expectRecord(record.delivery, "conversation bootstrap delivery");
	const conversation = expectRecord(record.conversation, "conversation bootstrap conversation");
	const transcript = expectRecord(record.transcript, "conversation bootstrap transcript");
	return {
		sessionId: expectString(conversation.sessionId, "conversation bootstrap sessionId"),
		subscriptionId: expectString(delivery.subscriptionId, "conversation bootstrap subscriptionId"),
		branchEpoch: expectString(transcript.branchEpoch, "conversation bootstrap branchEpoch"),
	};
}

export function readClientCredentials(path: string): StoredClientCredentials | undefined {
	if (!existsSync(path)) return undefined;
	assertPrivateFile(path);
	const record = expectRecord(parseJsonFile(path), "stored client credentials");
	if (
		Object.keys(record).some(
			(key) => !["version", "clientSecretKey", "clientNodeId", "hostNodeId", "workspace", "reconnectTicket"].includes(key),
		)
	) {
		throw new Error("Stored client credentials contain unsupported fields");
	}
	if (record.version !== 1) throw new Error("Stored client credentials have an unsupported version");
	const key = expectArray(record.clientSecretKey, "clientSecretKey").map((entry) => {
		if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
			throw new Error("clientSecretKey contains an invalid byte");
		}
		return entry;
	});
	if (key.length !== 32) throw new Error("clientSecretKey must contain 32 bytes");
	return {
		version: 1,
		clientSecretKey: key,
		clientNodeId: expectString(record.clientNodeId, "clientNodeId"),
		hostNodeId: expectString(record.hostNodeId, "hostNodeId"),
		workspace: expectString(record.workspace, "workspace"),
		reconnectTicket: expectString(record.reconnectTicket, "reconnectTicket"),
	};
}

export function withStoredRelayToken(payload: IrohRemoteTicketPayload, swarmDir: string, hostNodeId: string): IrohRemoteTicketPayload {
	if (payload.relayMode !== "production") return payload;
	const path = join(swarmDir, RELAY_TOKEN_FILE);
	if (!existsSync(path)) return payload;
	assertPrivateFile(path);
	const record = expectRecord(parseJsonFile(path), "stored relay token");
	if (Object.keys(record).some((key) => !["version", "hostNodeId", "token"].includes(key))) {
		throw new Error("Stored relay token contains unsupported fields");
	}
	if (record.version !== 1 || record.hostNodeId !== hostNodeId) throw new Error("Stored relay token identity mismatch");
	return { ...payload, relayAuthToken: expectString(record.token, "stored relay token") };
}

export async function persistSwarmPairingCredentials(options: {
	swarmDir: string;
	fullTicket: string;
	clientSecretKey: number[];
	clientNodeId: string;
	workspace: string;
}): Promise<StoredClientCredentials> {
	ensurePrivateDirectorySync(options.swarmDir);
	if (options.clientSecretKey.length !== 32 || options.clientSecretKey.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
		throw new Error("Paired client secret key must contain exactly 32 bytes");
	}
	const payload = decodeIrohRemoteTicketPayload(options.fullTicket);
	if (!payload.nodeId) throw new Error("Pairing ticket omitted host node identity");
	if (payload.workspace && payload.workspace !== options.workspace) throw new Error("Pairing ticket workspace mismatch");
	const credentials: StoredClientCredentials = {
		version: 1,
		clientSecretKey: [...options.clientSecretKey],
		clientNodeId: options.clientNodeId,
		hostNodeId: payload.nodeId,
		workspace: options.workspace,
		reconnectTicket: createIrohRemoteSanitizedReconnectTicket(options.fullTicket),
	};
	await writePrivateJson(join(options.swarmDir, CLIENT_STATE_FILE), credentials);
	if (payload.relayMode === "production" && payload.relayAuthToken) {
		await writePrivateJson(join(options.swarmDir, RELAY_TOKEN_FILE), {
			version: 1,
			hostNodeId: payload.nodeId,
			token: payload.relayAuthToken,
		} satisfies StoredRelayToken);
	}
	return credentials;
}

export function loadSwarmPairingCredentials(
	swarmDir: string,
): { credentials: StoredClientCredentials; payload: IrohRemoteTicketPayload } | undefined {
	const credentials = readClientCredentials(join(swarmDir, CLIENT_STATE_FILE));
	if (!credentials) return undefined;
	const payload = decodeIrohRemoteTicketPayload(credentials.reconnectTicket);
	if (payload.nodeId !== credentials.hostNodeId) throw new Error("Stored reconnect host identity drifted");
	return { credentials, payload: withStoredRelayToken(payload, swarmDir, credentials.hostNodeId) };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await writeDurableAtomicFile(path, `${JSON.stringify(value, null, 2)}\n`, { directoryMode: 0o700, fileMode: 0o600 });
	chmodSync(path, 0o600);
}

function assertPrivateFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Refusing private credential path: ${path}`);
	hardenPrivateRegularFileSync(path);
}

function parseJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid private JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function requireResponseType<Type extends ControlResponse["type"]>(
	response: ControlResponse,
	type: Type,
): Extract<ControlResponse, { type: Type }> {
	if (response.type === "error") throw new Error(`${response.code}: ${response.message}`);
	if (response.type !== type) throw new Error(`Expected daemon response ${type}, got ${response.type}`);
	return response as Extract<ControlResponse, { type: Type }>;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

