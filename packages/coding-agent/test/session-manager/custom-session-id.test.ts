import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

const managerOwner = createSessionManagerTestOwner();
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-session-manager-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager.newSession with custom id", () => {
	it("uses the provided id instead of generating one", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("allows alphanumeric session ids with interior punctuation", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "abc-123_def.456" });
		expect(session.getSessionId()).toBe("abc-123_def.456");
	});

	it("rejects invalid custom session ids", () => {
		const invalidIds = ["", "-abc", "abc-", "_abc", "abc_", ".abc", "abc.", "abc/def", "abc\\def", "abc def"];

		for (const id of invalidIds) {
			const session = SessionManager.inMemory();
			expect(() => session.newSession({ id })).toThrow(
				"Session id must be non-empty, contain only alphanumeric characters",
			);
		}
	});

	it("generates a UUIDv7 id when no id is provided", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
	});

	it("generates a UUIDv7 id when options are provided without an id", () => {
		const session = SessionManager.inMemory();
		const parentSession: SessionReference = {
			sessionDirectory: "/tmp/sessions",
			storeId: "parent-store",
			sessionGeneration: "generation-test",
			sessionId: "parent",
		};
		session.newSession({ parentSession });
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()?.parentSession).toEqual(parentSession);
	});

	it("includes the custom id in the session header", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "header-test-id" });

		expect(session.getHeader()).toMatchObject({ id: "header-test-id" });
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()?.id).toBe(session.getSessionId());
	});

	it("uses the provided id and exposes a stable reference for a persisted session", async () => {
		const tempDir = makeTempDir();
		const session = await SessionManager.create(tempDir, tempDir, { id: "created-session-id" });

		expect(session.getSessionId()).toBe("created-session-id");
		expect(session.getHeader()?.id).toBe("created-session-id");
		expect(session.getSessionRef()).toMatchObject({
			sessionDirectory: tempDir,
			sessionId: "created-session-id",
			storeId: expect.any(String),
		});
	});

	it("generates a UUIDv7 id when creating a branched session", async () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		await session.createBranchedSession(firstId);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()?.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id and records the parent reference when forking", async () => {
		const tempDir = makeTempDir();
		const source = await SessionManager.create(tempDir, tempDir, { id: "source-session-id" });
		const sourceRef = source.getSessionRef();
		if (!sourceRef) throw new Error("Expected a persisted source reference");

		const forked = await SessionManager.forkFrom(sourceRef, tempDir, tempDir);

		expect(forked.getSessionId()).toMatch(UUID_V7_RE);
		expect(forked.getHeader()?.parentSession).toEqual(sourceRef);
		expect(forked.getSessionRef()?.sessionId).toBe(forked.getSessionId());
	});

	it("uses the provided id when forking", async () => {
		const tempDir = makeTempDir();
		const source = await SessionManager.create(tempDir, tempDir, { id: "source-session-id" });
		const sourceRef = source.getSessionRef();
		if (!sourceRef) throw new Error("Expected a persisted source reference");

		const forked = await SessionManager.forkFrom(sourceRef, tempDir, tempDir, { id: "forked-session-id" });

		expect(forked.getHeader()).toMatchObject({ id: "forked-session-id", parentSession: sourceRef });
		expect(forked.getSessionRef()).toMatchObject({
			sessionDirectory: tempDir,
			storeId: sourceRef.storeId,
			sessionGeneration: expect.any(String),
			sessionId: "forked-session-id",
		});
		expect(forked.getSessionRef()?.sessionGeneration).not.toBe(sourceRef.sessionGeneration);
	});
});
