import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function createSessionWithMissingCwd(sessionDir: string, missingCwd: string): Promise<SessionReference> {
	const manager = await SessionManager.create(missingCwd, sessionDir, { id: "session-id" });
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("Expected a persisted session reference");
	return ref;
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => managerOwner.start());

	afterEach(async () => {
		await managerOwner.drain();
		vi.restoreAllMocks();
		for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("detects missing session cwd from persisted sessions", async () => {
		const fallbackCwd = createTempDir("volt-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("volt-session-cwd-session-dir");
		cleanupPaths.push(fallbackCwd, sessionDir);
		const ref = await createSessionWithMissingCwd(sessionDir, missingCwd);

		const sessionManager = await SessionManager.open(ref);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toEqual({
			sessionRef: ref,
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("supports overriding the effective cwd when opening a session", async () => {
		const fallbackCwd = createTempDir("volt-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("volt-session-cwd-override-session-dir");
		cleanupPaths.push(fallbackCwd, sessionDir);
		const ref = await createSessionWithMissingCwd(sessionDir, missingCwd);

		const sessionManager = await SessionManager.open(ref, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("closes a consumed manager and retains its row when the runtime factory fails", async () => {
		const cwd = createTempDir("volt-session-runtime-factory");
		const sessionDir = createTempDir("volt-session-runtime-factory-store");
		cleanupPaths.push(cwd, sessionDir);
		const sessionManager = await SessionManager.create(cwd, sessionDir, { id: "failed-runtime-factory" });
		const ref = sessionManager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const setupError = new Error("injected runtime factory failure");
		const closePersistence = vi.spyOn(sessionManager, "closePersistence");
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			throw setupError;
		};

		await expect(createAgentSessionRuntime(createRuntime, { cwd, agentDir: cwd, sessionManager })).rejects.toBe(
			setupError,
		);
		expect(closePersistence).toHaveBeenCalledOnce();
		expect(() => sessionManager.appendSessionInfo("late write")).toThrow("Session persistence is closed");
		expect(await SessionManager.findForResume(sessionDir, ref.sessionId)).toEqual(ref);
	});

	it("preserves runtime factory and manager close failures", async () => {
		const cwd = createTempDir("volt-session-runtime-close-failure");
		cleanupPaths.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		const setupError = new Error("injected runtime factory failure");
		const closeError = new Error("injected manager close failure");
		vi.spyOn(sessionManager, "closePersistence").mockRejectedValue(closeError);
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			throw setupError;
		};

		const error = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: cwd,
			sessionManager,
		}).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([setupError, closeError]);
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("volt-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("volt-session-cwd-runtime-session-dir");
		cleanupPaths.push(fallbackCwd, sessionDir);
		const ref = await createSessionWithMissingCwd(sessionDir, missingCwd);
		const sessionManager = await SessionManager.open(ref);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
		expect(() => sessionManager.appendSessionInfo("late write")).toThrow("Session persistence is closed");
		expect(await SessionManager.findForResume(sessionDir, ref.sessionId)).toEqual(ref);
	});
});
