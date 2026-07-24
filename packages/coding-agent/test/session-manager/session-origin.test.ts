import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/** Session files only flush once assistant content exists. */
function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as Message;
}

describe("SessionManager session origin", () => {
	const tempDirs: string[] = [];

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "volt-session-origin-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists the subagent origin in the header and surfaces it through list()", async () => {
		const cwd = makeTempDir();
		const sessionDir = join(cwd, "sessions");

		const userSession = SessionManager.create(cwd, sessionDir);
		userSession.appendMessage(assistantMessage("user session reply"));

		const subagentSession = SessionManager.create(cwd, sessionDir, { origin: "subagent" });
		subagentSession.appendMessage(assistantMessage("delegated run reply"));
		expect(subagentSession.getHeader()?.origin).toBe("subagent");
		await Promise.all([userSession.flush(), subagentSession.flush()]);

		const infos = await SessionManager.list(cwd, sessionDir);
		const byId = new Map(infos.map((info) => [info.id, info]));
		expect(byId.get(subagentSession.getSessionId())?.origin).toBe("subagent");
		expect(byId.get(userSession.getSessionId())?.origin).toBeUndefined();
	});

	it("keeps the subagent origin on branched sessions", () => {
		const cwd = makeTempDir();
		const session = SessionManager.create(cwd, join(cwd, "sessions"), { origin: "subagent" });
		const entryId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "delegated task" }],
			timestamp: 1,
		});

		session.createBranchedSession(entryId);

		expect(session.getHeader()?.origin).toBe("subagent");
	});

	it("does not write an origin for plain sessions", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		expect(session.getHeader()?.origin).toBeUndefined();
	});
});
