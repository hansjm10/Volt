import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { readIrohRemoteHostState, writeIrohRemoteHostState } from "../src/core/remote/iroh/index.ts";
import { main } from "../src/main.ts";

describe("remote CLI", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalAgentDir: string | undefined;
	let originalCwd: string;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-remote-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("lists and revokes paired Iroh clients", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "host.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			consumedPairingSecretHashes: [],
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [
				{
					nodeId: "client-node",
					label: "phone",
					allowedWorkspaces: ["project"],
					allowedTools: "read",
					pairedAt: 10,
					lastSeenAt: 20,
				},
			],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["remote", "clients", "--state", statePath])).resolves.toBeUndefined();

		expect(JSON.parse(logSpy.mock.calls.map(([message]) => String(message)).join("\n"))).toEqual([
			expect.objectContaining({ nodeId: "client-node", label: "phone" }),
		]);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();

		logSpy.mockClear();
		await expect(
			main(["remote", "revoke", "client-node", "--state", statePath, "--audit", auditPath]),
		).resolves.toBeUndefined();

		expect((await readIrohRemoteHostState(statePath)).clients).toEqual([]);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Revoked client-node");
		expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({
			type: "client_revoked",
			clientNodeId: "client-node",
			success: true,
		});
		expect(process.exitCode).toBeUndefined();
	});
});
