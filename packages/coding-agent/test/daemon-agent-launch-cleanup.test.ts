import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { cleanupIncompleteAgentLaunch } from "../src/daemon/agent-launch-cleanup.ts";

const cleanupPaths: string[] = [];

interface LaunchFixture {
	manager: SessionManager;
	record: NonNullable<ReturnType<SessionManager["getAgentLaunchRecord"]>>;
	sessionFile: string;
	workspace: { name: string; path: string };
}

async function createLaunchFixture(committed = false): Promise<LaunchFixture> {
	const workspacePath = await mkdtemp(join(tmpdir(), "volt-launch-reconcile-"));
	cleanupPaths.push(workspacePath);
	const sessionDir = join(workspacePath, "sessions");
	const manager = SessionManager.create(workspacePath, sessionDir, { id: "agent-session" });
	const receipt = manager.appendAgentLaunchReceipt({
		launchId: "launch-1",
		requestDigest: "digest-1",
		request: {
			launchId: "launch-1",
			catalogRevision: "revision-1",
			placement: { kind: "new_worktree", worktreeName: "launch-worktree" },
			config: { fastModeEnabled: false, agentMode: "build" },
		},
		placement: {
			kind: "worktree",
			worktreeId: "launch-worktree",
			branch: "volt/launch-worktree",
			created: true,
		},
		config: {
			kind: "configured",
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			fastModeEnabled: false,
			agentMode: "build",
		},
	});
	if (committed) manager.appendAgentLaunchCommit(receipt.id, "launch-1");
	await manager.flush();
	return {
		manager,
		record: manager.getAgentLaunchRecord("launch-1")!,
		sessionFile: manager.getSessionFile()!,
		workspace: { name: "volt", path: workspacePath },
	};
}

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("incomplete agent launch startup reconciliation", () => {
	test.each(["returned failure", "thrown failure"])(
		"retains the receipt after a %s and removes it on a later successful cleanup",
		async (failureKind) => {
			const fixture = await createLaunchFixture();
			const log = vi.fn();
			const failedRemove = vi.fn(async () => {
				if (failureKind === "thrown failure") throw new Error("remove threw");
				return { ok: false as const, error: "worktree_busy" };
			});

			await expect(
				cleanupIncompleteAgentLaunch({
					workspace: fixture.workspace,
					sessionId: "agent-session",
					sessionFile: fixture.sessionFile,
					record: fixture.record,
					removeWorktree: failedRemove,
					log,
				}),
			).resolves.toEqual({ kind: "cleanup_required", worktreeId: "launch-worktree" });
			expect(existsSync(fixture.sessionFile)).toBe(true);
			expect(log).toHaveBeenCalledWith(
				"incomplete agent launch cleanup requires retry",
				expect.objectContaining({
					workspace: "volt",
					launchId: "launch-1",
					sessionId: "agent-session",
					worktreeId: "launch-worktree",
				}),
			);

			const removeWorktree = vi.fn(async () => {
				expect(existsSync(fixture.sessionFile)).toBe(true);
				return { ok: true as const };
			});
			await expect(
				cleanupIncompleteAgentLaunch({
					workspace: fixture.workspace,
					sessionId: "agent-session",
					sessionFile: fixture.sessionFile,
					record: fixture.record,
					removeWorktree,
				}),
			).resolves.toEqual({ kind: "cleaned" });
			expect(removeWorktree).toHaveBeenCalledWith(fixture.workspace, "launch-worktree");
			expect(existsSync(fixture.sessionFile)).toBe(false);
		},
	);

	test("removes the receipt only when recovery verifies the worktree is already absent", async () => {
		const fixture = await createLaunchFixture();
		const unverifiedRemoval = vi.fn(async () => ({ ok: false as const, error: "worktree_not_found" }));

		await expect(
			cleanupIncompleteAgentLaunch({
				workspace: fixture.workspace,
				sessionId: "agent-session",
				sessionFile: fixture.sessionFile,
				record: fixture.record,
				removeWorktree: unverifiedRemoval,
			}),
		).resolves.toEqual({ kind: "cleanup_required", worktreeId: "launch-worktree" });
		expect(existsSync(fixture.sessionFile)).toBe(true);

		const verifiedRemoval = vi.fn(async () => ({
			ok: false as const,
			error: "worktree_not_found",
			verifiedAbsent: true,
		}));
		await expect(
			cleanupIncompleteAgentLaunch({
				workspace: fixture.workspace,
				sessionId: "agent-session",
				sessionFile: fixture.sessionFile,
				record: fixture.record,
				removeWorktree: verifiedRemoval,
			}),
		).resolves.toEqual({ kind: "cleaned" });
		expect(verifiedRemoval).toHaveBeenCalledWith(fixture.workspace, "launch-worktree");
		expect(existsSync(fixture.sessionFile)).toBe(false);
	});

	test("leaves committed launch sessions and their worktrees untouched", async () => {
		const fixture = await createLaunchFixture(true);
		const removeWorktree = vi.fn(async () => ({ ok: true as const }));

		await expect(
			cleanupIncompleteAgentLaunch({
				workspace: fixture.workspace,
				sessionId: "agent-session",
				sessionFile: fixture.sessionFile,
				record: fixture.record,
				removeWorktree,
			}),
		).resolves.toEqual({ kind: "committed" });
		expect(removeWorktree).not.toHaveBeenCalled();
		expect(existsSync(fixture.sessionFile)).toBe(true);
	});
});
