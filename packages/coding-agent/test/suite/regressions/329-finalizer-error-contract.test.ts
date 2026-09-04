import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/rpc/index.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SubagentManager } from "../../../src/core/subagents/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

function createServices(harness: Harness, cwd = harness.tempDir, agentDir = harness.tempDir): AgentSessionServices {
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

function createHarnessRuntimeFactory(options: { onHarness?: (harness: Harness, index: number) => void } = {}): {
	createRuntime: CreateAgentSessionRuntimeFactory;
	harnesses: Harness[];
} {
	const harnesses: Harness[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
		const harness = await createHarness({ sessionManager });
		const index = harnesses.push(harness) - 1;
		options.onHarness?.(harness, index);
		const services = createServices(harness, cwd, agentDir);
		return {
			session: harness.session,
			extensionsResult: harness.session.resourceLoader.getExtensions(),
			services,
			diagnostics: services.diagnostics,
		};
	};
	return { createRuntime, harnesses };
}

function cleanupHarnesses(harnesses: Harness[]): void {
	for (const harness of harnesses.reverse()) harness.cleanup();
}

describe("PR #329 finalizer error contract", () => {
	it("uses one AgentSessionRuntime finalizer when local subagent RPC startup fails", async () => {
		const owner = await createHarness();
		const startupError = new Error("injected local RPC startup failure");
		const fixture = createHarnessRuntimeFactory({
			onHarness: (harness) => {
				vi.spyOn(harness.session, "bindExtensions").mockRejectedValue(startupError);
			},
		});
		const manager = new SubagentManager({
			createRuntime: fixture.createRuntime,
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
		});
		const originalDispose = AgentSessionRuntime.prototype.dispose;
		let logicalFinalizerCalls = 0;
		const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose").mockImplementation(function (
			this: AgentSessionRuntime,
		): Promise<void> {
			if (fixture.harnesses.some((harness) => harness.session === this.session)) logicalFinalizerCalls += 1;
			return originalDispose.call(this);
		});

		try {
			await expect(manager.start()).rejects.toBe(startupError);
			expect(logicalFinalizerCalls).toBe(1);
		} finally {
			await manager.dispose().catch(() => undefined);
			disposeSpy.mockRestore();
			cleanupHarnesses(fixture.harnesses);
			owner.cleanup();
		}
	});

	it("aggregates every child-handle disposal failure from SubagentManager.dispose", async () => {
		const owner = await createHarness();
		const fixture = createHarnessRuntimeFactory();
		const disposalErrors = [new Error("first child disposal failed"), new Error("second child disposal failed")];
		let runtimeIndex = 0;
		const manager = new SubagentManager({
			createRuntime: fixture.createRuntime,
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
			onRuntimeCreated: ({ runtime }) => {
				const disposalError = disposalErrors[runtimeIndex++];
				if (!disposalError) throw new Error("unexpected extra child runtime");
				const disposeRuntime = runtime.dispose.bind(runtime);
				runtime.dispose = async () => {
					await disposeRuntime();
					throw disposalError;
				};
			},
		});

		try {
			await manager.start();
			await manager.start();

			const thrown = await manager.dispose().catch((error: unknown) => error);

			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("expected aggregate child cleanup failure");
			const errors = thrown.errors as unknown[];
			expect(errors).toHaveLength(disposalErrors.length);
			for (const disposalError of disposalErrors) expect(errors).toContain(disposalError);
		} finally {
			await manager.dispose().catch(() => undefined);
			cleanupHarnesses(fixture.harnesses);
			owner.cleanup();
		}
	});

	it("preserves RPC startup and runtime disposal failures together", async () => {
		const harness = await createHarness();
		const startupError = new Error("injected RPC bind failure");
		const cleanupError = new Error("injected RPC runtime disposal failure");
		vi.spyOn(harness.session, "bindExtensions").mockRejectedValue(startupError);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir }) => {
			const services = createServices(harness, cwd, agentDir);
			return {
				session: harness.session,
				extensionsResult: harness.session.resourceLoader.getExtensions(),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = new AgentSessionRuntime(harness.session, createServices(harness), createRuntime);
		const disposeRuntime = runtime.dispose.bind(runtime);
		vi.spyOn(runtime, "dispose").mockImplementation(async () => {
			await disposeRuntime();
			throw cleanupError;
		});
		const pair = createLoopbackRpcTransportPair();

		try {
			const thrown = await runRpcMode(runtime, { transport: pair.server, exitProcess: false }).catch(
				(error: unknown) => error,
			);

			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("expected aggregate RPC startup cleanup failure");
			const errors = thrown.errors as unknown[];
			expect(errors).toHaveLength(2);
			expect(errors[0]).toBe(startupError);
			expect(errors.slice(1)).toContain(cleanupError);
		} finally {
			await pair.client.close();
			harness.cleanup();
		}
	});

	it("preserves subagent and persistence failures through runtime disposal", async () => {
		const owner = await createHarness();
		const sessionManager = await SessionManager.create(owner.tempDir, join(owner.tempDir, "runtime-sessions"));
		const subagentManager = new SubagentManager({
			createRuntime: async () => {
				throw new Error("child runtime creation is not expected");
			},
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
		});
		const created = await createAgentSession({
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
			authStorage: owner.authStorage,
			modelRegistry: owner.session.modelRegistry,
			model: owner.getModel(),
			settingsManager: owner.settingsManager,
			resourceLoader: owner.session.resourceLoader,
			sessionManager,
			subagentToolManager: subagentManager,
			disableMcp: true,
			noTools: "all",
		});
		const services: AgentSessionServices = {
			cwd: owner.tempDir,
			projectCwd: owner.tempDir,
			lexicalProjectCwd: owner.tempDir,
			agentDir: owner.tempDir,
			authStorage: owner.authStorage,
			settingsManager: created.session.settingsManager,
			modelRegistry: created.session.modelRegistry,
			resourceLoader: created.session.resourceLoader,
			gitContextProvider: created.session.gitContextProvider,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(created.session, services, async () => {
			throw new Error("replacement runtime creation is not expected");
		});
		const subagentError = new Error("injected subagent cleanup failure");
		const persistenceError = new Error("injected persistence cleanup failure");
		const disposeSubagents = subagentManager.dispose.bind(subagentManager);
		const closePersistence = sessionManager.closePersistence.bind(sessionManager);
		let subagentDisposeCalls = 0;
		let managerCloseCalls = 0;
		const subagentDisposeSpy = vi.spyOn(subagentManager, "dispose").mockImplementation(async () => {
			subagentDisposeCalls++;
			await disposeSubagents();
			throw subagentError;
		});
		const managerCloseSpy = vi.spyOn(sessionManager, "closePersistence").mockImplementation(async () => {
			managerCloseCalls++;
			await closePersistence();
			throw persistenceError;
		});

		try {
			const thrown = await runtime.dispose().catch((error: unknown) => error);

			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("expected aggregate runtime cleanup failure");
			expect(thrown.message).toBe("Agent session runtime cleanup did not complete");
			expect(thrown.errors as unknown[]).toEqual([subagentError, persistenceError]);
			expect(subagentDisposeCalls).toBe(1);
			expect(managerCloseCalls).toBe(1);
			await expect(created.session.prompt("must not run")).rejects.toThrow("Cannot prompt a disposed session");
			await expect(runtime.newSession()).rejects.toThrow(
				"Agent session runtime is no longer accepting structural operations",
			);
		} finally {
			subagentDisposeSpy.mockRestore();
			managerCloseSpy.mockRestore();
			await runtime.dispose().catch(() => undefined);
			await sessionManager.closePersistence().catch(() => undefined);
			await subagentManager.dispose().catch(() => undefined);
			await owner.cleanupAsync();
		}
	});
});
