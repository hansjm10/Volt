import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import * as undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../../../src/core/output-guard.ts";
import { createIrohRemoteHandshakeFailure } from "../../../src/core/remote/iroh/handshake.ts";
import {
	createIrohRemoteOutboundFilteredRpcTransport,
	sanitizeIrohRemoteOutbound,
} from "../../../src/core/remote/iroh/outbound-filter.ts";
import { IrohRemoteOutcomeError } from "../../../src/core/remote/iroh/protocol.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	SESSION_STORE_DATABASE_FILENAME,
	SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import * as themeRuntime from "../../../src/core/theme/runtime.ts";
import { createSessionManagerTargetStore, resolveIrohRemoteSessionTarget } from "../../../src/daemon/session-target.ts";
import { main } from "../../../src/main.ts";
import { createDirectorySymlinkSync } from "../../symlink-utils.ts";
import { createHarness, type Harness } from "../harness.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repositoryRoot = resolve(packageRoot, "../..");
const roots: string[] = [];
const managers: SessionManager[] = [];
const harnesses: Harness[] = [];
const runtimes: AgentSessionRuntime[] = [];
const leases: SQLiteSessionStoreLease[] = [];
const CLI_ENV_KEYS = [
	"HOME",
	"VOLT_CODING_AGENT_DIR",
	"VOLT_CODING_AGENT_SESSION_DIR",
	"VOLT_OFFLINE",
	"VOLT_SKIP_VERSION_CHECK",
	"VOLT_PROFILE",
	"VOLT_STARTUP_BENCHMARK",
	"HTTP_PROXY",
	"HTTPS_PROXY",
] as const;
const UNDICI_WEB_GLOBAL_KEYS = [
	"fetch",
	"Headers",
	"Response",
	"Request",
	"FormData",
	"WebSocket",
	"CloseEvent",
	"ErrorEvent",
	"MessageEvent",
	"EventSource",
] as const;
interface StoreFixture {
	root: string;
	cwd: string;
	sessionDir: string;
}

interface IntegrityLeakSentinels {
	payload: string;
	clientInput: string;
	providerData: string;
	sessionDirectory: string;
	storeId: string;
	sessionGeneration: string;
}

function createStoreFixture(prefix: string): StoreFixture {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const cwd = join(root, "workspace-discovery-329");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	roots.push(root);
	return { root, cwd, sessionDir };
}

async function ownManager(manager: Promise<SessionManager>): Promise<SessionManager> {
	const resolved = await manager;
	managers.push(resolved);
	return resolved;
}

async function ownHarness(harness: Promise<Harness>): Promise<Harness> {
	const resolved = await harness;
	harnesses.push(resolved);
	return resolved;
}

function ownRuntime(runtime: AgentSessionRuntime): AgentSessionRuntime {
	runtimes.push(runtime);
	return runtime;
}

function corruptUnrelatedSummary(sessionDir: string, sessionId: string): void {
	const database = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
	try {
		database.exec("PRAGMA ignore_check_constraints = ON");
		const result = database
			.prepare("UPDATE sessions SET starting_git_context_recorded = 2 WHERE id = ?")
			.run(sessionId);
		if (result.changes !== 1) throw new Error(`Could not corrupt unrelated summary ${sessionId}`);
	} finally {
		database.close();
	}
}

function corruptTargetForOpen(
	sessionDir: string,
	sessionId: string,
	corruption: "canonical payload" | "summary projection",
	leakSentinels?: IntegrityLeakSentinels,
): void {
	const database = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
	try {
		const serializedSentinels = leakSentinels === undefined ? undefined : JSON.stringify(leakSentinels);
		const result =
			corruption === "canonical payload"
				? database
						.prepare("UPDATE entries SET payload_json = ? WHERE session_id = ? AND ordinal = 1")
						.run(serializedSentinels ?? "{}", sessionId)
				: database
						.prepare("UPDATE sessions SET name = ? WHERE id = ?")
						.run(serializedSentinels ?? "projection-drift-329", sessionId);
		if (result.changes !== 1) throw new Error(`Could not corrupt target ${sessionId}`);
	} finally {
		database.close();
	}
}

function servicesForHarness(harness: Harness, cwd: string, agentDir = harness.tempDir): AgentSessionServices {
	return {
		cwd,
		projectCwd: cwd,
		lexicalProjectCwd: cwd,
		agentDir,
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
		gitContextProvider: harness.session.gitContextProvider,
		diagnostics: [],
	};
}

async function closeTrackedManager(manager: SessionManager): Promise<void> {
	await manager.closePersistence();
}

async function runPrintCli(options: {
	root: string;
	cwd: string;
	sessionDir: string;
	sessionArguments: string[];
	prompt: string;
	response: string;
	confirmGlobal?: boolean;
}): Promise<void> {
	const agentDir = join(options.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const fauxHarness = await ownHarness(createHarness());
	const model = fauxHarness.getModel();
	fauxHarness.setResponses([fauxAssistantMessage(options.response)]);
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				[model.provider]: {
					api: fauxHarness.faux.api,
					apiKey: "faux-key",
					baseUrl: model.baseUrl,
					models: fauxHarness.faux.models,
				},
			},
		})}\n`,
	);
	const previousCwd = process.cwd();
	const previousExitCode = process.exitCode;
	const previousEnv = Object.fromEntries(CLI_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
		(typeof CLI_ENV_KEYS)[number],
		string | undefined
	>;
	const previousStdin = Object.getOwnPropertyDescriptor(process, "stdin");
	const previousDispatcher = undici.getGlobalDispatcher();
	const previousWebGlobals = UNDICI_WEB_GLOBAL_KEYS.map((key) => ({
		key,
		descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
	}));
	const previousFetch = globalThis.fetch;
	// These CLI arguments can reach at most the cross-project fork confirmation. A finite
	// answer is still supplied on every path so an unexpected confirmation cannot wait on EOF.
	const cliStdin = Readable.from([options.confirmGlobal ? "y\n" : "n\n"]);
	Object.defineProperty(cliStdin, "isTTY", { configurable: true, value: true });
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code) => {
		throw new Error("runPrintCli blocked process.exit");
	}) as typeof process.exit);
	// Print-mode assertions do not depend on theme initialization. Suppress main's
	// process-global theme writes so an existing theme instance/watcher is untouched.
	const initThemeSpy = vi.spyOn(themeRuntime, "initTheme").mockImplementation(() => undefined);
	const stopThemeWatcherSpy = vi.spyOn(themeRuntime, "stopThemeWatcher").mockImplementation(() => undefined);
	try {
		process.chdir(options.cwd);
		process.exitCode = undefined;
		process.env.HOME = options.root;
		process.env.VOLT_CODING_AGENT_DIR = agentDir;
		process.env.VOLT_CODING_AGENT_SESSION_DIR = options.sessionDir;
		process.env.VOLT_OFFLINE = "1";
		process.env.VOLT_SKIP_VERSION_CHECK = "1";
		delete process.env.VOLT_PROFILE;
		delete process.env.VOLT_STARTUP_BENCHMARK;
		// Prevent configureHttpDispatcher() from installing Undici's web globals while
		// retaining the prior fetch behavior for any incidental call in this fixture.
		globalThis.fetch = (input, init) => previousFetch(input, init);
		Object.defineProperty(process, "stdin", { configurable: true, value: cliStdin });
		await main([
			"--print",
			"--offline",
			"--session-dir",
			options.sessionDir,
			...options.sessionArguments,
			"--provider",
			model.provider,
			"--model",
			model.id,
			"--api-key",
			"faux-key",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			options.prompt,
		]);
	} finally {
		const replacementDispatcher = undici.getGlobalDispatcher();
		exitSpy.mockRestore();
		initThemeSpy.mockRestore();
		stopThemeWatcherSpy.mockRestore();
		restoreStdout();
		cliStdin.destroy();
		process.chdir(previousCwd);
		process.exitCode = previousExitCode;
		if (previousStdin) Object.defineProperty(process, "stdin", previousStdin);
		else Reflect.deleteProperty(process, "stdin");
		for (const key of CLI_ENV_KEYS) {
			const value = previousEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		undici.setGlobalDispatcher(previousDispatcher);
		for (const { key, descriptor } of previousWebGlobals) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
			else Object.defineProperty(globalThis, key, descriptor);
		}
		if (replacementDispatcher !== previousDispatcher) await replacementDispatcher.close();
	}

	expect(fauxHarness.getPendingResponseCount()).toBe(0);
}

afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	restoreStdout();
	for (const runtime of runtimes.splice(0).reverse()) {
		try {
			await runtime.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	for (const harness of harnesses.splice(0).reverse()) {
		try {
			await harness.cleanupAsync();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	for (const manager of managers.splice(0).reverse()) {
		try {
			await manager.closePersistence();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	for (const lease of leases.splice(0).reverse()) {
		try {
			await lease.release();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
	if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PR #329 regression cleanup failed");
});

describe("PR #329 remote SQLite locator privacy", () => {
	it("removes nested and flattened host-local SQLite locators without dropping public output", async () => {
		const writes: object[] = [];
		const locator = {
			sessionDirectory: "/Users/private/.volt/agent/sessions/--secret--",
			storeId: "private-store-id-329",
			sessionId: "public-session-id-329",
			sessionGeneration: "private-session-generation-329",
		};
		const parentLocator = {
			parentSessionDirectory: "/Users/private/.volt/agent/sessions/--parent-secret--",
			parentStoreId: "private-parent-store-id-329",
			parentSessionGeneration: "private-parent-session-generation-329",
		};
		const publicPayload = { status: "completed", count: 329 };
		const transport = createIrohRemoteOutboundFilteredRpcTransport({
			workspacePath: "/Users/private/workspace",
			transport: {
				write(value) {
					writes.push(value);
				},
				onLine: () => () => {},
				close: () => {},
			},
		});

		await transport.write({
			type: "tool_execution_end",
			toolCallId: "nested-locator-output",
			result: {
				content: [{ type: "text", text: "completed" }],
				details: { output: [{ nested: { locator, ...parentLocator, publicPayload } }] },
			},
		});

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			result: { details: { output: [{ nested: { publicPayload } }] } },
		});
		const wire = JSON.stringify(writes[0]);
		for (const forbidden of [
			"sessionDirectory",
			locator.sessionDirectory,
			"storeId",
			locator.storeId,
			"sessionGeneration",
			locator.sessionGeneration,
			"parentSessionDirectory",
			parentLocator.parentSessionDirectory,
			"parentStoreId",
			parentLocator.parentStoreId,
			"parentSessionGeneration",
			parentLocator.parentSessionGeneration,
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});

	it("omits host-local locator fields from bare and wrapped session references", () => {
		const sessionReference = {
			sessionDirectory: "/Users/private/.volt/agent/sessions/direct-secret-329",
			storeId: "direct-private-store-id-329",
			sessionId: "public-session-id-329",
			sessionGeneration: "direct-private-generation-329",
		};
		for (const value of [sessionReference, { ref: sessionReference }, { references: [sessionReference] }]) {
			const wire = JSON.stringify(sanitizeIrohRemoteOutbound(value, { workspacePath: "/Users/private/workspace" }));
			for (const forbidden of [
				"sessionDirectory",
				sessionReference.sessionDirectory,
				"storeId",
				sessionReference.storeId,
				"sessionGeneration",
				sessionReference.sessionGeneration,
			]) {
				expect(wire).not.toContain(forbidden);
			}
		}
	});
});

describe("PR #329 remote integrity-error privacy", () => {
	it.each(["canonical payload", "summary projection"] as const)(
		"bounds and sanitizes a remote explicit-session error for %s corruption",
		async (corruption) => {
			const { cwd, sessionDir } = createStoreFixture(`volt-329-remote-integrity-${corruption.split(" ")[0]}-`);
			const target = await ownManager(
				SessionManager.create(cwd, sessionDir, {
					id: `remote-integrity-${corruption === "canonical payload" ? "entry" : "projection"}-329`,
				}),
			);
			const targetRef = target.getSessionRef();
			if (!targetRef) throw new Error("Expected a remote integrity target reference");
			const leakSentinels: IntegrityLeakSentinels = {
				payload: "private-payload-secret-329",
				clientInput: "private-client-input-secret-329",
				providerData: "private-provider-data-secret-329",
				sessionDirectory: sessionDir,
				storeId: targetRef.storeId,
				sessionGeneration: targetRef.sessionGeneration,
			};
			target.appendMessage({ role: "user", content: JSON.stringify(leakSentinels), timestamp: 1 });
			await target.flush();
			await closeTrackedManager(target);
			corruptTargetForOpen(sessionDir, target.getSessionId(), corruption, leakSentinels);

			const resolution = await resolveIrohRemoteSessionTarget(
				{ kind: "session", sessionId: target.getSessionId() },
				{ name: "private-workspace-name-329", path: cwd },
				createSessionManagerTargetStore(cwd, sessionDir, { listAll: true, preserveSessionCwd: true }),
			).then(
				(resolved) => ({ status: "resolved" as const, resolved }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			);
			if (resolution.status === "resolved") {
				managers.push(resolution.resolved.sessionManager);
				throw new Error("Expected corrupt remote target resolution to fail");
			}
			if (!(resolution.error instanceof IrohRemoteOutcomeError)) throw resolution.error;
			expect(resolution.error.outcome).toBe("session_unavailable");
			expect(resolution.error.message).toBe("session_unavailable: session state is corrupt or ambiguous");

			const failure = createIrohRemoteHandshakeFailure(resolution.error.message, {
				outcome: "session_unavailable",
			});
			expect(failure).toMatchObject({
				success: false,
				outcome: "session_unavailable",
				error: "session_unavailable: session state is corrupt or ambiguous",
			});
			expect(failure.error.length).toBeLessThanOrEqual(96);
			const wire = JSON.stringify(failure);
			expect(wire.length).toBeLessThanOrEqual(256);
			for (const forbidden of [
				...Object.values(leakSentinels),
				cwd,
				"private-workspace-name-329",
				"payload_json",
				"sessionDirectory",
				"storeId",
				"sessionGeneration",
			]) {
				expect(wire).not.toContain(forbidden);
			}
		},
	);
});

describe("PR #329 exact-ID discovery isolation", () => {
	it("opens one exact target even when an unrelated summary is malformed", async () => {
		const { cwd, sessionDir } = createStoreFixture("volt-329-exact-api-");
		const target = await ownManager(SessionManager.create(cwd, sessionDir, { id: "exact-api-target-329" }));
		target.appendMessage({ role: "user", content: "exact target transcript", timestamp: 1 });
		await target.flush();
		const targetRef = target.getSessionRef();
		if (!targetRef) throw new Error("Expected an exact target reference");
		const malformed = await ownManager(SessionManager.create(cwd, sessionDir, { id: "unrelated-malformed-api-329" }));
		malformed.appendMessage({ role: "user", content: "unrelated", timestamp: 2 });
		await malformed.flush();
		await Promise.all([closeTrackedManager(target), closeTrackedManager(malformed)]);
		corruptUnrelatedSummary(sessionDir, malformed.getSessionId());

		const found = await SessionManager.findForResume(sessionDir, target.getSessionId());
		expect(found).toEqual(targetRef);
		if (!found) throw new Error("Expected exact lookup to resolve its target");
		const reopened = await ownManager(SessionManager.open(found));
		expect(reopened.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: "exact target transcript" },
		]);
	});

	it.each(["canonical payload", "summary projection"] as const)(
		"returns an exact reference before open rejects target %s corruption",
		async (corruption) => {
			const { cwd, sessionDir } = createStoreFixture(`volt-329-exact-corrupt-${corruption.split(" ")[0]}-`);
			const target = await ownManager(
				SessionManager.create(cwd, sessionDir, { id: `exact-corrupt-${corruption.split(" ")[0]}-329` }),
			);
			target.appendMessage({ role: "user", content: "target to corrupt", timestamp: 1 });
			await target.flush();
			const targetRef = target.getSessionRef();
			if (!targetRef) throw new Error("Expected a corruption target reference");
			await closeTrackedManager(target);
			corruptTargetForOpen(sessionDir, target.getSessionId(), corruption);

			const found = await SessionManager.findForResume(sessionDir, target.getSessionId());
			expect(found).toEqual(targetRef);
			if (!found) throw new Error("Expected summary-only lookup to return a reference");
			await expect(SessionManager.open(found)).rejects.toThrow();
		},
	);

	it("switches the runtime by exact ID without enumerating unrelated summaries", async () => {
		const { cwd, sessionDir } = createStoreFixture("volt-329-exact-runtime-");
		const current = await ownManager(SessionManager.create(cwd, sessionDir, { id: "runtime-current-329" }));
		current.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await current.flush();
		const target = await ownManager(SessionManager.create(cwd, sessionDir, { id: "runtime-target-329" }));
		target.appendMessage({ role: "user", content: "runtime exact target", timestamp: 2 });
		await target.flush();
		const malformed = await ownManager(
			SessionManager.create(cwd, sessionDir, { id: "runtime-unrelated-malformed-329" }),
		);
		malformed.appendMessage({ role: "user", content: "unrelated", timestamp: 3 });
		await malformed.flush();
		await Promise.all([closeTrackedManager(target), closeTrackedManager(malformed)]);
		corruptUnrelatedSummary(sessionDir, malformed.getSessionId());

		const initialHarness = await ownHarness(createHarness({ sessionManager: current }));
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: nextCwd, agentDir, sessionManager }) => {
			const replacementHarness = await ownHarness(createHarness({ sessionManager }));
			const services = servicesForHarness(replacementHarness, nextCwd, agentDir);
			return {
				session: replacementHarness.session,
				extensionsResult: replacementHarness.session.resourceLoader.getExtensions(),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = ownRuntime(
			new AgentSessionRuntime(initialHarness.session, servicesForHarness(initialHarness, cwd), createRuntime),
		);

		await expect(runtime.switchSessionById(target.getSessionId())).resolves.toEqual({
			cancelled: false,
			seeded: false,
		});
		expect(runtime.session.sessionId).toBe(target.getSessionId());
		expect(runtime.session.sessionManager.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: "runtime exact target" },
		]);
	});

	it.each(["--session", "--session-id"] as const)(
		"resumes an exact CLI target through %s without enumerating unrelated summaries",
		async (sessionFlag) => {
			const { root, cwd, sessionDir } = createStoreFixture(`volt-329-exact-cli-${sessionFlag.slice(2)}-`);
			const target = await ownManager(
				SessionManager.create(cwd, sessionDir, { id: `cli-${sessionFlag.slice(2)}-target-329` }),
			);
			target.appendMessage({ role: "user", content: "CLI seed", timestamp: 1 });
			await target.flush();
			const targetRef = target.getSessionRef();
			if (!targetRef) throw new Error("Expected a CLI target reference");
			const malformed = await ownManager(
				SessionManager.create(cwd, sessionDir, { id: `cli-${sessionFlag.slice(2)}-unrelated-malformed-329` }),
			);
			malformed.appendMessage({ role: "user", content: "unrelated", timestamp: 2 });
			await malformed.flush();
			await Promise.all([closeTrackedManager(target), closeTrackedManager(malformed)]);
			corruptUnrelatedSummary(sessionDir, malformed.getSessionId());

			const loadSession = vi.spyOn(SQLiteSessionStoreClient.prototype, "loadSession");
			let targetTranscriptLoads = 0;
			try {
				await runPrintCli({
					root,
					cwd,
					sessionDir,
					sessionArguments: [sessionFlag, target.getSessionId()],
					prompt: "CLI exact lookup prompt",
					response: "CLI exact target reached",
				});
				targetTranscriptLoads = loadSession.mock.calls.filter(
					([sessionId, sessionGeneration]) =>
						sessionId === targetRef.sessionId && sessionGeneration === targetRef.sessionGeneration,
				).length;
			} finally {
				loadSession.mockRestore();
			}
			expect(targetTranscriptLoads).toBe(1);

			const reopened = await ownManager(SessionManager.open(targetRef));
			expect(
				reopened
					.buildSessionContext()
					.messages.filter((message) => message.role === "user")
					.map((message) => message.content),
			).toContainEqual([{ type: "text", text: "CLI exact lookup prompt" }]);
		},
	);

	it("resolves a global exact CLI target without enumerating an unrelated project summary", async () => {
		const { root, cwd, sessionDir } = createStoreFixture("volt-329-exact-cli-global-");
		const globalCwd = join(root, "global-workspace");
		const malformedCwd = join(root, "malformed-workspace");
		mkdirSync(globalCwd, { recursive: true });
		mkdirSync(malformedCwd, { recursive: true });
		const target = await ownManager(SessionManager.create(globalCwd, sessionDir, { id: "cli-global-target-329" }));
		target.appendMessage({ role: "user", content: "global CLI seed", timestamp: 1 });
		await target.flush();
		const targetRef = target.getSessionRef();
		if (!targetRef) throw new Error("Expected a global CLI target reference");
		const malformed = await ownManager(
			SessionManager.create(malformedCwd, sessionDir, { id: "cli-global-unrelated-malformed-329" }),
		);
		await malformed.flush();
		expect(await SessionManager.list(malformedCwd, sessionDir)).toEqual([]);
		await Promise.all([closeTrackedManager(target), closeTrackedManager(malformed)]);
		corruptUnrelatedSummary(sessionDir, malformed.getSessionId());

		const loadSession = vi.spyOn(SQLiteSessionStoreClient.prototype, "loadSession");
		let targetTranscriptLoads = 0;
		try {
			await runPrintCli({
				root,
				cwd,
				sessionDir,
				sessionArguments: ["--session", target.getSessionId()],
				prompt: "global CLI exact lookup prompt",
				response: "global CLI exact target reached",
				confirmGlobal: true,
			});
			targetTranscriptLoads = loadSession.mock.calls.filter(
				([sessionId, sessionGeneration]) =>
					sessionId === targetRef.sessionId && sessionGeneration === targetRef.sessionGeneration,
			).length;
		} finally {
			loadSession.mockRestore();
		}
		expect(targetTranscriptLoads).toBe(1);

		const localSessions = await SessionManager.list(cwd, sessionDir);
		expect(localSessions).toHaveLength(1);
		const forked = await ownManager(SessionManager.open(localSessions[0]!.ref));
		const userContent = forked
			.buildSessionContext()
			.messages.filter((message) => message.role === "user")
			.map((message) => message.content);
		expect(userContent).toContainEqual("global CLI seed");
		expect(userContent).toContainEqual([{ type: "text", text: "global CLI exact lookup prompt" }]);
	});
});

describe("PR #329 physical store identity", () => {
	it("rejects a direct session-directory leaf symlink", async () => {
		const { root, sessionDir } = createStoreFixture("volt-329-store-leaf-symlink-");
		mkdirSync(sessionDir, { recursive: true });
		const alias = join(root, "sessions-alias");
		createDirectorySymlinkSync(sessionDir, alias);
		expect(realpathSync(alias)).toBe(realpathSync(sessionDir));

		await expect(acquireSharedSQLiteSessionStore(alias)).rejects.toThrow(
			"Refusing to use non-directory private path",
		);
		expect(existsSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME))).toBe(false);
	});

	it("shares one in-process store client across admitted symlinked-parent aliases", async () => {
		const { root } = createStoreFixture("volt-329-store-parent-alias-");
		const physicalParent = join(root, "physical-parent");
		const sessionDir = join(physicalParent, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const aliasParent = join(root, "parent-alias");
		createDirectorySymlinkSync(physicalParent, aliasParent);
		const alias = join(aliasParent, "sessions");
		expect(realpathSync(alias)).toBe(realpathSync(sessionDir));

		const physical = await acquireSharedSQLiteSessionStore(sessionDir);
		leases.push(physical);
		const linked = await acquireSharedSQLiteSessionStore(alias);
		leases.push(linked);

		expect(linked.client.info.storeId).toBe(physical.client.info.storeId);
		expect(linked.client).toBe(physical.client);
	});
});

describe("PR #329 deep-search behavior", () => {
	it("preserves matching, metadata, visibility, and eligible chunk order with large fixtures", async () => {
		const { cwd, sessionDir } = createStoreFixture("volt-329-search-");
		const searchablePadding = "s".repeat(192 * 1024);
		const nonSearchablePadding = "n".repeat(192 * 1024);
		const visible = await ownManager(SessionManager.create(cwd, sessionDir, { id: "metadata-session-329" }));
		visible.appendSessionInfo("obsolete-name-marker-329");
		visible.appendMessage({ role: "user", content: "boundary-alpha-329 order-user-329", timestamp: 10 });
		visible.appendCustomEntry("opaque-growth", {
			marker: "non-searchable-growth-marker-329",
			padding: nonSearchablePadding,
		});
		visible.appendMessage({
			role: "toolResult",
			toolCallId: "search-tool-call-329",
			toolName: "read",
			content: [{ type: "text", text: "tool-only-marker-329" }],
			isError: false,
			timestamp: 11,
		});
		visible.appendCustomMessageEntry("hidden-search-text", "undisplayed-marker-329", false);
		visible.appendMessage(fauxAssistantMessage("order-assistant-329 assistant-only-marker-329", { timestamp: 12 }));
		visible.appendCustomMessageEntry(
			"displayed-search-text",
			`order-custom-329 boundary-omega-329 ${searchablePadding} searchable-growth-tail-329 cross-session-left-329`,
			true,
		);
		visible.appendSessionInfo("latest-name-marker-329");
		await visible.flush();

		const other = await ownManager(SessionManager.create(cwd, sessionDir, { id: "other-searchable-session-329" }));
		other.appendMessage({
			role: "user",
			content: `cross-session-right-329 ${searchablePadding} second-session-tail-329`,
			timestamp: 12,
		});
		await other.flush();

		const hidden = await ownManager(SessionManager.create(cwd, sessionDir, { id: "hidden-session-329" }));
		hidden.appendSessionInfo("hidden-summary-marker-329");
		hidden.appendCustomEntry("hidden-opaque", { marker: "hidden-custom-marker-329" });
		await hidden.flush();

		const planning = await ownManager(SessionManager.create(cwd, sessionDir, { id: "planning-session-329" }));
		planning.appendSessionInfo("planning-visible-marker-329");
		planning.appendPlanningState({ mode: "plan", plan: null });
		await planning.flush();

		const ids = async (query: string, includeMessageFreeDurable = false): Promise<string[]> =>
			(
				await SessionManager.search(cwd, query, sessionDir, {
					includeMessageFreeDurable,
				})
			).map((session) => session.id);

		expect(
			await ids(
				'"boundary-alpha-329 order-user-329 order-assistant-329 assistant-only-marker-329 order-custom-329 boundary-omega-329"',
			),
		).toEqual([visible.getSessionId()]);
		expect(await ids("boundaryalpha329")).toEqual([visible.getSessionId()]);
		expect(await ids('"assistant-only-marker-329"')).toEqual([visible.getSessionId()]);
		expect(await ids("re:boundary-alpha-329\\s+order-user-329\\s+order-assistant-329")).toEqual([
			visible.getSessionId(),
		]);
		expect(await ids('"cross-session-left-329 cross-session-right-329"')).toEqual([]);
		expect(await ids('"searchable-growth-tail-329"')).toEqual([visible.getSessionId()]);
		expect(await ids('"second-session-tail-329"')).toEqual([other.getSessionId()]);
		expect(await ids('"latest-name-marker-329"')).toEqual([visible.getSessionId()]);
		expect(await ids('"obsolete-name-marker-329"')).toEqual([]);
		expect(await ids('"metadata-session-329"')).toEqual([visible.getSessionId()]);
		expect(new Set(await ids('"workspace-discovery-329"'))).toEqual(
			new Set([visible.getSessionId(), other.getSessionId(), planning.getSessionId()]),
		);
		expect(await ids('"planning-visible-marker-329"')).toEqual([planning.getSessionId()]);
		expect(await ids('"hidden-summary-marker-329"')).toEqual([]);
		expect(await ids('"hidden-summary-marker-329"', true)).toEqual([hidden.getSessionId()]);
		for (const excluded of [
			"non-searchable-growth-marker-329",
			"tool-only-marker-329",
			"undisplayed-marker-329",
			"hidden-custom-marker-329",
		]) {
			expect(await ids(`"${excluded}"`, true)).toEqual([]);
		}
	});
});

describe("PR #329 RFC and pending changelog contracts", () => {
	it("states implementation as complete without stale planning language", () => {
		const rfc = readFileSync(join(packageRoot, "docs/sqlite-session-storage-design.md"), "utf8");
		expect(rfc).toContain("- Status: Accepted; implemented");
		expect(rfc).toContain("A successfully committed SQLite session row is immediately **adopted**.");
		for (const staleLanguage of [
			"for a separate implementation plan",
			"implementation under this document-only revision",
			"Implementation phases for a separate plan",
			"implementation handoff, not authorization",
			"Before an implementation plan",
			"Implementation has not started",
			"requires a separate approved plan",
		]) {
			expect(rfc, `Implemented RFC retains stale language: ${staleLanguage}`).not.toContain(staleLanguage);
		}
	});

	it.each([
		{
			fileName: "fix-cleaned-up-persisted-sessions-when.md",
			contradiction: "Cleaned up persisted sessions when SDK session setup fails",
			correction: "Retained committed sessions when SDK session setup fails",
		},
		{
			fileName: "fix-removed-abandoned-sessions-created-by.md",
			contradiction: "Removed abandoned sessions created by failed new-session preparation",
			correction: "Retained committed sessions when new-session preparation fails",
		},
	])("records retained-row semantics directly in $fileName", ({ fileName, contradiction, correction }) => {
		const fragment = readFileSync(join(repositoryRoot, ".changeset", fileName), "utf8");
		expect(fragment).toContain(correction);
		expect(fragment, `Pending changelog contradicts immediate row adoption: ${contradiction}`).not.toContain(
			contradiction,
		);
	});
});
