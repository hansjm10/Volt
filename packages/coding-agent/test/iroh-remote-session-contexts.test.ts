import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getIrohRemoteRpcCommandCapabilities } from "../src/core/remote/iroh/access-grant.ts";
import { sanitizeIrohRemoteOutbound } from "../src/core/remote/iroh/outbound-filter.ts";
import {
	createIrohRemoteSessionContextsRpcBackend,
	handleIrohRemoteSessionContextsRpcCommand,
	IROH_REMOTE_SESSION_CONTEXTS_MAX_RESPONSE_BYTES,
	type IrohRemoteSessionContextsRpcBackend,
} from "../src/core/remote/iroh/session-contexts.ts";
import type { RpcGitContext, RpcSessionWorkContext } from "../src/core/rpc/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const gitContext: RpcGitContext = {
	repository: "Volt",
	head: { kind: "branch", name: "feature/work", oid: "0123456789abcdef0123456789abcdef01234567" },
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
	observedAt: "2026-08-30T00:00:00.000Z",
	stale: false,
};

const workContext: RpcSessionWorkContext = {
	changeId: "change-a",
	repository: "Volt",
	branch: "feature/work",
	resolutionState: "none",
};

function backend(): IrohRemoteSessionContextsRpcBackend {
	return {
		getSessionContexts: async (_workspaceName, sessionIds) =>
			sessionIds.map((sessionId, index) => ({
				sessionId,
				startingGitContext: index === 0 ? gitContext : null,
				workContext: index === 0 ? workContext : null,
			})),
	};
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("session_contexts workspace discovery", () => {
	test("returns one ordered explicit nullable result per requested id", async () => {
		const result = await handleIrohRemoteSessionContextsRpcCommand(
			{
				id: "request-1",
				type: "get_session_contexts",
				workspaceName: "volt",
				sessionIds: ["session-a", "session-b"],
			},
			{ authorizedWorkspaceName: "volt", backend: backend() },
		);
		expect(result).toMatchObject({
			handled: true,
			response: {
				id: "request-1",
				success: true,
				data: {
					contexts: [
						{ sessionId: "session-a", startingGitContext: gitContext, workContext },
						{ sessionId: "session-b", startingGitContext: null, workContext: null },
					],
				},
			},
		});
		if (result.handled) {
			expect(Buffer.byteLength(JSON.stringify(result.response), "utf8")).toBeLessThanOrEqual(
				IROH_REMOTE_SESSION_CONTEXTS_MAX_RESPONSE_BYTES,
			);
		}
	});

	test("rejects malformed, duplicate, oversized, and cross-workspace requests", async () => {
		const invalidCommands = [
			{ type: "get_session_contexts", workspaceName: "volt", sessionIds: [] },
			{ type: "get_session_contexts", workspaceName: "volt", sessionIds: ["session-a", "session-a"] },
			{ type: "get_session_contexts", workspaceName: "volt", sessionIds: ["BAD"] },
			{ type: "get_session_contexts", workspaceName: "volt", sessionIds: ["session-a"], extra: true },
			{ id: 123, type: "get_session_contexts", workspaceName: "volt", sessionIds: ["session-a"] },
			{
				type: "get_session_contexts",
				workspaceName: "volt",
				sessionIds: Array.from({ length: 65 }, (_, index) => `session-${index}`),
			},
		];
		for (const command of invalidCommands) {
			await expect(
				handleIrohRemoteSessionContextsRpcCommand(command, {
					authorizedWorkspaceName: "volt",
					backend: backend(),
				}),
			).resolves.toMatchObject({ handled: true, response: { success: false, error: "invalid_request" } });
		}
		await expect(
			handleIrohRemoteSessionContextsRpcCommand(
				{ type: "get_session_contexts", workspaceName: "other", sessionIds: ["session-a"] },
				{ authorizedWorkspaceName: "volt", backend: backend() },
			),
		).resolves.toMatchObject({ handled: true, response: { success: false, error: "session_mismatch" } });
	});

	test("passes successful context responses through outbound path sanitization", async () => {
		const result = await handleIrohRemoteSessionContextsRpcCommand(
			{ type: "get_session_contexts", workspaceName: "volt", sessionIds: ["session-a"] },
			{
				authorizedWorkspaceName: "volt",
				backend: {
					getSessionContexts: async () => [
						{
							sessionId: "session-a",
							startingGitContext: { ...gitContext, repository: "/Users/private/workspace" },
							workContext: { ...workContext, repository: "/Users/private/workspace" },
						},
					],
				},
			},
		);
		expect(result.handled).toBe(true);
		if (!result.handled) return;
		const sanitized = sanitizeIrohRemoteOutbound(result.response, {
			workspacePath: "/Users/private/workspace",
			remoteWorkspacePath: "/workspace",
		});
		expect(JSON.stringify(sanitized)).not.toContain("/Users/private/workspace");
		expect(JSON.stringify(sanitized)).toContain("/workspace");
	});

	test("contains malformed or reordered backend output", async () => {
		await expect(
			handleIrohRemoteSessionContextsRpcCommand(
				{
					id: "request-1",
					type: "get_session_contexts",
					workspaceName: "volt",
					sessionIds: ["session-a", "session-b"],
				},
				{
					authorizedWorkspaceName: "volt",
					backend: {
						getSessionContexts: async () => [
							{ sessionId: "session-b", startingGitContext: null, workContext: null },
							{ sessionId: "session-a", startingGitContext: null, workContext: null },
						],
					},
				},
			),
		).resolves.toMatchObject({ handled: true, response: { success: false, error: "request_failed" } });
	});

	test("backend combines live, targeted persisted, and Work-store context without all-session listing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-session-context-backend-"));
		temporaryDirectories.push(directory);
		const persistedId = "session-persisted";
		await writeFile(
			join(directory, `2026-08-30T00-00-00-000Z_${persistedId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: persistedId,
				timestamp: "2026-08-30T00:00:00.000Z",
				cwd: "/workspace",
			})}\n${JSON.stringify({
				type: "session_start_git_context",
				id: "entry-persisted",
				parentId: null,
				timestamp: "2026-08-30T00:00:01.000Z",
				ordinal: 1,
				gitContext,
			})}\n`,
		);
		const listSpy = vi.spyOn(SessionManager, "list");
		const workLookups: string[] = [];
		const sessionBackend = createIrohRemoteSessionContextsRpcBackend({
			workspaceName: "volt",
			sessionDirectory: directory,
			getLiveStartingGitContext: (sessionId) => (sessionId === "session-live" ? gitContext : undefined),
			getWorkContext: (sessionId) => {
				workLookups.push(sessionId);
				return sessionId === persistedId ? workContext : undefined;
			},
		});

		await expect(
			sessionBackend.getSessionContexts("volt", ["session-live", persistedId, "session-missing"]),
		).resolves.toEqual([
			{ sessionId: "session-live", startingGitContext: gitContext, workContext: null },
			{ sessionId: persistedId, startingGitContext: gitContext, workContext },
			{ sessionId: "session-missing", startingGitContext: null, workContext: null },
		]);
		expect(workLookups).toEqual(["session-live", persistedId, "session-missing"]);
		expect(listSpy).not.toHaveBeenCalled();
	});

	test("targeted starting Git lookup ignores unrelated history and validates the target header", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-session-contexts-"));
		temporaryDirectories.push(directory);
		const sessionId = "session-a";
		const header = {
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2026-08-30T00:00:00.000Z",
			cwd: "/workspace",
		};
		const starting = {
			type: "session_start_git_context",
			id: "entry-a",
			parentId: null,
			timestamp: "2026-08-30T00:00:01.000Z",
			ordinal: 1,
			gitContext,
		};
		await writeFile(
			join(directory, `2026-08-30T00-00-00-000Z_${sessionId}.jsonl`),
			`${JSON.stringify(header)}\n${JSON.stringify(starting)}\n`,
		);
		await writeFile(join(directory, "unrelated.jsonl"), "not json and never opened\n");

		const contexts = await SessionManager.readStartingGitContexts(directory, [sessionId, "session-missing"]);
		expect(contexts.get(sessionId)).toEqual(gitContext);
		expect(contexts.get("session-missing")).toBeNull();

		await writeFile(
			join(directory, "2026-08-30T00-00-01-000Z_session-b.jsonl"),
			`${JSON.stringify({ ...header, id: "wrong-id" })}\n`,
		);
		await expect(SessionManager.readStartingGitContexts(directory, ["session-b"])).rejects.toThrow("invalid header");
	});

	test("requires conversation observation authority", () => {
		expect(getIrohRemoteRpcCommandCapabilities({ type: "get_session_contexts" } as never)).toEqual([
			"conversation.observe.v1",
		]);
	});
});
