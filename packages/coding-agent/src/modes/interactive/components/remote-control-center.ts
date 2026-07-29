import { isAbsolute, relative, resolve } from "node:path";
import { type Component, getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@hansjm10/volt-tui";
import { getAgentDir, VERSION } from "../../../config.ts";
import {
	IROH_REMOTE_ACCESS_PRESET_NAMES,
	type IrohRemoteAccessPresetName,
	isIrohRemoteAccessPresetName,
} from "../../../core/remote/iroh/access-grant.ts";
import { formatIrohRemoteTicketQrCode } from "../../../core/remote/iroh/qr.ts";
import { getIrohRemotePairingVerificationDetails } from "../../../core/remote/iroh/ticket.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { createDaemonClient, type DaemonClient } from "../../../daemon/control-client.ts";
import {
	CONTROL_PAIR_CANCEL_CAPABILITY,
	CONTROL_RPC_GRANTS_CAPABILITY,
	type ControlEvent,
	type ControlResponse,
	type DaemonRemotePolicyStatus,
} from "../../../daemon/control-protocol.ts";
import { type DaemonProbeState, ensureDaemonRunning, probeDaemon, waitForDaemonExit } from "../../../daemon/spawn.ts";
import {
	findRecoverableVoltdStateBackup,
	inspectVoltdStateFiles,
	recoverVoltdStateFromBackup,
	regenerateInvalidVoltdState,
} from "../../../daemon/state.ts";
import { DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS } from "../../../remote/integrated-runtime-retention.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { resolveDaemonWorkspaceForCwd } from "../daemon-attach.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type RemoteStatus = Extract<ControlResponse, { type: "status_result" }>;
type PairingProgress = Extract<ControlEvent, { type: "pairing_progress" }>;

export class RemoteControlRequestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RemoteControlRequestError";
		this.code = code;
	}
}

const UNSAFE_TERMINAL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export type RemoteControlSnapshot =
	| {
			kind: "offline";
			state: DaemonProbeState;
			error?: string;
			invalidState?: { path: string; error: string };
	  }
	| { kind: "online"; status: RemoteStatus };

export interface RemotePairingHandle {
	requestId: string;
	dispose(): void;
}

export interface RemoteControlBackend {
	load(): Promise<RemoteControlSnapshot>;
	startDaemon(): Promise<void>;
	regenerateState(): Promise<{ backupPath: string; preservedIdentity: boolean }>;
	findRecoveryBackup(): Promise<{ path: string; preservedIdentity: boolean } | undefined>;
	recoverStateBackup(path: string): Promise<{ preservedIdentity: boolean }>;
	registerCurrentWorkspace(path: string): Promise<{ name: string; path: string }>;
	beginPairing(
		workspaceName: string,
		access: IrohRemoteAccessPresetName,
		onProgress: (event: PairingProgress) => void,
	): Promise<RemotePairingHandle>;
	revokeClient(clientNodeId: string): Promise<void>;
	approveClientRepair(clientNodeId: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * A management-only daemon client. It never acquires or releases a conversation
 * lease, so opening and closing /remote cannot transfer ownership of the active
 * session.
 */
export function createRemoteControlBackend(agentDir: string = getAgentDir()): RemoteControlBackend {
	let client: DaemonClient | undefined;
	const eventHandlers = new Set<(event: ControlEvent) => void>();
	const pendingPairingRequestIds = new Set<string>();
	const pairingCancellations = new Map<string, Promise<void>>();

	const cancelPairing = (active: DaemonClient, requestId: string): Promise<void> => {
		const existing = pairingCancellations.get(requestId);
		if (existing) return existing;
		if (!pendingPairingRequestIds.has(requestId)) return Promise.resolve();
		const cancellation = (async () => {
			try {
				if (active.connectionState === "connected") {
					const response = await active.request({ type: "pair_cancel", requestId });
					if (response.type === "error") throw new Error(response.message);
				}
			} catch {
				// A current daemon also invalidates tickets when the owning control connection closes.
				await active.close().catch(() => {});
			} finally {
				pendingPairingRequestIds.delete(requestId);
				pairingCancellations.delete(requestId);
			}
		})();
		pairingCancellations.set(requestId, cancellation);
		return cancellation;
	};

	const closeClient = async (): Promise<void> => {
		const active = client;
		client = undefined;
		if (active) {
			await Promise.all([...pendingPairingRequestIds].map((requestId) => cancelPairing(active, requestId)));
		}
		pendingPairingRequestIds.clear();
		pairingCancellations.clear();
		await active?.close();
	};

	const connect = async (): Promise<DaemonClient> => {
		if (client?.connectionState === "connected") return client;
		await closeClient();
		const probe = await probeDaemon(agentDir);
		if (!probe.healthy) throw new Error(`voltd is ${probe.state}`);
		const connected = createDaemonClient({
			socketPath: probe.socketPath,
			authToken: probe.authToken,
			client: "cli",
			version: VERSION,
			reconnect: false,
			onEvent: (event) => {
				for (const handler of eventHandlers) handler(event);
			},
		});
		client = connected;
		try {
			await connected.connect();
			return connected;
		} catch (error) {
			await closeClient();
			throw error;
		}
	};

	return {
		async load() {
			const probe = await probeDaemon(agentDir);
			if (!probe.healthy) {
				const invalidState = inspectVoltdStateFiles(agentDir);
				return {
					kind: "offline",
					state: probe.state,
					...(invalidState === undefined ? {} : { error: invalidState.error, invalidState }),
				};
			}
			try {
				const response = await (await connect()).request({ type: "status" });
				if (response.type === "error") throw new Error(response.message);
				if (response.type !== "status_result") throw new Error(`unexpected ${response.type} response`);
				return { kind: "online", status: response };
			} catch (error) {
				await closeClient();
				return {
					kind: "offline",
					state: "unresponsive",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		async startDaemon() {
			const result = await ensureDaemonRunning(agentDir);
			if (!result.healthy) throw new Error(result.error ?? `voltd did not start (${result.state})`);
			await closeClient();
		},
		async regenerateState() {
			const probe = await probeDaemon(agentDir);
			if (probe.healthy || probe.state !== "not-running") {
				throw new Error(`voltd must be fully stopped before regenerating state (currently ${probe.state})`);
			}
			return regenerateInvalidVoltdState(agentDir);
		},
		async findRecoveryBackup() {
			return findRecoverableVoltdStateBackup(agentDir);
		},
		async recoverStateBackup(path) {
			const probe = await probeDaemon(agentDir);
			if (probe.healthy) {
				const response = await (await connect()).request({ type: "shutdown" });
				if (response.type === "error") throw new Error(response.message);
				await closeClient();
				const exit = await waitForDaemonExit({
					agentDir,
					pid: probe.pid,
					socketPath: probe.socketPath,
				});
				if (exit !== "exited") throw new Error("voltd did not stop before state recovery");
			} else if (probe.state !== "not-running") {
				throw new Error(`voltd must be stopped before state recovery (currently ${probe.state})`);
			}
			const recovered = await recoverVoltdStateFromBackup(agentDir, path);
			const restarted = await ensureDaemonRunning(agentDir);
			if (!restarted.healthy) {
				throw new Error(restarted.error ?? `voltd did not restart (${restarted.state})`);
			}
			return { preservedIdentity: recovered.preservedIdentity };
		},
		async registerCurrentWorkspace(path) {
			const workspace = await resolveDaemonWorkspaceForCwd(await connect(), path);
			if (!workspace) throw new Error("could not register the current directory with voltd");
			return workspace;
		},
		async beginPairing(workspaceName, access, onProgress) {
			const queued: PairingProgress[] = [];
			let requestId: string | undefined;
			let terminal = false;
			const handler = (event: ControlEvent): void => {
				if (event.type !== "pairing_progress") return;
				if (requestId === undefined) {
					queued.push(event);
				} else if (event.requestId === requestId) {
					if (event.phase === "completed" || event.phase === "failed") {
						terminal = true;
						pendingPairingRequestIds.delete(requestId);
					}
					onProgress(event);
				}
			};
			eventHandlers.add(handler);
			try {
				const response = await (await connect()).request({ type: "pair_request", workspaceName, access });
				if (response.type === "error") throw new RemoteControlRequestError(response.code, response.message);
				if (response.type !== "pair_started") throw new Error(`unexpected ${response.type} response`);
				const startedRequestId = response.requestId;
				requestId = startedRequestId;
				for (const event of queued) {
					if (event.requestId !== startedRequestId) continue;
					if (event.phase === "completed" || event.phase === "failed") terminal = true;
					onProgress(event);
				}
				if (!terminal) pendingPairingRequestIds.add(startedRequestId);
				return {
					requestId: startedRequestId,
					dispose: () => {
						eventHandlers.delete(handler);
						if (terminal) return;
						terminal = true;
						const activeClient = client;
						if (activeClient) void cancelPairing(activeClient, startedRequestId);
					},
				};
			} catch (error) {
				eventHandlers.delete(handler);
				throw error;
			}
		},
		async revokeClient(clientNodeId) {
			const response = await (await connect()).request({ type: "client_revoke", clientNodeId });
			if (response.type === "error") throw new Error(response.message);
			if (response.type !== "ok") throw new Error(`unexpected ${response.type} response`);
		},
		async approveClientRepair(clientNodeId) {
			const response = await (await connect()).request({ type: "client_approve_repair", clientNodeId });
			if (response.type === "error") throw new Error(response.message);
			if (response.type !== "ok") throw new Error(`unexpected ${response.type} response`);
		},
		close: closeClient,
	};
}

export interface RemoteControlCenterOptions {
	getTerminalRows(): number;
	getCurrentWorkspaceName(): string | undefined;
	getCurrentWorkspacePath(): string;
	currentSessionId: string;
	requestRender(): void;
	copyText(text: string): Promise<void>;
	onClose(): void;
}

type View =
	| { kind: "loading"; label: string }
	| { kind: "offline"; snapshot: Extract<RemoteControlSnapshot, { kind: "offline" }> }
	| { kind: "overview"; status: RemoteStatus; notice?: string }
	| { kind: "access-picker"; status: RemoteStatus }
	| { kind: "workspace-picker"; status: RemoteStatus; access: IrohRemoteAccessPresetName }
	| { kind: "confirm-regenerate"; snapshot: Extract<RemoteControlSnapshot, { kind: "offline" }> }
	| {
			kind: "confirm-recover";
			status: RemoteStatus;
			workspaceName: string;
			access: IrohRemoteAccessPresetName;
			backupPath: string;
	  }
	| { kind: "confirm-revoke"; status: RemoteStatus; clientNodeId: string }
	| { kind: "confirm-repair"; status: RemoteStatus; clientNodeId: string }
	| {
			kind: "pairing";
			status: RemoteStatus;
			workspaceName: string;
			access: IrohRemoteAccessPresetName;
			phase: "starting" | "ticket" | "waiting" | "completed" | "failed";
			ticket?: string;
			message?: string;
			recoveryBackupPath?: string;
			showQr?: boolean;
	  };

type DisplayRow = {
	key?: string;
	text: string;
	raw?: boolean;
	tone?: "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";
};

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function abbreviatedId(value: string, width = 12): string {
	return value.length <= width ? value : `${value.slice(0, Math.max(4, width - 1))}…`;
}

function supportsSafePairing(status: RemoteStatus): boolean {
	return (
		status.capabilities?.includes(CONTROL_PAIR_CANCEL_CAPABILITY) === true &&
		status.capabilities.includes(CONTROL_RPC_GRANTS_CAPABILITY)
	);
}

const ACCESS_PRESET_DETAILS: Readonly<Record<IrohRemoteAccessPresetName, { label: string; description: string }>> =
	Object.freeze({
		coding: {
			label: "Coding",
			description: "Coding tools plus conversation and model controls.",
		},
		review: {
			label: "Review",
			description: "Read-only tools plus conversation and model controls.",
		},
		chat: {
			label: "Chat",
			description: "Conversation and model controls without tool access.",
		},
		full: {
			label: "Full access",
			description: "Everything: API keys, log upload, host control, worktrees, and workspaces.",
		},
	});

function workspaceForPath(status: RemoteStatus, path: string): RemoteStatus["workspaces"][number] | undefined {
	const currentPath = resolve(path);
	return status.workspaces
		.filter((workspace) => {
			const workspacePath = resolve(workspace.path);
			const pathFromWorkspace = relative(workspacePath, currentPath);
			return pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace));
		})
		.sort((left, right) => right.path.length - left.path.length)[0];
}

function policyTools(policy: DaemonRemotePolicyStatus, fallback?: string[]): string {
	if (policy.allowTools !== null) return policy.allowTools.join(", ") || "none";
	if (fallback !== undefined) return fallback.join(", ") || "none";
	return "per-device grant";
}

/** Full-viewport control center for daemon health, phone pairing, and access. */
export class RemoteControlCenterComponent implements Component {
	private readonly backend: RemoteControlBackend;
	private readonly options: RemoteControlCenterOptions;
	private view: View = { kind: "loading", label: "Loading remote access…" };
	private selectedKey = "refresh";
	private scrollOffset = 0;
	private manualScroll = false;
	private lastRows: DisplayRow[] = [];
	private lastPageSize = 1;
	private pairingHandle: RemotePairingHandle | undefined;
	private pairingAttempt = 0;
	private generation = 0;
	private disposed = false;

	constructor(backend: RemoteControlBackend, options: RemoteControlCenterOptions) {
		this.backend = backend;
		this.options = options;
	}

	async start(): Promise<void> {
		await this.refresh();
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.pairingAttempt++;
		this.pairingHandle?.dispose();
		this.pairingHandle = undefined;
		void this.backend.close();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const height = Math.max(6, this.options.getTerminalRows() || 24);
		const header = this.renderHeader(width);
		const footer = this.renderFooter(width);
		const pageSize = Math.max(1, height - header.length - footer.length);
		this.lastPageSize = pageSize;
		const rows = this.buildRows(width, pageSize);
		this.lastRows = rows;
		this.ensureSelection(rows);
		const selectedIndex = rows.findIndex((row) => row.key === this.selectedKey);
		const maxOffset = Math.max(0, rows.length - pageSize);
		if (!this.manualScroll && selectedIndex >= 0) {
			if (selectedIndex < this.scrollOffset) this.scrollOffset = selectedIndex;
			if (selectedIndex >= this.scrollOffset + pageSize) this.scrollOffset = selectedIndex - pageSize + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
		const body = rows.slice(this.scrollOffset, this.scrollOffset + pageSize).map((row) => this.renderRow(row, width));
		while (body.length < pageSize) body.push("");
		return [...header, ...body, ...footer];
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (
				this.view.kind === "access-picker" ||
				this.view.kind === "workspace-picker" ||
				this.view.kind === "confirm-regenerate" ||
				this.view.kind === "confirm-recover" ||
				this.view.kind === "confirm-revoke" ||
				this.view.kind === "confirm-repair" ||
				this.view.kind === "pairing"
			) {
				if (this.view.kind === "pairing") this.pairingAttempt++;
				this.pairingHandle?.dispose();
				this.pairingHandle = undefined;
				if (this.view.kind === "confirm-regenerate") {
					this.view = { kind: "offline", snapshot: this.view.snapshot };
					this.selectedKey = "regenerate-state";
				} else if (this.view.kind === "confirm-recover") {
					this.view = {
						kind: "pairing",
						status: this.view.status,
						workspaceName: this.view.workspaceName,
						access: this.view.access,
						phase: "failed",
						message: "Iroh endpoint unavailable",
						recoveryBackupPath: this.view.backupPath,
					};
					this.selectedKey = "pairing-recover";
				} else if (this.view.kind === "workspace-picker") {
					const { status, access } = this.view;
					this.view = { kind: "access-picker", status };
					this.selectedKey = `access:${access}`;
				} else {
					const returnKey =
						this.view.kind === "confirm-revoke"
							? `client:${this.view.clientNodeId}`
							: this.view.kind === "confirm-repair"
								? `revoked:${this.view.clientNodeId}`
								: "pair";
					this.view = { kind: "overview", status: this.view.status };
					this.selectedKey = returnKey;
				}
				this.scrollOffset = 0;
				this.manualScroll = false;
				this.options.requestRender();
			} else {
				this.options.onClose();
			}
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollRows(-this.lastPageSize);
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollRows(this.lastPageSize);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.activateSelection();
		} else {
			return;
		}
		this.options.requestRender();
	}

	private async refresh(notice?: string): Promise<void> {
		const generation = ++this.generation;
		this.pairingAttempt++;
		this.pairingHandle?.dispose();
		this.pairingHandle = undefined;
		this.view = { kind: "loading", label: "Refreshing remote access…" };
		this.options.requestRender();
		const snapshot = await this.backend.load();
		if (this.disposed || generation !== this.generation) return;
		this.view =
			snapshot.kind === "online"
				? { kind: "overview", status: snapshot.status, ...(notice === undefined ? {} : { notice }) }
				: { kind: "offline", snapshot };
		this.selectedKey = snapshot.kind === "online" ? "refresh" : "start";
		this.scrollOffset = 0;
		this.manualScroll = false;
		this.options.requestRender();
	}

	private async startDaemon(): Promise<void> {
		const generation = ++this.generation;
		this.view = { kind: "loading", label: "Starting voltd…" };
		this.options.requestRender();
		try {
			await this.backend.startDaemon();
			if (this.disposed || generation !== this.generation) return;
			await this.refresh("Daemon started");
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			this.view = {
				kind: "offline",
				snapshot: {
					kind: "offline",
					state: "not-running",
					error: error instanceof Error ? error.message : String(error),
				},
			};
			this.selectedKey = "start";
			this.options.requestRender();
		}
	}

	private async regenerateState(): Promise<void> {
		const generation = ++this.generation;
		this.view = { kind: "loading", label: "Backing up and regenerating daemon state…" };
		this.options.requestRender();
		try {
			const result = await this.backend.regenerateState();
			await this.backend.startDaemon();
			if (this.disposed || generation !== this.generation) return;
			await this.refresh(
				`Daemon state regenerated; backup saved to ${result.backupPath}${result.preservedIdentity ? " · Iroh identity preserved" : " · new Iroh identity created"}`,
			);
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			const snapshot = await this.backend.load();
			if (this.disposed || generation !== this.generation) return;
			this.view =
				snapshot.kind === "online"
					? { kind: "overview", status: snapshot.status, notice: "Daemon state was regenerated" }
					: {
							kind: "offline",
							snapshot: {
								...snapshot,
								error: error instanceof Error ? error.message : String(error),
							},
						};
			this.selectedKey =
				snapshot.kind === "online" ? "refresh" : snapshot.invalidState ? "regenerate-state" : "start";
			this.options.requestRender();
		}
	}

	private async recoverStateBackup(backupPath: string): Promise<void> {
		const generation = ++this.generation;
		this.view = { kind: "loading", label: "Stopping voltd and recovering daemon state…" };
		this.options.requestRender();
		try {
			const result = await this.backend.recoverStateBackup(backupPath);
			if (this.disposed || generation !== this.generation) return;
			await this.refresh(
				result.preservedIdentity
					? "Recovered daemon state and preserved the Iroh identity"
					: "Recovered daemon state with a new Iroh identity; pair phones again",
			);
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			const snapshot = await this.backend.load();
			if (this.disposed || generation !== this.generation) return;
			this.view =
				snapshot.kind === "online"
					? {
							kind: "overview",
							status: snapshot.status,
							notice: `State recovery failed: ${error instanceof Error ? error.message : String(error)}`,
						}
					: { kind: "offline", snapshot };
			this.selectedKey = "refresh";
			this.options.requestRender();
		}
	}

	private async registerCurrentWorkspace(): Promise<void> {
		const generation = ++this.generation;
		const currentPath = this.options.getCurrentWorkspacePath();
		this.view = { kind: "loading", label: "Registering current directory…" };
		this.options.requestRender();
		try {
			const workspace = await this.backend.registerCurrentWorkspace(currentPath);
			if (this.disposed || generation !== this.generation) return;
			await this.refresh(`Workspace ${workspace.name} is available`);
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			const snapshot = await this.backend.load();
			if (this.disposed || generation !== this.generation) return;
			this.view =
				snapshot.kind === "online"
					? {
							kind: "overview",
							status: snapshot.status,
							notice: `Workspace registration failed: ${error instanceof Error ? error.message : String(error)}`,
						}
					: { kind: "offline", snapshot };
			this.selectedKey = snapshot.kind === "online" ? "register-current" : "start";
			this.options.requestRender();
		}
	}

	private async beginPairing(
		workspaceName: string,
		access: IrohRemoteAccessPresetName,
		status: RemoteStatus,
	): Promise<void> {
		const pairingAttempt = ++this.pairingAttempt;
		this.pairingHandle?.dispose();
		this.pairingHandle = undefined;
		this.view = { kind: "pairing", status, workspaceName, access, phase: "starting" };
		this.selectedKey = "pairing-back";
		this.scrollOffset = 0;
		this.manualScroll = false;
		this.options.requestRender();
		try {
			const handle = await this.backend.beginPairing(workspaceName, access, (event) =>
				this.onPairingProgress(event, pairingAttempt),
			);
			if (
				this.disposed ||
				pairingAttempt !== this.pairingAttempt ||
				this.view.kind !== "pairing" ||
				this.view.workspaceName !== workspaceName ||
				this.view.access !== access
			) {
				handle.dispose();
				return;
			}
			if (this.view.phase === "completed" || this.view.phase === "failed") {
				handle.dispose();
			} else {
				this.pairingHandle = handle;
			}
		} catch (error) {
			const recoveryBackup =
				error instanceof RemoteControlRequestError && error.code === "iroh_unavailable"
					? await this.backend.findRecoveryBackup()
					: undefined;
			if (this.disposed || pairingAttempt !== this.pairingAttempt || this.view.kind !== "pairing") return;
			this.view = {
				...this.view,
				phase: "failed",
				message: error instanceof Error ? error.message : String(error),
				...(recoveryBackup === undefined ? {} : { recoveryBackupPath: recoveryBackup.path }),
			};
			this.selectedKey = recoveryBackup === undefined ? "pairing-back" : "pairing-recover";
			this.options.requestRender();
		}
	}

	private onPairingProgress(event: PairingProgress, pairingAttempt: number): void {
		if (this.disposed || pairingAttempt !== this.pairingAttempt || this.view.kind !== "pairing") return;
		if (event.phase === "ticket" && event.ticket) {
			this.view = { ...this.view, phase: "ticket", ticket: event.ticket };
		} else if (event.phase === "waiting") {
			this.view = { ...this.view, phase: "waiting" };
		} else if (event.phase === "completed") {
			this.view = {
				...this.view,
				phase: "completed",
				message: `Paired ${event.clientNodeId ? abbreviatedId(event.clientNodeId, 20) : "device"}`,
				showQr: false,
			};
			this.pairingHandle?.dispose();
			this.pairingHandle = undefined;
		} else if (event.phase === "failed") {
			this.view = { ...this.view, phase: "failed", message: event.error ?? "Pairing failed", showQr: false };
			this.pairingHandle?.dispose();
			this.pairingHandle = undefined;
		}
		this.options.requestRender();
	}

	private async copyPairingTicket(): Promise<void> {
		if (this.view.kind !== "pairing" || !this.view.ticket) return;
		const pairingAttempt = this.pairingAttempt;
		const ticket = this.view.ticket;
		try {
			await this.options.copyText(ticket);
			if (
				!this.disposed &&
				pairingAttempt === this.pairingAttempt &&
				this.view.kind === "pairing" &&
				this.view.ticket === ticket
			) {
				this.view = { ...this.view, message: "Pairing ticket copied" };
			}
		} catch (error) {
			if (
				!this.disposed &&
				pairingAttempt === this.pairingAttempt &&
				this.view.kind === "pairing" &&
				this.view.ticket === ticket
			) {
				this.view = { ...this.view, message: error instanceof Error ? error.message : String(error) };
			}
		}
		if (!this.disposed) this.options.requestRender();
	}

	private async revokeClient(clientNodeId: string): Promise<void> {
		const generation = ++this.generation;
		this.view = { kind: "loading", label: "Revoking device…" };
		this.options.requestRender();
		try {
			await this.backend.revokeClient(clientNodeId);
			if (this.disposed || generation !== this.generation) return;
			await this.refresh(`Revoked ${abbreviatedId(clientNodeId, 20)}`);
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			const snapshot = await this.backend.load();
			if (this.disposed || generation !== this.generation) return;
			this.view =
				snapshot.kind === "online"
					? {
							kind: "overview",
							status: snapshot.status,
							notice: `Revoke failed: ${error instanceof Error ? error.message : String(error)}`,
						}
					: { kind: "offline", snapshot };
			this.options.requestRender();
		}
	}

	private async approveClientRepair(clientNodeId: string): Promise<void> {
		const generation = ++this.generation;
		this.view = { kind: "loading", label: "Allowing device to re-pair…" };
		this.options.requestRender();
		try {
			await this.backend.approveClientRepair(clientNodeId);
			if (this.disposed || generation !== this.generation) return;
			await this.refresh("Re-pair approved. Choose Pair a phone and scan a fresh QR.");
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			const snapshot = await this.backend.load();
			if (this.disposed || generation !== this.generation) return;
			this.view =
				snapshot.kind === "online"
					? {
							kind: "overview",
							status: snapshot.status,
							notice: `Repair approval failed: ${error instanceof Error ? error.message : String(error)}`,
						}
					: { kind: "offline", snapshot };
			this.selectedKey = snapshot.kind === "online" ? `revoked:${clientNodeId}` : "start";
			this.options.requestRender();
		}
	}

	private activateSelection(): void {
		if (this.view.kind === "loading") return;
		const key = this.selectedKey;
		if (key === "refresh") {
			void this.refresh();
			return;
		}
		if (key === "start") {
			void this.startDaemon();
			return;
		}
		if (key === "regenerate-state" && this.view.kind === "offline" && this.view.snapshot.invalidState) {
			this.view = { kind: "confirm-regenerate", snapshot: this.view.snapshot };
			this.selectedKey = "confirm-regenerate-state";
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key === "confirm-regenerate-state" && this.view.kind === "confirm-regenerate") {
			void this.regenerateState();
			return;
		}
		if (key === "pairing-recover" && this.view.kind === "pairing" && this.view.recoveryBackupPath) {
			this.view = {
				kind: "confirm-recover",
				status: this.view.status,
				workspaceName: this.view.workspaceName,
				access: this.view.access,
				backupPath: this.view.recoveryBackupPath,
			};
			this.selectedKey = "confirm-recover-state";
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key === "confirm-recover-state" && this.view.kind === "confirm-recover") {
			void this.recoverStateBackup(this.view.backupPath);
			return;
		}
		if (key === "register-current") {
			if (this.view.kind === "overview") void this.registerCurrentWorkspace();
			return;
		}
		if (key === "pair") {
			if (this.view.kind !== "overview" || !supportsSafePairing(this.view.status)) return;
			this.view = { kind: "access-picker", status: this.view.status };
			this.selectedKey = "access:coding";
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key.startsWith("access:") && this.view.kind === "access-picker") {
			const selectedAccess = key.slice("access:".length);
			if (!isIrohRemoteAccessPresetName(selectedAccess)) return;
			const currentWorkspace = this.options.getCurrentWorkspaceName();
			const match = this.view.status.workspaces.find((workspace) => workspace.name === currentWorkspace);
			if (match) {
				void this.beginPairing(match.name, selectedAccess, this.view.status);
			} else if (this.view.status.workspaces.length === 1) {
				void this.beginPairing(this.view.status.workspaces[0]!.name, selectedAccess, this.view.status);
			} else if (this.view.status.workspaces.length > 1) {
				this.view = { kind: "workspace-picker", status: this.view.status, access: selectedAccess };
				this.selectedKey = `workspace:${this.view.status.workspaces[0]!.name}`;
				this.scrollOffset = 0;
				this.manualScroll = false;
			}
			return;
		}
		if (key.startsWith("workspace:") && this.view.kind === "workspace-picker") {
			void this.beginPairing(key.slice("workspace:".length), this.view.access, this.view.status);
			return;
		}
		if (key.startsWith("client:") && this.view.kind === "overview") {
			const clientNodeId = key.slice("client:".length);
			this.view = { kind: "confirm-revoke", status: this.view.status, clientNodeId };
			this.selectedKey = `revoke:${clientNodeId}`;
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key.startsWith("revoked:") && this.view.kind === "overview") {
			const clientNodeId = key.slice("revoked:".length);
			this.view = { kind: "confirm-repair", status: this.view.status, clientNodeId };
			this.selectedKey = `approve-repair:${clientNodeId}`;
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key.startsWith("revoke:") && this.view.kind === "confirm-revoke") {
			void this.revokeClient(this.view.clientNodeId);
			return;
		}
		if (key.startsWith("approve-repair:") && this.view.kind === "confirm-repair") {
			void this.approveClientRepair(this.view.clientNodeId);
			return;
		}
		if (key === "pairing-copy" && this.view.kind === "pairing" && this.view.ticket) {
			void this.copyPairingTicket();
			return;
		}
		if (key === "pairing-show-qr" && this.view.kind === "pairing" && this.view.ticket) {
			this.view = { ...this.view, showQr: true };
			this.selectedKey = "pairing-verification";
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key === "pairing-verification" && this.view.kind === "pairing") {
			this.view = { ...this.view, showQr: false };
			this.selectedKey = "pairing-show-qr";
			this.scrollOffset = 0;
			this.manualScroll = false;
			return;
		}
		if (key === "pairing-back" && this.view.kind === "pairing") {
			if (this.view.phase === "completed") {
				void this.refresh(this.view.message);
			} else {
				this.pairingAttempt++;
				this.pairingHandle?.dispose();
				this.pairingHandle = undefined;
				this.view = { kind: "overview", status: this.view.status };
				this.selectedKey = "pair";
				this.scrollOffset = 0;
				this.manualScroll = false;
			}
		}
	}

	private moveSelection(delta: number): void {
		const selectable = this.lastRows.filter((row) => row.key);
		if (selectable.length === 0) return;
		const index = selectable.findIndex((row) => row.key === this.selectedKey);
		const next = Math.max(0, Math.min(selectable.length - 1, (index < 0 ? 0 : index) + delta));
		this.selectedKey = selectable[next]!.key!;
		this.manualScroll = false;
	}

	private scrollRows(delta: number): void {
		const maxOffset = Math.max(0, this.lastRows.length - this.lastPageSize);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
		this.manualScroll = true;
	}

	private ensureSelection(rows: DisplayRow[]): void {
		if (rows.some((row) => row.key === this.selectedKey)) return;
		this.selectedKey = rows.find((row) => row.key)?.key ?? "";
	}

	private renderHeader(width: number): string[] {
		let state = "loading";
		if (this.view.kind === "offline") state = this.view.snapshot.state;
		else if (this.view.kind === "confirm-regenerate" || this.view.kind === "confirm-recover") state = "confirmation";
		else if ("status" in this.view)
			state = `online · ${this.view.status.phoneConnections} phone${this.view.status.phoneConnections === 1 ? "" : "s"}`;
		const title = theme.bold(theme.fg("accent", "Remote Access"));
		const right = theme.fg(this.view.kind === "offline" ? "warning" : "muted", state);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(right) - 2));
		return [new DynamicBorder().render(width)[0]!, truncateToWidth(` ${title}${gap}${right} `, width, ""), ""];
	}

	private renderFooter(width: number): string[] {
		const hints = [keyHint("tui.select.up", "navigate"), keyHint("tui.select.pageDown", "scroll")];
		hints.push(keyHint("tui.select.confirm", "select"));
		hints.push(
			keyHint("tui.select.cancel", this.view.kind === "overview" || this.view.kind === "offline" ? "close" : "back"),
		);
		return [truncateToWidth(` ${hints.join("  ")}`, width, ""), new DynamicBorder().render(width)[0]!];
	}

	private buildRows(width: number, pageSize: number): DisplayRow[] {
		if (this.view.kind === "loading") return [{ text: this.view.label, tone: "muted" }];
		if (this.view.kind === "offline") {
			return [
				{ text: "DAEMON", tone: "accent" },
				{ text: `voltd is ${this.view.snapshot.state}`, tone: "warning" },
				...(this.view.snapshot.error ? [{ text: this.view.snapshot.error, tone: "error" as const }] : []),
				...(this.view.snapshot.invalidState
					? [
							{
								text: "Regeneration creates a backup, preserves validated settings/identity when possible, and may require phones to pair again.",
								tone: "warning" as const,
							},
							{ key: "regenerate-state", text: "Regenerate daemon state…", tone: "warning" as const },
						]
					: [{ key: "start", text: "Start daemon", tone: "text" as const }]),
				{ key: "refresh", text: "Refresh status", tone: "text" },
			];
		}
		if (this.view.kind === "confirm-regenerate") {
			return [
				{ text: "REGENERATE DAEMON STATE", tone: "warning" },
				{ text: this.view.snapshot.invalidState?.path ?? "Unknown state file", tone: "dim" },
				{ text: "The invalid file will be kept as a timestamped backup.", tone: "text" },
				{ text: "Validated identity, workspace, and settings data will be preserved when safe.", tone: "text" },
				{ text: "Invalid access records are dropped; phones may need to pair again.", tone: "warning" },
				{ key: "confirm-regenerate-state", text: "Confirm regenerate state", tone: "warning" },
			];
		}
		if (this.view.kind === "confirm-recover") {
			return [
				{ text: "RECOVER PREVIOUS DAEMON STATE", tone: "warning" },
				{ text: this.view.backupPath, tone: "dim" },
				{ text: "The current daemon will stop and its state will be backed up.", tone: "text" },
				{ text: "Validated identity, workspace, and settings data will be restored.", tone: "text" },
				{ text: "Legacy access records are dropped; phones may need to pair again.", tone: "warning" },
				{ key: "confirm-recover-state", text: "Confirm recover and restart", tone: "warning" },
			];
		}
		if (this.view.kind === "access-picker") {
			return [
				{ text: "PAIR A PHONE · ACCESS", tone: "accent" },
				{ text: "Choose what this phone may do. Access can be changed later.", tone: "muted" },
				...IROH_REMOTE_ACCESS_PRESET_NAMES.flatMap((name) => {
					const details = ACCESS_PRESET_DETAILS[name];
					return [
						{
							key: `access:${name}`,
							text: details.label,
							tone: name === "full" ? ("warning" as const) : ("text" as const),
						},
						{ text: `  ${details.description}`, tone: "dim" as const },
					];
				}),
			];
		}
		if (this.view.kind === "workspace-picker") {
			return [
				{ text: `PAIR A PHONE · ${ACCESS_PRESET_DETAILS[this.view.access].label}`, tone: "accent" },
				{ text: "Choose the phone's initial workspace.", tone: "muted" },
				...this.view.status.workspaces.map((workspace) => ({
					key: `workspace:${workspace.name}`,
					text: `${workspace.name}  ${workspace.path}`,
					tone: "text" as const,
				})),
			];
		}
		if (this.view.kind === "confirm-revoke") {
			const revokeView = this.view;
			const client = revokeView.status.clients.find(
				(candidate) => candidate.clientNodeId === revokeView.clientNodeId,
			);
			return [
				{ text: "REVOKE DEVICE", tone: "error" },
				{ text: client?.label || "Unnamed phone", tone: "text" },
				{ text: revokeView.clientNodeId, tone: "dim" },
				{ text: "This immediately closes the device's active remote connections.", tone: "warning" },
				{ key: `revoke:${revokeView.clientNodeId}`, text: "Confirm revoke", tone: "error" },
			];
		}
		if (this.view.kind === "confirm-repair") {
			const repairView = this.view;
			const client = repairView.status.revokedClients?.find(
				(candidate) => candidate.clientNodeId === repairView.clientNodeId,
			);
			return [
				{ text: "ALLOW DEVICE TO RE-PAIR", tone: "warning" },
				{ text: client?.label || "Unnamed phone", tone: "text" },
				{ text: repairView.clientNodeId, tone: "dim" },
				{ text: "This identity may use one fresh pairing ticket after approval.", tone: "warning" },
				{ text: "The device remains revoked until fresh pairing succeeds.", tone: "muted" },
				{ key: `approve-repair:${repairView.clientNodeId}`, text: "Confirm allow re-pair", tone: "warning" },
			];
		}
		if (this.view.kind === "pairing") return this.buildPairingRows(width, pageSize);

		const status = this.view.status;
		const remotePolicy = status.remotePolicy ?? {
			allowTools: null,
			detachedRuntimeTtlMs: DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS,
		};
		const currentLease = status.leases.find((lease) => lease.sessionId === this.options.currentSessionId);
		const currentWorkspace =
			status.workspaces.find((workspace) => workspace.name === this.options.getCurrentWorkspaceName()) ??
			workspaceForPath(status, this.options.getCurrentWorkspacePath());
		const rows: DisplayRow[] = [
			...(this.view.notice
				? [
						{
							text: this.view.notice,
							tone: this.view.notice.includes("failed") ? ("error" as const) : ("success" as const),
						},
					]
				: []),
			{ text: "CONNECTION", tone: "accent" },
			{
				text: `voltd ${status.version} · pid ${status.pid} · up ${formatDuration(Date.now() - status.startedAtMs)}`,
				tone: "text",
			},
			{
				text: `${status.phoneConnections} attached phone${status.phoneConnections === 1 ? "" : "s"} · ${status.clients.length} paired device${status.clients.length === 1 ? "" : "s"}${status.revokedClients === undefined ? "" : ` · ${status.revokedClients.length} revoked`}`,
				tone: status.phoneConnections > 0 ? "success" : "muted",
			},
			{
				text: currentLease
					? `Current lease: ${currentLease.state} · ${currentLease.streamCount} stream${currentLease.streamCount === 1 ? "" : "s"} · ${currentLease.relayCount} relay${currentLease.relayCount === 1 ? "" : "s"}`
					: "Current lease: not reported by daemon",
				tone: currentLease ? "text" : "muted",
			},
			{ text: "ACTIONS", tone: "accent" },
			{ key: "refresh", text: "Refresh status", tone: "text" },
			{ key: "register-current", text: "Register current directory", tone: "text" },
			...(status.workspaces.length === 0
				? [{ text: "Pairing needs a registered workspace.", tone: "warning" as const }]
				: supportsSafePairing(status)
					? [{ key: "pair", text: "Pair a phone", tone: "text" as const }]
					: [{ text: "Restart voltd to pair with explicit access grants.", tone: "warning" as const }]),
			{ text: "HEADLESS POLICY", tone: "accent" },
			...(status.remotePolicy
				? [
						{
							text: `Tools: ${policyTools(remotePolicy, currentWorkspace?.allowedTools)}`,
							tone: "text" as const,
						},
						{
							text: `Source: ${remotePolicy.allowTools !== null ? "daemon override" : currentWorkspace?.allowedTools ? `workspace ${currentWorkspace.name}` : "paired device grant"}`,
							tone: "dim" as const,
						},
						{
							text: `Detached runtime retention: ${formatDuration(remotePolicy.detachedRuntimeTtlMs)}`,
							tone: "text" as const,
						},
					]
				: [
						{ text: "Tools: not reported by this running daemon", tone: "muted" as const },
						{ text: "Detached runtime retention: not reported", tone: "muted" as const },
					]),
			{ text: "PAIRED DEVICES", tone: "accent" },
		];
		if (status.clients.length === 0) rows.push({ text: "No paired devices.", tone: "muted" });
		for (const client of status.clients) {
			rows.push({
				key: `client:${client.clientNodeId}`,
				text: `${client.label || "Unnamed phone"} · ${abbreviatedId(client.clientNodeId, width < 60 ? 10 : 20)} · last seen ${formatDuration(Date.now() - (client.lastSeenAtMs ?? client.pairedAtMs))} ago`,
				tone: "text",
			});
			rows.push({
				text: `  Tools: ${
					client.allowedTools
						? `${client.allowedTools.join(", ") || "none"}${client.usesDefaultTools ? " (default)" : ""}`
						: "not reported"
				}`,
				tone: "dim",
			});
		}
		if (status.revokedClients !== undefined) {
			rows.push({ text: "REVOKED DEVICES", tone: "accent" });
			if (status.revokedClients.length === 0) rows.push({ text: "No revoked devices.", tone: "muted" });
			for (const client of status.revokedClients) {
				const approved = client.rePairApprovedAtMs !== undefined;
				rows.push({
					...(approved ? {} : { key: `revoked:${client.clientNodeId}` }),
					text: `${client.label || "Unnamed phone"} · ${abbreviatedId(client.clientNodeId, width < 60 ? 10 : 20)} · revoked ${formatDuration(Date.now() - client.revokedAtMs)} ago`,
					tone: approved ? "success" : "warning",
				});
				rows.push({
					text: approved ? "  Re-pair approved · scan a fresh QR" : "  Select to allow fresh pairing",
					tone: approved ? "success" : "dim",
				});
			}
		}
		rows.push({ text: "WORKSPACES", tone: "accent" });
		if (status.workspaces.length === 0) rows.push({ text: "No registered workspaces.", tone: "muted" });
		for (const workspace of status.workspaces) {
			rows.push({
				text: `${workspace.name === currentWorkspace?.name ? "Current · " : ""}${workspace.name} · ${workspace.path}`,
				tone: workspace.name === currentWorkspace?.name ? "accent" : "text",
			});
			if (workspace.allowedTools)
				rows.push({ text: `  Tools: ${workspace.allowedTools.join(", ") || "none"}`, tone: "dim" });
		}
		rows.push({ text: "LEASES", tone: "accent" });
		if (status.leases.length === 0) rows.push({ text: "No active conversation leases.", tone: "muted" });
		for (const lease of status.leases) {
			const current = lease.sessionId === this.options.currentSessionId;
			rows.push({
				text: `${current ? "Current · " : ""}${lease.workspaceName}/${abbreviatedId(lease.sessionId, width < 60 ? 10 : 18)} · ${lease.state} · ${lease.streamCount} streams · ${lease.relayCount} relays`,
				tone: current ? "accent" : "text",
			});
		}
		return rows;
	}

	private buildPairingRows(width: number, pageSize: number): DisplayRow[] {
		if (this.view.kind !== "pairing") return [];
		const phaseLabel = {
			starting: "Creating one-time ticket…",
			ticket: "Ticket ready",
			waiting: "Scan with Volt on your phone",
			completed: "Pairing complete",
			failed: "Pairing failed",
		}[this.view.phase];
		const rows: DisplayRow[] = [
			{
				text: `PAIR PHONE · ${this.view.workspaceName} · ${ACCESS_PRESET_DETAILS[this.view.access].label}`,
				tone: "accent",
			},
			{
				text:
					this.view.phase === "waiting"
						? "Scan with Volt, then compare these values before confirming"
						: phaseLabel,
				tone: this.view.phase === "failed" ? "error" : this.view.phase === "completed" ? "success" : "text",
			},
		];
		if (this.view.message)
			rows.push({ text: this.view.message, tone: this.view.phase === "failed" ? "error" : "muted" });

		let qrLines: string[] | undefined;
		let qrError: string | undefined;
		if (this.view.ticket) {
			try {
				qrLines = formatIrohRemoteTicketQrCode(this.view.ticket)
					.split("\n")
					.filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));
			} catch (error) {
				qrError = error instanceof Error ? error.message : String(error);
			}
		}
		const qrFits =
			qrLines !== undefined &&
			qrLines.length + 4 <= pageSize &&
			qrLines.every((line) => visibleWidth(line) <= width);
		if (this.view.showQr) {
			if (qrFits && qrLines !== undefined) {
				return [
					{ text: `PAIR QR · ${this.view.workspaceName}`, tone: "accent" },
					...qrLines.map((line) => ({ text: line, raw: true })),
					{ key: "pairing-verification", text: "Show verification details", tone: "text" },
					{ key: "pairing-copy", text: "Copy pairing ticket", tone: "text" },
					{ key: "pairing-back", text: "Cancel pairing", tone: "text" },
				];
			}
			rows.push({ text: "The terminal is no longer large enough to show the complete QR code.", tone: "warning" });
			rows.push({ key: "pairing-verification", text: "Show verification details", tone: "text" });
		} else if (this.view.ticket) {
			try {
				const details = getIrohRemotePairingVerificationDetails(this.view.ticket);
				const addDetail = (label: string, value: string | string[]): void => {
					rows.push({ text: label, tone: "dim" });
					for (const item of typeof value === "string" ? [value] : value) {
						const safeValue = stripAnsi(item).replace(UNSAFE_TERMINAL_CHARACTERS, "");
						rows.push(
							...wrapTextWithAnsi(safeValue, Math.max(1, width - 2)).map((line) => ({
								text: line,
								tone: "text" as const,
							})),
						);
					}
				};
				addDetail("Fingerprint", details.hostFingerprint);
				addDetail("Host ID", details.hostNodeId);
				addDetail("Workspace", details.workspace);
				addDetail("Relay mode", details.relayMode);
				addDetail("HTTPS relay origins", details.relayOrigins.length === 0 ? "none" : details.relayOrigins);
				addDetail(
					"Expires (UTC)",
					details.expiresAt === undefined ? "not specified" : new Date(details.expiresAt).toISOString(),
				);
			} catch (error) {
				rows.push({
					text: `Verification unavailable: ${error instanceof Error ? error.message : String(error)}`,
					tone: "error",
				});
			}
			if (qrFits) {
				rows.push({ key: "pairing-show-qr", text: "Show pairing QR", tone: "text" });
			} else if (qrError) {
				rows.push({ text: `QR unavailable: ${qrError}`, tone: "warning" });
			} else {
				rows.push({ text: "Enlarge the terminal to show the complete QR code.", tone: "warning" });
				rows.push({ text: "Use Copy pairing ticket instead of exposing it in scrollback.", tone: "dim" });
			}
		}
		if (this.view.ticket) rows.push({ key: "pairing-copy", text: "Copy pairing ticket", tone: "text" });
		if (this.view.recoveryBackupPath) {
			rows.push({
				text: "A recoverable daemon-state backup is available from before the endpoint failure.",
				tone: "warning",
			});
			rows.push({ key: "pairing-recover", text: "Recover previous daemon state…", tone: "warning" });
		}
		rows.push({
			key: "pairing-back",
			text:
				this.view.phase === "completed"
					? "Return to overview"
					: this.view.phase === "starting"
						? "Back to overview"
						: "Cancel pairing",
			tone: "text",
		});
		return rows;
	}

	private renderRow(row: DisplayRow, width: number): string {
		const marker = row.raw ? "" : row.key ? (row.key === this.selectedKey ? "› " : "  ") : "  ";
		const color = row.tone ?? "text";
		const safeText = row.raw ? row.text : stripAnsi(row.text).replace(UNSAFE_TERMINAL_CHARACTERS, "");
		const content = truncateToWidth(`${marker}${safeText}`, width, "…");
		let styled = theme.fg(color, content);
		if (row.key === this.selectedKey) {
			styled = theme.bg("selectedBg", `${styled}${" ".repeat(Math.max(0, width - visibleWidth(content)))}`);
		}
		return truncateToWidth(styled, width, "");
	}
}
