import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/core/theme/runtime.ts";

function assistantMessage(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("SessionInfo.modified", () => {
	const tempDirs: string[] = [];
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("uses the latest user or assistant message timestamp instead of database mtime", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "volt-session-modified-"));
		tempDirs.push(sessionDir);
		const manager = await SessionManager.create("/tmp", sessionDir, { id: "test-session" });
		const firstMessageTime = Date.now();
		manager.appendMessage(assistantMessage("first", firstMessageTime));
		await manager.flush();

		const msgTime = firstMessageTime + 1;
		manager.appendMessage(assistantMessage("later", msgTime));
		await manager.flush();

		const sessions = await SessionManager.list("/tmp", sessionDir);
		const summary = sessions.find((session) => session.id === manager.getSessionId());
		expect(summary).toBeDefined();
		expect(summary?.ref).toEqual(manager.getSessionRef());
		expect(summary?.modified.getTime()).toBe(msgTime);
	});
});
