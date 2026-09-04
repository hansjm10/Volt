import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import { getDefaultSessionDirPath, SessionManager } from "../src/core/session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "../src/core/session-store/index.ts";

it("keeps default persisted session storage inside the Vitest agent sandbox", async () => {
	const agentDir = process.env[ENV_AGENT_DIR];
	expect(agentDir).toBeTruthy();
	if (!agentDir) throw new Error("Vitest did not configure an isolated agent directory");
	expect(process.env[ENV_SESSION_DIR]).toBe("");
	if (process.platform !== "win32") expect(statSync(agentDir).mode & 0o777).toBe(0o700);

	const cwd = mkdtempSync(join(tmpdir(), "volt-session-storage-isolation-"));
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.create(cwd);
		await manager.materialize();
		const reference = manager.getSessionRef();
		if (!reference) throw new Error("Expected a persisted session reference");

		const expectedSessionDir = getDefaultSessionDirPath(cwd, agentDir);
		const relativeSessionDir = relative(agentDir, reference.sessionDirectory);
		expect(relativeSessionDir).not.toBe("");
		expect(relativeSessionDir.startsWith("..")).toBe(false);
		expect(isAbsolute(relativeSessionDir)).toBe(false);
		expect(reference.sessionDirectory).toBe(expectedSessionDir);
		expect(existsSync(join(expectedSessionDir, SESSION_STORE_DATABASE_FILENAME))).toBe(true);
	} finally {
		try {
			await manager?.closePersistence();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});
