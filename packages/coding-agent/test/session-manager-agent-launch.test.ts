import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { userMsg } from "./utilities.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionManager cold agent launch WAL", () => {
	test("persists host-only receipt and commit records without advancing transcript state", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-launch-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir, { id: "agent-fixed" });
		const request = {
			launchId: "launch-1",
			catalogRevision: "revision-1",
			placement: { kind: "workspace" as const },
			config: { fastModeEnabled: false, agentMode: "build" as const },
		};
		const config = {
			kind: "configured" as const,
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off" as const,
			fastModeEnabled: false,
			agentMode: "build" as const,
		};
		const receipt = manager.appendAgentLaunchReceipt({
			launchId: request.launchId,
			requestDigest: "digest-1",
			clientNodeId: "client-node",
			previousSessionId: "session-old",
			request,
			placement: { kind: "workspace" },
			config,
		});
		manager.appendAgentLaunchCommit(receipt.id, request.launchId);
		await manager.flush();

		expect(manager.getEntries()).toEqual([]);
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = SessionManager.open(sessionFile!, sessionDir);
		expect(reopened.getEntries()).toEqual([]);
		expect(reopened.getAgentLaunchRecord(request.launchId)).toMatchObject({
			receipt: { requestDigest: "digest-1", placement: { kind: "workspace" }, config },
			commit: { launchId: request.launchId, sessionId: "agent-fixed" },
		});
	});

	test("continue-recent selects a committed launch with interleaved config entries", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-launch-continue-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir, { id: "agent-committed-continue" });
		const receipt = manager.appendAgentLaunchReceipt({
			launchId: "launch-continue",
			requestDigest: "digest-continue",
			clientNodeId: "client-node",
			previousSessionId: null,
			request: {
				launchId: "launch-continue",
				catalogRevision: "revision-1",
				placement: { kind: "workspace" },
				config: { fastModeEnabled: false, agentMode: "build" },
			},
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		manager.appendModelChange("test", "model");
		manager.appendAgentLaunchCommit(receipt.id, "launch-continue");
		await manager.flush();

		expect(SessionManager.continueRecent(root, sessionDir).getSessionId()).toBe("agent-committed-continue");
	});

	test("hides an uncommitted launch from ordinary listing even after messages are appended", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-launch-hidden-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir, { id: "agent-hidden" });
		manager.appendAgentLaunchReceipt({
			launchId: "launch-hidden",
			requestDigest: "digest-hidden",
			clientNodeId: "client-node",
			previousSessionId: null,
			request: {
				launchId: "launch-hidden",
				catalogRevision: "revision-1",
				placement: { kind: "workspace" },
				config: { fastModeEnabled: false, agentMode: "build" },
			},
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		manager.appendMessage(userMsg("must remain recovery-only"));
		await manager.flush();

		await expect(SessionManager.list(root, sessionDir)).resolves.toEqual([]);
		await expect(
			SessionManager.list(root, sessionDir, undefined, { includeMessageFreeDurable: true }),
		).resolves.toEqual([]);
		await expect(
			SessionManager.list(root, sessionDir, undefined, {
				includeMessageFreeDurable: true,
				includeUncommittedAgentLaunch: true,
			}),
		).resolves.toHaveLength(1);
		expect(SessionManager.continueRecent(root, sessionDir).getSessionId()).not.toBe("agent-hidden");
	});

	test("recovers launch records before an unterminated torn WAL tail", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-launch-torn-tail-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir, { id: "agent-torn-tail" });
		manager.appendAgentLaunchReceipt({
			launchId: "launch-torn-tail",
			requestDigest: "digest-torn-tail",
			clientNodeId: "client-node",
			previousSessionId: null,
			request: {
				launchId: "launch-torn-tail",
				catalogRevision: "revision-1",
				placement: { kind: "workspace" },
				config: { fastModeEnabled: false, agentMode: "build" },
			},
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		await manager.flush();
		await appendFile(manager.getSessionFile()!, '{"type":"agent_launch_commit"');

		const sessions = await SessionManager.listAgentLaunchRecoverySessions(sessionDir, new AbortController().signal);
		expect(sessions).toMatchObject([{ id: "agent-torn-tail" }]);
		expect(sessions[0]?.records[0]?.commit).toBeUndefined();
	});

	test("cancels recovery-only session enumeration", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-launch-list-cancel-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		SessionManager.create(root, sessionDir, { id: "agent-cancelled-list" });
		const controller = new AbortController();
		controller.abort(new Error("stop recovery listing"));

		await expect(
			SessionManager.list(root, sessionDir, undefined, {
				includeUncommittedAgentLaunch: true,
				signal: controller.signal,
			}),
		).rejects.toThrow("stop recovery listing");
	});

	test("relocates an uncommitted existing-worktree reservation", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-existing-worktree-relocate-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		const worktree = join(root, "existing-worktree");
		const resolvedCwd = join(worktree, "packages", "coding-agent");
		const manager = SessionManager.create(worktree, sessionDir, { id: "agent-existing" });
		manager.appendAgentLaunchReceipt({
			launchId: "launch-existing",
			requestDigest: "digest-existing",
			clientNodeId: "client-node",
			previousSessionId: "session-old",
			request: {
				launchId: "launch-existing",
				catalogRevision: "revision-1",
				placement: { kind: "existing_worktree", worktreeId: "existing", workingDirectory: "packages/coding-agent" },
				config: { fastModeEnabled: false, agentMode: "build" },
			},
			placement: { kind: "worktree", worktreeId: "existing", branch: "feature/existing", created: false },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		await manager.flush();

		manager.relocateUncommittedAgentLaunch(resolvedCwd, "launch-existing");
		await manager.flush();

		expect(SessionManager.open(manager.getSessionFile()!, sessionDir).getCwd()).toBe(resolvedCwd);
	});

	test("durably relocates only an uncommitted message-free worktree reservation", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-agent-launch-relocate-"));
		cleanup.push(root);
		const sessionDir = join(root, "sessions");
		const plannedCwd = join(root, "planned-worktree");
		const resolvedCwd = join(plannedCwd, "packages", "coding-agent");
		const manager = SessionManager.create(plannedCwd, sessionDir, { id: "agent-fixed" });
		const branchReservation = {
			branch: "volt/launch-worktree",
			expectedOid: "a".repeat(40),
			ownershipRef: `refs/volt/agent-launches/${"b".repeat(64)}`,
		};
		manager.appendAgentLaunchReceipt({
			launchId: "launch-1",
			requestDigest: "digest-1",
			clientNodeId: "client-node",
			previousSessionId: "session-old",
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
			branchReservation,
		});
		await manager.flush();

		manager.relocateUncommittedAgentLaunch(resolvedCwd, "launch-1");
		await manager.flush();

		const reopened = SessionManager.open(manager.getSessionFile()!, sessionDir);
		expect(reopened.getCwd()).toBe(resolvedCwd);
		expect(reopened.getAgentLaunchRecord("launch-1")?.receipt).toMatchObject({
			requestDigest: "digest-1",
			branchReservation,
		});
		manager.appendModelChange("test", "model");
		expect(() => manager.relocateUncommittedAgentLaunch(root, "launch-1")).toThrow(
			"is not an uncommitted worktree reservation",
		);
	});
});
