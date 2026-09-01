import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

async function commitPlanningState(manager: SessionManager, mode: "build" | "plan"): Promise<void> {
	const projection = manager.issueCanonicalProjection();
	await manager.commitCanonicalCommand({
		guard: { kind: "exact", token: projection.token },
		mutations: [{ kind: "append", entry: { type: "planning_state_change", planning: { mode, plan: null } } }],
	});
}

function legacySessionJsonl(id: string, cwd: string, message = "hello"): string {
	return `${[
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({
			type: "message",
			id: `${id}-message`,
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "user", content: message, timestamp: Date.parse("2025-01-01T00:00:01.000Z") },
		}),
	].join("\n")}\n`;
}

describe("legacy JSONL import parsing", () => {
	let tempDir: string;
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		tempDir = join(tmpdir(), `session-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await managerOwner.drain();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns no entries for missing, empty, or headerless files", () => {
		expect(loadEntriesFromFile(join(tempDir, "missing.jsonl"))).toEqual([]);
		const empty = join(tempDir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(loadEntriesFromFile(empty)).toEqual([]);
		const headerless = join(tempDir, "headerless.jsonl");
		writeFileSync(headerless, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(headerless)).toEqual([]);
	});

	it("loads a valid import snapshot", () => {
		const path = join(tempDir, "valid.jsonl");
		writeFileSync(path, legacySessionJsonl("legacy", tempDir));

		const entries = loadEntriesFromFile(path);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message"]);
	});

	it("rejects malformed committed current-format records but ignores a torn final fragment", () => {
		const malformed = join(tempDir, "malformed.jsonl");
		writeFileSync(
			malformed,
			'{"type":"session","version":5,"id":"bad","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\nnot-json\n',
		);
		expect(() => loadEntriesFromFile(malformed)).toThrow("malformed at committed line 2");

		const torn = join(tempDir, "torn.jsonl");
		writeFileSync(
			torn,
			'{"type":"session","version":5,"id":"torn","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"client_input_sta',
		);
		expect(loadEntriesFromFile(torn)).toHaveLength(1);
	});

	it("rejects unsupported imports without mutating their bytes", async () => {
		const path = join(tempDir, "future.jsonl");
		const content = '{"type":"session","version":6,"id":"future","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n';
		writeFileSync(path, content);

		await expect(SessionManager.importFromJsonl(path, tempDir, tempDir)).rejects.toThrow(
			"newer than supported version 5",
		);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("imports a snapshot into SQLite and never treats the source as live storage", async () => {
		const path = join(tempDir, "source.jsonl");
		const sourceBytes = legacySessionJsonl("imported", tempDir, "legacy message");
		writeFileSync(path, sourceBytes);
		const sessionDir = join(tempDir, "sqlite-store");
		const manager = await SessionManager.importFromJsonl(path, tempDir, sessionDir);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected imported session reference");

		const sqliteMessageTimestamp = Date.now();
		manager.appendMessage({ role: "user", content: "SQLite message", timestamp: sqliteMessageTimestamp });
		await manager.flush();

		expect(readFileSync(path, "utf8")).toBe(sourceBytes);
		expect(existsSync(join(sessionDir, "sessions.sqlite"))).toBe(true);
		expect((await SessionManager.open(ref)).buildSessionContext().messages).toEqual([
			{
				role: "user",
				content: "legacy message",
				timestamp: Date.parse("2025-01-01T00:00:01.000Z"),
			},
			{ role: "user", content: "SQLite message", timestamp: sqliteMessageTimestamp },
		]);
	});

	it("migrates legacy files discovered in a session directory and archives them", async () => {
		const path = join(tempDir, "legacy.jsonl");
		writeFileSync(path, legacySessionJsonl("auto-imported", tempDir));

		const sessions = await SessionManager.list(tempDir, tempDir);

		expect(sessions).toMatchObject([{ id: "auto-imported", firstMessage: "hello" }]);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(join(tempDir, "legacy-jsonl", "legacy.jsonl"))).toBe(true);
		const reopened = await SessionManager.open(sessions[0]!.ref);
		expect(reopened.getSessionId()).toBe("auto-imported");
	});
});

describe("SessionManager SQLite session behavior", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		tempDir = join(tmpdir(), `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(async () => {
		await managerOwner.drain();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createVisibleSession(cwd: string, id: string, label: string): Promise<SessionManager> {
		const session = await SessionManager.create(cwd, tempDir, { id });
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		await session.flush();
		return session;
	}

	it("scopes current-folder APIs by cwd while listing all sessions in one store", async () => {
		const sessionA = await createVisibleSession(projectA, "session-a", "from A");
		const sessionB = await createVisibleSession(projectB, "session-b", "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.ref)).toEqual([sessionA.getSessionRef()]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.id))).toEqual(new Set(["session-a", "session-b"]));
		expect(new Set(all.map((session) => session.ref.storeId))).toEqual(
			new Set([sessionA.getSessionRef()?.storeId, sessionB.getSessionRef()?.storeId]),
		);

		const continuedA = await SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionRef()).toEqual(sessionA.getSessionRef());
	});

	it("commits delivery receipts, messages, and planning as one verifiable transaction", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		manager.reserveClientInput("delivery-1", "prompt", { message: "hello" });
		await manager.flush();
		const planning = {
			mode: "plan" as const,
			plan: {
				id: "plan-1",
				revision: 1,
				phase: "draft" as const,
				steps: [{ id: "step-1", text: "Inspect", status: "pending" as const }],
			},
		};
		const message = {
			role: "user" as const,
			content: "hello",
			clientMessageId: "delivery-1",
			timestamp: Date.now(),
		};
		const identity = { deliveryId: "delivery", epoch: 2, attemptId: "attempt-1" };

		const receipt = await manager.commitDelivery({ ...identity, messages: [message], planning });
		const verified = manager.verifyDeliveryReceipt(receipt);

		expect(manager.getClientInput("delivery-1")).toMatchObject({ state: "completed" });
		expect(manager.buildSessionContext()).toMatchObject({ messages: [message], planning });
		expect(verified).toMatchObject({ outcome: "committed", ...identity, messages: [message], planning });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected persisted session reference");
		const reopened = await SessionManager.open(ref);
		expect(reopened.getClientInput("delivery-1")).toMatchObject({ state: "completed" });
		expect(reopened.buildSessionContext()).toMatchObject({ messages: [message], planning });
	});

	it("attests a no-effect delivery without changing persisted entries", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		manager.appendPlanningState({ mode: "build", plan: null });
		await manager.flush();
		const before = manager.getEntries();

		const receipt = await manager.attestDeliveryNoEffect({
			deliveryId: "no-effect",
			epoch: 1,
			attemptId: "attempt-1",
		});

		expect(manager.verifyDeliveryReceipt(receipt)?.outcome).toBe("no_effect");
		expect(manager.getEntries()).toEqual(before);
	});

	it("restores navigation to an earlier entry and to root", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		const firstTimestamp = Date.now();
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: firstTimestamp });
		manager.appendMessage({ role: "user", content: "second", timestamp: firstTimestamp + 1 });
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected persisted session reference");

		manager.branch(firstId);
		await manager.flush();
		let reopened = await SessionManager.open(ref);
		expect(reopened.getLeafId()).toBe(firstId);
		expect(reopened.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);

		reopened.resetLeaf();
		await reopened.flush();
		reopened = await SessionManager.open(ref);
		expect(reopened.getLeafId()).toBeNull();
		expect(reopened.getBranch()).toEqual([]);
	});

	it("persists canonical planning commands through a reference", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		await commitPlanningState(manager, "plan");
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected persisted session reference");

		expect((await SessionManager.open(ref)).buildSessionContext().planning).toEqual({ mode: "plan", plan: null });
	});
});
