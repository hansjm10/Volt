import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { createDaemonLogger } from "../src/daemon/log.ts";
import { readPidfile, runVoltDaemon, VOLTD_EXIT_ALREADY_RUNNING } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { type RelayLifecycleOwner, RelayRegistry } from "../src/daemon/relay-stream.ts";
import { type DaemonProbeResult, ensureDaemonRunning, probeDaemon } from "../src/daemon/spawn.ts";
import { createEmptyVoltdState } from "../src/daemon/state.ts";
import { connectRawRelayClient, FakePhoneIrohStream, type RawRelayClient } from "./relay-doubles.ts";

// A leftover regular file at the socket path is a POSIX-only failure mode:
// Windows control sockets are named pipes (\\.\pipe\...) with no on-disk
// entry, and the OS removes the pipe when the owning process exits.
const posixIt = process.platform === "win32" ? it.skip : it;
const win32It = process.platform === "win32" ? it : it.skip;

describe("voltd lifecycle", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-life-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function waitForDaemon(): Promise<DaemonProbeResult> {
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		return status;
	}

	it("serves status, rejects a second instance, and shuts down gracefully", async () => {
		const paths = getDaemonPaths(agentDir);
		const daemon = runVoltDaemon({ agentDir, foreground: false });

		// Probe until healthy.
		const status = await waitForDaemon();
		expect(status.pid).toBe(process.pid);

		// Pidfile is advisory but present and truthful.
		const pidfile = readPidfile(paths.pidfilePath);
		expect(pidfile?.pid).toBe(process.pid);
		expect(pidfile?.socketPath).toBe(status.socketPath);

		// A second daemon on the same agent dir exits with already_running.
		await expect(runVoltDaemon({ agentDir, foreground: false })).resolves.toBe(VOLTD_EXIT_ALREADY_RUNNING);

		// Control client sees the shutdown broadcast on graceful shutdown.
		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});
		const shutdownResponse = await client.request({ type: "shutdown" });
		expect(shutdownResponse.type).toBe("ok");
		await expect(daemon).resolves.toBe(0);
		expect(events.some((event) => event.type === "daemon_shutdown")).toBe(true);
		await client.close();

		// Socket and pidfile removed; audit records started + shutdown.
		expect(existsSync(paths.socketPath)).toBe(false);
		expect(existsSync(paths.pidfilePath)).toBe(false);
		const auditLines = readFileSync(paths.auditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(auditLines.map((line) => line.type)).toEqual(["daemon_started", "daemon_shutdown"]);
	}, 20_000);

	it("destroys an accepted socket that never sends a hello during shutdown", async () => {
		const paths = getDaemonPaths(agentDir);
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		const status = await waitForDaemon();
		const rawSocket = createConnection(status.socketPath);
		await new Promise<void>((resolve, reject) => {
			rawSocket.once("connect", resolve);
			rawSocket.once("error", reject);
		});
		const rawSocketClosed = new Promise<void>((resolve) => rawSocket.once("close", () => resolve()));
		const client = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		let exitDeadline: NodeJS.Timeout | undefined;

		try {
			const shutdownResponse = await client.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			const exitWithinDeadline = Promise.race([
				daemon,
				new Promise<never>((_, reject) => {
					exitDeadline = setTimeout(() => reject(new Error("daemon shutdown exceeded 5s")), 5_000);
				}),
			]);
			await expect(exitWithinDeadline).resolves.toBe(0);
			await rawSocketClosed;
			expect(existsSync(paths.pidfilePath)).toBe(false);
			expect(existsSync(paths.socketPath)).toBe(false);
		} finally {
			clearTimeout(exitDeadline);
			rawSocket.destroy();
			await client.close();
			await daemon;
		}
	}, 20_000);

	it("serializes instances that request different custom socket paths", async () => {
		const paths = getDaemonPaths(agentDir);
		const customSocketPath = (label: string) =>
			process.platform === "win32"
				? `\\\\.\\pipe\\voltd-custom-${label}-${randomUUID()}`
				: join(paths.daemonDir, `custom-${label}.sock`);
		const firstSocketPath = customSocketPath("first");
		const daemon = runVoltDaemon({ agentDir, foreground: false, socketPath: firstSocketPath });
		const status = await waitForDaemon();
		expect(status.socketPath).toBe(firstSocketPath);

		await expect(
			runVoltDaemon({ agentDir, foreground: false, socketPath: customSocketPath("second") }),
		).resolves.toBe(VOLTD_EXIT_ALREADY_RUNNING);

		const client = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
	}, 20_000);

	posixIt(
		"recovers from a stale socket file",
		async () => {
			const paths = getDaemonPaths(agentDir);
			mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
			// A leftover regular file at the socket path produces EADDRINUSE on bind.
			writeFileSync(paths.socketPath, "", { mode: 0o600 });
			const daemon = runVoltDaemon({ agentDir, foreground: false });
			const status = await waitForDaemon();
			const client = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await client.request({ type: "shutdown" });
			await client.close();
			await expect(daemon).resolves.toBe(0);
		},
		20_000,
	);

	win32It(
		"uses a fresh Windows pipe when the legacy default pipe was pre-created",
		async () => {
			const paths = getDaemonPaths(agentDir);
			const precreatedPipe = createServer((socket) => {
				socket.destroy();
			});
			await new Promise<void>((resolve, reject) => {
				precreatedPipe.once("error", reject);
				precreatedPipe.listen(paths.socketPath, () => {
					precreatedPipe.off("error", reject);
					resolve();
				});
			});

			let daemon: Promise<number> | undefined;
			let daemonSocketPath: string | undefined;
			let daemonAuthToken: string | undefined;
			let shutdownRequested = false;
			try {
				daemon = runVoltDaemon({ agentDir, foreground: false });
				const status = await waitForDaemon();
				daemonSocketPath = status.socketPath;
				daemonAuthToken = status.authToken;
				expect(daemonSocketPath).toBeDefined();
				expect(daemonSocketPath).not.toBe(paths.socketPath);
				const client = createDaemonClient({
					socketPath: daemonSocketPath,
					client: "cli",
					version: "test",
					authToken: daemonAuthToken,
					reconnect: false,
				});
				try {
					await client.request({ type: "shutdown" });
					shutdownRequested = true;
				} finally {
					await client.close();
				}
				await expect(daemon).resolves.toBe(0);
			} finally {
				if (!shutdownRequested && daemonSocketPath) {
					const client = createDaemonClient({
						socketPath: daemonSocketPath,
						client: "cli",
						version: "test",
						authToken: daemonAuthToken,
						reconnect: false,
					});
					await client.request({ type: "shutdown" }).catch(() => {});
					await client.close().catch(() => {});
					await daemon?.catch(() => {});
				}
				await new Promise<void>((resolve) => {
					precreatedPipe.close(() => resolve());
				});
			}
		},
		20_000,
	);

	it("auto-starts when an unmatched endpoint is unresponsive", async () => {
		const paths = getDaemonPaths(agentDir);
		const freshSocketPath = `${paths.socketPath}-fresh`;
		const probes: DaemonProbeResult[] = [
			{ healthy: false, state: "unresponsive", socketPath: paths.socketPath },
			{
				healthy: true,
				state: "healthy",
				pid: 123,
				version: "test",
				socketPath: freshSocketPath,
				authToken: "test-token",
			},
		];
		const probe = vi.fn(async () => probes.shift()!);
		const spawn = vi.fn(async () => ({ ok: true, pid: 123, socketPath: freshSocketPath }));

		const result = await ensureDaemonRunning(agentDir, {
			probeDaemon: probe,
			spawnDetachedDaemon: spawn,
		});

		expect(probe).toHaveBeenCalledTimes(2);
		expect(spawn).toHaveBeenCalledOnce();
		expect(spawn).toHaveBeenCalledWith(agentDir);
		expect(result).toMatchObject({
			healthy: true,
			state: "healthy",
			spawned: true,
			pid: 123,
			socketPath: freshSocketPath,
		});
	});

	it("request/response correlation works over the control client", async () => {
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		const healthy = await waitForDaemon();
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "tui",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
		});
		const [statusResponse, clientsResponse, unsupported] = await Promise.all([
			client.request({ type: "status" }),
			client.request({ type: "clients_list" }),
			client.request({ type: "viewer_subscribe", viewerFeedId: "vf-nope" }),
		]);
		expect(statusResponse.type).toBe("status_result");
		if (statusResponse.type === "status_result") {
			expect(statusResponse.remoteTransport).toEqual({
				state: "unavailable",
				reasonCode: "extension_missing",
				message: "Phone transport is not enabled in this daemon.",
			});
		}
		expect(clientsResponse.type).toBe("clients_result");
		expect(unsupported.type).toBe("error");
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
	}, 20_000);

	it("broadcasts daemon_shutdown before extension quiescing completes", async () => {
		// Regression: the broadcast used to run AFTER the extension lifecycle,
		// which can drain streaming runtimes for up to 60s — control clients
		// waited blind for the whole drain.
		let releaseExtension: () => void = () => {};
		const extensionGate = new Promise<void>((resolve) => {
			releaseExtension = resolve;
		});
		let extensionQuiesceStarted = false;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			() => ({
				async quiesce() {
					extensionQuiesceStarted = true;
					await extensionGate;
				},
			}),
		]);
		const healthy = await waitForDaemon();

		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "cli",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});
		await client.request({ type: "shutdown" });

		// The broadcast must arrive while the extension is still draining.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !events.some((event) => event.type === "daemon_shutdown")) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(events.some((event) => event.type === "daemon_shutdown")).toBe(true);
		expect(extensionQuiesceStarted).toBe(true);

		releaseExtension();
		await expect(daemon).resolves.toBe(0);
		await client.close();
	}, 20_000);

	it("fences mutations from an established control client once shutdown begins", async () => {
		const paths = getDaemonPaths(agentDir);
		const lateWorkspacePath = join(agentDir, "late-workspace");
		mkdirSync(lateWorkspacePath);
		mkdirSync(paths.daemonDir, { recursive: true });
		const initialState = createEmptyVoltdState();
		const initialAccess = createIrohRemotePresetAccess("coding");
		initialState.clients.push({
			nodeId: "late-client",
			label: "late client",
			allowedWorkspaces: [],
			allowedTools: initialAccess.allowedTools,
			rpcGrant: initialAccess.rpcGrant,
			pairedAt: 1,
			lastSeenAt: 1,
		});
		writeFileSync(paths.statePath, `${JSON.stringify(initialState, null, 2)}\n`);
		let releaseExtension: () => void = () => {};
		const extensionGate = new Promise<void>((resolve) => {
			releaseExtension = resolve;
		});
		let extensionQuiesceStarted = false;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			(services) => ({
				async quiesce() {
					// Socket readiness does not imply the startup audit write is durable.
					// Settle queued writes before the test inspects the on-disk audit.
					await services.auditLogger.flush();
					extensionQuiesceStarted = true;
					await extensionGate;
				},
			}),
		]);
		const healthy = await waitForDaemon();
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "cli",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
		});

		try {
			expect((await client.request({ type: "shutdown" })).type).toBe("ok");
			await expect.poll(() => extensionQuiesceStarted).toBe(true);
			expect((await probeDaemon(agentDir)).state).toBe("shutting-down");

			const [workspaceResponse, accessResponse] = await Promise.all([
				client.request({ type: "workspace_register", name: "late", path: lateWorkspacePath }),
				client.request({
					type: "client_access_update",
					clientNodeId: "late-client",
					expectedRevision: 1,
					access: "full",
				}),
			]);
			expect(workspaceResponse).toMatchObject({ type: "error", code: "shutting_down" });
			expect(accessResponse).toMatchObject({ type: "error", code: "shutting_down" });

			const stateDuringQuiesce = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
				workspaces: Array<{ name: string }>;
				clients: Array<{ nodeId: string; rpcGrant: { revision: number } }>;
			};
			expect(stateDuringQuiesce.workspaces.some((workspace) => workspace.name === "late")).toBe(false);
			expect(stateDuringQuiesce.clients.find((client) => client.nodeId === "late-client")?.rpcGrant.revision).toBe(
				1,
			);
			const auditDuringQuiesce = readFileSync(paths.auditPath, "utf8");
			expect(auditDuringQuiesce).toContain('"type":"daemon_started"');
			expect(auditDuringQuiesce).not.toContain('"type":"workspace_registered"');
			expect(auditDuringQuiesce).not.toContain('"type":"client_access_updated"');

			releaseExtension();
			await expect(daemon).resolves.toBe(0);
			const stateAfterShutdown = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
				workspaces: Array<{ name: string }>;
				clients: Array<{ nodeId: string; rpcGrant: { revision: number } }>;
			};
			expect(stateAfterShutdown.workspaces.some((workspace) => workspace.name === "late")).toBe(false);
			expect(stateAfterShutdown.clients.find((client) => client.nodeId === "late-client")?.rpcGrant.revision).toBe(
				1,
			);
			const auditAfterShutdown = readFileSync(paths.auditPath, "utf8");
			expect(auditAfterShutdown).not.toContain('"type":"workspace_registered"');
			expect(auditAfterShutdown).not.toContain('"type":"client_access_updated"');
		} finally {
			releaseExtension();
			await client.close();
			await daemon;
		}
	}, 20_000);

	it("drains an admitted control mutation before extension and state quiescence", async () => {
		const paths = getDaemonPaths(agentDir);
		const admittedWorkspacePath = join(agentDir, "admitted-workspace");
		mkdirSync(admittedWorkspacePath);
		let releaseMutation: () => void = () => {};
		const mutationGate = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		let mutationStarted = false;
		let extensionQuiesceStarted = false;
		let workspaceWasDurableAtExtensionQuiesce = false;
		let auditWasDurableAtExtensionQuiesce = false;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			(services) => ({
				async handleRequest(_connection, request) {
					if (request.type !== "workspace_register" || request.name !== "admitted") {
						return false;
					}
					mutationStarted = true;
					await mutationGate;
					return false;
				},
				async quiesce() {
					extensionQuiesceStarted = true;
					workspaceWasDurableAtExtensionQuiesce = (
						JSON.parse(readFileSync(paths.statePath, "utf8")) as { workspaces: Array<{ name: string }> }
					).workspaces.some((workspace) => workspace.name === "admitted");
					auditWasDurableAtExtensionQuiesce = readFileSync(services.paths.auditPath, "utf8").includes(
						'"type":"workspace_registered"',
					);
				},
			}),
		]);
		const healthy = await waitForDaemon();
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "cli",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
		});

		try {
			const mutationResponse = client.request({
				type: "workspace_register",
				name: "admitted",
				path: admittedWorkspacePath,
			});
			await expect.poll(() => mutationStarted).toBe(true);

			// The shutdown handler itself is admitted and must still deliver its
			// response even though the older mutation keeps the drain open.
			expect((await client.request({ type: "shutdown" })).type).toBe("ok");
			expect(extensionQuiesceStarted).toBe(false);

			releaseMutation();
			expect((await mutationResponse).type).toBe("ok");
			await expect.poll(() => extensionQuiesceStarted).toBe(true);
			expect(workspaceWasDurableAtExtensionQuiesce).toBe(true);
			expect(auditWasDurableAtExtensionQuiesce).toBe(true);
			await expect(daemon).resolves.toBe(0);
		} finally {
			releaseMutation();
			await client.close();
			await daemon;
		}
	}, 20_000);

	it("bounds extension disposal after durable quiescing", async () => {
		const paths = getDaemonPaths(agentDir);
		const phases: string[] = [];
		let releaseDispose: () => void = () => {};
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			() => ({
				async quiesce() {
					phases.push("quiesce");
				},
				async dispose() {
					phases.push("dispose");
					await disposeGate;
				},
			}),
		]);
		const healthy = await waitForDaemon();
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "cli",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
		});

		await client.request({ type: "shutdown" });
		await expect(daemon).resolves.toBe(0);
		expect(phases).toEqual(["quiesce", "dispose"]);
		expect(existsSync(paths.pidfilePath)).toBe(false);
		expect(existsSync(paths.socketPath)).toBe(false);
		const shutdownAudit = readFileSync(paths.auditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; success: boolean; details?: Record<string, unknown> })
			.filter((line) => line.type === "daemon_shutdown")
			.at(-1);
		expect(shutdownAudit?.success).toBe(false);
		expect(shutdownAudit?.details?.extensionDisposalTimedOut).toBe(true);
		expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");

		releaseDispose();
		await client.close();
	}, 20_000);

	it("bounds redeemed relay physical tails after relay application quiesce", async () => {
		const paths = getDaemonPaths(agentDir);
		let releaseRead: () => void = () => {};
		let releaseWrite: () => void = () => {};
		let releaseReset: () => void = () => {};
		let releaseStop: () => void = () => {};
		let releaseApplicationMutation: () => void = () => {};
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const resetGate = new Promise<void>((resolve) => {
			releaseReset = resolve;
		});
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		const applicationMutationGate = new Promise<void>((resolve) => {
			releaseApplicationMutation = resolve;
		});
		const physicalTasks = new Set<Promise<void>>();
		const registry = new RelayRegistry();
		let relay: RelayLifecycleOwner | undefined;
		let relaySettledCount = 0;
		let applicationMutationStarted = false;
		let quiesced = false;
		let disposeStarted = false;
		let disposeSettled = false;
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			() => {
				const phone = new FakePhoneIrohStream();
				phone.recv.read = async () => {
					await readGate;
					return undefined;
				};
				phone.recv.stop = () => stopGate;
				phone.send.writeAll = () => writeGate;
				phone.send.reset = () => resetGate;
				relay = registry.mint({
					workspaceName: "ws",
					sessionId: "s-relay-tail",
					clientNodeId: "n-phone",
					ownerControlConnectionId: "control-test",
					connectionId: "conn-test",
					streamId: "stream-test",
					stream: phone,
					preamble: {
						handshake: { hello: {}, response: {} },
						authorization: {
							clientNodeId: "n-phone",
							workspaceName: "ws",
							workspacePath: "/tmp/ws",
							workspaceNames: ["ws"],
							workspaces: [{ name: "ws", status: "available" }],
							allowedTools: "",
							rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
						},
						relayMode: "disabled",
						connectionId: "conn-test",
						streamId: "stream-test",
						resolvedTarget: {
							sessionId: "s-relay-tail",
							selection: "resumed",
							workspaceName: "ws",
							workspacePath: "/tmp/ws",
						},
					},
					rejectPending: () => {},
					onSettled: async () => {
						applicationMutationStarted = true;
						await applicationMutationGate;
						relaySettledCount++;
					},
					observePhysicalTask: (task) => {
						const settled = task.then(
							() => undefined,
							() => undefined,
						);
						physicalTasks.add(settled);
						void settled.then(() => physicalTasks.delete(settled));
					},
				});
				return {
					admitRelay: (relayId, relayToken, socket, bufferedRemainder) =>
						registry.admit(relayId, relayToken, socket, bufferedRemainder),
					async quiesce() {
						await relay?.close("host_shutdown", { pendingMessage: "daemon shutting down" });
						quiesced = true;
					},
					async dispose() {
						disposeStarted = true;
						while (physicalTasks.size > 0) {
							await Promise.allSettled(Array.from(physicalTasks));
						}
						disposeSettled = true;
					},
				};
			},
		]);
		const status = await waitForDaemon();
		if (!relay) throw new Error("relay fixture was not minted");
		const relayClient: RawRelayClient = connectRawRelayClient(status.socketPath, relay);
		const control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});

		try {
			await expect.poll(() => relayClient.messages.length).toBe(2);
			relayClient.socket.write(Buffer.from("admitted relay bytes", "utf8"));
			await expect.poll(() => physicalTasks.size).toBeGreaterThan(1);
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await expect.poll(() => applicationMutationStarted).toBe(true);
			expect(disposeStarted).toBe(false);
			releaseApplicationMutation();
			await expect(daemon).resolves.toBe(0);
			expect(quiesced).toBe(true);
			expect(disposeSettled).toBe(false);
			expect(relaySettledCount).toBe(1);
			expect(registry.get(relay.relayId)).toBeUndefined();
			expect(existsSync(paths.pidfilePath)).toBe(false);
			expect(existsSync(paths.socketPath)).toBe(false);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
			const auditAfterShutdown = readFileSync(paths.auditPath, "utf8");

			releaseRead();
			releaseWrite();
			releaseReset();
			releaseStop();
			releaseApplicationMutation();
			await expect.poll(() => disposeSettled).toBe(true);
			expect(relaySettledCount).toBe(1);
			expect(readFileSync(paths.auditPath, "utf8")).toBe(auditAfterShutdown);
		} finally {
			releaseRead();
			releaseWrite();
			releaseReset();
			releaseStop();
			releaseApplicationMutation();
			relayClient.socket.destroy();
			await control.close();
			await daemon;
		}
	}, 20_000);

	it("forces process exit when a second shutdown signal arrives during quiescing", async () => {
		let signalHandler: (() => void) | undefined;
		let removedSignalHandler: (() => void) | undefined;
		const forcedExitCodes: number[] = [];
		let releaseQuiesce: () => void = () => {};
		const quiesceGate = new Promise<void>((resolve) => {
			releaseQuiesce = resolve;
		});
		let quiesceStarted = false;
		const daemon = runVoltDaemon(
			{
				agentDir,
				foreground: false,
				processLifecycle: {
					addShutdownSignalHandler(handler) {
						signalHandler = handler;
					},
					removeShutdownSignalHandler(handler) {
						removedSignalHandler = handler;
					},
					forceExit(code) {
						forcedExitCodes.push(code);
					},
				},
			},
			[
				() => ({
					async quiesce() {
						quiesceStarted = true;
						await quiesceGate;
					},
				}),
			],
		);
		await waitForDaemon();
		expect(signalHandler).toBeDefined();

		signalHandler?.();
		await expect.poll(() => quiesceStarted).toBe(true);
		expect(forcedExitCodes).toEqual([]);
		signalHandler?.();
		expect(forcedExitCodes).toEqual([1]);

		releaseQuiesce();
		await expect(daemon).resolves.toBe(0);
		expect(removedSignalHandler).toBe(signalHandler);
	}, 20_000);
});

describe("daemon log rotation", () => {
	it("rotates at the size threshold keeping one rotated file", () => {
		const dir = mkdtempSync(join(tmpdir(), "voltd-log-"));
		try {
			const logPath = join(dir, "voltd.log");
			const logger = createDaemonLogger({ logPath });
			const bigDetail = "x".repeat(1024 * 1024);
			for (let index = 0; index < 11; index++) {
				logger.log("info", "test", `entry ${index}`, { pad: bigDetail });
			}
			expect(existsSync(`${logPath}.1`)).toBe(true);
			expect(existsSync(logPath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
