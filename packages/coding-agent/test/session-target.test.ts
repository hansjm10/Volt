import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IrohRemoteOutcomeError } from "../src/core/remote/iroh/protocol.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	resolveIrohRemoteSessionTarget,
	type SessionTargetSessionStore,
} from "../src/daemon/session-target.ts";

interface FakeHandle {
	getSessionId(): string;
	getSessionFile(): string | undefined;
}

interface FakeStore extends SessionTargetSessionStore<FakeHandle> {
	createdIds: string[];
	openedPaths: string[];
}

const WORKSPACE = { name: "volt", path: "/tmp/volt-workspace" };

function createFakeStore(existing: Array<{ id: string; path: string }> = []): FakeStore {
	let createSequence = 0;
	const store: FakeStore = {
		createdIds: [],
		openedPaths: [],
		async list() {
			return existing;
		},
		open(path: string) {
			store.openedPaths.push(path);
			const session = existing.find((entry) => entry.path === path);
			if (!session) {
				throw new Error(`unexpected open: ${path}`);
			}
			return {
				getSessionId: () => session.id,
				getSessionFile: () => session.path,
			};
		},
		create(requestedId) {
			const id = requestedId ?? `fresh-${++createSequence}`;
			store.createdIds.push(id);
			return {
				getSessionId: () => id,
				getSessionFile: () => undefined,
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
		const store = createFakeStore([{ id: "existing", path: "/s/existing.jsonl" }]);
		const resolved = await resolve({ kind: "new", sessionId: "caller-session" }, store);
		expect(resolved.selection).toBe("created");
		expect(resolved.sessionId).toBe("caller-session");
		expect(resolved.requestedSessionId).toBeUndefined();
		expect(resolved.sessionFilePath).toBeUndefined();
		expect(resolved.workspaceName).toBe("volt");
		expect(resolved.workspacePath).toBe("/tmp/volt-workspace");
		expect(store.createdIds).toEqual(["caller-session"]);
		expect(store.openedPaths).toEqual([]);
	});

	it("resumes the same caller-named session on retry", async () => {
		const store = createFakeStore([{ id: "caller-session", path: "/s/caller-session.jsonl" }]);
		const resolved = await resolve({ kind: "new", sessionId: "caller-session" }, store);
		expect(resolved.selection).toBe("resumed");
		expect(resolved.sessionId).toBe("caller-session");
		expect(resolved.requestedSessionId).toBeUndefined();
		expect(store.createdIds).toEqual([]);
		expect(store.openedPaths).toEqual(["/s/caller-session.jsonl"]);
	});

	it("creates a fresh session for target last without a remembered id", async () => {
		const store = createFakeStore([{ id: "existing", path: "/s/existing.jsonl" }]);
		const resolved = await resolve({ kind: "last" }, store);
		expect(resolved.selection).toBe("created");
		expect(resolved.requestedSessionId).toBeUndefined();
		expect(store.createdIds).toEqual(["fresh-1"]);
	});

	it("resumes target last when the remembered session exists", async () => {
		const store = createFakeStore([{ id: "existing", path: "/s/existing.jsonl" }]);
		const resolved = await resolve({ kind: "last", resumeSessionId: "existing" }, store);
		expect(resolved.selection).toBe("resumed");
		expect(resolved.sessionId).toBe("existing");
		expect(resolved.requestedSessionId).toBe("existing");
		expect(resolved.sessionFilePath).toBe("/s/existing.jsonl");
		expect(store.openedPaths).toEqual(["/s/existing.jsonl"]);
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
		// Invalid syntax must not even hit the session list.
		expect(store.openedPaths).toEqual([]);
	});

	it("resumes target session when the session exists", async () => {
		const store = createFakeStore([
			{ id: "one", path: "/s/one.jsonl" },
			{ id: "two", path: "/s/two.jsonl" },
		]);
		const resolved = await resolve({ kind: "session", sessionId: "two" }, store);
		expect(resolved.selection).toBe("resumed");
		expect(resolved.sessionId).toBe("two");
		expect(resolved.requestedSessionId).toBe("two");
		expect(store.openedPaths).toEqual(["/s/two.jsonl"]);
	});

	it("throws session_unavailable for target session naming a missing id", async () => {
		const store = createFakeStore([]);
		const error = await resolve({ kind: "session", sessionId: "missing" }, store).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
		expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
		expect(store.createdIds).toEqual([]);
	});

	it("throws session_unavailable for target session with invalid id syntax", async () => {
		const store = createFakeStore([]);
		const error = await resolve({ kind: "session", sessionId: "NOT VALID!" }, store).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
		expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
	});

	it("returns the session manager handle it resolved", async () => {
		const store = createFakeStore([{ id: "existing", path: "/s/existing.jsonl" }]);
		const resolved = await resolve({ kind: "session", sessionId: "existing" }, store);
		expect(resolved.sessionManager.getSessionId()).toBe("existing");
	});

	it("fails closed if a resume target changes identity between lookup and open", async () => {
		const store = createFakeStore([{ id: "expected", path: "/s/expected.jsonl" }]);
		store.find = async () => ({ id: "expected", path: "/s/expected.jsonl" });
		store.open = () => ({
			getSessionId: () => "replacement",
			getSessionFile: () => "/s/expected.jsonl",
		});

		const error = await resolve({ kind: "session", sessionId: "expected" }, store).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
		expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
	});

	it("strictly resumes selector-hidden WAL-only sessions and never downgrades target corruption to missing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-session-target-wal-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir, { id: "wal-only-resume" });
			manager.reserveClientInput("handled-terminal", "prompt", { message: "/handled" });
			manager.transitionClientInput("handled-terminal", "started");
			manager.transitionClientInput("handled-terminal", "completed");
			await manager.flush();
			const sessionFile = manager.getSessionFile()!;
			expect(await SessionManager.listAll(tempDir)).toEqual([]);

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
			expect(resumed.sessionFilePath).toBe(sessionFile);
			expect(resumed.sessionManager.getClientInput("handled-terminal")?.state).toBe("completed");

			// A duplicate durable identity is equally ambiguous and must not pick a
			// winner based on directory enumeration order.
			const duplicateFile = join(tempDir, "duplicate.jsonl");
			copyFileSync(sessionFile, duplicateFile);
			const duplicateError = await resolveIrohRemoteSessionTarget(
				{ kind: "session", sessionId: "wal-only-resume" },
				{ name: "volt", path: tempDir },
				store,
			).catch((thrown) => thrown);
			expect(duplicateError).toBeInstanceOf(IrohRemoteOutcomeError);
			expect((duplicateError as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
			unlinkSync(duplicateFile);

			appendFileSync(sessionFile, '{"type":"client_input_state"\n');
			const before = readdirSync(tempDir).filter((name) => name.endsWith(".jsonl"));
			const error = await resolveIrohRemoteSessionTarget(
				{ kind: "last", resumeSessionId: "wal-only-resume" },
				{ name: "volt", path: tempDir },
				store,
			).catch((thrown) => thrown);
			expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
			expect((error as IrohRemoteOutcomeError).outcome).toBe("session_unavailable");
			expect(readdirSync(tempDir).filter((name) => name.endsWith(".jsonl"))).toEqual(before);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
