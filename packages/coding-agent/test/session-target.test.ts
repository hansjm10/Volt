import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IrohRemoteOutcomeError } from "../src/core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../src/core/session-store/index.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	resolveIrohRemoteSessionTarget,
	type SessionTargetSessionStore,
} from "../src/daemon/session-target.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";

interface FakeHandle {
	getSessionId(): string;
	getSessionRef(): SessionReference | undefined;
}

interface FakeStore extends SessionTargetSessionStore<FakeHandle> {
	createdIds: string[];
	openedRefs: SessionReference[];
}

const WORKSPACE = { name: "volt", path: "/tmp/volt-workspace" };

function ref(id: string, sessionDirectory = "/s", storeId = "store"): SessionReference {
	return { sessionDirectory, storeId, sessionId: id, sessionGeneration: `generation-${id}` };
}

function createFakeStore(existing: Array<{ id: string; ref: SessionReference }> = []): FakeStore {
	let createSequence = 0;
	const store: FakeStore = {
		createdIds: [],
		openedRefs: [],
		async list() {
			return existing;
		},
		async open(sessionRef) {
			store.openedRefs.push(sessionRef);
			const session = existing.find((entry) => entry.ref === sessionRef);
			if (!session) throw new Error(`unexpected open: ${sessionRef.sessionId}`);
			return {
				getSessionId: () => session.id,
				getSessionRef: () => session.ref,
			};
		},
		async create(requestedId) {
			const id = requestedId ?? `fresh-${++createSequence}`;
			store.createdIds.push(id);
			return {
				getSessionId: () => id,
				getSessionRef: () => undefined,
			};
		},
	};
	return store;
}

async function resolve(target: IrohRemoteSessionTarget, store: FakeStore) {
	return resolveIrohRemoteSessionTarget(target, WORKSPACE, store);
}

describe("resolveIrohRemoteSessionTarget", () => {
	it("creates the caller-named session for target new", async () => {
		const store = createFakeStore([{ id: "existing", ref: ref("existing") }]);
		const resolved = await resolve({ kind: "new", sessionId: "caller-session" }, store);
		expect(resolved.selection).toBe("created");
		expect(resolved.sessionId).toBe("caller-session");
		expect(resolved.requestedSessionId).toBeUndefined();
		expect(resolved.sessionRef).toBeUndefined();
		expect(resolved.workspaceName).toBe("volt");
		expect(resolved.workspacePath).toBe("/tmp/volt-workspace");
		expect(store.createdIds).toEqual(["caller-session"]);
		expect(store.openedRefs).toEqual([]);
	});

	it("resumes the same caller-named session on retry", async () => {
		const sessionRef = ref("caller-session");
		const store = createFakeStore([{ id: "caller-session", ref: sessionRef }]);
		const resolved = await resolve({ kind: "new", sessionId: "caller-session" }, store);
		expect(resolved.selection).toBe("resumed");
		expect(resolved.sessionId).toBe("caller-session");
		expect(resolved.requestedSessionId).toBeUndefined();
		expect(resolved.sessionRef).toEqual(sessionRef);
		expect(store.openedRefs).toEqual([sessionRef]);
	});

	it("creates a fresh session for target last without a remembered id", async () => {
		const store = createFakeStore([{ id: "existing", ref: ref("existing") }]);
		const resolved = await resolve({ kind: "last" }, store);
		expect(resolved.selection).toBe("created");
		expect(resolved.requestedSessionId).toBeUndefined();
		expect(store.createdIds).toEqual(["fresh-1"]);
	});

	it("resumes target last when the remembered session exists", async () => {
		const sessionRef = ref("existing");
		const store = createFakeStore([{ id: "existing", ref: sessionRef }]);
		const resolved = await resolve({ kind: "last", resumeSessionId: "existing" }, store);
		expect(resolved.selection).toBe("resumed");
		expect(resolved.sessionId).toBe("existing");
		expect(resolved.requestedSessionId).toBe("existing");
		expect(resolved.sessionRef).toEqual(sessionRef);
		expect(store.openedRefs).toEqual([sessionRef]);
		expect(store.createdIds).toEqual([]);
	});

	it("creates after missing for target last when the remembered session is gone", async () => {
		const store = createFakeStore([]);
		const resolved = await resolve({ kind: "last", resumeSessionId: "gone" }, store);
		expect(resolved.selection).toBe("created_after_missing");
		expect(resolved.sessionId).toBe("fresh-1");
		expect(resolved.requestedSessionId).toBe("gone");
	});

	it("creates after missing for target last with an invalid remembered id", async () => {
		const store = createFakeStore([]);
		const resolved = await resolve({ kind: "last", resumeSessionId: "NOT VALID!" }, store);
		expect(resolved.selection).toBe("created_after_missing");
		expect(resolved.requestedSessionId).toBe("NOT VALID!");
		expect(store.openedRefs).toEqual([]);
	});

	it("resumes target session when the session exists", async () => {
		const two = ref("two");
		const store = createFakeStore([
			{ id: "one", ref: ref("one") },
			{ id: "two", ref: two },
		]);
		const resolved = await resolve({ kind: "session", sessionId: "two" }, store);
		expect(resolved.selection).toBe("resumed");
		expect(resolved.sessionId).toBe("two");
		expect(resolved.requestedSessionId).toBe("two");
		expect(store.openedRefs).toEqual([two]);
	});

	it("throws session_unavailable for a missing or invalid explicit session", async () => {
		const store = createFakeStore([]);
		for (const sessionId of ["missing", "NOT VALID!"]) {
			const error = await resolve({ kind: "session", sessionId }, store).catch((thrown) => thrown);
			expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
			expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
		}
		expect(store.createdIds).toEqual([]);
	});

	it("returns the session manager handle it resolved", async () => {
		const store = createFakeStore([{ id: "existing", ref: ref("existing") }]);
		const resolved = await resolve({ kind: "session", sessionId: "existing" }, store);
		expect(resolved.sessionManager.getSessionId()).toBe("existing");
	});

	it("fails closed if a resume target changes identity between lookup and open", async () => {
		const expectedRef = ref("expected");
		const store = createFakeStore([{ id: "expected", ref: expectedRef }]);
		store.find = async () => expectedRef;
		store.open = async () => ({
			getSessionId: () => "replacement",
			getSessionRef: () => ref("replacement"),
		});

		const error = await resolve({ kind: "session", sessionId: "expected" }, store).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
		expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
	});

	it("fails closed when strict lookup reports corrupt or ambiguous state", async () => {
		const store = createFakeStore([]);
		store.find = async () => {
			throw new Error("ambiguous store state");
		};

		const error = await resolve({ kind: "last", resumeSessionId: "expected" }, store).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
		expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
		expect(store.createdIds).toEqual([]);
	});

	it("strictly resumes selector-hidden WAL-only SQLite sessions with one snapshot load", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-session-target-wal-"));
		const managerOwner = createSessionManagerTestOwner();
		managerOwner.start();
		try {
			const manager = await SessionManager.create(tempDir, tempDir, { id: "wal-only-resume" });
			manager.reserveClientInput("handled-terminal", "prompt", { message: "/handled" });
			manager.transitionClientInput("handled-terminal", "started");
			manager.transitionClientInput("handled-terminal", "completed");
			await manager.flush();
			const managerRef = manager.getSessionRef();
			if (!managerRef) throw new Error("Expected a persisted session reference");
			expect(await SessionManager.listAll(tempDir)).toEqual([]);

			const loadSession = vi.spyOn(SQLiteSessionStoreClient.prototype, "loadSession");
			try {
				const store = createSessionManagerTargetStore(tempDir, tempDir, {
					listAll: true,
					preserveSessionCwd: true,
				});
				const resumed = await resolveIrohRemoteSessionTarget(
					{ kind: "session", sessionId: "wal-only-resume" },
					{ name: "volt", path: tempDir },
					store,
				);
				expect(resumed.selection).toBe("resumed");
				expect(resumed.sessionRef).toEqual(managerRef);
				expect(resumed.sessionManager.getClientInput("handled-terminal")?.state).toBe("completed");
				expect(loadSession).toHaveBeenCalledTimes(1);
				expect(loadSession).toHaveBeenCalledWith(managerRef.sessionId, managerRef.sessionGeneration);
			} finally {
				loadSession.mockRestore();
			}
		} finally {
			await managerOwner.drain();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
