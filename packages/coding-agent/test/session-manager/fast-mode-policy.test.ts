import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-fast-mode-policy-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager Fast mode policy", () => {
	it("reduces Fast independently from thinking and model changes", () => {
		const manager = SessionManager.inMemory();
		manager.appendThinkingLevelChange("high");
		expect(manager.buildSessionContext().fastMode).toEqual({ enabled: false });

		manager.appendFastModeChange(true);
		expect(manager.buildSessionContext()).toMatchObject({
			thinkingLevel: "high",
			fastMode: { enabled: true },
		});

		manager.appendModelChange("openai-codex", "gpt-codex");
		manager.appendThinkingLevelChange("medium");
		expect(manager.buildSessionContext()).toMatchObject({
			thinkingLevel: "medium",
			model: { provider: "openai-codex", modelId: "gpt-codex" },
			fastMode: { enabled: true },
		});
	});

	it("keeps sibling branch states independent", () => {
		const manager = SessionManager.inMemory();
		const baseId = manager.appendThinkingLevelChange("high");
		const enabledId = manager.appendFastModeChange(true);

		manager.branch(baseId);
		const disabledId = manager.appendFastModeChange(false);

		expect(buildSessionContext(manager.getEntries(), enabledId).fastMode).toEqual({ enabled: true });
		expect(buildSessionContext(manager.getEntries(), disabledId).fastMode).toEqual({ enabled: false });
	});

	it("durably stores first-turn Fast state without exposing an empty session in normal lists", async () => {
		const dir = createTempDir();
		const manager = await SessionManager.create(dir, dir);
		manager.appendThinkingLevelChange("high");
		manager.appendFastModeChange(true);
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		const reopened = await SessionManager.open(ref);
		expect(reopened.buildSessionContext().fastMode).toEqual({ enabled: true });
		expect(await SessionManager.list(dir, dir)).toEqual([]);
		expect(await SessionManager.list(dir, dir, undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: manager.getSessionId(), ref },
		]);

		const continued = await SessionManager.continueRecent(dir, dir);
		expect(continued.getSessionId()).not.toBe(manager.getSessionId());
	});

	it("durably stores a message-free branched session with Fast state", async () => {
		const dir = createTempDir();
		const manager = await SessionManager.create(dir, dir);
		manager.appendThinkingLevelChange("high");
		const fastEntryId = manager.appendFastModeChange(true);

		const branchedRef = await manager.createBranchedSession(fastEntryId);
		await manager.flush();
		if (!branchedRef) throw new Error("Expected a persisted branched reference");

		const reopened = await SessionManager.open(branchedRef);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.buildSessionContext()).toMatchObject({
			thinkingLevel: "high",
			fastMode: { enabled: true },
		});
	});

	it("round-trips both Fast policy states through SQLite", async () => {
		const dir = createTempDir();
		const manager = await SessionManager.create(dir, dir);
		manager.appendFastModeChange(true);
		manager.appendFastModeChange(false);
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		expect((await SessionManager.open(ref)).buildSessionContext().fastMode).toEqual({ enabled: false });
	});

	it("honors options passed as the second listAll argument", async () => {
		const agentDir = createTempDir();
		const cwd = join(agentDir, "workspace");
		const sessionDir = join(agentDir, "sessions", "workspace-sessions");
		vi.stubEnv("VOLT_CODING_AGENT_DIR", agentDir);
		const manager = await SessionManager.create(cwd, sessionDir);
		manager.appendFastModeChange(true);
		await manager.flush();

		expect(await SessionManager.listAll()).toEqual([]);
		expect(await SessionManager.listAll(undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: manager.getSessionId(), ref: manager.getSessionRef() },
		]);
	});
});
