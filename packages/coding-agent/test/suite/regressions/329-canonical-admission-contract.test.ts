import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_SNAPSHOT_VERSION,
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "../../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../../session-manager-owner.ts";

const SESSION_ID_MAX_CHARACTERS = 512;
const SNAPSHOT_TIMESTAMP = "2026-09-03T12:00:00.000Z";
const managerOwner = createSessionManagerTestOwner();

let root: string;

function captureError(operation: () => unknown): unknown {
	try {
		operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

async function captureAsyncError(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

async function durableSessionIds(cwd: string, sessionDir: string): Promise<string[]> {
	return (
		await SessionManager.list(cwd, sessionDir, undefined, {
			includeMessageFreeDurable: true,
		})
	).map((session) => session.id);
}

function leafOnlySnapshot(cwd: string, id: string): [Record<string, unknown>, Record<string, unknown>] {
	return [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
			id,
			timestamp: SNAPSHOT_TIMESTAMP,
			cwd,
		},
		{
			type: "leaf",
			id: "snapshot-leaf",
			parentId: null,
			ordinal: 1,
			timestamp: SNAPSHOT_TIMESTAMP,
			targetId: null,
		},
	];
}

beforeEach(() => {
	managerOwner.start();
	root = mkdtempSync(join(tmpdir(), "volt-329-canonical-admission-"));
});

afterEach(async () => {
	try {
		await managerOwner.drain();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("PR #329 canonical entry admission contract", () => {
	it("rejects a schema-invalid branch summary before moving or persisting the leaf", async () => {
		const sessionDir = join(root, "branch-store");
		const manager = await SessionManager.create(root, sessionDir, { id: "branch-admission" });
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		const entryNotifications: string[] = [];
		const branchNotifications: Array<{ previousLeafId: string | null; nextLeafId: string | null }> = [];
		manager.subscribeEntries((entry) => entryNotifications.push(entry.id));
		manager.subscribeBranchChanges((change) => branchNotifications.push(change));

		const admissionError = captureError(() => manager.branchWithSummary(firstId, 42 as never));
		const stateAfterRejection = {
			leafId: manager.getLeafId(),
			entryIds: manager.getEntries().map((entry) => entry.id),
			entryNotifications: [...entryNotifications],
			branchNotifications: [...branchNotifications],
		};

		await manager.flush();
		const reopenedAfterRejection = await SessionManager.open(ref);
		const persistedAfterRejection = {
			leafId: reopenedAfterRejection.getLeafId(),
			entries: reopenedAfterRejection
				.getEntries()
				.map((entry) => ({ id: entry.id, ordinal: entry.ordinal, parentId: entry.parentId })),
		};

		const nextId = manager.appendSessionInfo("after rejected branch");
		await manager.flush();
		const reopenedAfterNextAppend = await SessionManager.open(ref);
		const nextEntry = reopenedAfterNextAppend.getEntry(nextId);

		expect({
			admissionRejected: admissionError instanceof Error,
			stateAfterRejection,
			persistedAfterRejection,
			nextEntry: nextEntry && { id: nextEntry.id, ordinal: nextEntry.ordinal, parentId: nextEntry.parentId },
		}).toEqual({
			admissionRejected: true,
			stateAfterRejection: {
				leafId: secondId,
				entryIds: [firstId, secondId],
				entryNotifications: [],
				branchNotifications: [],
			},
			persistedAfterRejection: {
				leafId: secondId,
				entries: [
					{ id: firstId, ordinal: 1, parentId: null },
					{ id: secondId, ordinal: 2, parentId: firstId },
				],
			},
			nextEntry: { id: nextId, ordinal: 3, parentId: secondId },
		});
	});

	it("rejects overlong public session IDs before replacing state or creating a SQLite row", async () => {
		const overlongId = "s".repeat(SESSION_ID_MAX_CHARACTERS + 1);
		const inMemory = SessionManager.inMemory(root);
		const originalId = inMemory.getSessionId();
		const replacementError = captureError(() => inMemory.newSession({ id: overlongId }));
		const sessionDir = join(root, "public-id-store");
		const creationError = await captureAsyncError(() => SessionManager.create(root, sessionDir, { id: overlongId }));

		expect({
			replacementRejected: replacementError instanceof Error,
			statePreserved: inMemory.getSessionId() === originalId && inMemory.getHeader()?.id === originalId,
			creationRejected: creationError instanceof Error,
			rowIds: await durableSessionIds(root, sessionDir),
		}).toEqual({
			replacementRejected: true,
			statePreserved: true,
			creationRejected: true,
			rowIds: [],
		});
	});

	it("accepts a 512-character public session ID across replacement, creation, and reference open", async () => {
		const boundaryId = "b".repeat(SESSION_ID_MAX_CHARACTERS);
		const inMemory = SessionManager.inMemory(root);
		inMemory.newSession({ id: boundaryId });
		const sessionDir = join(root, "boundary-id-store");
		const persisted = await SessionManager.create(root, sessionDir, { id: boundaryId });
		await persisted.flush();
		const ref = persisted.getSessionRef();
		if (!ref) throw new Error("Expected a persisted boundary session reference");
		const reopened = await SessionManager.open(ref);

		expect({
			inMemoryId: inMemory.getSessionId(),
			persistedId: persisted.getSessionId(),
			reopenedId: reopened.getSessionId(),
			rowIds: await durableSessionIds(root, sessionDir),
		}).toEqual({
			inMemoryId: boundaryId,
			persistedId: boundaryId,
			reopenedId: boundaryId,
			rowIds: [boundaryId],
		});
	});

	it("rejects overlong session-reference IDs before state replacement or child-row creation", async () => {
		const sourceDir = join(root, "reference-source-store");
		const source = await SessionManager.create(root, sourceDir, { id: "reference-seed" });
		const sourceRef = source.getSessionRef();
		if (!sourceRef) throw new Error("Expected a persisted session reference");
		const overlongRef = {
			...sourceRef,
			sessionId: "r".repeat(SESSION_ID_MAX_CHARACTERS + 1),
		};
		const inMemory = SessionManager.inMemory(root);
		const originalId = inMemory.getSessionId();
		const replacementError = captureError(() =>
			inMemory.newSession({ id: "reference-child", parentSession: overlongRef }),
		);
		const openError = await captureAsyncError(() => SessionManager.open(overlongRef));
		const targetDir = join(root, "reference-target-store");
		const creationError = await captureAsyncError(() =>
			SessionManager.create(root, targetDir, {
				id: "persisted-reference-child",
				parentSession: overlongRef,
			}),
		);

		expect({
			replacementRejected: replacementError instanceof Error,
			statePreserved: inMemory.getSessionId() === originalId && inMemory.getHeader()?.id === originalId,
			openRejected: openError instanceof Error,
			creationRejected: creationError instanceof Error,
			sourceRowIds: await durableSessionIds(root, sourceDir),
			targetRowIds: await durableSessionIds(root, targetDir),
		}).toEqual({
			replacementRejected: true,
			statePreserved: true,
			openRejected: true,
			creationRejected: true,
			sourceRowIds: ["reference-seed"],
			targetRowIds: [],
		});
	});

	it("rejects an overlong snapshot session ID even when import assigns a safe target ID", async () => {
		const snapshotPath = join(root, "overlong-snapshot-id.jsonl");
		const records = leafOnlySnapshot(root, "h".repeat(SESSION_ID_MAX_CHARACTERS + 1));
		writeFileSync(snapshotPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const sessionDir = join(root, "snapshot-id-store");
		const importError = await captureAsyncError(() =>
			SessionManager.importFromJsonl(snapshotPath, root, sessionDir, { id: "safe-import-target" }),
		);

		expect({
			importRejected: importError instanceof Error,
			rowIds: await durableSessionIds(root, sessionDir),
		}).toEqual({
			importRejected: true,
			rowIds: [],
		});
	});

	it("rejects overlong subagent session IDs before entry admission or persistence", async () => {
		const sessionDir = join(root, "subagent-store");
		const manager = await SessionManager.create(root, sessionDir, { id: "subagent-parent" });
		const parentEntryId = manager.appendMessage({ role: "user", content: "delegate", timestamp: 1 });
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const overlongId = "c".repeat(SESSION_ID_MAX_CHARACTERS + 1);

		const admissionError = captureError(() =>
			manager.appendSubagentSpawn({
				toolCallId: "call-overlong",
				subagentId: "sa_overlong",
				agent: "researcher",
				childSessionId: overlongId,
				childSessionRef: { ...ref, sessionId: overlongId },
				requestKey: "request-overlong",
			}),
		);
		const spawnsAfterRejection = manager.getSubagentSpawnEntries();
		const nextId = manager.appendSessionInfo("after rejected spawn");
		await manager.flush();
		const reopened = await SessionManager.open(ref);
		const nextEntry = reopened.getEntry(nextId);

		expect({
			admissionRejected: admissionError instanceof Error,
			spawnCountAfterRejection: spawnsAfterRejection.length,
			nextEntry: nextEntry && { ordinal: nextEntry.ordinal, parentId: nextEntry.parentId },
			persistedSpawnCount: reopened.getSubagentSpawnEntries().length,
		}).toEqual({
			admissionRejected: true,
			spawnCountAfterRejection: 0,
			nextEntry: { ordinal: 2, parentId: parentEntryId },
			persistedSpawnCount: 0,
		});
	});

	it("rejects a committed blank record through the public JSONL snapshot importer", async () => {
		const snapshotPath = join(root, "blank-record.jsonl");
		const records = leafOnlySnapshot(root, "blank-record-snapshot");
		writeFileSync(snapshotPath, `${JSON.stringify(records[0])}\n \t\n${JSON.stringify(records[1])}\n`);
		const sessionDir = join(root, "blank-record-store");
		const importError = await captureAsyncError(() => SessionManager.importFromJsonl(snapshotPath, root, sessionDir));

		expect({
			importRejected: importError instanceof Error,
			rowIds: await durableSessionIds(root, sessionDir),
		}).toEqual({
			importRejected: true,
			rowIds: [],
		});
	});
});
