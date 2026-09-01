import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";

const roots: string[] = [];

function fixture(): { root: string; cwd: string; sessionDir: string } {
	const root = mkdtempSync(join(tmpdir(), "volt-session-manager-sqlite-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	return { root, cwd, sessionDir };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite-backed SessionManager", () => {
	it("keeps new sessions hidden until visible content and reopens by stable reference", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir);
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

		const reopened = await SessionManager.open(ref!);
		expect(reopened.buildSessionContext().messages).toMatchObject([{ role: "user", content: "hello sqlite" }]);
	});

	it("searches indexed history beyond the first message without loading transcript payloads", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: "first message", timestamp: Date.now() });
		manager.appendCustomEntry("large-private-payload", { payload: "x".repeat(128 * 1024) });
		manager.appendMessage({ role: "user", content: "deep-only-needle", timestamp: Date.now() + 1 });
		await manager.flush();

		const matches = await SessionManager.search(cwd, "deep-only-needle", sessionDir);
		expect(matches).toMatchObject([{ id: manager.getSessionId(), firstMessage: "first message" }]);
	});

	it("fails stale managers closed after delete and same-id recreation", async () => {
		const { cwd, sessionDir } = fixture();
		const original = await SessionManager.create(cwd, sessionDir, { id: "reused-id" });
		original.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		await original.flush();
		const originalRef = original.getSessionRef()!;
		expect(await SessionManager.delete(originalRef, 1)).toBe(true);

		const replacement = await SessionManager.create(cwd, sessionDir, { id: "reused-id" });
		expect(replacement.getSessionRef()?.sessionGeneration).not.toBe(originalRef.sessionGeneration);
		original.appendSessionInfo("stale write");
		await expect(original.flush()).rejects.toThrow(/ambiguous|reconcil/i);
		expect(original.getConversationAuthorityStatus().status).toBe("reconciliation_required");
	});

	it("preserves complete parent references across stores", async () => {
		const first = fixture();
		const second = fixture();
		const parent = await SessionManager.create(first.cwd, first.sessionDir);
		parent.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
		await parent.flush();
		const child = await SessionManager.forkFrom(parent.getSessionRef()!, second.cwd, second.sessionDir);
		const childInfo = (await SessionManager.list(second.cwd, second.sessionDir))[0]!;
		expect(childInfo.parentSessionRef).toEqual(parent.getSessionRef());
		await expect(SessionManager.open(childInfo.parentSessionRef!)).resolves.toBeInstanceOf(SessionManager);
		expect(child.getSessionId()).toBe(childInfo.id);

		const snapshotPath = join(second.root, "child-snapshot.jsonl");
		const snapshot = await SessionManager.exportJsonlSnapshot(childInfo.ref, snapshotPath);
		expect(await SessionManager.delete(childInfo.ref, snapshot.revision)).toBe(true);
		const restored = await SessionManager.importFromJsonl(snapshotPath, second.cwd, second.sessionDir);
		expect(restored.getHeader()?.parentSession).toEqual(parent.getSessionRef());
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
		expect(await SessionManager.open(sessions[0]!.ref)).toBeInstanceOf(SessionManager);
		await expect(readdir(join(sessionDir, "legacy-jsonl"))).resolves.toHaveLength(1);
	});
});
