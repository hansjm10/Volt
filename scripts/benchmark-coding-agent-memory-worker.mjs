import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import {
	AuthStorage,
	DefaultMcpClientFactory,
	IrohRemoteActiveStreamRegistry,
	IrohRemoteAuditLogger,
	IrohRemoteHostStateManager,
	McpManager,
	McpMetadataCache,
	McpOutputStore,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createIrohRemotePresetAccess,
} from "@hansjm10/volt-coding-agent";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../packages/coding-agent/src/core/mcp/config.ts";
import { IntegratedRuntimeRegistry } from "../packages/coding-agent/src/daemon/integrated-runtimes.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const EVENT_PREFIX = "VOLT_MEMORY_BENCHMARK_EVENT ";
const CONVERSATION_TURNS = 20;
const PAYLOAD_BYTES = 2048;
const RECONNECT_CYCLES = 10;

function parseArgs(argv) {
	let scenario;
	let root;
	let retentionTtlMs;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg !== "--scenario" && arg !== "--root" && arg !== "--retention-ttl-ms") {
			throw new Error(`Unknown worker option: ${arg}`);
		}
		if (index + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
		const value = argv[++index];
		if (arg === "--scenario") scenario = value;
		if (arg === "--root") root = resolve(value);
		if (arg === "--retention-ttl-ms") retentionTtlMs = Number(value);
	}
	if (!scenario || !root) throw new Error("worker requires --scenario and --root");
	if (!Number.isInteger(retentionTtlMs) || retentionTtlMs < 250) {
		throw new Error("worker requires --retention-ttl-ms >= 250");
	}
	return { scenario, root, retentionTtlMs };
}

class CheckpointChannel {
	constructor() {
		this.sequence = 0;
		this.pending = new Map();
		this.readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
		this.readline.on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message?.type !== "continue" || typeof message.id !== "string") return;
			const resolvePending = this.pending.get(message.id);
			if (!resolvePending) return;
			this.pending.delete(message.id);
			resolvePending();
		});
	}

	async checkpoint(name, details = {}) {
		const id = `checkpoint-${++this.sequence}`;
		const continued = new Promise((resolveContinued) => this.pending.set(id, resolveContinued));
		process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: "checkpoint", id, name, details })}\n`);
		await continued;
	}

	done() {
		process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: "done" })}\n`);
		this.readline.close();
	}
}

function registerBenchmarkFaux() {
	const faux = registerFauxProvider({
		models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 4096 }],
		tokensPerSecond: 1_000_000,
	});
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "benchmark-only-faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "benchmark-only-faux-key",
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
			baseUrl: registeredModel.baseUrl,
		})),
	});
	return { faux, model, authStorage, modelRegistry };
}

async function createBenchmarkRuntime(options) {
	const registered = options.registered ?? registerBenchmarkFaux();
	const settingsManager = SettingsManager.inMemory(options.settings ?? { lsp: { enabled: false } });
	const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			projectCwd: options.workspace,
			agentDir: options.agentDir,
			authStorage: registered.authStorage,
			modelRegistry: registered.modelRegistry,
			settingsManager,
			resourceLoaderOptions: {
				additionalExtensionPaths: options.extensionPaths ?? [],
				noExtensions: (options.extensionPaths?.length ?? 0) === 0,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: registered.model,
				tools: options.tools,
				allowUnlistedExtensionTools: true,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const sessionManager =
		options.sessionManager ??
		SessionManager.create(options.workspace, options.sessionDir, { id: options.sessionId ?? randomUUID() });
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.workspace,
		agentDir: options.agentDir,
		sessionManager,
	});
	await runtime.session.bindExtensions({ mode: "rpc" });
	assert.equal(runtime.session.sessionId, sessionManager.getSessionId());
	assert.equal(runtime.session.isBusy, false);
	return { runtime, registered, settingsManager };
}

function payload(label, turn) {
	const prefix = `${label}:${String(turn).padStart(2, "0")}:`;
	assert(prefix.length < PAYLOAD_BYTES);
	return `${prefix}${"x".repeat(PAYLOAD_BYTES - prefix.length)}`;
}

async function runRuntimeIdle(context) {
	const created = await createBenchmarkRuntime(context);
	try {
		assert.equal(created.runtime.session.messages.length, 0);
		await context.channel.checkpoint("baseline", { sessionId: created.runtime.session.sessionId, messages: 0 });
		await created.runtime.dispose();
		await context.channel.checkpoint("post-disposal", { disposed: true });
	} finally {
		await created.runtime.dispose();
		created.registered.faux.unregister();
	}
}

async function runConversation(context) {
	const registered = registerBenchmarkFaux();
	registered.faux.setResponses(
		Array.from({ length: CONVERSATION_TURNS }, (_, turn) => fauxAssistantMessage(payload("assistant", turn))),
	);
	const created = await createBenchmarkRuntime({ ...context, registered });
	try {
		await context.channel.checkpoint("baseline", {
			sessionId: created.runtime.session.sessionId,
			messages: created.runtime.session.messages.length,
		});
		for (let turn = 0; turn < CONVERSATION_TURNS; turn++) {
			await created.runtime.session.prompt(payload("user", turn));
		}
		assert.equal(created.runtime.session.messages.length, CONVERSATION_TURNS * 2);
		assert.equal(registered.faux.state.callCount, CONVERSATION_TURNS);
		assert.equal(registered.faux.getPendingResponseCount(), 0);
		await context.channel.checkpoint("populated", {
			sessionId: created.runtime.session.sessionId,
			messages: created.runtime.session.messages.length,
			turns: CONVERSATION_TURNS,
			payloadBytes: PAYLOAD_BYTES,
		});
		await created.runtime.dispose();
		await context.channel.checkpoint("post-disposal", { disposed: true });
	} finally {
		await created.runtime.dispose();
		registered.faux.unregister();
	}
}

function createAuthorization(workspace) {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "benchmark-client",
			label: "benchmark-client",
			allowedWorkspaces: ["benchmark"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "benchmark", path: workspace },
		workspaceNames: ["benchmark"],
		workspaces: [{ name: "benchmark", status: "available" }],
	};
}

function createHello(target, sessionId) {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "benchmark",
		mode: "conversation",
		conversation: { target, sessionId },
	};
}

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
};

async function runReconnectRetention(context) {
	const sessionId = randomUUID();
	const created = await createBenchmarkRuntime({ ...context, sessionId });
	let ttlMs = 60_000;
	let factoryCalls = 0;
	const disposals = [];
	const registry = new IntegratedRuntimeRegistry({
		agentDir: context.agentDir,
		auditLogger: new IrohRemoteAuditLogger(),
		stateManager: new IrohRemoteHostStateManager(),
		activeStreams: new IrohRemoteActiveStreamRegistry(),
		detachedRuntimeTtlMs: () => ttlMs,
		getAllowTools: () => undefined,
		getProjectTrustedForWorkspace: () => false,
		setClientLastSessionId: async () => undefined,
		onRuntimeDisposed: (entry, reason) => disposals.push({ entry, reason }),
		createRuntime: async () => {
			factoryCalls++;
			assert.equal(factoryCalls, 1);
			return { runtime: created.runtime, sessionSelection: { kind: "created", sessionId } };
		},
	});
	const authorization = createAuthorization(context.workspace);
	let entry;
	try {
		const first = await registry.getOrCreateEntry(
			{ hello: createHello("new", sessionId), response: HANDSHAKE_RESPONSE },
			authorization,
		);
		entry = first.entry;
		assert.equal(first.created, true);
		assert.equal(entry.lifecycle, "prepared");
		await registry.commitEntry(entry, first.sessionSelection, authorization, first.attachClaim);
		assert.equal(entry.lifecycle, "active");
		assert.equal(registry.size, 1);
		const initialSubscriber = await registry.attachSubscriber(entry, first.attachClaim);
		first.attachClaim.release();
		await context.channel.checkpoint("baseline", { lifecycle: entry.lifecycle, registrySize: registry.size });
		await registry.detachSubscriber(entry, initialSubscriber, "benchmark_initial_detach");
		assert.equal(registry.isDetached(entry), true);
		await context.channel.checkpoint("detached", { lifecycle: entry.lifecycle, registrySize: registry.size });

		for (let cycle = 0; cycle < RECONNECT_CYCLES; cycle++) {
			const warm = await registry.getOrCreateEntry(
				{ hello: createHello("session", sessionId), response: HANDSHAKE_RESPONSE },
				authorization,
			);
			assert.equal(warm.created, false);
			assert.equal(warm.entry, entry);
			assert.equal(warm.entry.runtime, created.runtime);
			assert.equal(warm.entry.lifecycle, "active");
			assert.equal(registry.size, 1);
			assert.equal(factoryCalls, 1);
			await registry.commitEntry(warm.entry, warm.sessionSelection, authorization, warm.attachClaim);
			const subscriber = await registry.attachSubscriber(warm.entry, warm.attachClaim);
			warm.attachClaim.release();
			assert.equal(warm.entry.subscribers.size, 1);
			if (cycle === RECONNECT_CYCLES - 1) ttlMs = context.retentionTtlMs;
			await registry.detachSubscriber(warm.entry, subscriber, `benchmark_cycle_${cycle + 1}`);
			assert.equal(registry.isDetached(warm.entry), true);
		}
		await context.channel.checkpoint("post-cycle", {
			cycles: RECONNECT_CYCLES,
			lifecycle: entry.lifecycle,
			registrySize: registry.size,
			retentionTtlMs: ttlMs,
		});
		const deadline = Date.now() + ttlMs + 5_000;
		while (!entry.retirementPromise && Date.now() < deadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		assert(entry.retirementPromise, "detached runtime did not begin retirement");
		await entry.retirementPromise;
		assert.equal(entry.lifecycle, "retired");
		assert.equal(registry.size, 0);
		assert.equal(disposals.length, 1);
		assert.equal(disposals[0].entry, entry);
		assert.equal(disposals[0].reason, "detached_runtime_ttl_expired");
		assert.equal(factoryCalls, 1);
		await context.channel.checkpoint("post-disposal", {
			disposed: true,
			lifecycle: entry.lifecycle,
			registrySize: registry.size,
		});
	} finally {
		await registry.stopAll("benchmark_cleanup");
		await created.runtime.dispose();
		created.registered.faux.unregister();
	}
}

async function writeExtensionFixture(context) {
	const extensionPath = join(context.root, "fixtures", "benchmark-extension.ts");
	const markerPath = join(context.root, "fixtures", "extension-started.txt");
	await mkdir(dirname(extensionPath), { recursive: true });
	await writeFile(
		extensionPath,
		`import { writeFileSync } from "node:fs";\nimport { Type } from "@hansjm10/volt-ai";\nimport { defineTool } from "@hansjm10/volt-coding-agent";\n\nexport default function (volt) {\n\tvolt.on("session_start", () => {\n\t\twriteFileSync(${JSON.stringify(markerPath)}, "started\\n");\n\t});\n\tvolt.registerTool(defineTool({\n\t\tname: "benchmark_extension",\n\t\tlabel: "Benchmark extension",\n\t\tdescription: "Exercise the memory benchmark extension loader",\n\t\tparameters: Type.Object({ value: Type.String() }),\n\t\tasync execute(_id, params) {\n\t\t\treturn { content: [{ type: "text", text: \`extension:\${params.value}\` }], details: {} };\n\t\t},\n\t}));\n}\n`,
		"utf8",
	);
	return { extensionPath, markerPath };
}

async function runExtension(context) {
	const fixture = await writeExtensionFixture(context);
	await context.channel.checkpoint("before-activation", { fixture: "typescript-extension" });
	const created = await createBenchmarkRuntime({
		...context,
		extensionPaths: [fixture.extensionPath],
		tools: ["benchmark_extension"],
	});
	try {
		const extensionRunner = created.runtime.session.extensionRunner;
		assert.deepEqual(extensionRunner.getExtensionPaths(), [fixture.extensionPath]);
		assert(extensionRunner.getAllRegisteredTools().some((tool) => tool.definition.name === "benchmark_extension"));
		assert.equal(extensionRunner.hasHandlers("session_start"), true);
		assert.equal((await readFile(fixture.markerPath, "utf8")).trim(), "started");
		assert(created.runtime.session.getActiveToolNames().includes("benchmark_extension"));
		const tool = created.runtime.session.state.tools.find((candidate) => candidate.name === "benchmark_extension");
		assert(tool);
		const result = await tool.execute("benchmark-extension-call", { value: "ok" });
		assert.equal(result.content[0]?.type, "text");
		assert.equal(result.content[0]?.text, "extension:ok");
		await context.channel.checkpoint("active", { tool: "benchmark_extension", listener: "session_start" });
		await created.runtime.dispose();
		await context.channel.checkpoint("post-disposal", { disposed: true });
	} finally {
		await created.runtime.dispose();
		created.registered.faux.unregister();
	}
}

async function runMcp(context) {
	const serverPath = join(repoRoot, "scripts", "fixtures", "memory-benchmark-mcp-server.mjs");
	await context.channel.checkpoint("before-activation", { fixture: "stdio-mcp" });
	const source = sourceForMcpConfigPath(join(context.root, "fixtures", "mcp.json"), {
		scope: "temporary",
		label: "memory benchmark",
		precedence: 1,
		shared: false,
	});
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			servers: {
				fixture: {
					transport: "stdio",
					command: process.execPath,
					args: [serverPath],
					cwd: context.workspace,
					lifecycle: "keep-alive",
				},
			},
		},
		source,
	);
	const config = finalizeMcpConfig(merged);
	assert.deepEqual(config.diagnostics, []);
	const manager = new McpManager({
		config,
		clientFactory: new DefaultMcpClientFactory({ cwd: context.workspace }),
		metadataCache: new McpMetadataCache({ agentDir: context.agentDir }),
		outputStore: new McpOutputStore({
			agentDir: context.agentDir,
			maxOutputBytes: config.settings.maxOutputBytes,
			maxOutputLines: config.settings.maxOutputLines,
		}),
	});
	try {
		const connected = await manager.connectServer("fixture");
		assert.equal(connected.server.status, "ready");
		const listed = await manager.listTools("fixture");
		assert(listed.tools.some((tool) => tool.name === "echo"));
		const called = await manager.callTool(
			{ action: "call", server: "fixture", tool: "echo", arguments: { text: "benchmark" } },
			{ mode: "rpc", caller: "user" },
		);
		assert.equal(called.status, "completed");
		assert.match(called.content, /echo:benchmark/);
		await context.channel.checkpoint("active", { serverStatus: manager.getServer("fixture").status, tool: "echo" });
		await manager.dispose();
		assert.equal(manager.getServer("fixture").status, "disconnected");
		await context.channel.checkpoint("post-disposal", { disposed: true, serverStatus: "disconnected" });
	} finally {
		await manager.dispose();
	}
}

async function runLsp(context) {
	const serverPath = join(repoRoot, "scripts", "fixtures", "memory-benchmark-lsp-server.mjs");
	const sourcePath = join(context.workspace, "benchmark.foo");
	await writeFile(sourcePath, "benchmark symbol\n", "utf8");
	await context.channel.checkpoint("before-activation", { fixture: "stdio-lsp" });
	const disabledBuiltIns = Object.fromEntries(
		["typescript", "python", "go", "rust", "cpp", "zig", "lua", "bash"].map((name) => [name, { enabled: false }]),
	);
	const created = await createBenchmarkRuntime({
		...context,
		tools: ["lsp"],
		settings: {
			lsp: {
				enabled: true,
				settleMs: 50,
				firstSettleMs: 500,
				idleShutdownMs: 0,
				servers: {
					...disabledBuiltIns,
					benchmark: {
						command: [process.execPath, serverPath],
						fileExtensions: [".foo"],
						rootMarkers: [],
					},
				},
			},
		},
	});
	try {
		assert(created.runtime.session.getActiveToolNames().includes("lsp"));
		const tool = created.runtime.session.state.tools.find((candidate) => candidate.name === "lsp");
		assert(tool);
		const result = await tool.execute("benchmark-lsp-call", {
			action: "hover",
			path: "benchmark.foo",
			symbol: "benchmark",
			line: 1,
		});
		assert.equal(result.content[0]?.type, "text");
		assert.match(result.content[0]?.text ?? "", /benchmark hover/);
		const status = created.runtime.session.getLspStatus();
		assert.equal(status.enabled, true);
		assert(status.servers.some((server) => server.name === "benchmark" && server.alive));
		await context.channel.checkpoint("active", { server: "benchmark", tool: "lsp" });
		await created.runtime.dispose();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		await context.channel.checkpoint("post-disposal", { disposed: true });
	} finally {
		await created.runtime.dispose();
		created.registered.faux.unregister();
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const workspace = join(options.root, "workspace");
	const agentDir = join(options.root, "agent");
	const sessionDir = join(options.root, "sessions");
	await Promise.all([
		mkdir(workspace, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	const channel = new CheckpointChannel();
	const context = { ...options, workspace, agentDir, sessionDir, channel };
	const scenarios = {
		"runtime-idle": runRuntimeIdle,
		conversation: runConversation,
		"reconnect-retention": runReconnectRetention,
		extension: runExtension,
		mcp: runMcp,
		lsp: runLsp,
	};
	const run = scenarios[options.scenario];
	if (!run) throw new Error(`Unsupported worker scenario: ${options.scenario}`);
	await run(context);
	channel.done();
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
