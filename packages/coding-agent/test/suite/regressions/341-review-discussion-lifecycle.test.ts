import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import { BUILTIN_HOST_ACTION_REGISTRY, type HostActionInvocationContext } from "../../../src/core/host-actions.ts";
import { registerReviewHandoffAliases } from "../../../src/core/review-anchors.ts";
import { assertReviewDiscussionRpcAllowed } from "../../../src/core/review-discussion-policy.ts";
import { HostReviewDiscussionService, type ReviewDiscussionService } from "../../../src/core/review-discussions.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	getReviewRun,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { RpcReviewDiscussionLinkSchema } from "../../../src/core/rpc/schema/review-discussions.ts";
import { buildRpcSessionState } from "../../../src/core/rpc/session-state.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../../../src/core/session-store/client.ts";
import { handleRpcCommand, type RpcCommandDispatcherContext } from "../../../src/modes/rpc/rpc-command-dispatcher.ts";
import { validateRpcCommandPayload } from "../../../src/modes/rpc/rpc-command-validation.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function record(): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId: "review-341",
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "selected revision",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "Findings",
			overallExplanation: "Evidence",
			findings: [1, 2, 3, 4].map((n) => ({
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
				changeLocation: { path: "src/value.ts", side: "head", startLine: 1, endLine: 2 },
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
	const root = mkdtempSync(join(tmpdir(), "volt-341-lifecycle-"));
	const harness = await createHarness({ settings: { lsp: { enabled: false }, compaction: { enabled: false } } });
	const runtimes: AgentSessionRuntime[] = [];
	const gates: Array<() => void> = [];
	cleanups.push(async () => {
		for (const release of gates) release();
		await Promise.all(runtimes.map((runtime) => runtime.dispose()));
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
			tools: ["read", "write", "bash", "lsp"],
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
	const source = await createAgentSessionRuntime(factory, {
		sessionManager: await SessionManager.create(root, join(root, "sessions")),
		cwd: root,
		agentDir: root,
	});
	runtimes.push(source);
	source.session.setSessionName("Source");
	await appendReviewRunDurably(source.session.sessionManager, record());
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
		createSibling: async (parent, ref, assertCurrent) => {
			const manager = await SessionManager.open(ref);
			const child = await parent.createReviewDiscussionSibling(manager);
			assertCurrent();
			runtimes.push(child);
			child.reviewDiscussions = service.forRuntime(child);
			return child;
		},
	});
	source.reviewDiscussions = service.forRuntime(source);
	return { root, source, service, api: source.reviewDiscussions, harness, runtimes, factory, gates };
}

function holdResponses(harness: Harness, count: number, gates: Array<() => void>) {
	harness.setResponses(
		Array.from({ length: count }, () => async () => {
			await new Promise<void>((resolve) => gates.push(resolve));
			return fauxAssistantMessage("Discussion answer");
		}),
	);
}

function successful(result: Awaited<ReturnType<ReviewDiscussionService["start"]>>) {
	return result.results.map((item) => {
		expect(item.outcome).not.toBe("failed");
		if (!item.discussion) throw new Error("missing discussion");
		return item.discussion;
	});
}

describe("Regression #341 host sibling lifecycle", () => {
	it("projects identity without permission claims and executes RPC bash and current-context plans", async () => {
		const { api, harness, runtimes, root, source } = await fixture();
		await source.session.setAgentMode("plan");
		expect(source.session.getActiveToolNames()).not.toContain("write");
		harness.setResponses([fauxAssistantMessage("Analysis only")]);
		await api.start("review-341", ["f1"], "start");
		const child = runtimes[1]!;
		await child.session.waitForIdle();
		expect(child.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "bash", "lsp"]));
		const link = buildRpcSessionState(child.session).reviewDiscussion!;
		expect(Compile(RpcReviewDiscussionLinkSchema).Errors(link)).toEqual([]);
		expect(link).not.toHaveProperty("readOnly");
		const hostContext: HostActionInvocationContext = {
			session: child.session,
			abortRun: () => child.session.abort(),
			compactContext: (instructions) => child.session.compact(instructions),
			newSession: (options) => child.newSession(options),
			renameSession: (name) => child.session.setSessionName(name),
			executePlan: (id, revision, strategy) => child.executePlan(id, revision, strategy),
			changePlan: (id, revision) => child.session.changePlan(id, revision),
			discardPlan: (id, revision) => child.session.discardPlan(id, revision),
		};
		const context = {
			session: child.session,
			runtimeHost: child,
			options: { allowUiActionInvocation: true },
			assertConversationGenerationCurrent: () => {},
			createHostActionContext: () => hostContext,
		} as RpcCommandDispatcherContext;
		expect(await handleRpcCommand({ type: "bash", command: "printf rpc-fixed > rpc.txt" }, context)).toMatchObject({
			success: true,
			data: { exitCode: 0 },
		});
		expect(readFileSync(join(root, "rpc.txt"), "utf8")).toBe("rpc-fixed");
		await child.session.setAgentMode("plan");
		let plan = child.session.updatePlan({ steps: [{ text: "Apply fix" }] });
		plan = child.session.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
			title: "Fix",
			summary: "Fix the selected finding",
		});
		expect(BUILTIN_HOST_ACTION_REGISTRY.getDescriptor("plan.execute", hostContext)?.enabled).toBe(true);
		await expect(
			BUILTIN_HOST_ACTION_REGISTRY.invoke("plan.execute", hostContext, {
				planId: plan.id,
				expectedRevision: plan.revision,
				strategy: "new_session",
			}),
		).rejects.toThrow("source review");
		expect(
			await handleRpcCommand({ type: "plan_change", planId: plan.id, expectedRevision: plan.revision }, context),
		).toMatchObject({ success: true, data: { plan: { phase: "draft" } } });
		plan = child.session.planningState.plan!;
		plan = child.session.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
			title: "Fix",
			summary: "Fix the selected finding",
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: join(root, "plan-fix.txt"), content: "fixed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fix applied"),
		]);
		const command = {
			type: "plan_execute",
			planId: plan.id,
			expectedRevision: plan.revision,
			strategy: "retain_context",
		} as const;
		expect(
			await handleRpcCommand(
				{
					id: "execute",
					type: "invoke_ui_action",
					action: "plan.execute",
					args: { planId: plan.id, expectedRevision: plan.revision, strategy: "retain_context" },
				},
				context,
			),
		).toMatchObject({ success: true, data: { status: "completed", stateChanged: true } });
		await child.session.waitForIdle();
		expect(readFileSync(join(root, "plan-fix.txt"), "utf8")).toBe("fixed");
		expect(await handleRpcCommand(command, context)).toMatchObject({
			success: true,
			data: { started: false, selectedSessionId: link.sessionId },
		});
		plan = child.session.planningState.plan!;
		expect(
			await handleRpcCommand({ type: "plan_discard", planId: plan.id, expectedRevision: plan.revision }, context),
		).toMatchObject({ success: true, data: { plan: null } });
		expect(child.session.sessionId).toBe(link.sessionId);
	});
	it("dispatches co-client create/list and returns explicit unavailable without a sibling service", async () => {
		const { source, harness, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const context = {
			session: source.session,
			runtimeHost: source,
			options: {},
			assertConversationGenerationCurrent: () => {},
		} as RpcCommandDispatcherContext;
		const first = await handleRpcCommand(
			{ id: "one", type: "start_review_discussions", runId: "review-341", findingIds: ["f1"], requestId: "stable" },
			context,
		);
		expect(first).toMatchObject({ id: "one", success: true, data: { results: [{ outcome: "created" }] } });
		await runtimes[1]!.session.waitForIdle();
		const second = await handleRpcCommand(
			{ id: "two", type: "start_review_discussions", runId: "review-341", findingIds: ["f1"], requestId: "stable" },
			{ ...context },
		);
		expect(second).toMatchObject({ id: "two", success: true, data: { results: [{ outcome: "existing" }] } });
		expect(await handleRpcCommand({ type: "list_review_discussions", runId: "review-341" }, context)).toMatchObject({
			success: true,
			data: { discussions: [{ status: "completed" }] },
		});
		source.reviewDiscussions = undefined;
		expect(await handleRpcCommand({ type: "list_review_discussions", runId: "review-341" }, context)).toMatchObject({
			success: false,
			errorCode: "review_discussions_unavailable",
		});
	});
	it("starts four overlapping turns, co-client deduplicates and lists, and keeps one-child cancellation isolated", async () => {
		const { api, harness, runtimes, source, service, gates, root } = await fixture();
		holdResponses(harness, 4, gates);
		const first = successful(await api.start("review-341", ["f1", "f2", "f3", "f4"], "request"));
		await vi.waitFor(() => expect(gates).toHaveLength(4));
		expect(new Set(first.map((row) => row.discussionId)).size).toBe(4);
		expect(runtimes).toHaveLength(5);
		expect(
			runtimes
				.slice(1)
				.every((runtime) => runtime.session.isBusy && runtime.cwd === root && runtime.session.isReviewDiscussion),
		).toBe(true);
		const second = service.forRuntime(source);
		expect(
			(await second.start("review-341", ["f1", "f2", "f3", "f4"], "retry")).results.every(
				(row) => row.outcome === "existing",
			),
		).toBe(true);
		expect((await second.list("review-341")).discussions).toHaveLength(4);
		expect(gates).toHaveLength(4);
		const child = runtimes[1]!;
		expect(buildRpcSessionState(child.session).reviewDiscussion).toMatchObject({
			sourceSessionId: source.session.sessionId,
		});
		expect((await child.reviewDiscussions!.source())?.sourceSessionId).toBe(source.session.sessionId);
		const abort = child.session.abort();
		for (const release of gates) release();
		await abort;
		await Promise.all(runtimes.slice(1).map((runtime) => runtime.session.waitForIdle()));
		expect(
			runtimes
				.slice(2)
				.every((runtime) =>
					runtime.session.messages.some(
						(message) => message.role === "assistant" && message.stopReason !== "aborted",
					),
				),
		).toBe(true);
		expect(
			getReviewRun(source.session.sessionManager, "review-341")?.result?.findings.every(
				(finding) => finding.status === "open",
			),
		).toBe(true);
		for (const runtime of runtimes.slice(1))
			expect(runtime.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("contains partial failures, retries only definitively unsubmitted launches, and never repeats completed kickoff", async () => {
		const { api, harness, source, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("retry")]);
		const create = vi.spyOn(source, "createReviewDiscussionSibling");
		create.mockImplementationOnce(async (manager) => {
			await manager.closePersistence();
			throw new Error("injected");
		});
		const result = await api.start("review-341", ["f1", "f2", "unknown"], "partial");
		expect(result.results.map((row) => row.outcome)).toEqual(["failed", "created", "failed"]);
		expect(result.results[2]).toMatchObject({ errorCode: "unknown_finding" });
		await runtimes[1]!.session.waitForIdle();
		const retry = successful(await api.start("review-341", ["f1", "f2"], "retry"));
		expect(retry.map((row) => row.discussionId)).toEqual(
			result.results.slice(0, 2).map((row) => row.discussion!.discussionId),
		);
		await Promise.all(runtimes.map((runtime) => runtime.session.waitForIdle()));
		await api.start("review-341", ["f1", "f2"], "lost-response");
		expect(runtimes).toHaveLength(3);
		for (const runtime of runtimes.slice(1))
			expect(runtime.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("idle reset uses expected-child CAS and request history without automatically spending", async () => {
		const { api, harness, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const [first] = successful(await api.start("review-341", ["f1"], "start"));
		await runtimes[1]!.session.waitForIdle();
		const [a, b] = await Promise.all([
			api.reset(first!.discussionId, first!.sessionId, "a"),
			api.reset(first!.discussionId, first!.sessionId, "b"),
		]);
		expect([a.status, b.status].sort()).toEqual(["conflict", "reset"]);
		expect(a.discussion.discussionId).toBe(first!.discussionId);
		expect(a.discussion.currentSessionId).not.toBe(first!.sessionId);
		expect(a.discussion.status).toBe("idle");
		expect(await api.reset(first!.discussionId, first!.sessionId, "a")).toEqual(a);
		expect(runtimes).toHaveLength(3);
		expect(runtimes[2]!.session.isBusy).toBe(false);
		await expect(runtimes[1]!.newSession()).rejects.toThrow("source-linked");
		await expect(runtimes[1]!.importFromJsonl("missing")).rejects.toThrow("source-linked");
	});

	it("source handoff aliases converge and copied/forked metadata cannot grant authority", async () => {
		const { api, harness, source, service, runtimes, factory, root } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const first = successful(await api.start("review-341", ["f1"], "start"))[0]!;
		await runtimes[1]!.session.waitForIdle();
		const target = await SessionManager.create(root, join(root, "sessions"));
		appendReviewRun(target, record());
		await target.materialize();
		const alias = await createAgentSessionRuntime(factory, { sessionManager: target, cwd: root, agentDir: root });
		runtimes.push(alias);
		await expect(service.forRuntime(alias).list("review-341")).rejects.toThrow("not owned");
		await registerReviewHandoffAliases(source.session.sessionManager, target, ["review-341"]);
		expect(successful(await service.forRuntime(alias).start("review-341", ["f1"], "alias"))[0]!.discussionId).toBe(
			first.discussionId,
		);
		await service.forRuntime(alias).recordOutcome({ runId: "review-341", findingId: "f1", status: "fixed" });
		expect(getReviewRun(source.session.sessionManager, "review-341")?.result?.findings[0]?.status).toBe("fixed");
		expect(getReviewRun(alias.session.sessionManager, "review-341")?.result?.findings[0]?.status).toBe("open");
	});

	it("survives an actual source rebind and a child runtime reconnect without another initial turn", async () => {
		const { api, harness, source, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const sourceId = source.session.sessionId;
		const [first] = successful(await api.start("review-341", ["f1"], "first"));
		await runtimes[1]!.session.waitForIdle();
		await runtimes[1]!.dispose();
		runtimes.splice(1, 1);
		await source.newSession({
			setup: async (manager) => {
				appendReviewRun(manager, record());
			},
		});
		expect(source.session.sessionId).not.toBe(sourceId);
		const [existing] = successful(await api.start("review-341", ["f1"], "after-rebind"));
		expect(existing).toMatchObject({
			discussionId: first!.discussionId,
			sourceSessionId: sourceId,
			currentSessionId: first!.currentSessionId,
		});
		expect(runtimes).toHaveLength(1);
	});

	it("fails closed on deleted children and stale source generations", async () => {
		const { api, harness, source, runtimes, root } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const [first] = successful(await api.start("review-341", ["f1"], "first"));
		await runtimes[1]!.session.waitForIdle();
		const childRef = runtimes[1]!.session.sessionRef!;
		await runtimes[1]!.dispose();
		runtimes.splice(1, 1);
		await SessionManager.delete(childRef);
		expect((await api.list("review-341")).discussions[0]).toMatchObject({ available: false, status: "unavailable" });
		const store = await SQLiteSessionStoreClient.open(join(root, "sessions"));
		try {
			const sourceRef = source.session.sessionRef!;
			expect(
				await store.resolveReviewAnchor("review-341", {
					sessionId: sourceRef.sessionId,
					sessionGeneration: "stale",
					cwd: root,
				}),
			).toBeNull();
			expect(
				await store.resolveReviewAnchor("review-341", {
					sessionId: sourceRef.sessionId,
					sessionGeneration: sourceRef.sessionGeneration,
					cwd: join(root, "other"),
				}),
			).toBeNull();
		} finally {
			await store.close();
		}
		const reset = await api.reset(first!.discussionId, first!.sessionId, "reset-deleted");
		expect(reset).toMatchObject({ status: "reset", discussion: { available: true, status: "idle" } });
	});

	it("limits source-owned RPC lifecycle only, bounds requests and preserves general conversations", async () => {
		const { api, harness, runtimes, source } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await api.start("review-341", ["f1"], "start");
		const child = runtimes[1]!.session;
		for (const command of [
			{ type: "new_session" },
			{ type: "record_review_finding_outcome", runId: "review-341", findingId: "f1", status: "fixed" },
			{ type: "plan_execute", planId: "p", expectedRevision: 1, strategy: "new_session" },
			{ type: "invoke_ui_action", id: "action", action: "review.fix" },
		] as const) {
			expect(() => assertReviewDiscussionRpcAllowed(child, command)).toThrow("requires the source review");
			expect(() => assertReviewDiscussionRpcAllowed(source.session, command)).not.toThrow();
		}
		for (const command of [
			{ type: "subagent_start", agent: "general", prompt: "fix" },
			{ type: "subagent_abort", subagentId: "sa_1" },
			{ type: "get_mcp_prompt", server: "x", prompt: "x" },
			{ type: "connect_mcp_server", server: "x" },
			{ type: "bash", command: "echo allowed" },
			{ type: "plan_execute", planId: "p", expectedRevision: 1, strategy: "retain_context" },
			{ type: "invoke_ui_action", id: "action", action: "custom.fix" },
		] as const)
			expect(() => assertReviewDiscussionRpcAllowed(child, command)).not.toThrow();
		expect(
			validateRpcCommandPayload({
				type: "start_review_discussions",
				runId: "review-341",
				findingIds: Array.from({ length: 51 }, (_, n) => String(n)),
				requestId: "request",
			}),
		).toBeDefined();
		expect(
			validateRpcCommandPayload({
				type: "start_review_discussions",
				runId: "review-341",
				findingIds: ["f1"],
				requestId: "request",
			}),
		).toBeUndefined();
	});
});
