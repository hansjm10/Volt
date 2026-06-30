import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/volt-agent-core";
import { createInProcessRpcClient, type InProcessRpcClient } from "../../modes/rpc/in-process-rpc-client.ts";
import type { RpcClientEvent } from "../../modes/rpc/rpc-client-base.ts";
import type { SessionStats } from "../agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../agent-session-runtime.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { parseModelPattern } from "../model-resolver.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { RpcSessionState, RpcTranscriptResponse } from "../rpc/types.ts";
import { SessionManager } from "../session-manager.ts";
import type { SubagentDefinition } from "./index.ts";

export type SubagentEvent = RpcClientEvent;
export type SubagentEndEvent = Extract<SubagentEvent, { type: "agent_end" }>;
export type SubagentEventListener = (event: SubagentEvent) => void;

export interface SubagentResult {
	id: string;
	sessionId: string;
	event: SubagentEndEvent;
}

export interface SubagentHandle {
	id: string;
	sessionId: string;
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<RpcSessionState>;
	getTranscript(options?: { limit?: number; beforeEntryId?: string }): Promise<RpcTranscriptResponse>;
	getSessionStats(): Promise<SessionStats>;
	waitForEnd(): Promise<SubagentResult>;
	dispose(): Promise<void>;
	onEvent(listener: SubagentEventListener): () => void;
}

export interface SubagentManagerOptions {
	createRuntime: CreateAgentSessionRuntimeFactory;
	cwd: string;
	agentDir: string;
	resourceLoader?: ResourceLoader;
	/** Maximum tool policy inherited from the parent context. Definition tools are intersected with this list. */
	allowedTools?: string[];
	requestTimeoutMs?: number;
}

export interface SubagentStartOptions {
	cwd?: string;
	agentDir?: string;
	sessionManager?: SessionManager;
	requestTimeoutMs?: number;
}

export interface SubagentStartByNameOptions extends SubagentStartOptions {
	resourceLoader?: ResourceLoader;
	/** Maximum tool policy inherited from the parent context. Definition tools are intersected with this list. */
	allowedTools?: string[];
}

export class SubagentDefinitionNotFoundError extends Error {
	readonly agentName: string;
	readonly availableNames: string[];
	readonly diagnostics: ResourceDiagnostic[];

	constructor(agentName: string, availableNames: string[], diagnostics: ResourceDiagnostic[] = []) {
		super(
			agentName.trim() ? `Subagent definition "${agentName}" was not found` : "Subagent definition name is required",
		);
		this.name = "SubagentDefinitionNotFoundError";
		this.agentName = agentName;
		this.availableNames = availableNames;
		this.diagnostics = diagnostics;
	}
}

export class SubagentDefinitionConfigurationError extends Error {
	readonly agentName: string;
	readonly field: "model" | "thinking";

	constructor(agentName: string, field: "model" | "thinking", message: string) {
		super(`Invalid subagent definition "${agentName}" ${field}: ${message}`);
		this.name = "SubagentDefinitionConfigurationError";
		this.agentName = agentName;
		this.field = field;
	}
}

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isThinkingLevel(value: string): value is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function normalizeUniqueNames(names: readonly string[] | undefined): string[] | undefined {
	if (!names) {
		return undefined;
	}
	return Array.from(new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)));
}

function intersectTools(
	requestedTools: string[] | undefined,
	allowedTools: string[] | undefined,
): string[] | undefined {
	const normalizedRequested = normalizeUniqueNames(requestedTools);
	const normalizedAllowed = normalizeUniqueNames(allowedTools);
	if (!normalizedAllowed) {
		return normalizedRequested;
	}
	if (!normalizedRequested) {
		return normalizedAllowed;
	}
	const allowed = new Set(normalizedAllowed);
	return normalizedRequested.filter((toolName) => allowed.has(toolName));
}

class LocalSubagentHandle implements SubagentHandle {
	readonly id: string;
	readonly sessionId: string;
	private readonly client: InProcessRpcClient;
	private readonly removeFromManager: (id: string) => void;
	private readonly eventListeners = new Set<SubagentEventListener>();
	private readonly endPromise: Promise<SubagentResult>;
	private resolveEnd: (result: SubagentResult) => void = () => {};
	private rejectEnd: (error: Error) => void = () => {};
	private disposed = false;

	constructor(options: {
		id: string;
		sessionId: string;
		client: InProcessRpcClient;
		removeFromManager: (id: string) => void;
	}) {
		this.id = options.id;
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.removeFromManager = options.removeFromManager;
		this.endPromise = new Promise<SubagentResult>((resolve, reject) => {
			this.resolveEnd = resolve;
			this.rejectEnd = reject;
		});
		void this.endPromise.catch(() => {});
	}

	async prompt(message: string): Promise<void> {
		this.assertOpen();
		await this.client.prompt(message);
	}

	async abort(): Promise<void> {
		this.assertOpen();
		await this.client.abort();
	}

	async getState(): Promise<RpcSessionState> {
		this.assertOpen();
		return this.client.getState();
	}

	async getTranscript(options: { limit?: number; beforeEntryId?: string } = {}): Promise<RpcTranscriptResponse> {
		this.assertOpen();
		return this.client.getTranscript(options);
	}

	async getSessionStats(): Promise<SessionStats> {
		this.assertOpen();
		return this.client.getSessionStats();
	}

	waitForEnd(): Promise<SubagentResult> {
		return this.endPromise;
	}

	onEvent(listener: SubagentEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		try {
			await this.client.stop();
		} finally {
			this.eventListeners.clear();
			this.removeFromManager(this.id);
			this.rejectEnd(new Error(`Subagent ${this.id} was disposed before completion`));
		}
	}

	handleEvent(event: SubagentEvent): void {
		if (this.disposed) {
			return;
		}
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Listener failures should not break the child RPC event stream.
			}
		}
		if (event.type === "agent_end" && event.willRetry !== true) {
			this.resolveEnd({ id: this.id, sessionId: this.sessionId, event });
		}
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error(`Subagent ${this.id} is disposed`);
		}
	}
}

export class SubagentManager {
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly resourceLoader?: ResourceLoader;
	private readonly allowedTools?: string[];
	private readonly requestTimeoutMs?: number;
	private readonly handles = new Map<string, LocalSubagentHandle>();

	constructor(options: SubagentManagerOptions) {
		this.createRuntime = options.createRuntime;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.resourceLoader = options.resourceLoader;
		this.allowedTools = normalizeUniqueNames(options.allowedTools);
		this.requestTimeoutMs = options.requestTimeoutMs;
	}

	async start(options: SubagentStartOptions = {}): Promise<SubagentHandle> {
		return this.startRuntime(options);
	}

	listDefinitions(options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition[] {
		const resourceLoader = options.resourceLoader ?? this.resourceLoader;
		return resourceLoader?.getSubagents().definitions ?? [];
	}

	getDefinition(agentName: string, options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition {
		return this.resolveDefinition(agentName, options.resourceLoader);
	}

	async startByName(agentName: string, options: SubagentStartByNameOptions = {}): Promise<SubagentHandle> {
		const definition = this.getDefinition(agentName, { resourceLoader: options.resourceLoader });
		return this.startRuntime(options, {
			definition,
			allowedTools: options.allowedTools ?? this.allowedTools,
		});
	}

	async dispose(): Promise<void> {
		const handles = Array.from(this.handles.values());
		await Promise.all(handles.map((handle) => handle.dispose()));
	}

	private async startRuntime(
		options: SubagentStartOptions,
		definitionOptions?: {
			definition: SubagentDefinition;
			allowedTools?: string[];
		},
	): Promise<SubagentHandle> {
		const cwd = options.cwd ?? this.cwd;
		const agentDir = options.agentDir ?? this.agentDir;
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
		const runtime = await this.createChildRuntime({ cwd, agentDir, sessionManager });
		try {
			if (definitionOptions) {
				await this.applyDefinitionToRuntime(runtime, definitionOptions.definition, definitionOptions.allowedTools);
			}

			const id = `sa_${randomUUID()}`;
			let handle: LocalSubagentHandle | undefined;
			const client = await createInProcessRpcClient(runtime, {
				requestTimeoutMs: options.requestTimeoutMs ?? this.requestTimeoutMs,
				onEvent: (event) => {
					handle?.handleEvent(event);
				},
			});
			handle = new LocalSubagentHandle({
				id,
				sessionId: runtime.session.sessionId,
				client,
				removeFromManager: (handleId) => {
					this.handles.delete(handleId);
				},
			});
			this.handles.set(id, handle);
			return handle;
		} catch (error) {
			await runtime.dispose().catch(() => undefined);
			throw error;
		}
	}

	private resolveDefinition(
		agentName: string,
		resourceLoaderOverride: ResourceLoader | undefined,
	): SubagentDefinition {
		const resourceLoader = resourceLoaderOverride ?? this.resourceLoader;
		if (!resourceLoader) {
			throw new SubagentDefinitionNotFoundError(agentName, []);
		}

		const result = resourceLoader.getSubagents();
		const definition = result.definitions.find((candidate) => candidate.name === agentName.trim());
		if (!definition) {
			throw new SubagentDefinitionNotFoundError(
				agentName,
				result.definitions.map((candidate) => candidate.name),
				result.diagnostics,
			);
		}
		return definition;
	}

	private async applyDefinitionToRuntime(
		runtime: AgentSessionRuntime,
		definition: SubagentDefinition,
		allowedTools: string[] | undefined,
	): Promise<void> {
		const activeTools = intersectTools(definition.tools, allowedTools);
		if (activeTools) {
			runtime.session.setActiveToolsByName(activeTools);
		}
		runtime.session.appendSystemPromptContext(definition.systemPrompt);

		let thinkingLevel = this.validateThinkingLevel(definition);
		if (definition.model) {
			const availableModels = await runtime.session.modelRegistry.getAvailable();
			const resolved = parseModelPattern(definition.model, availableModels, {
				allowInvalidThinkingLevelFallback: false,
			});
			if (!resolved.model) {
				throw new SubagentDefinitionConfigurationError(
					definition.name,
					"model",
					`model reference "${definition.model}" is not available or is not configured`,
				);
			}
			await runtime.session.setModel(resolved.model, { persistDefault: false });
			thinkingLevel ??= resolved.thinkingLevel;
		}

		if (thinkingLevel) {
			runtime.session.setThinkingLevel(thinkingLevel, { persistDefault: false });
		}
	}

	private validateThinkingLevel(definition: SubagentDefinition): ThinkingLevel | undefined {
		if (!definition.thinking) {
			return undefined;
		}
		// Discovery keeps invalid frontmatter as diagnostics, but definition-backed starts fail
		// before prompting so callers get a clear configuration error for this subagent.
		if (!isThinkingLevel(definition.thinking)) {
			throw new SubagentDefinitionConfigurationError(
				definition.name,
				"thinking",
				`"${definition.thinking}" is not a supported thinking level`,
			);
		}
		return definition.thinking;
	}

	private async createChildRuntime(options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
	}): Promise<AgentSessionRuntime> {
		return createAgentSessionRuntime(this.createRuntime, {
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager: options.sessionManager,
		});
	}
}
