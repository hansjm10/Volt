import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("review custom-message sessions", () => {
	let tempDir: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-review-custom-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "workspace");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists displayed review-only custom messages so they remain listable", async () => {
		const session = SessionManager.create(cwd, sessionDir);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTruthy();
		expect(existsSync(sessionFile!)).toBe(false);

		session.appendCustomMessageEntry("review", "Automated review result\n\nFindings:\n1. Fix the bug", true, {
			findings: [{ title: "Fix the bug" }],
		});
		await session.flush();

		expect(existsSync(sessionFile!)).toBe(true);
		expect(readFileSync(sessionFile!, "utf8")).toContain('"type":"custom_message"');

		const sessions = await SessionManager.list(cwd, sessionDir);
		const summary = sessions.find((item) => item.id === session.getSessionId());

		expect(summary).toBeDefined();
		expect(summary).toMatchObject({
			messageCount: 1,
			firstMessage: "Automated review result\n\nFindings:\n1. Fix the bug",
		});
		expect(summary?.allMessagesText).toContain("Fix the bug");
	});

	it("uses displayed review custom messages in the current runtime summary", async () => {
		const sessionManager = SessionManager.create(cwd, sessionDir);
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
