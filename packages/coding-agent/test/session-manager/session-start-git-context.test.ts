import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcGitContext } from "../../src/core/rpc/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const STARTING_GIT_CONTEXT: RpcGitContext = {
	repository: "volt-app",
	head: {
		kind: "branch",
		name: "feature/work-organization",
		oid: "0123456789abcdef0123456789abcdef01234567",
	},
	upstream: null,
	base: null,
	status: {
		staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		untracked: 0,
		conflicted: 0,
		total: 0,
		clean: true,
	},
	operation: null,
	revision: 1,
	observedAt: "2026-08-29T00:00:00.000Z",
	stale: false,
};

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

describe("SessionManager starting Git context", () => {
	const tempDirs: string[] = [];

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "volt-session-start-git-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists only the first observation for a newly created session", async () => {
		const cwd = makeTempDir();
		const sessionDir = join(cwd, "sessions");
		const session = SessionManager.create(cwd, sessionDir, { id: "starting-git-session" });

		expect(session.recordStartingGitContext(session.getSessionId(), STARTING_GIT_CONTEXT)).toBe(true);
		expect(session.getStartingGitContext()).toEqual(STARTING_GIT_CONTEXT);
		expect(session.recordStartingGitContext(session.getSessionId(), null)).toBe(false);

		session.appendMessage(assistantMessage("persist the session"));
		expect(session.buildSessionContext().messages).toHaveLength(1);
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = SessionManager.open(sessionFile!, sessionDir);
		expect(reopened.getStartingGitContext()).toEqual(STARTING_GIT_CONTEXT);
		expect(reopened.recordStartingGitContext(reopened.getSessionId(), null)).toBe(false);

		const infos = await SessionManager.list(cwd, sessionDir);
		expect(infos).toHaveLength(1);
		expect(infos[0]?.startingGitContext).toEqual(STARTING_GIT_CONTEXT);
	});

	it("rejects a delayed observation for a replaced session id", () => {
		const session = SessionManager.inMemory(makeTempDir());
		const replacedSessionId = session.getSessionId();
		session.newSession({ id: "replacement" });

		expect(session.recordStartingGitContext(replacedSessionId, STARTING_GIT_CONTEXT)).toBe(false);
		expect(session.getStartingGitContext()).toBeUndefined();
	});

	it("rejects malformed current-format starting context on direct and enumerated reads", async () => {
		const cwd = makeTempDir();
		const sessionDir = join(cwd, "sessions");
		const session = SessionManager.create(cwd, sessionDir, { id: "malformed-starting-git" });
		session.recordStartingGitContext(session.getSessionId(), STARTING_GIT_CONTEXT);
		session.appendMessage(assistantMessage("persist the session"));
		await session.flush();
		const sessionFile = session.getSessionFile()!;
		const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const entryIndex = lines.findIndex((line) => line.includes('"type":"session_start_git_context"'));
		const entry = JSON.parse(lines[entryIndex]!) as { gitContext: { head: { oid: string } } };
		entry.gitContext.head.oid = "not-an-object-id";
		lines[entryIndex] = JSON.stringify(entry);
		writeFileSync(sessionFile, `${lines.join("\n")}\n`);

		expect(() => SessionManager.open(sessionFile, sessionDir)).toThrow(/invalid starting Git context/i);
		expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
	});
});
