/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/volt-ai";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, isBunBinary, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import {
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	formatIrohRemoteTicketQrCode,
	getIrohRemoteUnsafeAllowedTools,
	getIrohRemoteWorkspaceAvailabilityStatus,
	IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE,
	IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
	IrohRemoteAuditLogger,
	type IrohRemoteClient,
	IrohRemoteHostStateManager,
	type IrohRemotePushTarget,
	type IrohRemoteRelayMode,
	type IrohRemoteRevokedClient,
	type IrohRemoteUnsafeApproval,
	type IrohRemoteWorkspace,
	type IrohRemoteWorkspaceAvailabilityStatus,
	isIrohRemoteRelayMode,
	normalizeIrohRemoteAllowTools,
	requestIrohRemoteActiveRevocation,
	requestIrohRemotePairingTicket,
} from "./core/remote/iroh/index.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { SubagentManager } from "./core/subagents/index.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { handleStoreCommand } from "./store/store-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function printRemoteCommandHelp(): void {
	console.error(`Usage:
  volt remote host [options]
  volt remote host --register-workspace [path|name=path] [options]
  volt remote host --unregister-workspace <name> [options]
  volt remote pair [options]
  volt remote status [options]
  volt remote clients [options]
  volt remote revoke <node-id>|--all [options]
  volt remote approve-repair <node-id> [options]

Host options are forwarded to the integrated Iroh remote host. Common options:
  --workspace <name=path>       Workspace exposed to the client
  --register-workspace [spec]   Register cwd, path, or name=path in host state and exit
  --unregister-workspace <name> Remove a registered workspace from host state without deleting files
  --mobile                      Mobile-facing host mode. Skips startup pairing; relay already defaults to default
  --relay <disabled|default>    Iroh relay preset. Defaults to default; use disabled for LAN-only testing
  --state <path>                Host state path
  --audit <path>                Host audit JSONL path
  --allow-tools <list>          Remote tool allowlist. Defaults to the saved workspace allowlist or default remote tools.
                                bash/edit/write can mutate host state; web_search can make network requests with host credentials.
                                These grants require confirmation.
  --profile <name>              Volt settings profile
  --agent-dir <path>            Volt agent config directory
  --push-relay-url <url>        Volt push relay URL. Defaults to the managed Volt relay or VOLT_PUSH_RELAY_URL.
  --push-relay-auth-token <token>
                                Optional bearer token for custom push relays. Defaults to VOLT_PUSH_RELAY_AUTH_TOKEN.
  --approve                     Trust project-local Volt settings/resources for the remote workspace
  --no-pairing                  Reject unpaired clients and print a paired-client ticket
  --once                        Exit after first client disconnects
  --yes                         Accept unsafe remote tool grants for noninteractive startup without trusting the workspace

Pair options:
  --workspace <name>            Saved workspace name to pair with the running host
  --allow-tools <list>          Tool allowlist for the new client. Defaults to the saved workspace allowlist or default remote tools.
  --label <label>               Optional label hint if the client does not provide one
  --ttl <duration>              Pairing ticket TTL, e.g. 30s, 10m, or 1h
  --state <path>                Host state path
  --relay <disabled|default>    Expected running host relay mode; omitted uses the live host mode
  --yes                         Accept unsafe remote tool grants for noninteractive pairing

Client management options:
  --state <path>                Host state path
  --audit <path>                Audit JSONL path for status/revoke/approve-repair
  --all                         Revoke every paired client (revoke command only)
`);
}

interface RemoteManagementArgs {
	auditPath?: string;
	error?: string;
	help: boolean;
	positionals: string[];
	statePath: string;
}

interface RemoteRevokeArgs extends RemoteManagementArgs {
	all: boolean;
}

interface RemotePairArgs {
	allowTools?: string;
	error?: string;
	help: boolean;
	labelHint?: string;
	positionals: string[];
	relayMode?: IrohRemoteRelayMode;
	statePath: string;
	ttlMs?: number;
	workspace?: string;
	yes: boolean;
}

interface RemoteHostUnregisterArgs {
	error?: string;
	help: boolean;
	positionals: string[];
	statePath: string;
	workspaceName?: string;
}

interface IrohRemoteStatusWorkspaceView {
	allowedTools?: string;
	name: string;
	path: string;
	status: IrohRemoteWorkspaceAvailabilityStatus;
}

interface IrohRemoteStatusClientView {
	allowedTools: string;
	allowedWorkspaces: string[];
	label: string;
	lastSeenAt: number;
	nodeId: string;
	pairedAt: number;
	pushTargetCount?: number;
	pushTargets?: IrohRemoteStatusPushTargetView[];
}

interface IrohRemoteStatusPushTargetView {
	createdAt: number;
	enabled: boolean;
	hasTokenHash: boolean;
	platform: string;
	provider: string;
	relayUrl?: string;
	updatedAt: number;
}

interface IrohRemoteStatusRevokedClientView {
	allowedTools: string;
	allowedWorkspaces: string[];
	label: string;
	lastSeenAt: number;
	nodeId: string;
	pairedAt: number;
	rePairApprovedAt?: number;
	revokedAt: number;
}

interface IrohRemoteStatusView {
	auditPath: string;
	clientCount: number;
	clients: IrohRemoteStatusClientView[];
	liveStatus: {
		available: false;
		warning: string;
	};
	revokedClientCount: number;
	revokedClients: IrohRemoteStatusRevokedClientView[];
	statePath: string;
	warning: string;
	workspaces: IrohRemoteStatusWorkspaceView[];
}

const IROH_REMOTE_PERSISTED_STATUS_WARNING =
	"Persisted state only; live Iroh remote host status is not available from this command yet.";

function getDefaultIrohRemoteStatePath(): string {
	return join(getAgentDir(), "remote", "iroh-host.json");
}

function getDefaultIrohRemoteAuditPath(statePath: string): string {
	return statePath.endsWith(".json")
		? `${statePath.slice(0, -".json".length)}.audit.jsonl`
		: `${statePath}.audit.jsonl`;
}

function argsIncludeOption(args: readonly string[], option: string): boolean {
	return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function addDefaultRemoteHostStateArgs(args: readonly string[]): string[] {
	if (argsIncludeOption(args, "--state")) {
		return [...args];
	}
	return ["--state", getDefaultIrohRemoteStatePath(), ...args];
}

function addDefaultRemoteHostRuntimeArgs(args: readonly string[]): string[] {
	return [...args];
}

function parseRemoteManagementArgs(args: readonly string[]): RemoteManagementArgs {
	const positionals: string[] = [];
	let auditPath: string | undefined;
	let statePath = getDefaultIrohRemoteStatePath();

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { auditPath, help: true, positionals, statePath };
		}

		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
		if (flag === "--state" || flag === "--audit") {
			const value = inlineValue ?? args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { auditPath, error: `${flag} requires a value`, help: false, positionals, statePath };
			}
			if (inlineValue === undefined) {
				index++;
			}
			if (flag === "--state") {
				statePath = resolvePath(value);
			} else {
				auditPath = resolvePath(value);
			}
			continue;
		}

		if (arg.startsWith("-")) {
			return { auditPath, error: `Unknown remote option: ${arg}`, help: false, positionals, statePath };
		}
		positionals.push(arg);
	}

	return { auditPath, help: false, positionals, statePath: resolvePath(statePath) };
}

function parseRemoteRevokeArgs(args: readonly string[]): RemoteRevokeArgs {
	const positionals: string[] = [];
	let all = false;
	let auditPath: string | undefined;
	let statePath = getDefaultIrohRemoteStatePath();

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { all, auditPath, help: true, positionals, statePath };
		}
		if (arg === "--all") {
			all = true;
			continue;
		}

		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
		if (flag === "--state" || flag === "--audit") {
			const value = inlineValue ?? args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { all, auditPath, error: `${flag} requires a value`, help: false, positionals, statePath };
			}
			if (inlineValue === undefined) {
				index++;
			}
			if (flag === "--state") {
				statePath = resolvePath(value);
			} else {
				auditPath = resolvePath(value);
			}
			continue;
		}

		if (arg.startsWith("-")) {
			return { all, auditPath, error: `Unknown remote revoke option: ${arg}`, help: false, positionals, statePath };
		}
		positionals.push(arg);
	}

	return { all, auditPath, help: false, positionals, statePath: resolvePath(statePath) };
}

function parseRemoteHostUnregisterArgs(args: readonly string[]): RemoteHostUnregisterArgs {
	const positionals: string[] = [];
	let statePath = getDefaultIrohRemoteStatePath();
	let workspaceName: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { help: true, positionals, statePath };
		}

		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
		if (flag === "--state" || flag === "--unregister-workspace") {
			const value = inlineValue ?? args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { error: `${flag} requires a value`, help: false, positionals, statePath };
			}
			if (inlineValue === undefined) {
				index++;
			}
			if (flag === "--state") {
				statePath = resolvePath(value);
			} else {
				workspaceName = value;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			return { error: `Unknown remote host unregister option: ${arg}`, help: false, positionals, statePath };
		}
		positionals.push(arg);
	}

	if (workspaceName === undefined || workspaceName.trim().length === 0) {
		return { error: "--unregister-workspace requires a value", help: false, positionals, statePath };
	}

	return {
		help: false,
		positionals,
		statePath: resolvePath(statePath),
		workspaceName,
	};
}

function parseRemotePairArgs(args: readonly string[]): RemotePairArgs {
	const positionals: string[] = [];
	let allowTools: string | undefined;
	let labelHint: string | undefined;
	let relayMode: IrohRemoteRelayMode | undefined;
	let statePath = getDefaultIrohRemoteStatePath();
	let ttlMs: number | undefined;
	let workspace: string | undefined;
	let yes = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { help: true, positionals, statePath, yes };
		}
		if (arg === "--yes") {
			yes = true;
			continue;
		}

		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
		if (
			flag === "--allow-tools" ||
			flag === "--label" ||
			flag === "--relay" ||
			flag === "--state" ||
			flag === "--ttl" ||
			flag === "--workspace"
		) {
			const value = inlineValue ?? args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { error: `${flag} requires a value`, help: false, positionals, statePath, yes };
			}
			if (inlineValue === undefined) {
				index++;
			}

			if (flag === "--allow-tools") {
				allowTools = value;
			} else if (flag === "--label") {
				labelHint = value;
			} else if (flag === "--relay") {
				if (!isIrohRemoteRelayMode(value)) {
					return { error: "--relay must be disabled or default", help: false, positionals, statePath, yes };
				}
				relayMode = value;
			} else if (flag === "--state") {
				statePath = resolvePath(value);
			} else if (flag === "--ttl") {
				const parsedTtlMs = parseRemotePairTtlMs(value);
				if (parsedTtlMs === undefined) {
					return {
						error: "--ttl must be a positive duration such as 30s, 10m, or 1h",
						help: false,
						positionals,
						statePath,
						yes,
					};
				}
				ttlMs = parsedTtlMs;
			} else {
				workspace = value;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			return { error: `Unknown remote pair option: ${arg}`, help: false, positionals, statePath, yes };
		}
		positionals.push(arg);
	}

	return {
		help: false,
		positionals,
		statePath: resolvePath(statePath),
		yes,
		...(allowTools === undefined ? {} : { allowTools }),
		...(labelHint === undefined ? {} : { labelHint }),
		...(relayMode === undefined ? {} : { relayMode }),
		...(ttlMs === undefined ? {} : { ttlMs }),
		...(workspace === undefined ? {} : { workspace }),
	};
}

function parseRemotePairTtlMs(value: string): number | undefined {
	const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
	const unit = match[2];
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	const ttlMs = amount * multiplier;
	return Number.isSafeInteger(ttlMs) ? ttlMs : undefined;
}

function selectRemotePairWorkspace(
	workspaces: readonly { name: string; allowedTools?: string }[],
	workspaceName: string | undefined,
): { name: string; allowedTools?: string } | { error: string } {
	if (workspaceName !== undefined) {
		const workspace = workspaces.find((entry) => entry.name === workspaceName);
		return workspace ?? { error: `No saved Iroh remote workspace named ${workspaceName}` };
	}
	if (workspaces.length === 0) {
		return {
			error: "No saved Iroh remote workspaces found. Start `volt remote host --workspace <name=path>` first.",
		};
	}
	if (workspaces.length > 1) {
		return {
			error: `Multiple saved Iroh remote workspaces found (${workspaces.map((workspace) => workspace.name).join(", ")}). Pass --workspace <name>.`,
		};
	}
	const workspace = workspaces[0];
	if (!workspace) {
		return {
			error: "No saved Iroh remote workspaces found. Start `volt remote host --workspace <name=path>` first.",
		};
	}
	return workspace;
}

async function confirmUnsafeRemotePairToolGrant(
	allowTools: string,
	yes: boolean,
): Promise<IrohRemoteUnsafeApproval | undefined> {
	const unsafeTools = getIrohRemoteUnsafeAllowedTools(allowTools);
	if (unsafeTools.length === 0) return undefined;

	const warning = [
		`Unsafe remote tools requested: ${unsafeTools.join(", ")}.`,
		"These tools can modify files, run shell commands, or make network requests using host credentials through a paired remote client.",
	].join("\n");
	if (yes) return "yes_flag";
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		throw new Error(`${warning}\nPass --yes to accept unsafe remote tool grants in noninteractive contexts.`);
	}

	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const accepted = await new Promise<boolean>((resolve) => {
			readline.question(`${warning}\nType yes to continue: `, (answer) => {
				resolve(answer.trim().toLowerCase() === "yes");
			});
		});
		if (!accepted) {
			throw new Error("Unsafe remote tool grant was not accepted.");
		}
		return "tty_confirmation";
	} finally {
		readline.close();
	}
}

function printRemotePairingTicket(ticket: string): void {
	if (process.stderr.isTTY) {
		try {
			console.error("pairing ticket QR:");
			console.error(formatIrohRemoteTicketQrCode(ticket));
		} catch (error) {
			console.error(`Could not render pairing ticket QR: ${error instanceof Error ? error.message : String(error)}`);
		}
		console.error("pairing ticket:");
	}
	console.log(ticket);
}

async function handleRemotePairCommand(args: readonly string[]): Promise<void> {
	const parsed = parseRemotePairArgs(args);
	if (parsed.help) {
		printRemoteCommandHelp();
		return;
	}
	if (parsed.error) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		process.exitCode = 1;
		return;
	}
	if (parsed.positionals.length > 0) {
		console.error(chalk.red(`Error: Unexpected remote pair argument: ${parsed.positionals[0]}`));
		process.exitCode = 1;
		return;
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath: parsed.statePath });
	const state = await stateManager.getState();
	const workspace = selectRemotePairWorkspace(state.workspaces, parsed.workspace);
	if ("error" in workspace) {
		console.error(chalk.red(`Error: ${workspace.error}`));
		process.exitCode = 1;
		return;
	}

	const allowTools = normalizeIrohRemoteAllowTools(
		parsed.allowTools ?? workspace.allowedTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	);
	let unsafeApproval: IrohRemoteUnsafeApproval | undefined;
	try {
		unsafeApproval = await confirmUnsafeRemotePairToolGrant(allowTools, parsed.yes);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
		return;
	}

	try {
		const response = await requestIrohRemotePairingTicket({
			statePath: parsed.statePath,
			request: {
				type: IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE,
				workspace: workspace.name,
				allowTools,
				...(parsed.labelHint === undefined ? {} : { labelHint: parsed.labelHint }),
				...(parsed.relayMode === undefined ? {} : { relayMode: parsed.relayMode }),
				...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
				...(unsafeApproval === undefined ? {} : { unsafeApproval }),
			},
		});
		if (!response.success) {
			console.error(chalk.red(`Error: ${response.error}`));
			process.exitCode = 1;
			return;
		}
		printRemotePairingTicket(response.ticket);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
}

async function formatRemoteStatusWorkspace(workspace: IrohRemoteWorkspace): Promise<IrohRemoteStatusWorkspaceView> {
	return {
		name: workspace.name,
		path: workspace.path,
		status: await getIrohRemoteWorkspaceAvailabilityStatus(workspace),
		...(workspace.allowedTools === undefined ? {} : { allowedTools: workspace.allowedTools }),
	};
}

function formatRemoteStatusClient(client: IrohRemoteClient): IrohRemoteStatusClientView {
	const pushTargets = (client.pushTargets ?? [])
		.map((target) => formatRemoteStatusPushTarget(target))
		.sort(
			(left, right) =>
				left.provider.localeCompare(right.provider) ||
				left.platform.localeCompare(right.platform) ||
				left.createdAt - right.createdAt ||
				left.updatedAt - right.updatedAt,
		);
	return {
		nodeId: client.nodeId,
		label: client.label,
		allowedWorkspaces: [...client.allowedWorkspaces].sort(),
		allowedTools: client.allowedTools,
		pairedAt: client.pairedAt,
		lastSeenAt: client.lastSeenAt,
		...(pushTargets.length === 0 ? {} : { pushTargetCount: pushTargets.length, pushTargets }),
	};
}

function formatRemoteStatusPushTarget(target: IrohRemotePushTarget): IrohRemoteStatusPushTargetView {
	return {
		provider: target.provider,
		platform: target.platform,
		enabled: target.enabled,
		hasTokenHash: target.tokenHash !== undefined,
		...(target.relayUrl === undefined ? {} : { relayUrl: target.relayUrl }),
		createdAt: target.createdAt,
		updatedAt: target.updatedAt,
	};
}

function formatRemoteStatusRevokedClient(client: IrohRemoteRevokedClient): IrohRemoteStatusRevokedClientView {
	return {
		nodeId: client.nodeId,
		label: client.label,
		allowedWorkspaces: [...client.allowedWorkspaces].sort(),
		allowedTools: client.allowedTools,
		pairedAt: client.pairedAt,
		lastSeenAt: client.lastSeenAt,
		revokedAt: client.revokedAt,
		...(client.rePairApprovedAt === undefined ? {} : { rePairApprovedAt: client.rePairApprovedAt }),
	};
}

async function createRemoteStatusView(options: {
	auditPath: string;
	clients: readonly IrohRemoteClient[];
	revokedClients: readonly IrohRemoteRevokedClient[];
	statePath: string;
	workspaces: readonly IrohRemoteWorkspace[];
}): Promise<IrohRemoteStatusView> {
	const clients = options.clients
		.map((client) => formatRemoteStatusClient(client))
		.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
	const revokedClients = options.revokedClients
		.map((client) => formatRemoteStatusRevokedClient(client))
		.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
	const workspaces = (
		await Promise.all(options.workspaces.map((workspace) => formatRemoteStatusWorkspace(workspace)))
	).sort((left, right) => left.name.localeCompare(right.name));
	return {
		statePath: options.statePath,
		auditPath: options.auditPath,
		warning: IROH_REMOTE_PERSISTED_STATUS_WARNING,
		liveStatus: {
			available: false,
			warning: IROH_REMOTE_PERSISTED_STATUS_WARNING,
		},
		workspaces,
		clientCount: clients.length,
		clients,
		revokedClientCount: revokedClients.length,
		revokedClients,
	};
}

async function handleRemoteHostUnregisterCommand(args: readonly string[]): Promise<void> {
	const parsed = parseRemoteHostUnregisterArgs(args);
	if (parsed.help) {
		printRemoteCommandHelp();
		return;
	}
	if (parsed.error) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		process.exitCode = 1;
		return;
	}
	if (parsed.positionals.length > 0) {
		console.error(chalk.red(`Error: Unexpected remote host unregister argument: ${parsed.positionals[0]}`));
		process.exitCode = 1;
		return;
	}
	const workspaceName = parsed.workspaceName;
	if (workspaceName === undefined) {
		console.error(chalk.red("Error: --unregister-workspace requires a value"));
		process.exitCode = 1;
		return;
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath: parsed.statePath });
	const removedWorkspace = await stateManager.unregisterWorkspace(workspaceName);
	if (!removedWorkspace) {
		console.error(chalk.red(`Error: No registered Iroh remote workspace named ${workspaceName}`));
		process.exitCode = 1;
		return;
	}
	console.error(`Unregistered workspace ${workspaceName}`);
}

async function handleRemoteStatusCommand(args: readonly string[]): Promise<void> {
	const parsed = parseRemoteManagementArgs(args);
	if (parsed.help) {
		printRemoteCommandHelp();
		return;
	}
	if (parsed.error) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		process.exitCode = 1;
		return;
	}
	if (parsed.positionals.length > 0) {
		console.error(chalk.red(`Error: Unexpected remote status argument: ${parsed.positionals[0]}`));
		process.exitCode = 1;
		return;
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath: parsed.statePath });
	const state = await stateManager.getState();
	console.log(
		JSON.stringify(
			await createRemoteStatusView({
				auditPath: parsed.auditPath ?? getDefaultIrohRemoteAuditPath(parsed.statePath),
				clients: state.clients,
				revokedClients: state.revokedClients ?? [],
				statePath: parsed.statePath,
				workspaces: state.workspaces,
			}),
			null,
			2,
		),
	);
}

async function handleRemoteClientsCommand(args: readonly string[]): Promise<void> {
	const parsed = parseRemoteManagementArgs(args);
	if (parsed.help) {
		printRemoteCommandHelp();
		return;
	}
	if (parsed.error) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		process.exitCode = 1;
		return;
	}
	if (parsed.positionals.length > 0) {
		console.error(chalk.red(`Error: Unexpected remote clients argument: ${parsed.positionals[0]}`));
		process.exitCode = 1;
		return;
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath: parsed.statePath });
	const clients = (await stateManager.listClients())
		.map((client) => formatRemoteStatusClient(client))
		.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
	console.log(JSON.stringify(clients, null, 2));
}

async function logRemoteClientRevocation(
	auditLogger: IrohRemoteAuditLogger,
	nodeId: string,
	success: boolean,
	error?: string,
): Promise<void> {
	try {
		await auditLogger.log({
			type: "client_revoked",
			clientNodeId: nodeId,
			success,
			...(error === undefined ? {} : { error }),
		});
	} catch {
		// Audit logging is best-effort for local client management commands.
	}
}

type ActiveRemoteRevocationStatus = "available" | "unavailable";

async function reportActiveRemoteRevocation(statePath: string, nodeId: string): Promise<ActiveRemoteRevocationStatus> {
	try {
		const activeRevocation = await requestIrohRemoteActiveRevocation({
			statePath,
			request: {
				type: IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
				nodeId,
			},
		});
		if (activeRevocation.success && activeRevocation.closed) {
			console.error(`Active connection revoked for ${nodeId}`);
		} else if (activeRevocation.success) {
			console.error(`No active live connection found for ${nodeId}`);
		} else {
			console.error(`Active live revocation unavailable for ${nodeId}: ${activeRevocation.error}`);
		}
		return "available";
	} catch (error) {
		console.error(
			`Active live revocation unavailable for ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "unavailable";
	}
}

async function handleRemoteRevokeCommand(args: readonly string[]): Promise<void> {
	const parsed = parseRemoteRevokeArgs(args);
	if (parsed.help) {
		printRemoteCommandHelp();
		return;
	}
	if (parsed.error) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		process.exitCode = 1;
		return;
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath: parsed.statePath });
	const auditLogger = new IrohRemoteAuditLogger({
		path: parsed.auditPath ?? getDefaultIrohRemoteAuditPath(parsed.statePath),
	});

	if (parsed.all) {
		if (parsed.positionals.length > 0) {
			console.error(chalk.red(`Error: Unexpected remote revoke argument: ${parsed.positionals[0]}`));
			process.exitCode = 1;
			return;
		}

		const clients = await stateManager.listClients();
		if (clients.length === 0) {
			console.error("No paired clients to revoke");
			return;
		}

		const revokedNodeIds: string[] = [];
		const revokedAt = Date.now();
		for (const client of clients) {
			const result = await stateManager.revokeClient(client.nodeId, revokedAt);
			await logRemoteClientRevocation(
				auditLogger,
				client.nodeId,
				result.revoked,
				result.revoked ? undefined : "client not found",
			);
			if (result.revoked) {
				revokedNodeIds.push(client.nodeId);
			}
		}

		for (const nodeId of revokedNodeIds) {
			const activeStatus = await reportActiveRemoteRevocation(parsed.statePath, nodeId);
			if (activeStatus === "unavailable") {
				break;
			}
		}

		console.error(`Revoked ${revokedNodeIds.length} client${revokedNodeIds.length === 1 ? "" : "s"}`);
		return;
	}

	const nodeId = parsed.positionals[0];
	if (!nodeId) {
		console.error(chalk.red("Error: Missing node id to revoke"));
		process.exitCode = 1;
		return;
	}
	if (parsed.positionals.length > 1) {
		console.error(chalk.red(`Error: Unexpected remote revoke argument: ${parsed.positionals[1]}`));
		process.exitCode = 1;
		return;
	}

	const result = await stateManager.revokeClient(nodeId);
	await logRemoteClientRevocation(
		auditLogger,
		nodeId,
		result.revoked,
		result.revoked ? undefined : "client not found",
	);

	if (!result.revoked) {
		console.error(chalk.red(`Error: No client found for ${nodeId}`));
		process.exitCode = 1;
		return;
	}

	await reportActiveRemoteRevocation(parsed.statePath, nodeId);
	console.error(`Revoked ${nodeId}`);
}

async function handleRemoteApproveRepairCommand(args: readonly string[]): Promise<void> {
	const parsed = parseRemoteManagementArgs(args);
	if (parsed.help) {
		printRemoteCommandHelp();
		return;
	}
	if (parsed.error) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		process.exitCode = 1;
		return;
	}

	const nodeId = parsed.positionals[0];
	if (!nodeId) {
		console.error(chalk.red("Error: Missing node id to approve for re-pair"));
		process.exitCode = 1;
		return;
	}
	if (parsed.positionals.length > 1) {
		console.error(chalk.red(`Error: Unexpected remote approve-repair argument: ${parsed.positionals[1]}`));
		process.exitCode = 1;
		return;
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath: parsed.statePath });
	const result = await stateManager.approveClientRePair(nodeId);
	const auditLogger = new IrohRemoteAuditLogger({
		path: parsed.auditPath ?? getDefaultIrohRemoteAuditPath(parsed.statePath),
	});
	try {
		await auditLogger.log({
			type: "client_repair_approved",
			clientNodeId: nodeId,
			success: result.approved,
			error: result.approved ? undefined : "revoked client not found",
		});
	} catch {
		// Audit logging is best-effort for local client management commands.
	}

	if (!result.approved) {
		console.error(chalk.red(`Error: No revoked client found for ${nodeId}`));
		process.exitCode = 1;
		return;
	}

	console.error(`Approved re-pair for ${nodeId}`);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveRemoteHostScript(packageDir: string): Promise<string | undefined> {
	const sourceHostScript = join(packageDir, "src", "remote", "iroh-host.mjs");
	if (await pathExists(sourceHostScript)) {
		return sourceHostScript;
	}

	const distHostScript = join(packageDir, "dist", "remote", "iroh-host.mjs");
	if (await pathExists(distHostScript)) {
		return distHostScript;
	}

	return undefined;
}

async function handleRemoteCommand(args: string[], options: { profile?: string } = {}): Promise<boolean> {
	if (args[0] !== "remote") {
		return false;
	}

	const command = args[1];
	if (command === undefined || command === "--help" || command === "-h") {
		printRemoteCommandHelp();
		return true;
	}
	if (command === "clients") {
		await handleRemoteClientsCommand(args.slice(2));
		return true;
	}
	if (command === "approve-repair") {
		await handleRemoteApproveRepairCommand(args.slice(2));
		return true;
	}
	if (command === "pair") {
		await handleRemotePairCommand(args.slice(2));
		return true;
	}
	if (command === "status") {
		await handleRemoteStatusCommand(args.slice(2));
		return true;
	}
	if (command === "revoke") {
		await handleRemoteRevokeCommand(args.slice(2));
		return true;
	}
	if (command !== "host") {
		console.error(chalk.red(`Error: Unknown remote command: ${command}`));
		printRemoteCommandHelp();
		process.exitCode = 1;
		return true;
	}
	const rawHostArgs = args.slice(2);
	const hostArgs = addDefaultRemoteHostStateArgs(rawHostArgs);
	if (hostArgs.includes("--help") || hostArgs.includes("-h")) {
		printRemoteCommandHelp();
		return true;
	}
	if (argsIncludeOption(rawHostArgs, "--unregister-workspace")) {
		await handleRemoteHostUnregisterCommand(rawHostArgs);
		return true;
	}
	if (isBunBinary) {
		console.error(chalk.red("Error: volt remote host is not available from the Bun binary release yet."));
		console.error("Use a Node.js npm install or a source checkout with optional @number0/iroh dependencies.");
		process.exitCode = 1;
		return true;
	}

	const packageDir = getPackageDir();
	const hostScript = await resolveRemoteHostScript(packageDir);
	const sourceModesIndex = join(packageDir, "src", "modes", "index.ts");
	if (!hostScript) {
		console.error(chalk.red("Error: Iroh remote host entrypoint is not available in this installation."));
		console.error(
			"Reinstall @earendil-works/volt-coding-agent or use a source checkout that includes src/remote/iroh-host.mjs.",
		);
		process.exitCode = 1;
		return true;
	}

	const nodeArgs = (await pathExists(sourceModesIndex)) ? ["--conditions", "volt-source"] : [];
	const profileArgs = options.profile ? ["--profile", options.profile] : [];
	const resolvedHostArgs = addDefaultRemoteHostRuntimeArgs(hostArgs);
	await new Promise<void>((resolve) => {
		const child = spawn(process.execPath, [...nodeArgs, hostScript, ...resolvedHostArgs, ...profileArgs], {
			cwd: process.cwd(),
			stdio: "inherit",
		});
		child.once("error", (error) => {
			console.error(chalk.red(error instanceof Error ? error.message : String(error)));
			process.exitCode = 1;
			resolve();
		});
		child.once("exit", (code, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				return;
			}
			process.exitCode = code ?? 0;
			resolve();
		});
	});
	return true;
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveRequestedProfile(parsed: Args): string | undefined {
	const profile = parsed.profile ?? process.env.VOLT_PROFILE;
	const trimmed = profile?.trim();
	return trimmed ? trimmed : undefined;
}

function stripCommandProfileArgs(args: readonly string[]): { args: string[]; profile?: string; error?: string } {
	const commandArgs: string[] = [];
	let profile: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--profile") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { args: [...args], error: "--profile requires a value" };
			}
			profile = value;
			index++;
			continue;
		}
		commandArgs.push(arg);
	}

	return { args: commandArgs, profile };
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch =
		localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir);
		}
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.allowUnlistedExtensionTools) {
		options.allowUnlistedExtensionTools = true;
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.VOLT_OFFLINE);
	if (offlineMode) {
		process.env.VOLT_OFFLINE = "1";
		process.env.VOLT_SKIP_VERSION_CHECK = "1";
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	const commandProfileArgs = stripCommandProfileArgs(args);
	if (commandProfileArgs.error) {
		console.error(chalk.red(`Error: ${commandProfileArgs.error}`));
		process.exitCode = 1;
		return;
	}
	const commandRuntimeOptions = {
		extensionFactories: options?.extensionFactories,
		profile:
			commandProfileArgs.profile !== undefined
				? commandProfileArgs.profile.trim() || undefined
				: process.env.VOLT_PROFILE?.trim() || undefined,
	};

	if (await handleRemoteCommand(commandProfileArgs.args, { profile: commandRuntimeOptions.profile })) {
		return;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted: false,
		profile: commandProfileArgs.profile,
	});
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handleStoreCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	if (await handlePackageCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && commandProfileArgs.args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `volt update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	const parsed = parseArgs(args);
	const requestedProfile = resolveRequestedProfile(parsed);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir, { profile: requestedProfile });
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = parsed.name.trim();
		if (!name) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const trustStore = new ProjectTrustStore(agentDir);
	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const projectTrustByCwd = new Map<string, boolean>();

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const authStorage = AuthStorage.create();
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const { cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext } = runtimeOptions;
		const runtimeProfile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : requestedProfile;
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, {
			projectTrusted,
			profile: runtimeProfile,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			settingsManager: runtimeSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		const { settingsManager, modelRegistry, resourceLoader } = services;
		if (parsed.lsp) {
			settingsManager.applyOverrides({ lsp: { enabled: true } });
		}
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRegistry,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const subagentManager = new SubagentManager({
			createRuntime,
			cwd,
			agentDir,
			resourceLoader,
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			allowUnlistedExtensionTools: sessionOptions.allowUnlistedExtensionTools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
			subagentToolManager: subagentManager,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry, resourceLoader } = services;
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.VOLT_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: VOLT_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			modelFallbackMessage,
			modelScopePatterns: parsed.models,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
