import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	SESSION_STORE_DATABASE_FILENAME,
	type SQLiteSessionStoreLease,
} from "../../src/core/session-store/index.ts";
import { createHarness } from "../suite/harness.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];
const storeLeases: SQLiteSessionStoreLease[] = [];

async function own(manager: Promise<SessionManager>): Promise<SessionManager> {
	const resolved = await manager;
	managers.push(resolved);
	return resolved;
}

function fixture(): { root: string; cwd: string; sessionDir: string } {
	const root = mkdtempSync(join(tmpdir(), "volt-session-manager-sqlite-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	return { root, cwd, sessionDir };
}

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.drainPersistence();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const lease of storeLeases.splice(0)) await lease.release();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite-backed SessionManager", () => {
	it("keeps new sessions hidden until visible content and reopens by stable reference", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await own(SessionManager.create(cwd, sessionDir));
		const ref = manager.getSessionRef();
		expect(ref).toBeDefined();
		expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		expect(await SessionManager.list(cwd, sessionDir, undefined, { includeMessageFreeDurable: true })).toHaveLength(
			1,
		);

		manager.appendMessage({ role: "user", content: "hello sqlite", timestamp: Date.now() });
		await manager.flush();

		const listed = await SessionManager.list(cwd, sessionDir);
		expect(listed).toMatchObject([{ id: manager.getSessionId(), firstMessage: "hello sqlite", messageCount: 1 }]);
		expect(listed[0]?.ref).toEqual(ref);

		const reopened = await own(SessionManager.open(ref!));
		expect(reopened.buildSessionContext().messages).toMatchObject([{ role: "user", content: "hello sqlite" }]);
	});

	it("publishes absolute custom session directories that survive caller cwd changes", async () => {
		const { root, cwd } = fixture();
		const originalCwd = process.cwd();
		const creatorCwd = join(root, "caller-a");
		const consumerCwd = join(root, "caller-b");
		const relativeSessionDir = "relative-sessions";
		mkdirSync(creatorCwd, { recursive: true });
		mkdirSync(consumerCwd, { recursive: true });

		try {
			process.chdir(creatorCwd);
			const absoluteSessionDir = join(process.cwd(), relativeSessionDir);
			const manager = await own(SessionManager.create(cwd, relativeSessionDir, { id: "portable-session" }));
			manager.appendMessage({ role: "user", content: "portableneedle", timestamp: Date.now() });
			await manager.flush();
			const createdRef = manager.getSessionRef();
			if (!createdRef) throw new Error("Expected a persisted session reference");

			const opened = await own(
				SessionManager.open({
					...createdRef,
					sessionDirectory: relativeSessionDir,
				}),
			);
			const continued = await own(SessionManager.continueRecent(cwd, relativeSessionDir));
			const listedRef = (await SessionManager.list(cwd, relativeSessionDir)).find(
				(session) => session.id === createdRef.sessionId,
			)?.ref;
			const searchedRef = (await SessionManager.search(cwd, "portableneedle", relativeSessionDir)).find(
				(session) => session.id === createdRef.sessionId,
			)?.ref;
			const searchedAllRef = (await SessionManager.searchAll("portableneedle", relativeSessionDir)).find(
				(session) => session.id === createdRef.sessionId,
			)?.ref;
			const listedAllRef = (await SessionManager.listAll(relativeSessionDir)).find(
				(session) => session.id === createdRef.sessionId,
			)?.ref;
			const references = {
				create: createdRef,
				open: opened.getSessionRef(),
				continueRecent: continued.getSessionRef(),
				findForResume: await SessionManager.findForResume(relativeSessionDir, createdRef.sessionId),
				list: listedRef,
				search: searchedRef,
				searchAll: searchedAllRef,
				listAll: listedAllRef,
			};
			for (const ref of Object.values(references)) {
				expect(ref).toBeDefined();
				expect(ref?.sessionDirectory).toBe(absoluteSessionDir);
			}
			expect(manager.getSessionDir()).toBe(absoluteSessionDir);

			process.chdir(consumerCwd);
			const reopened = await own(SessionManager.open(createdRef));
			expect(reopened.getSessionId()).toBe(createdRef.sessionId);
			expect(reopened.getSessionDir()).toBe(absoluteSessionDir);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("lists valid sessions without auditing unrelated foreign-key violations", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await own(SessionManager.create(cwd, sessionDir));
		manager.appendMessage({ role: "user", content: "valid session", timestamp: Date.now() });
		await manager.flush();
		const sessionId = manager.getSessionId();
		await manager.closePersistence();

		const db = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
		try {
			db.exec("PRAGMA foreign_keys = OFF");
			db.prepare(
				`INSERT INTO entries (
					session_id, entry_id, ordinal, parent_entry_id, entry_type, timestamp, is_host_only, payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("missing-session", "orphan-entry", 1, null, "message", "2026-09-02T00:00:00.000Z", 0, "{}");
		} finally {
			db.close();
		}

		expect((await SessionManager.list(cwd, sessionDir)).map((session) => session.id)).toEqual([sessionId]);
		const auditLease = await acquireSharedSQLiteSessionStore(sessionDir);
		storeLeases.push(auditLease);
		const audit = await auditLease.client.verifyForeignKeys();
		expect(audit).toMatchObject({
			status: "violation",
			table: "entries",
			rowId: null,
			parentTable: "sessions",
		});
		if (audit.status !== "violation") throw new Error("Expected a foreign-key violation");
		expect(Number.isSafeInteger(audit.constraintIndex)).toBe(true);
	});

	it("searches indexed history beyond the first message without loading transcript payloads", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await own(SessionManager.create(cwd, sessionDir));
		manager.appendMessage({ role: "user", content: "first message", timestamp: Date.now() });
		manager.appendCustomEntry("large-private-payload", { payload: "x".repeat(128 * 1024) });
		manager.appendMessage({ role: "user", content: "deep-only-needle", timestamp: Date.now() + 1 });
		await manager.flush();

		const matches = await SessionManager.search(cwd, "deep-only-needle", sessionDir);
		expect(matches).toMatchObject([{ id: manager.getSessionId(), firstMessage: "first message" }]);
	});

	it("globally ranks deep-text matches across session stores", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-session-search-all-"));
		roots.push(root);
		const olderCwd = join(root, "work-a");
		const newerCwd = join(root, "work-b");
		mkdirSync(olderCwd, { recursive: true });
		mkdirSync(newerCwd, { recursive: true });
		vi.stubEnv("VOLT_CODING_AGENT_DIR", join(root, "agent"));

		const older = await own(SessionManager.create(olderCwd, undefined, { id: "rank-old" }));
		older.appendMessage({ role: "user", content: "summary a", timestamp: 1_700_000_000_000 });
		older.appendMessage({ role: "user", content: "rankneedle tail", timestamp: 1_700_000_000_001 });
		await older.flush();

		const newer = await own(SessionManager.create(newerCwd, undefined, { id: "rank-new" }));
		newer.appendMessage({ role: "user", content: "summary b", timestamp: 1_700_000_001_000 });
		newer.appendMessage({ role: "user", content: "xxxx rankneedle", timestamp: 1_700_000_001_001 });
		await newer.flush();

		const matches = await SessionManager.searchAll('"rankneedle"');
		expect(matches.map((session) => session.id)).toEqual(["rank-old", "rank-new"]);
		expect(matches.map((session) => session.firstMessage)).toEqual(["summary a", "summary b"]);
	});

	it("fails stale managers closed after delete and same-id recreation", async () => {
		const { cwd, sessionDir } = fixture();
		const original = await own(SessionManager.create(cwd, sessionDir, { id: "reused-id" }));
		original.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		await original.flush();
		const originalRef = original.getSessionRef()!;
		expect(await SessionManager.delete(originalRef, 1)).toBe(true);

		const replacement = await own(SessionManager.create(cwd, sessionDir, { id: "reused-id" }));
		expect(replacement.getSessionRef()?.sessionGeneration).not.toBe(originalRef.sessionGeneration);
		original.appendSessionInfo("stale write");
		await expect(original.flush()).rejects.toThrow(/ambiguous|reconcil/i);
		expect(original.getConversationAuthorityStatus().status).toBe("reconciliation_required");
	});

	it("preserves complete parent references across stores", async () => {
		const first = fixture();
		const second = fixture();
		const parent = await own(SessionManager.create(first.cwd, first.sessionDir));
		parent.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
		await parent.flush();
		const child = await own(SessionManager.forkFrom(parent.getSessionRef()!, second.cwd, second.sessionDir));
		const childInfo = (await SessionManager.list(second.cwd, second.sessionDir))[0]!;
		expect(childInfo.parentSessionRef).toEqual(parent.getSessionRef());
		const reopenedParent = await own(SessionManager.open(childInfo.parentSessionRef!));
		expect(reopenedParent).toBeInstanceOf(SessionManager);
		expect(child.getSessionId()).toBe(childInfo.id);

		const snapshotPath = join(second.root, "child-snapshot.jsonl");
		const snapshot = await SessionManager.exportJsonlSnapshot(childInfo.ref, snapshotPath);
		expect(await SessionManager.delete(childInfo.ref, snapshot.revision)).toBe(true);
		const restored = await own(SessionManager.importFromJsonl(snapshotPath, second.cwd, second.sessionDir));
		expect(restored.getHeader()?.parentSession).toEqual(parent.getSessionRef());
	});

	it("keeps another manager usable when reconciliation replaces a same-store lease", async () => {
		const { cwd, sessionDir } = fixture();
		const first = await own(SessionManager.create(cwd, sessionDir));
		const second = await own(SessionManager.open(first.getSessionRef()!));
		const faultLease = await acquireSharedSQLiteSessionStore(sessionDir);
		storeLeases.push(faultLease);
		vi.spyOn(faultLease.client, "applyTransaction").mockRejectedValueOnce(
			new Error("injected pre-commit response failure"),
		);

		first.appendSessionInfo("rolled back");
		await expect(first.flush()).rejects.toThrow("transaction was rolled back");
		second.appendSessionInfo("surviving owner");
		await second.flush();
		expect(second.getSessionName()).toBe("surviving owner");
	});

	it("releases a replacement lease installed while shutdown awaits reconciliation", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await own(SessionManager.create(cwd, sessionDir));
		const faultLease = await acquireSharedSQLiteSessionStore(sessionDir);
		storeLeases.push(faultLease);
		const close = vi.spyOn(faultLease.client, "close");
		vi.spyOn(faultLease.client, "applyTransaction").mockRejectedValueOnce(
			new Error("injected pre-commit response failure"),
		);

		manager.appendSessionInfo("rolled back during shutdown");
		await expect(manager.drainPersistence()).resolves.toMatchObject({ status: "reconciliation_required" });
		await faultLease.release();
		expect(close).toHaveBeenCalledOnce();
	});

	it("shares one idempotent shutdown drain and seals writes synchronously", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await own(SessionManager.create(cwd, sessionDir));
		manager.appendSessionInfo("before close");

		const firstDrain = manager.drainPersistence();
		expect(manager.drainPersistence()).toBe(firstDrain);
		expect(() => manager.appendSessionInfo("after close")).toThrow("Session persistence is closed");
		expect(() => manager.newSession()).toThrow("Session persistence is closed");
		await expect(firstDrain).resolves.toEqual({ status: "closed" });
		await expect(manager.closePersistence()).resolves.toBeUndefined();
	});

	it("preserves a session generation advanced beyond the discarding manager's final revision", async () => {
		const { cwd, sessionDir } = fixture();
		const discarding = await own(SessionManager.create(cwd, sessionDir));
		discarding.appendPlanningState({ mode: "plan", plan: null });
		await discarding.flush();
		const ref = discarding.getSessionRef();
		expect(ref).toBeDefined();

		const advancing = await own(SessionManager.open(ref!));
		advancing.appendSessionInfo("advanced owner");
		await advancing.flush();

		await expect(discarding.discardPersistence()).rejects.toThrow("Session changed before deletion (revision 2)");
		const reopened = await own(SessionManager.open(ref!));
		expect(reopened.getSessionRef()).toEqual(ref);
		expect(reopened.getSessionName()).toBe("advanced owner");
	});

	it("keeps another manager usable and permits immediate deletion after the final close", async () => {
		const { root, cwd, sessionDir } = fixture();
		const first = await own(SessionManager.create(cwd, sessionDir));
		first.appendMessage({ role: "user", content: "shared owner", timestamp: Date.now() });
		await first.flush();
		const second = await own(SessionManager.open(first.getSessionRef()!));

		await first.closePersistence();
		second.appendSessionInfo("still open");
		await second.flush();
		await second.closePersistence();

		rmSync(root, { recursive: true });
		roots.splice(roots.indexOf(root), 1);
	});

	it("releases the final manager when awaited AgentSession shutdown completes", async () => {
		const { root, cwd, sessionDir } = fixture();
		const manager = await own(SessionManager.create(cwd, sessionDir));
		const harness = await createHarness({ sessionManager: manager });

		await harness.cleanupAsync();
		rmSync(root, { recursive: true });
		roots.splice(roots.indexOf(root), 1);
	});

	it("rejects invalid imported parent ordering without retaining a hidden row", async () => {
		const { cwd, sessionDir, root } = fixture();
		const jsonl = join(root, "cycle.jsonl");
		const timestamp = "2026-08-31T12:00:00.000Z";
		writeFileSync(
			jsonl,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					snapshotVersion: 1,
					id: "cycle",
					timestamp,
					cwd,
				},
				{
					type: "message",
					id: "a",
					parentId: "b",
					ordinal: 1,
					timestamp,
					message: { role: "user", content: "first", timestamp: Date.now() },
				},
				{
					type: "message",
					id: "b",
					parentId: "a",
					ordinal: 2,
					timestamp,
					message: { role: "user", content: "second", timestamp: Date.now() },
				},
				{ type: "leaf", id: "leaf", parentId: "b", ordinal: 3, timestamp, targetId: "b" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		await expect(SessionManager.importFromJsonl(jsonl, cwd, sessionDir)).rejects.toThrow(/invalid or forward parent/);
		expect(await SessionManager.list(cwd, sessionDir, undefined, { includeMessageFreeDurable: true })).toEqual([]);
	});

	it("ignores unmarked JSONL beside the store and rejects it as an explicit snapshot", async () => {
		const { cwd, sessionDir } = fixture();
		mkdirSync(sessionDir, { recursive: true });
		const jsonl = join(sessionDir, "unmarked.jsonl");
		const timestamp = "2026-08-31T12:00:00.000Z";
		writeFileSync(
			jsonl,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "unmarked",
				timestamp,
				cwd,
			})}\n`,
		);

		expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		expect(existsSync(jsonl)).toBe(true);
		await expect(SessionManager.importFromJsonl(jsonl, cwd, sessionDir)).rejects.toThrow(
			"Session snapshot version must be 1",
		);
	});
});
