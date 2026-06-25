import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	getIrohRemoteControlPath,
	IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
	IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
	IrohRemoteHostStateManager,
	parseIrohRemoteWorkspaceSpec,
	readIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/index.ts";
import { main } from "../src/main.ts";

async function withMockPairControlServer(
	statePath: string,
	handleRequest: (request: Record<string, unknown>) => Record<string, unknown>,
	callback: () => Promise<void>,
): Promise<void> {
	const controlPath = getIrohRemoteControlPath(statePath);
	if (process.platform !== "win32") {
		mkdirSync(dirname(controlPath), { recursive: true });
		rmSync(controlPath, { force: true });
	}
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const request = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
			socket.end(`${JSON.stringify(handleRequest(request))}\n`);
		});
	});
	await new Promise<void>((resolveListen) => server.listen(controlPath, resolveListen));
	try {
		await callback();
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		if (process.platform !== "win32") {
			rmSync(controlPath, { force: true });
		}
	}
}

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

	it("prints unsafe remote tool warning help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["remote", "host", "--help"])).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
		const helpText = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(helpText).toContain("volt remote pair [options]");
		expect(helpText).toContain("volt remote status [options]");
		expect(helpText).toContain("volt remote approve-repair <node-id> [options]");
		expect(helpText).toContain("--register-workspace");
		expect(helpText).toContain("bash, edit, or write can modify host state and require confirmation");
		expect(helpText).toContain("--mobile");
		expect(helpText).toContain("--yes");
		expect(helpText).toContain("without trusting the workspace");
		expect(process.exitCode).toBeUndefined();
	});

	it("parses workspace registration specs", () => {
		expect(parseIrohRemoteWorkspaceSpec(undefined, projectDir)).toEqual({
			name: "project",
			path: projectDir,
		});
		expect(parseIrohRemoteWorkspaceSpec("src", projectDir)).toEqual({
			name: "src",
			path: join(projectDir, "src"),
		});
		expect(parseIrohRemoteWorkspaceSpec("volt=.", projectDir)).toEqual({
			name: "volt",
			path: resolve(projectDir, "."),
		});
		expect(() => parseIrohRemoteWorkspaceSpec("=.", projectDir)).toThrow("Workspace name cannot be empty");
	});

	it("preserves workspace tool defaults when upserting without explicit tools", async () => {
		const statePath = join(tempDir, "host.json");
		const firstPath = join(projectDir, "first");
		const secondPath = join(projectDir, "second");
		mkdirSync(firstPath, { recursive: true });
		mkdirSync(secondPath, { recursive: true });
		const stateManager = new IrohRemoteHostStateManager({ statePath });

		await expect(stateManager.upsertWorkspace({ name: "project", path: firstPath }, "read")).resolves.toEqual({
			name: "project",
			path: firstPath,
			allowedTools: "read",
		});
		await expect(stateManager.upsertWorkspace({ name: "project", path: secondPath })).resolves.toEqual({
			name: "project",
			path: secondPath,
			allowedTools: "read",
		});
		await expect(stateManager.upsertWorkspace({ name: "project", path: firstPath }, "read,grep")).resolves.toEqual({
			name: "project",
			path: firstPath,
			allowedTools: "read,grep",
		});
	});

	it("registers the current directory with the default Iroh host state path", async () => {
		const defaultStatePath = join(agentDir, "remote", "iroh-host.json");
		const realProjectDir = realpathSync(projectDir);

		await expect(main(["remote", "host", "--register-workspace"])).resolves.toBeUndefined();

		const savedState = await readIrohRemoteHostState(defaultStatePath);
		expect(savedState.workspaces).toEqual([
			{
				name: basename(realProjectDir),
				path: realProjectDir,
			},
		]);
		expect(process.exitCode).toBe(0);
	});

	it("trusts a registered workspace when approved", async () => {
		const statePath = join(tempDir, "host.json");
		const realProjectDir = realpathSync(projectDir);

		await expect(
			main(["remote", "host", "--state", statePath, "--register-workspace", `app=${projectDir}`, "--approve"]),
		).resolves.toBeUndefined();

		const trustState = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")) as Record<string, boolean>;
		expect(trustState[realProjectDir]).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("registers explicit workspace specs with an explicit Iroh host state path", async () => {
		const statePath = join(tempDir, "custom", "host.json");
		const alphaPath = join(projectDir, "alpha");
		const betaPath = join(projectDir, "beta");
		mkdirSync(alphaPath, { recursive: true });
		mkdirSync(betaPath, { recursive: true });

		await expect(
			main(["remote", "host", "--state", statePath, "--register-workspace", `alpha=${alphaPath}`]),
		).resolves.toBeUndefined();
		expect(process.exitCode).toBe(0);
		process.exitCode = undefined;

		await expect(
			main(["remote", "host", "--state", statePath, "--register-workspace", betaPath]),
		).resolves.toBeUndefined();

		const savedState = await readIrohRemoteHostState(statePath);
		expect(savedState.workspaces).toEqual([
			{
				name: "alpha",
				path: realpathSync(alphaPath),
			},
			{
				name: basename(realpathSync(betaPath)),
				path: realpathSync(betaPath),
			},
		]);
		expect(process.exitCode).toBe(0);
	});

	it("updates a registered workspace realpath while preserving saved tool defaults", async () => {
		const statePath = join(tempDir, "host.json");
		const firstPath = join(projectDir, "first");
		const secondPath = join(projectDir, "second");
		mkdirSync(firstPath, { recursive: true });
		mkdirSync(secondPath, { recursive: true });
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "app", path: firstPath, allowedTools: "read" }],
			clients: [],
		});

		await expect(
			main(["remote", "host", "--state", statePath, "--register-workspace", `app=${secondPath}`]),
		).resolves.toBeUndefined();

		let savedState = await readIrohRemoteHostState(statePath);
		expect(savedState.workspaces).toEqual([
			{
				name: "app",
				path: realpathSync(secondPath),
				allowedTools: "read",
			},
		]);
		expect(process.exitCode).toBe(0);
		process.exitCode = undefined;

		await expect(
			main([
				"remote",
				"host",
				"--state",
				statePath,
				"--register-workspace",
				`app=${firstPath}`,
				"--allow-tools",
				"read,grep",
			]),
		).resolves.toBeUndefined();

		savedState = await readIrohRemoteHostState(statePath);
		expect(savedState.workspaces).toEqual([
			{
				name: "app",
				path: realpathSync(firstPath),
				allowedTools: "read,grep",
			},
		]);
		expect(process.exitCode).toBe(0);
	});

	it("rejects invalid workspace registration paths", async () => {
		const statePath = join(tempDir, "host.json");
		const filePath = join(projectDir, "file.txt");
		writeFileSync(filePath, "not a directory");

		await expect(
			main(["remote", "host", "--state", statePath, "--register-workspace", join(projectDir, "missing")]),
		).resolves.toBeUndefined();
		expect(process.exitCode).toBe(1);
		expect((await readIrohRemoteHostState(statePath)).workspaces).toEqual([]);
		process.exitCode = undefined;

		await expect(
			main(["remote", "host", "--state", statePath, "--register-workspace", `file=${filePath}`]),
		).resolves.toBeUndefined();
		expect(process.exitCode).toBe(1);
		expect((await readIrohRemoteHostState(statePath)).workspaces).toEqual([]);
	});

	it("creates a remote pairing ticket through a running host control channel", async () => {
		const statePath = join(tempDir, "host.json");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let requestBody: Record<string, unknown> | undefined;

		await withMockPairControlServer(
			statePath,
			(request) => {
				requestBody = request;
				return {
					type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
					success: true,
					expiresAt: 125,
					ticket: "volt+iroh://v1/mock-ticket",
				};
			},
			async () => {
				await expect(
					main([
						"remote",
						"pair",
						"--state",
						statePath,
						"--workspace",
						"project",
						"--label",
						"tablet",
						"--ttl",
						"30s",
						"--relay",
						"disabled",
					]),
				).resolves.toBeUndefined();
			},
		);

		expect(requestBody).toEqual({
			type: "volt_iroh_pair_request",
			workspace: "project",
			allowTools: "read",
			labelHint: "tablet",
			ttlMs: 30_000,
			relayMode: "disabled",
		});
		expect(logSpy.mock.calls.map(([message]) => String(message))).toEqual(["volt+iroh://v1/mock-ticket"]);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("prints a remote pairing QR when stderr is a TTY", async () => {
		const statePath = join(tempDir, "host.json");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stderrTtyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
		Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });

		try {
			await withMockPairControlServer(
				statePath,
				() => ({
					type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
					success: true,
					expiresAt: 125,
					ticket: "volt+iroh://v1/mock-ticket",
				}),
				async () => {
					await expect(
						main(["remote", "pair", "--state", statePath, "--workspace", "project"]),
					).resolves.toBeUndefined();
				},
			);
		} finally {
			if (stderrTtyDescriptor) {
				Object.defineProperty(process.stderr, "isTTY", stderrTtyDescriptor);
			} else {
				Reflect.deleteProperty(process.stderr, "isTTY");
			}
		}

		expect(logSpy.mock.calls.map(([message]) => String(message))).toEqual(["volt+iroh://v1/mock-ticket"]);
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("pairing ticket QR:");
		expect(stderr).toContain("pairing ticket:");
		expect(process.exitCode).toBeUndefined();
	});

	it("rejects ambiguous remote pair workspace selection before contacting a host", async () => {
		const statePath = join(tempDir, "host.json");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [
				{ name: "one", path: projectDir, allowedTools: "read" },
				{ name: "two", path: projectDir, allowedTools: "read" },
			],
			clients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["remote", "pair", "--state", statePath])).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Multiple saved Iroh remote workspaces found",
		);
		expect(process.exitCode).toBe(1);
	});

	it("reports when no running host control channel is available for remote pair", async () => {
		const statePath = join(tempDir, "host.json");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
		});
		const controlPath = getIrohRemoteControlPath(statePath);
		if (process.platform !== "win32") {
			rmSync(controlPath, { force: true });
		}
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["remote", "pair", "--state", statePath, "--workspace", "project"])).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"No running Iroh remote host control channel is available",
		);
		expect(process.exitCode).toBe(1);
	});

	it("requires --yes for unsafe remote pair tool grants in noninteractive contexts", async () => {
		const statePath = join(tempDir, "host.json");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			main(["remote", "pair", "--state", statePath, "--workspace", "project", "--allow-tools", "read,bash"]),
		).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Pass --yes to accept unsafe remote tool grants",
		);
		expect(process.exitCode).toBe(1);
	});

	it("passes unsafe remote pair approvals to the running host control channel", async () => {
		const statePath = join(tempDir, "host.json");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let requestBody: Record<string, unknown> | undefined;

		await withMockPairControlServer(
			statePath,
			(request) => {
				requestBody = request;
				return {
					type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
					success: true,
					expiresAt: 125,
					ticket: "volt+iroh://v1/unsafe-ticket",
				};
			},
			async () => {
				await expect(
					main([
						"remote",
						"pair",
						"--state",
						statePath,
						"--workspace",
						"project",
						"--allow-tools",
						"read,bash",
						"--yes",
					]),
				).resolves.toBeUndefined();
			},
		);

		expect(requestBody).toMatchObject({
			allowTools: "read,bash",
			unsafeApproval: "yes_flag",
			workspace: "project",
		});
		expect(logSpy.mock.calls.map(([message]) => String(message))).toEqual(["volt+iroh://v1/unsafe-ticket"]);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("prints persisted Iroh remote status without secrets", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "custom.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: [1, 2, 3],
			pairingSecretTombstones: [
				{
					secretHash: "sha256:consumed-secret-hash",
					workspace: "alpha",
					outcome: "pairing_secret_consumed",
					createdAt: 5,
					expiresAt: 15,
					consumedAt: 10,
					clientNodeId: "client-b",
					retainUntil: 20,
				},
			],
			workspaces: [
				{ name: "zeta", path: join(projectDir, "zeta"), allowedTools: "read" },
				{ name: "alpha", path: join(projectDir, "alpha"), allowedTools: "read,grep" },
			],
			clients: [
				{
					nodeId: "client-b",
					label: "tablet",
					allowedWorkspaces: ["zeta", "alpha"],
					allowedTools: "read,grep",
					pairedAt: 10,
					lastSeenAt: 20,
					pushTargets: [
						{
							id: "relay-target-1",
							provider: "fcm",
							platform: "ios",
							pushTargetAuthToken: "secret-target-auth-token",
							relayUrl: "https://push.example.test",
							tokenHash: "sha256:push-token-hash",
							enabled: true,
							createdAt: 100,
							updatedAt: 110,
						},
					],
				},
			],
			revokedClients: [
				{
					nodeId: "client-a",
					label: "old phone",
					allowedWorkspaces: ["alpha"],
					allowedTools: "read",
					pairedAt: 1,
					lastSeenAt: 2,
					revokedAt: 3,
					rePairApprovedAt: 4,
				},
			],
			pendingPairingTickets: [
				{
					secretHash: "sha256:pending-secret-hash",
					workspace: "alpha",
					allowedTools: "read",
					createdAt: 30,
					expiresAt: 40,
				},
			],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["remote", "status", "--state", statePath, "--audit", auditPath])).resolves.toBeUndefined();

		const statusText = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		const status = JSON.parse(statusText);
		expect(status).toEqual({
			statePath,
			auditPath,
			warning: "Persisted state only; live Iroh remote host status is not available from this command yet.",
			liveStatus: {
				available: false,
				warning: "Persisted state only; live Iroh remote host status is not available from this command yet.",
			},
			workspaces: [
				{ name: "alpha", path: join(projectDir, "alpha"), allowedTools: "read,grep" },
				{ name: "zeta", path: join(projectDir, "zeta"), allowedTools: "read" },
			],
			clientCount: 1,
			clients: [
				{
					nodeId: "client-b",
					label: "tablet",
					allowedWorkspaces: ["alpha", "zeta"],
					allowedTools: "read,grep",
					pairedAt: 10,
					lastSeenAt: 20,
					pushTargetCount: 1,
					pushTargets: [
						{
							provider: "fcm",
							platform: "ios",
							enabled: true,
							hasTokenHash: true,
							relayUrl: "https://push.example.test",
							createdAt: 100,
							updatedAt: 110,
						},
					],
				},
			],
			revokedClientCount: 1,
			revokedClients: [
				{
					nodeId: "client-a",
					label: "old phone",
					allowedWorkspaces: ["alpha"],
					allowedTools: "read",
					pairedAt: 1,
					lastSeenAt: 2,
					revokedAt: 3,
					rePairApprovedAt: 4,
				},
			],
		});
		expect(statusText).not.toContain("hostSecretKey");
		expect(statusText).not.toContain("consumedPairingSecretHashes");
		expect(statusText).not.toContain("pairingSecretTombstones");
		expect(statusText).not.toContain("pendingPairingTickets");
		expect(statusText).not.toContain("secret-target-auth-token");
		expect(statusText).not.toContain("sha256:");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("sends active revocation requests to a running host control channel", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "host.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
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
		let requestBody: Record<string, unknown> | undefined;

		await withMockPairControlServer(
			statePath,
			(request) => {
				requestBody = request;
				return {
					type: IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
					success: true,
					closed: true,
					closedCount: 1,
				};
			},
			async () => {
				await expect(
					main(["remote", "revoke", "client-node", "--state", statePath, "--audit", auditPath]),
				).resolves.toBeUndefined();
			},
		);

		expect(requestBody).toEqual({ type: "volt_iroh_revoke_request", nodeId: "client-node" });
		const savedState = await readIrohRemoteHostState(statePath);
		expect(savedState.clients).toEqual([]);
		expect(savedState.revokedClients).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
		expect(logSpy).not.toHaveBeenCalled();
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("Active connection revoked for client-node");
		expect(stderr).toContain("Revoked client-node");
		expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({
			type: "client_revoked",
			clientNodeId: "client-node",
			success: true,
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("audits failed Iroh remote revocation", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "host.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			main(["remote", "revoke", "missing-client", "--state", statePath, "--audit", auditPath]),
		).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Error: No client found for missing-client",
		);
		expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({
			type: "client_revoked",
			clientNodeId: "missing-client",
			success: false,
			error: "client not found",
		});
		expect(process.exitCode).toBe(1);
	});

	it("approves revoked Iroh clients for explicit re-pair", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "host.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
			revokedClients: [
				{
					nodeId: "client-node",
					label: "phone",
					allowedWorkspaces: ["project"],
					allowedTools: "read",
					pairedAt: 10,
					lastSeenAt: 20,
					revokedAt: 30,
				},
			],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			main(["remote", "approve-repair", "client-node", "--state", statePath, "--audit", auditPath]),
		).resolves.toBeUndefined();

		const savedState = await readIrohRemoteHostState(statePath);
		expect(savedState.revokedClients).toEqual([
			expect.objectContaining({ nodeId: "client-node", rePairApprovedAt: expect.any(Number) }),
		]);
		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Approved re-pair for client-node",
		);
		expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({
			type: "client_repair_approved",
			clientNodeId: "client-node",
			success: true,
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("audits failed Iroh remote re-pair approval", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "host.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [],
			revokedClients: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			main(["remote", "approve-repair", "missing-client", "--state", statePath, "--audit", auditPath]),
		).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Error: No revoked client found for missing-client",
		);
		expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({
			type: "client_repair_approved",
			clientNodeId: "missing-client",
			success: false,
			error: "revoked client not found",
		});
		expect(process.exitCode).toBe(1);
	});

	it("lists and revokes paired Iroh clients", async () => {
		const statePath = join(tempDir, "host.json");
		const auditPath = join(tempDir, "host.audit.jsonl");
		await writeIrohRemoteHostState(statePath, {
			hostSecretKey: undefined,
			workspaces: [{ name: "project", path: projectDir, allowedTools: "read" }],
			clients: [
				{
					nodeId: "client-node",
					label: "phone",
					allowedWorkspaces: ["project"],
					allowedTools: "read",
					pairedAt: 10,
					lastSeenAt: 20,
					pushTargets: [
						{
							id: "relay-target-2",
							provider: "fcm",
							platform: "ios",
							pushTargetAuthToken: "client-list-secret-target-auth-token",
							relayUrl: "https://push.example.test",
							tokenHash: "sha256:client-list-token-hash",
							enabled: true,
							createdAt: 30,
							updatedAt: 40,
						},
					],
				},
			],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["remote", "clients", "--state", statePath])).resolves.toBeUndefined();

		const clientsText = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(JSON.parse(clientsText)).toEqual([
			expect.objectContaining({
				nodeId: "client-node",
				label: "phone",
				pushTargetCount: 1,
				pushTargets: [
					{
						provider: "fcm",
						platform: "ios",
						enabled: true,
						hasTokenHash: true,
						relayUrl: "https://push.example.test",
						createdAt: 30,
						updatedAt: 40,
					},
				],
			}),
		]);
		expect(clientsText).not.toContain("client-list-secret-target-auth-token");
		expect(clientsText).not.toContain("sha256:");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();

		logSpy.mockClear();
		await expect(
			main(["remote", "revoke", "client-node", "--state", statePath, "--audit", auditPath]),
		).resolves.toBeUndefined();

		const savedState = await readIrohRemoteHostState(statePath);
		expect(savedState.clients).toEqual([]);
		expect(savedState.revokedClients).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Revoked client-node");
		expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({
			type: "client_revoked",
			clientNodeId: "client-node",
			success: true,
		});
		expect(process.exitCode).toBeUndefined();
	});
});
