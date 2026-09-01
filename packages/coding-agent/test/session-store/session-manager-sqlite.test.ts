import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore, type SQLiteSessionStoreLease } from "../../src/core/session-store/index.ts";
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

	it("rejects cyclic imported entry parents without retaining a hidden row", async () => {
		const { cwd, sessionDir, root } = fixture();
		const jsonl = join(root, "cycle.jsonl");
		const timestamp = "2026-08-31T12:00:00.000Z";
		writeFileSync(
			jsonl,
			`${[
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "cycle", timestamp, cwd },
				{ type: "leaf", id: "a", parentId: "b", ordinal: 1, timestamp, targetId: null },
				{ type: "leaf", id: "b", parentId: "a", ordinal: 2, timestamp, targetId: null },
				{
					type: "message",
					id: "message",
					parentId: "a",
					ordinal: 3,
					timestamp,
					message: { role: "user", content: "cycle", timestamp: Date.now() },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		await expect(SessionManager.importFromJsonl(jsonl, cwd, sessionDir)).rejects.toThrow(/host-only parent cycle/);
		expect(await SessionManager.list(cwd, sessionDir, undefined, { includeMessageFreeDurable: true })).toEqual([]);
	});

	it("imports legacy JSONL once and moves the source to the retained backup", async () => {
		const { cwd, sessionDir } = fixture();
		mkdirSync(sessionDir, { recursive: true });
		const sessionId = "legacy-session";
		const timestamp = "2026-08-31T12:00:00.000Z";
		writeFileSync(
			join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: sessionId,
				timestamp,
				cwd,
			})}\n${JSON.stringify({
				type: "message",
				id: "message-1",
				parentId: null,
				ordinal: 1,
				timestamp: "2026-08-31T12:01:00.000Z",
				message: { role: "user", content: "legacy history", timestamp: 1_788_177_660_000 },
			})}\n`,
		);

		const sessions = await SessionManager.list(cwd, sessionDir);
		expect(sessions).toMatchObject([{ id: sessionId, firstMessage: "legacy history" }]);
		expect(await own(SessionManager.open(sessions[0]!.ref))).toBeInstanceOf(SessionManager);
		await expect(readdir(join(sessionDir, "legacy-jsonl"))).resolves.toHaveLength(1);
	});
});
