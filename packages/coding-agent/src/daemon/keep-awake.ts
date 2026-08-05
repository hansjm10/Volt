import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/**
 * Cross-platform "keep the host awake" assertion held by voltd while enabled.
 * Zero native dependencies: each platform gets a long-lived child process whose
 * lifetime IS the assertion — killing the child releases it.
 *
 *  - darwin: `caffeinate -i -s` (idle + system sleep on AC; the display may
 *    still sleep). Lid-closed sleep on battery cannot be prevented.
 *  - linux: `systemd-inhibit --mode=block sleep infinity`; hosts without
 *    systemd degrade with a reason instead of failing.
 *  - win32: a PowerShell child that P/Invokes SetThreadExecutionState with
 *    ES_CONTINUOUS | ES_SYSTEM_REQUIRED; the OS clears the flag when the
 *    process exits.
 */

export type KeepAwakeState = "disabled" | "active" | "degraded";
export type KeepAwakeMethod = "caffeinate" | "systemd-inhibit" | "powershell";

export interface KeepAwakeStatus {
	/** Desired (persisted) state. */
	enabled: boolean;
	/** Actual state; `degraded` means enabled but the assertion is not held. */
	state: KeepAwakeState;
	method?: KeepAwakeMethod;
	/** Present when degraded. Generic wording only — this string goes to phones. */
	reason?: string;
}

export interface KeepAwakeControllerOptions {
	platform?: NodeJS.Platform;
	spawn?: typeof nodeSpawn;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	onStatusChanged?: (status: KeepAwakeStatus) => void;
	/** Respawn delays after unexpected child exit; the last entry repeats. */
	retryBackoffMs?: number[];
}

/**
 * SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) = 0x80000001.
 * Exits non-zero when the call fails so the controller reports degraded.
 */
const WINDOWS_KEEP_AWAKE_SCRIPT = [
	"Add-Type -Name KeepAwake -Namespace Volt -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
	"if ([Volt.KeepAwake]::SetThreadExecutionState([uint32]'0x80000001') -eq 0) { exit 1 };",
	"while ($true) { Start-Sleep -Seconds 3600 }",
].join(" ");

const DEFAULT_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000];
const KILL_ESCALATION_MS = 2_000;
/** A child alive this long is considered stable; the retry backoff resets. */
const STABLE_CHILD_MS = 60_000;

export function getKeepAwakeCommand(
	platform: NodeJS.Platform,
): { method: KeepAwakeMethod; command: string; args: string[] } | undefined {
	switch (platform) {
		case "darwin":
			return { method: "caffeinate", command: "/usr/bin/caffeinate", args: ["-i", "-s"] };
		case "linux":
			return {
				method: "systemd-inhibit",
				command: "systemd-inhibit",
				args: [
					"--what=sleep:idle",
					"--who=voltd",
					"--why=volt keep-awake enabled",
					"--mode=block",
					"sleep",
					"infinity",
				],
			};
		case "win32":
			return {
				method: "powershell",
				command: "powershell",
				args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_KEEP_AWAKE_SCRIPT],
			};
		default:
			return undefined;
	}
}

export class KeepAwakeController {
	private readonly platform: NodeJS.Platform;
	private readonly spawn: typeof nodeSpawn;
	private readonly log: (level: "info" | "warn" | "error", message: string) => void;
	private readonly onStatusChanged?: (status: KeepAwakeStatus) => void;
	private readonly retryBackoffMs: number[];

	private enabled = false;
	private state: KeepAwakeState = "disabled";
	private reason: string | undefined;
	private child: ChildProcess | undefined;
	/** Distinguishes exit events of the current child from already-replaced ones. */
	private generation = 0;
	private retryTimer: NodeJS.Timeout | undefined;
	private retryIndex = 0;

	constructor(options: KeepAwakeControllerOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.spawn = options.spawn ?? nodeSpawn;
		this.log = options.log ?? (() => {});
		this.onStatusChanged = options.onStatusChanged;
		this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
	}

	get status(): KeepAwakeStatus {
		const method = getKeepAwakeCommand(this.platform)?.method;
		return {
			enabled: this.enabled,
			state: this.state,
			...(method === undefined ? {} : { method }),
			...(this.reason === undefined ? {} : { reason: this.reason }),
		};
	}

	setEnabled(enabled: boolean): KeepAwakeStatus {
		if (enabled === this.enabled) {
			return this.status;
		}
		this.enabled = enabled;
		if (enabled) {
			this.retryIndex = 0;
			this.startChild();
		} else {
			this.stopChild();
			this.setState("disabled", undefined);
		}
		return this.status;
	}

	async shutdown(): Promise<void> {
		// Releases the assertion but keeps `enabled` (persisted) untouched so a
		// restarted daemon re-applies it.
		this.stopChild();
		this.state = this.enabled ? "degraded" : "disabled";
	}

	private setState(state: KeepAwakeState, reason: string | undefined): void {
		if (state === this.state && reason === this.reason) {
			return;
		}
		this.state = state;
		this.reason = reason;
		try {
			this.onStatusChanged?.(this.status);
		} catch {
			// Observers must never break the controller.
		}
	}

	private startChild(): void {
		const command = getKeepAwakeCommand(this.platform);
		if (command === undefined) {
			this.setState("degraded", "unsupported platform");
			return;
		}
		this.generation += 1;
		const generation = this.generation;
		let child: ChildProcess;
		try {
			child = this.spawn(command.command, command.args, {
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			});
		} catch (error) {
			this.log("error", `spawn ${command.method} failed: ${String(error)}`);
			this.handleChildGone(generation, `${command.method} unavailable`);
			return;
		}
		child.unref();
		this.child = child;
		child.on("error", (error: NodeJS.ErrnoException) => {
			const reason = error.code === "ENOENT" ? `${command.method} not found` : `${command.method} failed to start`;
			this.log("error", `${command.method} error: ${String(error)}`);
			this.handleChildGone(generation, reason);
		});
		child.on("exit", (code, signal) => {
			this.log("warn", `${command.method} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
			this.handleChildGone(generation, `${command.method} exited`);
		});
		const stableTimer = setTimeout(() => {
			if (generation === this.generation) {
				this.retryIndex = 0;
			}
		}, STABLE_CHILD_MS);
		stableTimer.unref?.();
		this.log("info", `spawned ${command.method} (pid ${child.pid ?? "?"})`);
		this.setState("active", undefined);
	}

	private handleChildGone(generation: number, reason: string): void {
		if (generation !== this.generation || !this.enabled) {
			return;
		}
		this.child = undefined;
		this.setState("degraded", reason);
		const delay = this.retryBackoffMs[Math.min(this.retryIndex, this.retryBackoffMs.length - 1)] ?? 30_000;
		this.retryIndex += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.enabled) {
				this.startChild();
			}
		}, delay);
		this.retryTimer.unref?.();
	}

	private stopChild(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		// Bump the generation so the pending exit event of the killed child is stale.
		this.generation += 1;
		const child = this.child;
		this.child = undefined;
		if (child === undefined || child.exitCode !== null || child.killed) {
			return;
		}
		try {
			child.kill("SIGTERM");
			const escalate = setTimeout(() => {
				try {
					if (child.exitCode === null) {
						child.kill("SIGKILL");
					}
				} catch {
					// Best-effort escalation.
				}
			}, KILL_ESCALATION_MS);
			escalate.unref?.();
		} catch {
			// Child already gone.
		}
	}
}
