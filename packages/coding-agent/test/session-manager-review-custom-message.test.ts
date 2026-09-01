import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";

describe("review custom-message sessions", () => {
	let tempDir: string;
	let cwd: string;
	let sessionDir: string;
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		tempDir = join(tmpdir(), `volt-review-custom-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "workspace");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		await managerOwner.drain();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists displayed review-only custom messages so they remain listable", async () => {
		const session = await SessionManager.create(cwd, sessionDir);
		const sessionRef = session.getSessionRef();
		expect(sessionRef).toBeDefined();
		expect(existsSync(join(sessionDir, "sessions.sqlite"))).toBe(true);

		session.appendCustomMessageEntry("review", "Automated review result\n\nFindings:\n1. Fix the bug", true, {
			findings: [{ title: "Fix the bug" }],
		});
		await session.flush();

		const sessions = await SessionManager.list(cwd, sessionDir);
		const summary = sessions.find((item) => item.id === session.getSessionId());

		expect(summary).toBeDefined();
		expect(summary).toMatchObject({
			messageCount: 1,
			firstMessage: "Automated review result\n\nFindings:\n1. Fix the bug",
		});
		expect((await SessionManager.search(cwd, "Fix the bug", sessionDir)).map((item) => item.ref)).toEqual([
			sessionRef,
		]);
	});

	it("uses displayed review custom messages in the current runtime summary", async () => {
		const sessionManager = await SessionManager.create(cwd, sessionDir);
		sessionManager.appendCustomMessageEntry("review", "Automated review result\n\nNo issues found.", true);

		const runtimeHost = new AgentSessionRuntime(
			{
				sessionManager,
				get sessionId() {
					return sessionManager.getSessionId();
				},
				get sessionName() {
					return undefined;
				},
			} as unknown as AgentSession,
			{ cwd } as unknown as AgentSessionServices,
			async () => {
				throw new Error("not used");
			},
		);

		const summaries = await runtimeHost.listSessions();

		expect(summaries[0]).toMatchObject({
			sessionId: sessionManager.getSessionId(),
			messageCount: 1,
			firstMessage: "Automated review result\n\nNo issues found.",
			current: true,
		});
	});
});
