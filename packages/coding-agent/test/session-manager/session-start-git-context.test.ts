import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		const session = await SessionManager.create(cwd, sessionDir, { id: "starting-git-session" });

		expect(session.recordStartingGitContext(session.getSessionId(), STARTING_GIT_CONTEXT)).toBe(true);
		expect(session.getStartingGitContext()).toEqual(STARTING_GIT_CONTEXT);
		expect(session.recordStartingGitContext(session.getSessionId(), null)).toBe(false);

		session.appendMessage(assistantMessage("persist the session"));
		expect(session.buildSessionContext().messages).toHaveLength(1);
		await session.flush();

		const sessionRef = session.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted session reference");
		const reopened = await SessionManager.open(sessionRef);
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

	it("rejects malformed starting context during explicit JSONL import", async () => {
		const cwd = makeTempDir();
		const sessionDir = join(cwd, "sessions");
		const inputPath = join(cwd, "malformed-starting-git.jsonl");
		const malformedContext = structuredClone(STARTING_GIT_CONTEXT);
		if (!("oid" in malformedContext.head)) throw new Error("Expected an oid-bearing Git head");
		malformedContext.head.oid = "not-an-object-id";
		writeFileSync(
			inputPath,
			`${[
				JSON.stringify({
					type: "session",
					version: 5,
					id: "malformed-starting-git",
					timestamp: "2026-08-29T00:00:00.000Z",
					cwd,
				}),
				JSON.stringify({
					type: "session_start_git_context",
					id: "git-context",
					parentId: null,
					ordinal: 1,
					timestamp: "2026-08-29T00:00:01.000Z",
					gitContext: malformedContext,
				}),
			].join("\n")}\n`,
		);

		await expect(SessionManager.importFromJsonl(inputPath, cwd, sessionDir)).rejects.toThrow(
			/invalid starting Git context/i,
		);
		expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
	});
});
