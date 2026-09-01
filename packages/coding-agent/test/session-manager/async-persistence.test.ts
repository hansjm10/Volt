import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const cleanups: string[] = [];

function createTempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-async-session-"));
	cleanups.push(root);
	return root;
}

afterEach(() => {
	for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SessionManager asynchronous SQLite persistence", () => {
	it("awaits creation of a durable hidden session and exposes it by reference", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root, { id: "hidden-session" });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		expect(existsSync(join(root, "sessions.sqlite"))).toBe(true);
		expect(await SessionManager.list(root, root)).toEqual([]);
		expect(await SessionManager.list(root, root, undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: "hidden-session", ref },
		]);
		expect((await SessionManager.open(ref)).getSessionId()).toBe("hidden-session");
	});

	it("preserves append order and ordinals after flush and reopen", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));

		const first = manager.appendCustomMessageEntry("test", "one", true);
		const second = manager.appendCustomEntry("test", { value: "two" });
		const third = manager.appendSessionInfo("three");
		const watermark = manager.flush();

		expect(manager.flush()).toBe(watermark);
		expect(observed).toEqual([first, second, third]);
		await watermark;

		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const reopened = await SessionManager.open(ref);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([first, second, third]);
		expect(reopened.getEntries().map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
	});

	it("materializes custom-only sessions without making them selector-visible", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const customEntryId = manager.appendCustomEntry("test", { durable: true });

		await manager.materialize();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const reopened = await SessionManager.open(ref);
		expect(reopened.getEntry(customEntryId)).toMatchObject({
			type: "custom",
			customType: "test",
			data: { durable: true },
		});
		expect(await SessionManager.list(root, root)).toEqual([]);
	});

	it("persists separate sessions independently in one store", async () => {
		const root = createTempDir();
		const first = await SessionManager.create(root, root, { id: "first" });
		const second = await SessionManager.create(root, root, { id: "second" });
		first.appendCustomMessageEntry("test", "first entry", true);
		second.appendCustomMessageEntry("test", "second entry", true);

		await Promise.all([first.flush(), second.flush()]);

		const firstRef = first.getSessionRef();
		const secondRef = second.getSessionRef();
		if (!firstRef || !secondRef) throw new Error("Expected persisted session references");
		expect((await SessionManager.open(firstRef)).getSessionName()).toBeUndefined();
		expect((await SessionManager.open(firstRef)).buildSessionContext().messages).toMatchObject([
			{ role: "custom", content: "first entry" },
		]);
		expect((await SessionManager.open(secondRef)).buildSessionContext().messages).toMatchObject([
			{ role: "custom", content: "second entry" },
		]);
	});

	it("fails stale concurrent managers closed instead of losing a committed update", async () => {
		const root = createTempDir();
		const seed = await SessionManager.create(root, root, { id: "shared" });
		seed.appendCustomMessageEntry("test", "seed", true);
		await seed.flush();
		const ref = seed.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const first = await SessionManager.open(ref);
		const stale = await SessionManager.open(ref);

		const firstId = first.appendCustomEntry("test", { writer: "first" });
		await first.flush();
		stale.appendCustomEntry("test", { writer: "stale" });
		await expect(stale.flush()).rejects.toThrow("Session revision changed");
		expect(stale.getConversationAuthorityStatus().status).toBe("reconciliation_required");
		expect(() => stale.getEntries()).toThrow("requires reconciliation");

		const reopened = await SessionManager.open(ref);
		expect(reopened.getEntry(firstId)).toMatchObject({ type: "custom", data: { writer: "first" } });
		expect(reopened.getEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom", data: { writer: "stale" } }),
		);
	});

	it("imports legacy JSONL once and continues only in SQLite", async () => {
		const root = createTempDir();
		const legacyPath = join(root, "legacy.jsonl");
		const legacyBytes = `${JSON.stringify({
			type: "session",
			version: 4,
			id: "legacy",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: root,
		})}\n`;
		writeFileSync(legacyPath, legacyBytes);

		const manager = await SessionManager.importFromJsonl(legacyPath, root, join(root, "sqlite-store"));
		manager.appendCustomMessageEntry("test", "SQLite entry", true);
		await manager.flush();

		expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		expect((await SessionManager.open(ref)).buildSessionContext().messages).toMatchObject([
			{ role: "custom", content: "SQLite entry" },
		]);
	});

	it.runIf(process.platform !== "win32")("keeps the SQLite database private", async () => {
		const root = createTempDir();
		await SessionManager.create(root, root);
		expect(statSync(join(root, "sessions.sqlite")).mode & 0o777).toBe(0o600);
	});
});
