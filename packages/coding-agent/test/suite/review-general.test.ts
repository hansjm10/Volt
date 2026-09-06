import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import {
	createIrohRemoteRpcGrant,
	getIrohRemoteRpcCommandCapabilities,
} from "../../src/core/remote/iroh/access-grant.ts";
import { getIrohRemoteRpcFilterResult } from "../../src/core/remote/iroh/rpc-command-filter.ts";
import {
	registerDurableReviewAnchor,
	registerReviewHandoffAliases,
	resolveCanonicalReviewSource,
} from "../../src/core/review-anchors.ts";
import { getReviewGeneral } from "../../src/core/review-general.ts";
import { appendReviewRunDurably } from "../../src/core/review-state.ts";
import { RPC_COMMAND_SCHEMAS } from "../../src/core/rpc/schema/commands.ts";
import { RPC_RESPONSE_SCHEMAS } from "../../src/core/rpc/schema/responses.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/client.ts";
import { handleRpcCommand, type RpcCommandDispatcherContext } from "../../src/modes/rpc/rpc-command-dispatcher.ts";
import { validateRpcCommandPayload } from "../../src/modes/rpc/rpc-command-validation.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-general-"));
	const directory = join(root, "sessions");
	const harnesses: Harness[] = [];
	const runtimes: AgentSessionRuntime[] = [];
	const managers: SessionManager[] = [];
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, cwd, agentDir }) => {
		const h = await createHarness({ sessionManager, settings: { lsp: { enabled: false } } });
		harnesses.push(h);
		return {
			session: h.session,
			extensionsResult: h.session.resourceLoader.getExtensions(),
			diagnostics: [],
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: h.authStorage,
				modelRegistry: h.session.modelRegistry,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				gitContextProvider: h.session.gitContextProvider,
				diagnostics: [],
			},
		};
	};
	async function own(manager: SessionManager) {
		const runtime = await createAgentSessionRuntime(factory, { sessionManager: manager, cwd: root, agentDir: root });
		runtimes.push(runtime);
		return runtime;
	}
	cleanups.push(async () => {
		for (const runtime of runtimes) await runtime.dispose();
		for (const manager of managers) await manager.closePersistence();
		for (const h of harnesses) await h.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const runtime = await own(await SessionManager.create(root, directory));
	const source = runtime.session.sessionManager;
	source.appendSessionInfo("Review source");
	await source.materialize();
	await registerDurableReviewAnchor(source, "run");
	const original = source.getSessionRef()!;
	const options = { preserveReviewRunId: "run", replaceReviewGeneral: true };
	return { runtime, root, directory, source, original, options, own, managers };
}

describe("durable review General publication", () => {
	it("replaces repeatedly, preserves canonical source and does not promote ordinary aliases or reopened history", async () => {
		const { runtime, root, directory, source, original, options, managers } = await fixture();
		for (const revision of [1, 2]) {
			expect(await runtime.newSession(options)).toEqual({ cancelled: false, seeded: false });
			expect(await getReviewGeneral(runtime.session.sessionManager, "run")).toEqual({
				runId: "run",
				sourceSessionId: original.sessionId,
				generalSessionId: runtime.session.sessionId,
				generalSessionGeneration: runtime.session.sessionRef!.sessionGeneration,
				generalRevision: revision,
				generalAvailable: true,
			});
			expect(await resolveCanonicalReviewSource(runtime.session.sessionManager, "run")).toEqual(original);
		}
		const final = await getReviewGeneral(runtime.session.sessionManager, "run");
		const alias = await SessionManager.create(root, directory);
		managers.push(alias);
		await registerReviewHandoffAliases(runtime.session.sessionManager, alias, ["run"]);
		expect(await getReviewGeneral(alias, "run")).toEqual(final);
		await runtime.switchSession(original);
		expect(await getReviewGeneral(runtime.session.sessionManager, "run")).toEqual(final);
		await expect(runtime.newSession(options)).rejects.toThrow("exact current General");
		expect(await getReviewGeneral(source, "run")).toEqual(final);
	});

	it.each(["setup", "ownership", "rebind", "seed"])("does not promote when %s fails", async (phase) => {
		const { runtime, source, options } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		const fail = async () => {
			throw new Error("injected failure");
		};
		let candidate: SessionManager | undefined;
		if (phase === "ownership") runtime.subscribeSessionWillProject(fail);
		if (phase === "rebind") runtime.setRebindSession(fail);
		await expect(
			runtime.newSession({
				...options,
				setup: async (manager) => {
					candidate = manager;
					if (phase === "setup") await fail();
				},
				...(phase === "seed" ? { withSession: fail } : {}),
			}),
		).rejects.toThrow("injected failure");
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
		await expect(getReviewGeneral(candidate!, "run")).rejects.toThrow("exact member");
	});

	it("does not promote cancelled or stale replacements and rejects same-source competitors", async () => {
		const { runtime, source, options } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		vi.spyOn(runtime.session.extensionRunner, "hasHandlers").mockReturnValueOnce(true);
		vi.spyOn(runtime.session.extensionRunner, "emit").mockResolvedValueOnce({ cancel: true });
		expect(await runtime.newSession(options)).toEqual({ cancelled: true, seeded: false });
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
		let stale = false;
		await expect(
			runtime.newSession({
				...options,
				setup: async () => {
					stale = true;
				},
				assertConversationGenerationCurrent: () => {
					if (stale) throw new Error("stale authority");
				},
			}),
		).rejects.toThrow("stale authority");
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
		const results = await Promise.allSettled([runtime.newSession(options), runtime.newSession(options)]);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(await getReviewGeneral(runtime.session.sessionManager, "run")).toMatchObject({ generalRevision: 1 });
	});

	it("rejects a candidate identity changed by a delayed replacement callback before durable publication", async () => {
		const { runtime, source, options } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		runtime.setRebindSession(async () => {
			expect(await getReviewGeneral(source, "run")).toEqual(initial);
			await runtime.session.sessionManager.flush();
			runtime.session.sessionManager.newSession();
		});
		await expect(runtime.newSession(options)).rejects.toThrow("changed before durable publication");
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
	});

	it("authorizes RPC lookup from current and historical same-run children without canonical mutation authority", async () => {
		const { source, root, original, own } = await fixture();
		const lease = await acquireSharedSQLiteSessionStore(original.sessionDirectory);
		try {
			const member = { sessionId: original.sessionId, sessionGeneration: original.sessionGeneration, cwd: root };
			const createdAt = new Date().toISOString();
			const child = (id: string) => ({
				id,
				sessionGeneration: `generation:${id}`,
				formatVersion: 5,
				cwd: root,
				createdAt,
				parentSessionDirectory: null,
				parentStoreId: null,
				parentSessionId: null,
				parentSessionGeneration: null,
				origin: null,
			});
			const discussion = await lease.client.createOrGetReviewDiscussion({
				source: member,
				runId: "run",
				findingId: "finding",
				discussionId: "discussion",
				child: child("child"),
				contextSnapshot: {},
				createdAt,
				requestId: "start",
				kickoffClientMessageId: "kickoff",
			});
			const reset = await lease.client.resetReviewDiscussion({
				source: member,
				discussionId: "discussion",
				expectedChild: discussion.current.child,
				child: child("next"),
				createdAt,
				requestId: "reset",
				kickoffClientMessageId: "next-kickoff",
			});
			await lease.client.registerReviewAnchor({ runId: "foreign", source: member, createdAt });
			for (const identity of [discussion.current.child, reset.child.child]) {
				const runtime = await own(await SessionManager.open({ ...original, ...identity }));
				const context = {
					session: runtime.session,
					runtimeHost: runtime,
					options: {},
					assertConversationGenerationCurrent: () => {},
				} as unknown as RpcCommandDispatcherContext;
				expect(await handleRpcCommand({ type: "get_review_general", runId: "run" }, context)).toMatchObject({
					success: true,
					data: await getReviewGeneral(source, "run"),
				});
				await expect(handleRpcCommand({ type: "get_review_general", runId: "foreign" }, context)).rejects.toThrow(
					"exact member",
				);
				await expect(
					handleRpcCommand(
						{ type: "new_session", preserveReviewRunId: "run", replaceReviewGeneral: true },
						context,
					),
				).rejects.toThrow("source review");
				expect(await resolveCanonicalReviewSource(runtime.session.sessionManager, "run")).toBeUndefined();
			}
		} finally {
			await lease.release();
		}
	});

	it("returns explicit exact-generation unavailability after restart and rejects foreign stores", async () => {
		const { runtime, source, options, directory, root, managers } = await fixture();
		await runtime.newSession(options);
		const final = await getReviewGeneral(runtime.session.sessionManager, "run");
		const target = runtime.session.sessionRef!;
		await runtime.dispose();
		const reader = await SessionManager.open(source.getSessionRef()!);
		managers.push(reader);
		expect(await getReviewGeneral(reader, "run")).toEqual(final);
		await SessionManager.delete(target);
		const reused = await SessionManager.create(root, directory, { id: target.sessionId });
		managers.push(reused);
		expect(await getReviewGeneral(reader, "run")).toEqual({ ...final, generalAvailable: false });
		await expect(getReviewGeneral(reused, "run")).rejects.toThrow("exact member");
		const foreign = await SessionManager.create(root, join(root, "foreign"), { id: reader.getSessionId() });
		managers.push(foreign);
		await expect(getReviewGeneral(foreign, "run")).rejects.toThrow("exact member");
	});

	it("serves the required RPC shape as a read, rejects malformed flags and forwards explicit General replacement", async () => {
		const { runtime, source, original } = await fixture();
		await appendReviewRunDurably(source, {
			schemaVersion: 1,
			runId: "run",
			workflowAction: "review.uncommitted",
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			target: {
				description: "Changes",
				diffCommand: "git diff",
				identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
				files: [],
			},
			options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		});
		const context = () =>
			({
				session: runtime.session,
				runtimeHost: runtime,
				options: {},
				assertConversationGenerationCurrent: () => {},
				createHostActionContext: () => ({ session: runtime.session, newSession: runtime.newSession.bind(runtime) }),
			}) as unknown as RpcCommandDispatcherContext;
		const command = { type: "get_review_general", runId: "run" } as const;
		const response = await handleRpcCommand(command, context());
		expect(Compile(RPC_RESPONSE_SCHEMAS.get_review_general).Errors(response)).toEqual([]);
		expect(response).toMatchObject({
			success: true,
			data: { sourceSessionId: original.sessionId, generalRevision: 0 },
		});
		for (const field of [
			"runId",
			"sourceSessionId",
			"generalSessionId",
			"generalSessionGeneration",
			"generalRevision",
			"generalAvailable",
		]) {
			const data = { ...(response as { data: Record<string, unknown> }).data };
			delete data[field];
			expect(Compile(RPC_RESPONSE_SCHEMAS.get_review_general).Check({ ...response, data })).toBe(false);
		}
		expect(getIrohRemoteRpcCommandCapabilities(command)).toEqual(["conversation.observe.v1"]);
		expect(
			getIrohRemoteRpcFilterResult(JSON.stringify(command), createIrohRemoteRpcGrant(["conversation.observe.v1"])),
		).toMatchObject({ allowed: true });
		expect(validateRpcCommandPayload({ type: "get_review_general", runId: "é".repeat(200) })).toContain("UTF-8");
		for (const invalid of [
			{ type: "new_session", replaceReviewGeneral: true },
			{ type: "new_session", replaceReviewGeneral: "true", preserveReviewRunId: "run" },
		]) {
			expect(Compile(RPC_COMMAND_SCHEMAS.new_session).Check(invalid)).toBe(false);
			expect(validateRpcCommandPayload(invalid)).toBeDefined();
		}
		expect(
			await handleRpcCommand(
				{ type: "new_session", preserveReviewRunId: "run", replaceReviewGeneral: true },
				context(),
			),
		).toMatchObject({ success: true, data: { cancelled: false } });
		expect(await handleRpcCommand(command, context())).toMatchObject({ success: true, data: { generalRevision: 1 } });
		await expect(handleRpcCommand({ type: "get_review_general", runId: "foreign" }, context())).rejects.toThrow(
			"exact member",
		);
	});
});
