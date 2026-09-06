import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	digestSessionStoreTransactionPayload,
	SESSION_STORE_REVIEW_CONTEXT_MAX_BYTES,
	type SessionStoreCreateReviewDiscussionInput,
	type SessionStoreCreateSessionInput,
	type SessionStoreResetReviewDiscussionInput,
	type SessionStoreTransactionPayload,
	SQLiteSessionStoreClient,
} from "../src/core/session-store/index.ts";
import {
	parseSessionStoreOperationResult,
	parseSessionStoreWorkerOperation,
} from "../src/core/session-store/protocol.ts";

const NOW = "2026-09-05T12:00:00.000Z";
const roots: string[] = [];
const clients: SQLiteSessionStoreClient[] = [];

function child(id: string, cwd: string): SessionStoreCreateSessionInput {
	return {
		id,
		sessionGeneration: `generation:${id}`,
		formatVersion: 5,
		cwd,
		createdAt: NOW,
		parentSessionDirectory: null,
		parentStoreId: null,
		parentSessionId: null,
		parentSessionGeneration: null,
		origin: null,
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-discussion-store-"));
	roots.push(root);
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const directory = join(root, "sessions");
	const first = await SQLiteSessionStoreClient.open(directory);
	clients.push(first);
	const second = await SQLiteSessionStoreClient.open(directory);
	clients.push(second);
	await first.createHiddenSession(child("source", cwd));
	const source = { sessionId: "source", sessionGeneration: "generation:source", cwd };
	const anchor = { runId: "run", source, createdAt: NOW };
	await first.registerReviewAnchor(anchor);
	const input: SessionStoreCreateReviewDiscussionInput = {
		source,
		runId: "run",
		findingId: "finding",
		discussionId: "discussion",
		child: child("child", cwd),
		contextSnapshot: { finding: { title: "Canonical finding", body: "Details" }, review: { runId: "run" } },
		createdAt: NOW,
		requestId: "create",
		kickoffClientMessageId: "kickoff",
	};
	return { first, second, source, anchor, input, root, cwd };
}

function reset(input: SessionStoreCreateReviewDiscussionInput, id = "next"): SessionStoreResetReviewDiscussionInput {
	return {
		source: input.source,
		discussionId: input.discussionId,
		expectedChild: { sessionId: input.child.id, sessionGeneration: input.child.sessionGeneration },
		child: child(id, input.source.cwd),
		createdAt: NOW,
		requestId: `reset:${id}`,
		kickoffClientMessageId: `kickoff:${id}`,
	};
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Regression #341 durable review discussions", () => {
	it("initializes General, never promotes ordinary aliases, CAS replaces repeatedly and survives reopen", async () => {
		const { first, second, source, cwd, anchor: registration } = await fixture();
		const initial = await first.findReviewAnchor("run");
		expect(initial).toMatchObject({
			general: { sessionId: source.sessionId, sessionGeneration: source.sessionGeneration },
			generalRevision: 0,
			generalAvailable: true,
		});
		for (const id of ["a", "b", "c"]) await first.createHiddenSession(child(id, cwd));
		const a = { sessionId: "a", sessionGeneration: "generation:a", cwd };
		const b = { sessionId: "b", sessionGeneration: "generation:b", cwd };
		const c = { sessionId: "c", sessionGeneration: "generation:c", cwd };
		await first.registerReviewAlias("run", source, a);
		expect(await first.resolveReviewGeneral("run", a)).toEqual(initial);
		const requests = [a, b].map((replacement) => ({
			runId: "run",
			member: source,
			expectedRevision: 0,
			replacement,
		}));
		const results = await Promise.allSettled([
			first.replaceReviewGeneral(requests[0]!),
			second.replaceReviewGeneral(requests[1]!),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const winner = (await first.findReviewAnchor("run"))!;
		expect(winner.generalRevision).toBe(1);
		expect(winner.source).toEqual(initial!.source);
		await expect(
			first.replaceReviewGeneral({ ...requests[0]!, expectedRevision: 1, replacement: c }),
		).rejects.toMatchObject({ code: "review_identity_conflict" });
		await first.replaceReviewGeneral({
			runId: "run",
			member: { ...winner.general, cwd },
			expectedRevision: 1,
			replacement: c,
		});
		const final = await first.resolveReviewGeneral("run", source);
		expect(final).toMatchObject({ general: { sessionId: "c" }, generalRevision: 2 });
		expect(await first.registerReviewAnchor(registration)).toEqual(final);
		await Promise.all([first.close(), second.close()]);
		const reopened = await SQLiteSessionStoreClient.open(first.sessionDirectory);
		clients.push(reopened);
		expect(await reopened.resolveReviewGeneral("run", source)).toEqual(final);
		expect(await reopened.resolveReviewGeneral("run", { ...winner.general, cwd })).toEqual(final);
	});

	it("authorizes same-run historical children only, preserves exact unavailable General and canonical authority", async () => {
		const { first, source, input, cwd } = await fixture();
		const discussion = await first.createOrGetReviewDiscussion(input);
		const next = await first.resetReviewDiscussion(reset(input));
		for (const member of [discussion.current.child, next.child.child]) {
			expect(await first.resolveReviewGeneral("run", { ...member, cwd })).toMatchObject({ generalRevision: 0 });
			expect(await first.resolveReviewAnchor("run", { ...member, cwd })).toBeNull();
			expect(await first.resolveReviewGeneral("other", { ...member, cwd })).toBeNull();
			expect(await first.resolveReviewGeneral("run", { ...member, sessionGeneration: "wrong", cwd })).toBeNull();
		}
		await first.createHiddenSession(child("general", cwd));
		const general = { sessionId: "general", sessionGeneration: "generation:general", cwd };
		await first.replaceReviewGeneral({ runId: "run", member: source, expectedRevision: 0, replacement: general });
		await first.deleteSession({
			sessionId: general.sessionId,
			sessionGeneration: general.sessionGeneration,
			expectedRevision: 0,
		});
		await first.createHiddenSession({ ...child("general", cwd), sessionGeneration: "reused" });
		expect(await first.resolveReviewGeneral("run", source)).toMatchObject({
			general: { sessionId: "general", sessionGeneration: "generation:general" },
			generalRevision: 1,
			generalAvailable: false,
			sourceAvailable: true,
		});
		expect(await first.resolveReviewGeneral("run", { ...general, sessionGeneration: "reused" })).toBeNull();
		expect((await first.findReviewDiscussion("run", "finding"))?.source.sessionId).toBe(source.sessionId);
	});

	it("rolls back General pointer and alias membership together when durable publication fails", async () => {
		const { first, source, cwd } = await fixture();
		await first.createHiddenSession(child("candidate", cwd));
		const candidate = { sessionId: "candidate", sessionGeneration: "generation:candidate", cwd };
		const db = new DatabaseSync(first.info.databasePath);
		try {
			db.exec(
				"CREATE TRIGGER fail_general BEFORE UPDATE ON review_anchors BEGIN SELECT RAISE(ABORT, 'injected'); END",
			);
			await expect(
				first.replaceReviewGeneral({ runId: "run", member: source, expectedRevision: 0, replacement: candidate }),
			).rejects.toThrow("injected");
			expect(await first.resolveReviewAnchor("run", candidate)).toBeNull();
			expect(await first.findReviewAnchor("run")).toMatchObject({
				generalRevision: 0,
				general: { sessionId: source.sessionId },
			});
			db.exec("DROP TRIGGER fail_general");
		} finally {
			db.close();
		}
	});
	it("atomically creates one hidden empty child across independent workers and returns the canonical winner", async () => {
		const { first, second, input } = await fixture();
		const competing = {
			...input,
			discussionId: "losing-discussion",
			requestId: "competing",
			child: child("competing", input.source.cwd),
			contextSnapshot: { other: "must not overwrite" },
			kickoffClientMessageId: "other-kickoff",
		};
		const [a, b] = await Promise.all([
			first.createOrGetReviewDiscussion(input),
			second.createOrGetReviewDiscussion(competing),
		]);
		expect(a).toEqual(b);
		expect(a.current.available).toBe(true);
		expect(await first.listSessionSummaries()).toEqual([]);
		expect(await first.listSessionSummaries({ includeHidden: true })).toHaveLength(2);
		const snapshot = await first.loadSession(a.current.child.sessionId, a.current.child.sessionGeneration);
		expect(snapshot).toMatchObject({ session: { revision: 0, visible: false }, entries: [], clientInputs: [] });
		expect(await first.findReviewDiscussion("run", "finding")).toEqual(a);
		expect(await first.findReviewDiscussionByChild(a.current.child)).toEqual({ discussion: a, child: a.current });
		expect(await first.findReviewDiscussionByChild({ ...a.current.child, sessionGeneration: "wrong" })).toBeNull();
		expect(await first.verifyForeignKeys()).toEqual({ status: "valid" });
	});

	it("CAS resets serialize, retain exact history and replay the same successful request after later resets", async () => {
		const { first, second, input } = await fixture();
		const initial = await first.createOrGetReviewDiscussion(input);
		const requests = [reset(input, "a"), reset(input, "b")];
		const results = await Promise.all([
			first.resetReviewDiscussion(requests[0]!),
			second.resetReviewDiscussion(requests[1]!),
		]);
		expect(results.map((result) => result.status).sort()).toEqual(["conflict", "reset"]);
		const winnerIndex = results.findIndex((result) => result.status === "reset");
		const winner = results[winnerIndex]!;
		expect(await second.resetReviewDiscussion(requests[winnerIndex]!)).toEqual(winner);
		expect(await first.listSessionSummaries({ includeHidden: true })).toHaveLength(3);
		const third = { ...reset(input, "third"), expectedChild: winner.child.child };
		expect(await first.resetReviewDiscussion(third)).toMatchObject({ status: "reset", child: { ordinal: 3 } });
		expect(await second.resetReviewDiscussion(requests[winnerIndex]!)).toEqual(winner);
		const history = await second.listReviewDiscussionHistory(input.discussionId);
		expect(history.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
		expect(await second.listReviewDiscussionHistory(input.discussionId, { limit: 1, offset: 1 })).toEqual([
			history[1],
		]);
		expect((await second.findReviewDiscussionByChild(initial.current.child))?.child).toEqual(initial.current);
		expect((await second.findReviewDiscussionByChild(initial.current.child))?.discussion.current.ordinal).toBe(3);
		await expect(
			first.resetReviewDiscussion({ ...requests[winnerIndex]!, kickoffClientMessageId: "changed" }),
		).rejects.toMatchObject({ code: "review_identity_conflict" });
	});

	it("retains seeded transcripts, canonical context and kickoff identities across reset and reopen", async () => {
		const { first, second, input } = await fixture();
		const initial = await first.createOrGetReviewDiscussion(input);
		const payload: SessionStoreTransactionPayload = {
			session: {
				updatedAt: NOW,
				startingGitContextRecorded: false,
				startingGitContext: null,
				name: null,
				visible: true,
				leafId: "message",
				messageCount: 1,
				firstMessage: "discuss",
			},
			entries: [
				{
					entry: {
						type: "message",
						id: "message",
						ordinal: 1,
						parentId: null,
						timestamp: NOW,
						message: { role: "user", content: "discuss", timestamp: Date.parse(NOW) },
					},
				},
			],
			clientInputs: [],
			searchChunks: [{ chunkIndex: 0, entryId: "message", text: "discuss" }],
		};
		expect(
			await first.applyTransaction({
				...initial.current.child,
				expectedRevision: 0,
				commitId: "seed",
				digest: digestSessionStoreTransactionPayload(payload),
				payload,
			}),
		).toMatchObject({ status: "committed" });
		const before = await first.loadSession(initial.current.child.sessionId, initial.current.child.sessionGeneration);
		const resetResult = await first.resetReviewDiscussion(reset(input));
		await Promise.all([first.close(), second.close()]);
		const reopened = await SQLiteSessionStoreClient.open(first.sessionDirectory);
		clients.push(reopened);
		expect(await reopened.resetReviewDiscussion(reset(input))).toEqual(resetResult);
		expect(
			await reopened.loadSession(initial.current.child.sessionId, initial.current.child.sessionGeneration),
		).toEqual(before);
		const discussion = await reopened.findReviewDiscussion("run", "finding");
		expect(discussion?.contextSnapshot).toEqual(input.contextSnapshot);
		expect(
			(await reopened.listReviewDiscussionHistory(input.discussionId)).map((item) => item.kickoffClientMessageId),
		).toEqual(["kickoff", "kickoff:next"]);
		expect(await reopened.findReviewDiscussionByChild(initial.current.child)).toEqual({
			discussion,
			child: initial.current,
		});
	});

	it("deduplicates simultaneous retries of a single reset request", async () => {
		const { first, second, input } = await fixture();
		await first.createOrGetReviewDiscussion(input);
		const request = reset(input);
		const results = await Promise.all([first.resetReviewDiscussion(request), second.resetReviewDiscussion(request)]);
		expect(results[0]).toEqual(results[1]);
		expect(await first.listReviewDiscussionHistory(input.discussionId)).toHaveLength(2);
		expect(await first.listSessionSummaries({ includeHidden: true })).toHaveLength(3);
	});

	it("preserves deleted history without rebinding reused ids and can reset an unavailable current child", async () => {
		const { first, second, input, source, anchor } = await fixture();
		const discussion = await first.createOrGetReviewDiscussion(input);
		await second.deleteSession({ ...discussion.current.child, expectedRevision: 0 });
		await expect(second.createHiddenSession(input.child)).rejects.toMatchObject({ code: "review_identity_conflict" });
		await second.createHiddenSession({ ...input.child, sessionGeneration: "replacement" });
		expect((await first.findReviewDiscussion("run", "finding"))?.current.available).toBe(false);
		expect((await first.findReviewDiscussionByChild(discussion.current.child))?.child.available).toBe(false);
		expect(
			await first.findReviewDiscussionByChild({ sessionId: input.child.id, sessionGeneration: "replacement" }),
		).toBeNull();
		expect(await first.resetReviewDiscussion(reset(input))).toMatchObject({
			status: "reset",
			child: { available: true },
		});
		await second.deleteSession({
			sessionId: source.sessionId,
			sessionGeneration: source.sessionGeneration,
			expectedRevision: 0,
		});
		await expect(second.createHiddenSession(child("source", source.cwd))).rejects.toMatchObject({
			code: "review_identity_conflict",
		});
		await second.createHiddenSession({ ...child("source", source.cwd), sessionGeneration: "new-source" });
		expect((await first.findReviewAnchor("run"))?.sourceAvailable).toBe(false);
		expect((await first.findReviewDiscussion("run", "finding"))?.sourceAvailable).toBe(false);
		expect(await first.listReviewDiscussionHistory(input.discussionId)).toHaveLength(2);
		await expect(first.createOrGetReviewDiscussion(input)).rejects.toMatchObject({
			code: "review_source_unavailable",
		});
		await expect(
			first.registerReviewAnchor({ ...anchor, source: { ...source, sessionGeneration: "new-source" } }),
		).rejects.toMatchObject({ code: "review_identity_conflict" });
		await expect(
			first.resetReviewDiscussion({
				...reset(input, "later"),
				expectedChild: { sessionId: "next", sessionGeneration: "generation:next" },
			}),
		).rejects.toMatchObject({ code: "review_source_unavailable" });
		expect(await first.resetReviewDiscussion(reset(input))).toMatchObject({ status: "reset", child: { ordinal: 2 } });
		expect(await first.verifyForeignKeys()).toEqual({ status: "valid" });
	});

	it("requires canonical anchors and rejects copied/fork source authority, stale generations and mismatched cwd", async () => {
		const { first, input, source, anchor, cwd } = await fixture();
		await expect(first.createOrGetReviewDiscussion({ ...input, runId: "unregistered" })).rejects.toMatchObject({
			code: "review_anchor_not_found",
		});
		expect(await first.findReviewAnchor("unregistered")).toBeNull();
		await first.createHiddenSession(child("fork", cwd));
		await expect(
			first.createOrGetReviewDiscussion({
				...input,
				source: { ...source, sessionId: "fork", sessionGeneration: "generation:fork" },
			}),
		).rejects.toMatchObject({ code: "review_identity_conflict" });
		await expect(
			first.createOrGetReviewDiscussion({ ...input, source: { ...source, sessionGeneration: "stale" } }),
		).rejects.toMatchObject({ code: "review_identity_conflict" });
		await expect(
			first.registerReviewAnchor({ ...anchor, runId: "new", source: { ...source, sessionGeneration: "stale" } }),
		).rejects.toMatchObject({ code: "review_source_unavailable" });
		await expect(
			first.registerReviewAnchor({ ...anchor, runId: "new", source: { ...source, cwd: "/different" } }),
		).rejects.toMatchObject({ code: "review_cwd_mismatch" });
		await expect(
			first.createOrGetReviewDiscussion({ ...input, source: { ...source, cwd: "/different" } }),
		).rejects.toMatchObject({ code: "review_cwd_mismatch" });
		await expect(
			first.createOrGetReviewDiscussion({ ...input, child: { ...input.child, cwd: "/different" } }),
		).rejects.toMatchObject({ code: "review_cwd_mismatch" });
		expect(await first.findReviewDiscussion("run", "finding")).toBeNull();
		await first.createOrGetReviewDiscussion(input);
		await expect(
			first.resetReviewDiscussion({ ...reset(input), child: child("next", "/different") }),
		).rejects.toMatchObject({ code: "review_cwd_mismatch" });
		expect(await first.listReviewDiscussionHistory(input.discussionId)).toHaveLength(1);
	});

	it.runIf(process.platform !== "win32")("accepts canonical cwd aliases but detects a retargeted alias", async () => {
		const { first, input, root, cwd } = await fixture();
		const alias = join(root, "alias");
		symlinkSync(cwd, alias, "dir");
		const discussion = await first.createOrGetReviewDiscussion({
			...input,
			source: { ...input.source, cwd: alias },
			child: { ...input.child, cwd: alias },
		});
		expect(discussion.source.cwd).toBe(realpathSync(cwd));
		expect(discussion.current.available).toBe(true);
		rmSync(alias);
		const other = join(root, "other");
		mkdirSync(other);
		symlinkSync(other, alias, "dir");
		expect((await first.findReviewDiscussion("run", "finding"))?.current.available).toBe(false);
		await expect(
			first.createOrGetReviewDiscussion({ ...input, source: { ...input.source, cwd: alias } }),
		).rejects.toMatchObject({ code: "review_cwd_mismatch" });
	});

	it("rolls back reservations if the relation fails and supports retry", async () => {
		const { first, input } = await fixture();
		await first.createHiddenSession(input.child);
		await expect(first.createOrGetReviewDiscussion(input)).rejects.toMatchObject({ code: "session_already_exists" });
		expect(await first.findReviewDiscussion("run", "finding")).toBeNull();
		await first.deleteSession({
			sessionId: input.child.id,
			sessionGeneration: input.child.sessionGeneration,
			expectedRevision: 0,
		});
		await first.createOrGetReviewDiscussion(input);
		const db = new DatabaseSync(first.info.databasePath);
		try {
			db.exec(
				"CREATE TRIGGER fail_child BEFORE INSERT ON review_discussion_children BEGIN SELECT RAISE(ABORT, 'injected'); END",
			);
			await expect(first.resetReviewDiscussion(reset(input))).rejects.toThrow("injected");
			expect(await first.findSessionSummaryById("next")).toBeNull();
			expect(await first.listReviewDiscussionHistory(input.discussionId)).toHaveLength(1);
			db.exec("DROP TRIGGER fail_child");
		} finally {
			db.close();
		}
		expect(await first.resetReviewDiscussion(reset(input))).toMatchObject({ status: "reset" });
	});

	it("bounds and orders lists, validates canonical context and rejects malformed worker/client values", async () => {
		const { first, input } = await fixture();
		for (const id of ["c", "a", "b"])
			await first.createOrGetReviewDiscussion({
				...input,
				findingId: id,
				discussionId: id,
				child: child(id, input.source.cwd),
			});
		expect((await first.listReviewDiscussions("run", { limit: 2 })).map((item) => item.discussionId)).toEqual([
			"a",
			"b",
		]);
		expect(
			(await first.listReviewDiscussions("run", { limit: 2, offset: 2 })).map((item) => item.discussionId),
		).toEqual(["c"]);
		await expect(first.listReviewDiscussions("run", { limit: 101 })).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(first.listReviewDiscussionHistory("a", { offset: -1 })).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(first.listReviewDiscussionHistory("missing")).rejects.toMatchObject({
			code: "review_discussion_not_found",
		});
		await expect(
			first.createOrGetReviewDiscussion({
				...input,
				contextSnapshot: "x".repeat(SESSION_STORE_REVIEW_CONTEXT_MAX_BYTES),
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			first.createOrGetReviewDiscussion({ ...input, contextSnapshot: { bad: Number.NaN } }),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(() =>
			parseSessionStoreWorkerOperation({ kind: "create_review_discussion", input: { ...input, portable: true } }),
		).toThrow(/unknown property/);
		expect(() =>
			parseSessionStoreWorkerOperation({
				kind: "reset_review_discussion",
				input: { ...reset(input), expectedChild: { sessionId: "only-id" } },
			}),
		).toThrow(/missing property/);
		expect(() =>
			parseSessionStoreOperationResult("find_review_anchor", {
				runId: "run",
				source: input.source,
				createdAt: NOW,
				sourceAvailable: "true",
				general: { sessionId: "source", sessionGeneration: "generation:source" },
				generalRevision: 0,
				generalAvailable: true,
			}),
		).toThrow(/boolean/);
		expect(() =>
			parseSessionStoreOperationResult(
				"list_review_discussions",
				Array.from({ length: 101 }, () => null),
			),
		).toThrow(/unbounded/);
		const result = await first.createOrGetReviewDiscussion(input);
		expect(() =>
			parseSessionStoreOperationResult("find_review_discussion", {
				...result,
				current: { ...result.current, discussionId: "other" },
			}),
		).toThrow(/different discussion/);
	});
});
