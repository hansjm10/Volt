import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir, VERSION } from "../config.ts";
import { type IrohRemoteAccessPresetName, isIrohRemoteAccessPresetName } from "../core/remote/iroh/access-grant.ts";
import { formatIrohRemoteTicketQrCode } from "../core/remote/iroh/qr.ts";
import { getIrohRemotePairingVerificationDetails } from "../core/remote/iroh/ticket.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { createDaemonClient, type DaemonClient } from "./control-client.ts";
import type { ControlEvent, ControlResponse } from "./control-protocol.ts";
import { ensureDaemonRunning, probeDaemon } from "./spawn.ts";

function printRemoteUsage(): void {
	console.error(`Usage: volt remote <command>

Commands:
  pair [--workspace <name>] [--access coding|review|chat|full]
                                Create a pairing ticket (default access: coding).
  access <node-id> set <preset> Update a paired device's tool and RPC access.
  status [--json]               Show daemon status (workspaces, clients, leases).
  clients                       List paired clients.
  revoke <node-id>              Revoke a paired client and close its connections.
  approve-repair <node-id>      Allow a revoked client node ID to re-pair.
  workspace add [path] [--name <name>]
                                Register a workspace with the daemon.
  workspace remove <name>       Unregister an empty workspace (refuses while worktrees exist).
  workspace list                List registered workspaces.
  worktree add [--workspace <name>] [--name <id>] [--branch <ref>] [--base <ref>]
                                Create a daemon-managed git worktree.
  worktree adopt <path> [--workspace <name>] [--name <id>] [--base <ref>]
                                Adopt an existing git worktree checkout.
  worktree list [--workspace <name>] [--json]
                                List daemon-managed worktrees.
  worktree remove <id> [--workspace <name>] [--force]
                                Remove a worktree (refuses dirty/busy without --force).
  worktree prune [--workspace <name>] [--purge-recovery]
                                Reconcile records; explicitly purge unowned recovery checkouts.
  worktree diff <id> [--workspace <name>]
                                Show the worktree branch's diff against its base ref.

"volt remote host" has been replaced by the background daemon. Run "volt daemon start"
(or enable remote.background). See docs/daemon.md.
`);
}

interface RemoteControlSession {
	client: DaemonClient;
	events: (handler: (event: ControlEvent) => void) => void;
	/** Resolves if the daemon control connection is lost before close() is called. */
	whenConnectionLost: Promise<void>;
	close(): Promise<void>;
}

async function connectToDaemon(options: { autoStart: boolean }): Promise<RemoteControlSession | undefined> {
	const agentDir = getAgentDir();
	let probe = await probeDaemon(agentDir);
	if (!probe.healthy && options.autoStart) {
		probe = await ensureDaemonRunning(agentDir);
	}
	if (!probe.healthy) {
		console.error("voltd is not running. Start it with: volt daemon start");
		process.exitCode = 1;
		return undefined;
	}
	const handlers = new Set<(event: ControlEvent) => void>();
	let closing = false;
	let resolveConnectionLost: () => void = () => {};
	const whenConnectionLost = new Promise<void>((resolve) => {
		resolveConnectionLost = resolve;
	});
	const client = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: VERSION,
		authToken: probe.authToken,
		reconnect: false,
		onEvent: (event) => {
			for (const handler of handlers) {
				handler(event);
			}
		},
		onConnectionStateChange: (nextState) => {
			if (nextState === "gone" && !closing) {
				resolveConnectionLost();
			}
		},
	});
	try {
		await client.connect();
	} catch (error) {
		console.error(`Error: could not connect to voltd: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		return undefined;
	}
	return {
		client,
		events: (handler) => {
			handlers.add(handler);
		},
		whenConnectionLost,
		close: () => {
			closing = true;
			return client.close();
		},
	};
}

function reportControlError(response: ControlResponse, context: string): boolean {
	if (response.type === "error") {
		const code = response.code === "workspace_has_worktrees" ? ` [${response.code}]` : "";
		console.error(`Error: ${context}${code}: ${response.message}`);
		process.exitCode = 1;
		return true;
	}
	return false;
}

async function getCanonicalCwd(): Promise<string> {
	try {
		return await realpath(process.cwd());
	} catch {
		return resolve(process.cwd());
	}
}

function findWorkspaceForPath<T extends { path: string }>(workspaces: readonly T[], path: string): T | undefined {
	return workspaces
		.filter((workspace) => {
			const relativePath = relative(resolve(workspace.path), path);
			return (
				relativePath.length === 0 ||
				(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
			);
		})
		.sort((left, right) => right.path.length - left.path.length)[0];
}

/** Render only the non-secret ticket fields a user should compare in Volt. */
export function formatRemotePairingVerificationLines(ticket: string): string[] {
	const details = getIrohRemotePairingVerificationDetails(ticket);
	return [
		"verify these details in Volt before confirming:",
		"  Fingerprint",
		`    ${details.hostFingerprint}`,
		"  Host ID",
		`    ${details.hostNodeId}`,
		"  Workspace",
		`    ${details.workspace}`,
		"  Relay mode",
		`    ${details.relayMode}`,
		"  HTTPS relay origins",
		...(details.relayOrigins.length === 0 ? ["    none"] : details.relayOrigins.map((origin) => `    ${origin}`)),
		"  Expires (UTC)",
		`    ${details.expiresAt === undefined ? "not specified" : new Date(details.expiresAt).toISOString()}`,
	];
}

async function handlePairCommand(args: string[]): Promise<void> {
	let workspaceName: string | undefined;
	let access: IrohRemoteAccessPresetName = "coding";
	const accessIndex = args.indexOf("--access");
	if (accessIndex !== -1) {
		const value = args[accessIndex + 1];
		if (!isIrohRemoteAccessPresetName(value)) {
			console.error("Error: --access requires coding, review, chat, or full");
			process.exitCode = 1;
			return;
		}
		access = value;
	}
	const workspaceIndex = args.indexOf("--workspace");
	if (workspaceIndex !== -1) {
		workspaceName = args[workspaceIndex + 1];
		if (!workspaceName) {
			console.error("Error: --workspace requires a value");
			process.exitCode = 1;
			return;
		}
	}

	const session = await connectToDaemon({ autoStart: true });
	if (!session) {
		return;
	}
	try {
		// Default the pairing workspace to the daemon workspace registered for the cwd,
		// registering the cwd when nothing matches (name = basename).
		if (workspaceName === undefined) {
			const status = await session.client.request({ type: "status" });
			if (status.type !== "status_result") {
				reportControlError(status, "status");
				return;
			}
			const cwd = await getCanonicalCwd();
			const match = findWorkspaceForPath(status.workspaces, cwd);
			if (match) {
				workspaceName = match.name;
			} else {
				workspaceName = basename(cwd) || "workspace";
				const registered = await session.client.request({
					type: "workspace_register",
					name: workspaceName,
					path: cwd,
				});
				if (reportControlError(registered, "workspace register")) {
					return;
				}
				console.error(`registered workspace: ${workspaceName} -> ${cwd}`);
			}
		}

		const done = new Promise<void>((resolveDone) => {
			session.events((event) => {
				if (event.type !== "pairing_progress") {
					return;
				}
				if (event.phase === "ticket" && event.ticket) {
					try {
						for (const line of formatRemotePairingVerificationLines(event.ticket)) console.error(line);
					} catch (error) {
						console.error(
							`pairing failed: ticket verification details are invalid: ${error instanceof Error ? error.message : String(error)}`,
						);
						process.exitCode = 1;
						resolveDone();
						return;
					}
					if (process.stderr.isTTY) {
						try {
							console.error("pairing ticket QR:");
							console.error(formatIrohRemoteTicketQrCode(event.ticket));
						} catch (error) {
							console.error(
								`Could not render pairing QR: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					console.error("pairing ticket:");
					console.log(event.ticket);
					return;
				}
				if (event.phase === "waiting") {
					console.error("waiting for the phone to pair (Ctrl-C to stop waiting)...");
					return;
				}
				if (event.phase === "completed") {
					console.error(`paired: ${event.clientNodeId ?? "client"}`);
					resolveDone();
					return;
				}
				if (event.phase === "failed") {
					console.error(`pairing failed: ${event.error ?? "unknown error"}`);
					process.exitCode = 1;
					resolveDone();
				}
			});
		});

		const response = await session.client.request({
			type: "pair_request",
			access,
			...(workspaceName === undefined ? {} : { workspaceName }),
		});
		if (reportControlError(response, "pair")) {
			return;
		}
		await Promise.race([
			done,
			session.whenConnectionLost.then(() => {
				console.error("Error: lost connection to voltd while waiting for the phone to pair");
				process.exitCode = 1;
			}),
		]);
	} finally {
		await session.close();
	}
}

async function handleStatusCommand(args: string[]): Promise<void> {
	const session = await connectToDaemon({ autoStart: false });
	if (!session) {
		return;
	}
	try {
		const response = await session.client.request({ type: "status" });
		if (response.type !== "status_result") {
			reportControlError(response, "status");
			return;
		}
		if (args.includes("--json")) {
			console.log(JSON.stringify({ ...response, id: undefined, type: undefined }, null, 2));
			return;
		}
		console.error(`voltd ${response.version} (pid ${response.pid})`);
		console.error(`workspaces: ${response.workspaces.length}`);
		for (const workspace of response.workspaces) {
			console.error(`  ${workspace.name} -> ${workspace.path}`);
		}
		console.error(`paired clients: ${response.clients.length}`);
		for (const client of response.clients) {
			console.error(`  ${client.clientNodeId}${client.label ? ` (${client.label})` : ""}`);
		}
		console.error(`phone connections: ${response.phoneConnections}`);
		console.error(`leases: ${response.leases.length}`);
		for (const lease of response.leases) {
			console.error(
				`  ${lease.workspaceName}/${lease.sessionId}: ${lease.state} (streams ${lease.streamCount}, relays ${lease.relayCount})`,
			);
		}
	} finally {
		await session.close();
	}
}

async function handleClientsCommand(): Promise<void> {
	const session = await connectToDaemon({ autoStart: false });
	if (!session) {
		return;
	}
	try {
		const response = await session.client.request({ type: "clients_list" });
		if (response.type !== "clients_result") {
			reportControlError(response, "clients");
			return;
		}
		console.log(JSON.stringify(response.clients, null, 2));
	} finally {
		await session.close();
	}
}

async function handleAccessCommand(args: string[]): Promise<void> {
	const [nodeId, action, presetValue] = args;
	if (!nodeId || action !== "set" || !isIrohRemoteAccessPresetName(presetValue)) {
		console.error("Error: usage: volt remote access <node-id> set coding|review|chat|full");
		process.exitCode = 1;
		return;
	}
	const session = await connectToDaemon({ autoStart: false });
	if (!session) return;
	try {
		const clients = await session.client.request({ type: "clients_list" });
		if (clients.type !== "clients_result") {
			reportControlError(clients, "clients");
			return;
		}
		const client = clients.clients.find((entry) => entry.clientNodeId === nodeId);
		if (!client) {
			console.error(`Error: paired client not found: ${nodeId}`);
			process.exitCode = 1;
			return;
		}
		if (!client.rpcGrant) {
			console.error(`Error: paired client has no RPC grant and must re-pair: ${nodeId}`);
			process.exitCode = 1;
			return;
		}
		const response = await session.client.request({
			type: "client_access_update",
			clientNodeId: nodeId,
			expectedRevision: client.rpcGrant.revision,
			access: presetValue,
		});
		if (reportControlError(response, "access set")) return;
		if (response.type !== "client_access_updated" || response.client.rpcGrant === undefined) {
			console.error("Error: unexpected daemon response for access set");
			process.exitCode = 1;
			return;
		}
		console.error(`updated access for ${nodeId}: ${presetValue} (revision ${response.client.rpcGrant.revision})`);
	} finally {
		await session.close();
	}
}

async function handleRevokeCommand(args: string[]): Promise<void> {
	const all = args.includes("--all");
	const positionals = args.filter((arg) => !arg.startsWith("--"));
	if (!all && positionals.length === 0) {
		console.error("Error: Missing node id to revoke");
		process.exitCode = 1;
		return;
	}
	const session = await connectToDaemon({ autoStart: false });
	if (!session) {
		return;
	}
	try {
		let nodeIds = positionals;
		if (all) {
			const clients = await session.client.request({ type: "clients_list" });
			if (clients.type !== "clients_result") {
				reportControlError(clients, "clients");
				return;
			}
			nodeIds = clients.clients.map((client) => client.clientNodeId);
			if (nodeIds.length === 0) {
				console.error("No paired clients to revoke");
				return;
			}
		}
		let revokedCount = 0;
		for (const nodeId of nodeIds) {
			const response = await session.client.request({ type: "client_revoke", clientNodeId: nodeId });
			if (response.type === "error") {
				console.error(`Error: revoke ${nodeId}: ${response.message}`);
				process.exitCode = 1;
				continue;
			}
			revokedCount++;
			console.error(`Revoked ${nodeId}`);
		}
		if (all) {
			console.error(`Revoked ${revokedCount} client${revokedCount === 1 ? "" : "s"}`);
		}
	} finally {
		await session.close();
	}
}

async function handleApproveRepairCommand(args: string[]): Promise<void> {
	const nodeId = args[0];
	if (!nodeId) {
		console.error("Error: Missing node id to approve for re-pair");
		process.exitCode = 1;
		return;
	}
	const session = await connectToDaemon({ autoStart: false });
	if (!session) {
		return;
	}
	try {
		const response = await session.client.request({ type: "client_approve_repair", clientNodeId: nodeId });
		if (reportControlError(response, "approve-repair")) {
			return;
		}
		console.error(`Approved re-pair for ${nodeId}`);
	} finally {
		await session.close();
	}
}

async function handleWorkspaceCommand(args: string[]): Promise<void> {
	const subcommand = args[0];
	if (subcommand === "add") {
		const rest = args.slice(1);
		let name: string | undefined;
		const nameIndex = rest.indexOf("--name");
		if (nameIndex !== -1) {
			name = rest[nameIndex + 1];
			if (!name) {
				console.error("Error: --name requires a value");
				process.exitCode = 1;
				return;
			}
			rest.splice(nameIndex, 2);
		}
		const path = resolve(rest[0] ?? process.cwd());
		const workspaceName = name ?? basename(path) ?? "workspace";
		const session = await connectToDaemon({ autoStart: true });
		if (!session) {
			return;
		}
		try {
			const response = await session.client.request({ type: "workspace_register", name: workspaceName, path });
			if (reportControlError(response, "workspace add")) {
				return;
			}
			console.error(`registered workspace: ${workspaceName} -> ${path}`);
		} finally {
			await session.close();
		}
		return;
	}
	if (subcommand === "remove") {
		const name = args[1];
		if (!name) {
			console.error("Error: workspace remove requires a name");
			process.exitCode = 1;
			return;
		}
		const session = await connectToDaemon({ autoStart: false });
		if (!session) {
			return;
		}
		try {
			const response = await session.client.request({ type: "workspace_unregister", name });
			if (reportControlError(response, "workspace remove")) {
				return;
			}
			console.error(`unregistered workspace: ${name}`);
		} finally {
			await session.close();
		}
		return;
	}
	if (subcommand === "list") {
		const session = await connectToDaemon({ autoStart: false });
		if (!session) {
			return;
		}
		try {
			const response = await session.client.request({ type: "status" });
			if (response.type !== "status_result") {
				reportControlError(response, "workspace list");
				return;
			}
			console.log(JSON.stringify(response.workspaces, null, 2));
		} finally {
			await session.close();
		}
		return;
	}
	console.error(`Error: Unknown workspace command: ${subcommand ?? "<missing>"}`);
	printRemoteUsage();
	process.exitCode = 1;
}

function takeFlagValue(args: string[], flag: string): { ok: true; value: string | undefined } | { ok: false } {
	const index = args.indexOf(flag);
	if (index === -1) {
		return { ok: true, value: undefined };
	}
	const value = args[index + 1];
	if (!value) {
		console.error(`Error: ${flag} requires a value`);
		process.exitCode = 1;
		return { ok: false };
	}
	args.splice(index, 2);
	return { ok: true, value };
}

/**
 * Default the workspace to the daemon workspace registered for the cwd (same
 * prefix match as pairing), without auto-registering on miss.
 */
async function resolveWorkspaceNameForCwd(session: RemoteControlSession): Promise<string | undefined> {
	const status = await session.client.request({ type: "status" });
	if (status.type !== "status_result") {
		reportControlError(status, "status");
		return undefined;
	}
	const cwd = await getCanonicalCwd();
	const match = findWorkspaceForPath(status.workspaces, cwd);
	if (!match) {
		console.error("Error: no registered workspace matches the current directory; pass --workspace <name>");
		process.exitCode = 1;
		return undefined;
	}
	return match.name;
}

async function handleWorktreeCommand(args: string[]): Promise<void> {
	const subcommand = args[0];
	if (
		subcommand !== "add" &&
		subcommand !== "adopt" &&
		subcommand !== "list" &&
		subcommand !== "remove" &&
		subcommand !== "prune" &&
		subcommand !== "diff"
	) {
		console.error(`Error: Unknown worktree command: ${subcommand ?? "<missing>"}`);
		printRemoteUsage();
		process.exitCode = 1;
		return;
	}
	const rest = args.slice(1);
	const workspaceFlag = takeFlagValue(rest, "--workspace");
	if (!workspaceFlag.ok) {
		return;
	}
	const session = await connectToDaemon({ autoStart: false });
	if (!session) {
		return;
	}
	try {
		let workspaceName = workspaceFlag.value;
		if (
			workspaceName === undefined &&
			(subcommand === "add" || subcommand === "adopt" || subcommand === "remove" || subcommand === "diff")
		) {
			workspaceName = await resolveWorkspaceNameForCwd(session);
			if (workspaceName === undefined) {
				return;
			}
		}
		if (subcommand === "add") {
			const nameFlag = takeFlagValue(rest, "--name");
			const branchFlag = takeFlagValue(rest, "--branch");
			const baseFlag = takeFlagValue(rest, "--base");
			if (!nameFlag.ok || !branchFlag.ok || !baseFlag.ok || workspaceName === undefined) {
				return;
			}
			const response = await session.client.request({
				type: "worktree_create",
				workspaceName,
				...(nameFlag.value === undefined ? {} : { worktreeName: nameFlag.value }),
				...(branchFlag.value === undefined ? {} : { branch: branchFlag.value }),
				...(baseFlag.value === undefined ? {} : { baseRef: baseFlag.value }),
			});
			if (reportControlError(response, "worktree add")) {
				return;
			}
			if (response.type !== "worktree_result") {
				console.error("Error: unexpected daemon response for worktree add");
				process.exitCode = 1;
				return;
			}
			console.error(
				`created worktree ${response.worktree.id} (branch ${response.worktree.branch}) -> ${response.worktree.path}`,
			);
			return;
		}
		if (subcommand === "adopt") {
			const nameFlag = takeFlagValue(rest, "--name");
			const baseFlag = takeFlagValue(rest, "--base");
			const path = rest.filter((arg) => !arg.startsWith("--"))[0];
			if (!nameFlag.ok || !baseFlag.ok || workspaceName === undefined) {
				return;
			}
			if (!path) {
				console.error("Error: worktree adopt requires a path");
				process.exitCode = 1;
				return;
			}
			const response = await session.client.request({
				type: "worktree_adopt",
				workspaceName,
				path: resolve(path),
				...(nameFlag.value === undefined ? {} : { worktreeName: nameFlag.value }),
				...(baseFlag.value === undefined ? {} : { baseRef: baseFlag.value }),
			});
			if (reportControlError(response, "worktree adopt")) {
				return;
			}
			if (response.type !== "worktree_result") {
				console.error("Error: unexpected daemon response for worktree adopt");
				process.exitCode = 1;
				return;
			}
			console.error(
				`adopted worktree ${response.worktree.id} (branch ${response.worktree.branch}) -> ${response.worktree.path}`,
			);
			return;
		}
		if (subcommand === "list") {
			const response = await session.client.request({
				type: "worktree_list",
				...(workspaceName === undefined ? {} : { workspaceName }),
			});
			if (reportControlError(response, "worktree list")) {
				return;
			}
			if (response.type !== "worktrees_result") {
				console.error("Error: unexpected daemon response for worktree list");
				process.exitCode = 1;
				return;
			}
			if (rest.includes("--json")) {
				console.log(JSON.stringify(response.worktrees, null, 2));
				return;
			}
			for (const worktree of response.worktrees) {
				const aheadBehind =
					worktree.aheadBehind === undefined
						? ""
						: ` (+${worktree.aheadBehind.ahead}/-${worktree.aheadBehind.behind})`;
				console.error(
					`${worktree.workspaceName}/${worktree.id}: ${worktree.branch}${aheadBehind}` +
						`${worktree.available === false ? " (missing)" : ""}${worktree.dirty === true ? " (dirty)" : ""}` +
						` -> ${worktree.path}`,
				);
			}
			if (response.worktrees.length === 0) {
				console.error("no worktrees");
			}
			return;
		}
		if (subcommand === "diff") {
			const worktreeId = rest.filter((arg) => !arg.startsWith("--"))[0];
			if (!worktreeId || workspaceName === undefined) {
				if (!worktreeId) {
					console.error("Error: worktree diff requires a worktree id");
					process.exitCode = 1;
				}
				return;
			}
			const response = await session.client.request({ type: "worktree_list", workspaceName });
			if (reportControlError(response, "worktree diff")) {
				return;
			}
			if (response.type !== "worktrees_result") {
				console.error("Error: unexpected daemon response for worktree diff");
				process.exitCode = 1;
				return;
			}
			const worktree = response.worktrees.find((entry) => entry.id === worktreeId);
			if (!worktree) {
				console.error(`Error: no worktree ${worktreeId} in workspace ${workspaceName}`);
				process.exitCode = 1;
				return;
			}
			if (worktree.available === false) {
				console.error(`Error: worktree ${worktreeId} checkout is missing (${worktree.path})`);
				process.exitCode = 1;
				return;
			}
			// Read-only, run locally in the user's terminal; the daemon never mutates
			// the main checkout (design §5.3).
			const child = spawnProcess("git", ["-C", worktree.path, "diff", `${worktree.baseRef ?? "HEAD"}...HEAD`], {
				stdio: ["ignore", "inherit", "inherit"],
			});
			const code = await waitForChildProcess(child);
			if (code !== 0) {
				process.exitCode = 1;
			}
			return;
		}
		if (subcommand === "remove") {
			const force = rest.includes("--force");
			const worktreeId = rest.filter((arg) => !arg.startsWith("--"))[0];
			if (!worktreeId) {
				console.error("Error: worktree remove requires a worktree id");
				process.exitCode = 1;
				return;
			}
			if (workspaceName === undefined) {
				return;
			}
			const response = await session.client.request({
				type: "worktree_remove",
				workspaceName,
				worktreeId,
				...(force ? { force } : {}),
			});
			if (reportControlError(response, "worktree remove")) {
				return;
			}
			console.error(`removed worktree ${worktreeId}`);
			return;
		}
		const purgeRecovery = rest.includes("--purge-recovery");
		const response = await session.client.request({
			type: "worktree_prune",
			...(workspaceName === undefined ? {} : { workspaceName }),
			...(purgeRecovery ? { purgeRecovery } : {}),
		});
		if (reportControlError(response, "worktree prune")) {
			return;
		}
		if (response.type !== "worktree_prune_result") {
			console.error("Error: unexpected daemon response for worktree prune");
			process.exitCode = 1;
			return;
		}
		for (const result of response.results) {
			console.error(
				`${result.workspaceName}: removed ${result.removedRecords.length} record(s), ` +
					`quarantined ${result.orphanCheckouts.length} orphan checkout(s), ` +
					`purged ${result.purgedRecoveryCheckouts?.length ?? 0} recovery checkout(s)`,
			);
		}
	} finally {
		await session.close();
	}
}

/** Router for `volt remote <command>` (daemon control clients); returns true when handled. */
export async function handleRemoteControlCommand(
	args: string[],
	options: { isStandaloneBinary: boolean },
): Promise<boolean> {
	if (args[0] !== "remote") {
		return false;
	}
	const command = args[1];
	if (command === undefined || command === "--help" || command === "-h") {
		printRemoteUsage();
		return true;
	}
	if (command === "host") {
		console.error(
			'"volt remote host" has been replaced by the background daemon. Run "volt daemon start" (or enable remote.background). See docs/daemon.md.',
		);
		process.exitCode = 1;
		return true;
	}
	if (options.isStandaloneBinary) {
		console.error("Error: volt remote is not available from the standalone binary release.");
		console.error("Use a Node.js npm install or a source checkout with optional @number0/iroh dependencies.");
		process.exitCode = 1;
		return true;
	}
	const rest = args.slice(2);
	switch (command) {
		case "pair":
			await handlePairCommand(rest);
			return true;
		case "status":
			await handleStatusCommand(rest);
			return true;
		case "clients":
			await handleClientsCommand();
			return true;
		case "access":
			await handleAccessCommand(rest);
			return true;
		case "revoke":
			await handleRevokeCommand(rest);
			return true;
		case "approve-repair":
			await handleApproveRepairCommand(rest);
			return true;
		case "workspace":
			await handleWorkspaceCommand(rest);
			return true;
		case "worktree":
			await handleWorktreeCommand(rest);
			return true;
		default:
			console.error(`Error: Unknown remote command: ${command}`);
			printRemoteUsage();
			process.exitCode = 1;
			return true;
	}
}
