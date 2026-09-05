import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import type { CodeHostProvider, ReviewCodeHostPublishRequest } from "../../../src/core/code-host/index.ts";
import { registerReviewHandoffAliases, resolveCanonicalReviewSource } from "../../../src/core/review-anchors.ts";
import { HostReviewDiscussionService } from "../../../src/core/review-discussions.ts";
import { publishReviewRun } from "../../../src/core/review-publish.ts";
import type { ReviewSnapshot } from "../../../src/core/review-snapshot.ts";
import {
	acknowledgeReviewRun,
	appendReviewRun,
	appendReviewRunDurably,
	exportCanonicalReviewFeedback,
	exportReviewFeedback,
	getCanonicalReviewRun,
	getReviewRun,
	listCanonicalReviewRuns,
	planCanonicalIncrementalReview,
	type ReviewRunRecord,
	recordReviewFindingOutcome,
} from "../../../src/core/review-state.ts";
import { RPC_RESPONSE_SCHEMAS, RpcErrorResponseSchema } from "../../../src/core/rpc/schema/responses.ts";
import type { RpcCloseHandler, RpcLineHandler } from "../../../src/core/rpc/transport.ts";
import { RPC_STABLE_ERROR_CODES } from "../../../src/core/rpc/wire-limits.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	createRpcErrorResponse,
	handleRpcCommand,
	type RpcCommandDispatcherContext,
} from "../../../src/modes/rpc/rpc-command-dispatcher.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function review(runId = "review:341", endedAt = 2): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.pr",
		status: "completed",
		startedAt: 1,
		endedAt,
		target: {
			description: "PR #341",
			diffCommand: "git diff base..head",
			identity: {
				kind: "pr",
				baseTree: "base",
				headTree: "head",
				pullRequest: {
					providerId: "test",
					number: 341,
					title: "Review",
					body: "",
					url: "https://example.test/pr/341",
					baseRefName: "main",
					headRefName: "topic",
					baseRefOid: "a".repeat(40),
					headRefOid: "b".repeat(40),
				},
			},
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
		result: {
			completionStatus: "complete",
			summary: "Verified findings",
			overallExplanation: "Evidence",
			findings: [1, 2, 3].map((n) => ({
				id: `f${n}`,
				fingerprint: `fingerprint-${n}`,
				status: "open",
				title: `Finding ${n}`,
				body: "Immutable evidence",
				trigger: "Input",
				impact: "Wrong result",
				category: "correctness",
				rootCauseKey: `cause-${n}`,
				priority: 2,
				confidence: 0.9,
				changeLocation: { path: "value.ts", side: "head", startLine: 1, endLine: 1 },
				evidenceLocations: [],
				verification: { outcome: "accepted", method: "inspection", rationale: "Evidence", confidence: 0.9 },
			})),
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
		},
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-341-outcomes-"));
	const directory = join(root, "sessions");
	const harness = await createHarness({ settings: { lsp: { enabled: false }, compaction: { enabled: false } } });
	const runtimes: AgentSessionRuntime[] = [];
	const managers: SessionManager[] = [];
	cleanups.push(async () => {
		for (const runtime of runtimes) await runtime.dispose();
		for (const manager of managers) await manager.closePersistence();
		await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, cwd, agentDir }) => {
		const created = await createAgentSession({
			sessionManager,
			cwd,
			agentDir,
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			tools: [],
			disableMcp: true,
		});
		return {
			...created,
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				gitContextProvider: created.session.gitContextProvider,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const service = new HostReviewDiscussionService({
		findRuntime: (ref) =>
			runtimes.find((runtime) => {
				const current = runtime.session.sessionRef;
				return (
					current?.storeId === ref.storeId &&
					current.sessionId === ref.sessionId &&
					current.sessionGeneration === ref.sessionGeneration
				);
			}),
		assertCurrent: (runtime) => {
			if (!runtimes.includes(runtime)) throw new Error("retired");
		},
		// These isolated stores have no competing runtime. Broker exclusion is
		// exercised separately by 341-review-sibling-admission.test.ts.
		withSourceWrite: (_requester, _source, write) => write(),
		createSibling: async () => {
			throw new Error("This test never launches a provider turn");
		},
	});
	async function own(manager: SessionManager) {
		const runtime = await createAgentSessionRuntime(factory, { sessionManager: manager, cwd: root, agentDir: root });
		runtimes.push(runtime);
		runtime.reviewDiscussions = service.forRuntime(runtime);
		return runtime;
	}
	const source = await own(await SessionManager.create(root, directory));
	await appendReviewRunDurably(source.session.sessionManager, review());
	const aliases: AgentSessionRuntime[] = [];
	for (let index = 0; index < 2; index++) {
		const manager = await SessionManager.create(root, directory);
		appendReviewRun(manager, review());
		await manager.materialize();
		await registerReviewHandoffAliases(source.session.sessionManager, manager, ["review:341"]);
		aliases.push(await own(manager));
	}
	async function dispatch(runtime: AgentSessionRuntime, command: RpcCommand): Promise<RpcResponse | undefined> {
		try {
			return await handleRpcCommand(command, {
				session: runtime.session,
				runtimeHost: runtime,
				options: {},
				assertConversationGenerationCurrent: () => {},
			} as RpcCommandDispatcherContext);
		} catch (error) {
			return createRpcErrorResponse(
				command.id,
				command.type,
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
	}
	return { root, directory, source, aliases, runtimes, managers, own, dispatch, harness };
}

function expectErrorEnvelope(response: unknown, errorCode: string) {
	expect(response).toMatchObject({ type: "response", success: false, errorCode });
	expect(Compile(RpcErrorResponseSchema).Errors(response)).toEqual([]);
}

describe("Regression #341 canonical finding hydration and outcomes", () => {
	it("converges source and persisted aliases after every manual outcome, including reopened readers", async () => {
		const { source, aliases, managers, dispatch } = await fixture();
		const sourceManager = source.session.sessionManager;
		const staleSource = await SessionManager.open(sourceManager.getSessionRef()!);
		managers.push(staleSource);
		acknowledgeReviewRun(aliases[0]!.session.sessionManager, "review:341", 123);
		for (const [index, status] of (["accepted", "fixed", "dismissed"] as const).entries()) {
			const writer = [aliases[0]!, source, aliases[1]!][index]!;
			const response = await dispatch(writer, {
				type: "record_review_finding_outcome",
				runId: "review:341",
				findingId: "f1",
				status,
				...(status === "dismissed" ? { reason: "false_positive" as const, note: "Manually verified" } : {}),
			});
			expect(response).toMatchObject({ success: true, data: { status } });
			expect(Compile(RPC_RESPONSE_SCHEMAS.record_review_finding_outcome).Errors(response)).toEqual([]);
			const expected = (await getCanonicalReviewRun(sourceManager, "review:341"))!.result!.findings;
			for (const runtime of [source, ...aliases]) {
				expect(await dispatch(runtime, { type: "get_review_result", runId: "review:341" })).toMatchObject({
					success: true,
					data: { findings: expected },
				});
				expect((await listCanonicalReviewRuns(runtime.session.sessionManager)).runs[0]!.result!.findings).toEqual(
					expected,
				);
			}
			expect((await getCanonicalReviewRun(staleSource, "review:341"))!.result!.findings).toEqual(expected);
		}
		expect((await getCanonicalReviewRun(aliases[0]!.session.sessionManager, "review:341"))!.acknowledgedAt).toBe(123);
		for (const alias of aliases) {
			expect(exportReviewFeedback(alias.session.sessionManager).outcomes).toEqual([]);
			expect((await exportCanonicalReviewFeedback(alias.session.sessionManager)).outcomes).toEqual(
				exportReviewFeedback(sourceManager).outcomes,
			);
		}
		const reopened = await SessionManager.open(aliases[0]!.session.sessionRef!);
		managers.push(reopened);
		expect((await getCanonicalReviewRun(reopened, "review:341"))!.result!.findings[0]!.status).toBe("dismissed");
	});

	it("hydrates canonical writes when the source runtime is no longer active", async () => {
		const { source, aliases, runtimes, dispatch } = await fixture();
		const sourceManager = source.session.sessionManager;
		await source.dispose();
		runtimes.splice(runtimes.indexOf(source), 1);
		expect(
			await dispatch(aliases[0]!, {
				type: "record_review_finding_outcome",
				runId: "review:341",
				findingId: "f1",
				status: "fixed",
			}),
		).toMatchObject({ success: true });
		for (const manager of [sourceManager, ...aliases.map((alias) => alias.session.sessionManager)]) {
			expect((await getCanonicalReviewRun(manager, "review:341"))!.result!.findings[0]!.status).toBe("fixed");
		}
	});

	it("uses canonical outcomes for incremental review and publishing, preserving local pagination", async () => {
		const { source, aliases, dispatch } = await fixture();
		const alias = aliases[0]!.session.sessionManager;
		appendReviewRun(alias, review("review:local", 1));
		await alias.flush();
		for (const [findingId, status] of [
			["f1", "fixed"],
			["f2", "dismissed"],
			["f3", "accepted"],
		] as const) {
			expect(
				await dispatch(source, {
					type: "record_review_finding_outcome",
					runId: "review:341",
					findingId,
					status,
					...(status === "dismissed" ? { reason: "intentional" as const } : {}),
				}),
			).toMatchObject({ success: true });
		}
		const first = await listCanonicalReviewRuns(alias, { limit: 1 });
		expect(first.runs[0]!.result!.findings.map((finding) => finding.status)).toEqual([
			"fixed",
			"dismissed",
			"accepted",
		]);
		expect((await listCanonicalReviewRuns(alias, { cursor: first.nextCursor, limit: 1 })).runs[0]!.runId).toBe(
			"review:local",
		);
		const snapshot: ReviewSnapshot = {
			...review().target,
			root: "/unused",
			changedFiles: [],
			readFile: async () => undefined,
			listFiles: async () => [],
			search: async () => ({
				matches: [],
				filesScanned: 0,
				skippedPaths: [],
				nextFileIndex: 0,
				nextLineIndex: 0,
				complete: true,
			}),
			materializeHead: async () => "/unused",
			dispose: async () => {},
		};
		for (const options of [{}, { parentRunId: "review:341" }]) {
			expect(await planCanonicalIncrementalReview(alias, snapshot, review().options, options)).toMatchObject({
				mode: "incremental",
				priorOpenFindings: [{ id: "f3", status: "accepted" }],
				suppressedDismissedFingerprints: ["fingerprint-2"],
			});
		}
		let request: ReviewCodeHostPublishRequest | undefined;
		const provider: CodeHostProvider = {
			id: "test",
			displayName: "Test",
			probeCurrentPullRequest: async () => undefined,
			capturePullRequestContext: async () => ({ ok: false, error: "unused" }),
			getPullRequestFetchPlan: () => {
				throw new Error("unused");
			},
			verifyPullRequestHead: async () => {},
			publishPullRequestReview: async (value) => {
				request = value;
				return {};
			},
		};
		const published = await publishReviewRun(
			alias.getCwd(),
			(await getCanonicalReviewRun(alias, "review:341"))!,
			provider,
		);
		expect(published.summaryOnlyFindingIds).toEqual(["f3"]);
		expect(request!.body).toContain("Volt finding: f3");
		expect(request!.body).not.toContain("Volt finding: f1");
		expect(request!.body).not.toContain("Volt finding: f2");
	});

	it("keeps ephemeral, unregistered, forked and imported reviews local even with a discussion backend", async () => {
		const { root, directory, source, managers, own, dispatch } = await fixture();
		const ref = source.session.sessionRef!;
		const exported = join(root, "source.jsonl");
		await SessionManager.exportJsonlSnapshot(ref, exported);
		const local = await SessionManager.create(root, directory);
		appendReviewRun(local, review());
		const ephemeral = SessionManager.inMemory(root);
		appendReviewRun(ephemeral, review());
		const fork = await SessionManager.forkFrom(ref, root, directory);
		const imported = await SessionManager.importFromJsonl(exported, root, directory, { id: randomUUID() });
		const otherStore = await SessionManager.forkFrom(ref, root, join(root, "other-store"));
		for (const manager of [ephemeral, local, fork, imported, otherStore]) {
			const runtime = await own(manager);
			const writeCanonical = vi.spyOn(runtime.reviewDiscussions!, "recordOutcome");
			expect(await resolveCanonicalReviewSource(manager, "review:341")).toBeUndefined();
			expect(
				await dispatch(runtime, {
					type: "record_review_finding_outcome",
					runId: "review:341",
					findingId: "f1",
					status: "fixed",
				}),
			).toMatchObject({ success: true });
			expect(writeCanonical).not.toHaveBeenCalled();
			expect((await getCanonicalReviewRun(manager, "review:341"))!.result!.findings[0]!.status).toBe("fixed");
		}
		expect(
			(await getCanonicalReviewRun(source.session.sessionManager, "review:341"))!.result!.findings[0]!.status,
		).toBe("open");
		const copied = await SessionManager.create(root, directory);
		managers.push(copied);
		appendReviewRun(copied, review());
		await copied.materialize();
		await registerReviewHandoffAliases(imported, copied, ["review:341"]);
		expect(await resolveCanonicalReviewSource(copied, "review:341")).toBeUndefined();
	});

	it("preserves unanchored feedback ordering and rejects a canonical alias opened in another cwd", async () => {
		const { root, directory, aliases, managers } = await fixture();
		const local = await SessionManager.create(root, directory);
		managers.push(local);
		appendReviewRun(local, review());
		appendReviewRun(local, review("review:other", 3));
		await recordReviewFindingOutcome(local, { runId: "review:341", findingId: "f1", status: "accepted" });
		await recordReviewFindingOutcome(local, { runId: "review:other", findingId: "f2", status: "fixed" });
		await recordReviewFindingOutcome(local, { runId: "review:341", findingId: "f1", status: "fixed" });
		expect((await exportCanonicalReviewFeedback(local)).outcomes).toEqual(exportReviewFeedback(local).outcomes);
		const moved = await SessionManager.open(aliases[0]!.session.sessionRef!, join(root, "other-cwd"));
		managers.push(moved);
		await expect(getCanonicalReviewRun(moved, "review:341")).rejects.toMatchObject({
			code: "review_source_unavailable",
		});
		await expect(
			recordReviewFindingOutcome(moved, { runId: "review:341", findingId: "f1", status: "fixed" }),
		).rejects.toMatchObject({ code: "review_source_unavailable" });
	});

	it("fails explicitly when the canonical run is no longer on the source branch", async () => {
		const { source, aliases, dispatch } = await fixture();
		source.session.sessionManager.resetLeaf();
		await source.session.sessionManager.flush();
		const alias = aliases[0]!;
		for (const command of [
			{ type: "get_review_result", runId: "review:341" },
			{ type: "list_review_workflows" },
			{ type: "export_review_feedback" },
			{ type: "record_review_finding_outcome", runId: "review:341", findingId: "f1", status: "fixed" },
		] as const)
			expectErrorEnvelope(await dispatch(alias, command), "review_source_unavailable");
		expect(getReviewRun(alias.session.sessionManager, "review:341")!.result!.findings[0]!.status).toBe("open");
	});

	it("does not fall back to aliases after source deletion or same-id recreation", async () => {
		const { root, directory, source, aliases, runtimes, managers, dispatch } = await fixture();
		const ref = source.session.sessionRef!;
		await source.dispose();
		runtimes.splice(runtimes.indexOf(source), 1);
		expect(await SessionManager.delete(ref)).toBe(true);
		const replacement = await SessionManager.create(root, directory, { id: ref.sessionId });
		managers.push(replacement);
		appendReviewRun(replacement, review());
		await replacement.materialize();
		expect(replacement.getSessionRef()!.sessionGeneration).not.toBe(ref.sessionGeneration);
		for (const alias of aliases) {
			expectErrorEnvelope(
				await dispatch(alias, { type: "get_review_result", runId: "review:341" }),
				"review_source_unavailable",
			);
			expectErrorEnvelope(await dispatch(alias, { type: "list_review_workflows" }), "review_source_unavailable");
			expectErrorEnvelope(
				await dispatch(alias, {
					type: "record_review_finding_outcome",
					runId: "review:341",
					findingId: "f1",
					status: "fixed",
				}),
				"review_source_unavailable",
			);
		}
	});

	it("requires a canonical writer on aliases but permits direct source outcomes without the sibling backend", async () => {
		const { source, aliases, dispatch } = await fixture();
		source.reviewDiscussions = undefined;
		aliases[0]!.reviewDiscussions = undefined;
		expect(
			await dispatch(source, {
				type: "record_review_finding_outcome",
				runId: "review:341",
				findingId: "f1",
				status: "fixed",
			}),
		).toMatchObject({ success: true });
		expectErrorEnvelope(
			await dispatch(aliases[0]!, {
				type: "record_review_finding_outcome",
				runId: "review:341",
				findingId: "f1",
				status: "accepted",
			}),
			"review_source_unavailable",
		);
		expect(exportReviewFeedback(aliases[0]!.session.sessionManager).outcomes).toEqual([]);
		expect(
			(await getCanonicalReviewRun(aliases[0]!.session.sessionManager, "review:341"))!.result!.findings[0]!.status,
		).toBe("fixed");
	});

	it("rejects a conversation replacement during outcome lookup rather than writing into the replacement", async () => {
		const { aliases } = await fixture();
		const manager = aliases[0]!.session.sessionManager;
		const original = SessionManager.open;
		vi.spyOn(SessionManager, "open").mockImplementationOnce(async (ref) => {
			const opened = await original(ref);
			manager.newSession();
			appendReviewRun(manager, review());
			await manager.flush();
			return opened;
		});
		await expect(
			recordReviewFindingOutcome(manager, { runId: "review:341", findingId: "f1", status: "fixed" }),
		).rejects.toMatchObject({ code: "review_source_unavailable" });
		expect(exportReviewFeedback(manager).outcomes).toEqual([]);
	});

	it("routes the existing RPC review.feedback host action through canonical state", async () => {
		const { aliases, source } = await fixture();
		let line!: RpcLineHandler;
		let close: RpcCloseHandler | undefined;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const writes: object[] = [];
		const mode = runRpcMode(aliases[0]!, {
			exitProcess: false,
			disposeRuntimeOnClose: false,
			onReady: ready,
			transport: {
				write: (value) => {
					writes.push(value);
				},
				onLine: (handler) => {
					line = handler;
					return () => {};
				},
				onClose: (handler) => {
					close = handler;
					return () => {};
				},
				close: () => {},
			},
		});
		await started;
		try {
			await line(
				JSON.stringify({
					id: "feedback",
					type: "invoke_ui_action",
					action: "review.feedback",
					args: { runId: "review:341", findingId: "f2", status: "dismissed", reason: "intentional" },
				}),
			);
			await vi.waitFor(() =>
				expect(writes).toContainEqual(expect.objectContaining({ id: "feedback", success: true })),
			);
			expect(
				(await getCanonicalReviewRun(source.session.sessionManager, "review:341"))!.result!.findings[1]!.status,
			).toBe("dismissed");
			expect(exportReviewFeedback(aliases[0]!.session.sessionManager).outcomes).toEqual([]);
		} finally {
			close?.();
			await mode;
		}
	});

	it("registers emitted review errors and validates both correlated and uncorrelated envelopes", async () => {
		const { source, dispatch } = await fixture();
		for (const code of ["review_discussions_unavailable", "review_source_unavailable"] as const) {
			expect(RPC_STABLE_ERROR_CODES).toContain(code);
			for (const id of [undefined, "request"])
				expectErrorEnvelope(createRpcErrorResponse(id, "get_review_result", "Unavailable", { code }), code);
			expectErrorEnvelope(createRpcErrorResponse("request", "invoke_ui_action", "Unavailable", { code }), code);
		}
		expectErrorEnvelope(
			await dispatch(source, { id: "missing", type: "list_review_discussions", runId: "unknown" }),
			"review_source_unavailable",
		);
		vi.spyOn(source.reviewDiscussions!, "recordOutcome").mockRejectedValueOnce(new Error("source retired"));
		expectErrorEnvelope(
			await dispatch(source, {
				type: "record_review_finding_outcome",
				runId: "review:341",
				findingId: "f1",
				status: "fixed",
			}),
			"review_source_unavailable",
		);
		source.reviewDiscussions = undefined;
		expectErrorEnvelope(
			await dispatch(source, { type: "get_review_discussion_source" }),
			"review_discussions_unavailable",
		);
	});
});
