import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
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

	it("durably writes first-turn Fast state without exposing an empty session in normal lists", async () => {
		const dir = createTempDir();
		const manager = SessionManager.create(dir, dir);
		manager.appendThinkingLevelChange("high");
		manager.appendFastModeChange(true);
		await manager.flush();
		const sessionFile = manager.getSessionFile();

		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);
		const reopened = SessionManager.open(sessionFile!, dir);
		expect(reopened.buildSessionContext().fastMode).toEqual({ enabled: true });
		expect(await SessionManager.list(dir, dir)).toEqual([]);
		expect(
			await SessionManager.list(dir, dir, undefined, {
				includeMessageFreeDurable: true,
			}),
		).toMatchObject([{ id: manager.getSessionId(), path: sessionFile }]);
		expect(SessionManager.continueRecent(dir, dir).getSessionId()).toBe(manager.getSessionId());
	});

	it("durably writes a message-free branched session with Fast state", async () => {
		const dir = createTempDir();
		const manager = SessionManager.create(dir, dir);
		manager.appendThinkingLevelChange("high");
		const fastEntryId = manager.appendFastModeChange(true);

		const branchedFile = manager.createBranchedSession(fastEntryId);
		await manager.flush();

		expect(branchedFile).toBeDefined();
		expect(existsSync(branchedFile!)).toBe(true);
		const reopened = SessionManager.open(branchedFile!, dir);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.buildSessionContext()).toMatchObject({
			thinkingLevel: "high",
			fastMode: { enabled: true },
		});
	});

	it("rejects malformed persisted Fast state", async () => {
		const dir = createTempDir();
		const manager = SessionManager.create(dir, dir);
		manager.appendFastModeChange(true);
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		const records = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const fastEntry = records.find((entry) => entry.type === "fast_mode_change")!;
		fastEntry.enabled = "yes";
		writeFileSync(sessionFile, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		expect(() => SessionManager.open(sessionFile, dir)).toThrow("has an invalid enabled state");
	});

	it("honors options passed as the second listAll argument", async () => {
		const agentDir = createTempDir();
		const cwd = join(agentDir, "workspace");
		const sessionDir = join(agentDir, "sessions", "workspace-sessions");
		vi.stubEnv("VOLT_CODING_AGENT_DIR", agentDir);
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendFastModeChange(true);
		await manager.flush();

		expect(await SessionManager.listAll()).toEqual([]);
		expect(await SessionManager.listAll(undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: manager.getSessionId(), path: manager.getSessionFile() },
		]);
	});
});
