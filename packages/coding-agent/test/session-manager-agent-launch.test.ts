import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

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
});
