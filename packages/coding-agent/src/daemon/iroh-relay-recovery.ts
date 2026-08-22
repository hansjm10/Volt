import type { IrohEndpointAddrLike, IrohWatchHandleLike } from "./iroh-native.ts";

export const IROH_RELAY_RECOVERY_DELAY_MS = 30_000;
export const IROH_RELAY_RECOVERY_RETRY_MS = 30_000;

export interface IrohRelayRecoveryMonitorOptions {
	watchAddr(callback: (addr: IrohEndpointAddrLike) => void): IrohWatchHandleLike;
	recover(): Promise<void>;
	log(level: "info" | "warn", message: string, details?: Record<string, unknown>): void;
	recoveryDelayMs?: number;
	retryDelayMs?: number;
}

/**
 * Watches the endpoint's advertised relay address and recycles its relay-map
 * entry when a previously-online endpoint remains offline. The native online()
 * promise only reports first registration and does not cover later outages.
 */
export class IrohRelayRecoveryMonitor {
	private readonly options: IrohRelayRecoveryMonitorOptions;
	private readonly recoveryDelayMs: number;
	private readonly retryDelayMs: number;
	private watchHandle: IrohWatchHandleLike | undefined;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveryTask: Promise<void> | undefined;
	private hasConnected = false;
	private relayOffline = false;
	private stopped = false;

	constructor(options: IrohRelayRecoveryMonitorOptions) {
		this.options = options;
		this.recoveryDelayMs = options.recoveryDelayMs ?? IROH_RELAY_RECOVERY_DELAY_MS;
		this.retryDelayMs = options.retryDelayMs ?? IROH_RELAY_RECOVERY_RETRY_MS;
	}

	start(): void {
		if (this.watchHandle !== undefined || this.stopped) return;
		this.watchHandle = this.options.watchAddr((addr) => this.observeRelayAddress(addr));
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.recoveryTimer !== undefined) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
		const watchHandle = this.watchHandle;
		this.watchHandle = undefined;
		await Promise.allSettled([watchHandle?.stop(), this.recoveryTask]);
	}

	private observeRelayAddress(addr: IrohEndpointAddrLike): void {
		if (this.stopped) return;
		if (addr.relayUrl() !== null) {
			const recovered = this.relayOffline;
			this.hasConnected = true;
			this.relayOffline = false;
			if (this.recoveryTimer !== undefined) {
				clearTimeout(this.recoveryTimer);
				this.recoveryTimer = undefined;
			}
			if (recovered) {
				this.options.log("info", "Iroh relay registration recovered");
			}
			return;
		}
		if (!this.hasConnected || this.relayOffline) return;
		this.relayOffline = true;
		this.options.log("warn", "Iroh relay registration lost; scheduling recovery", {
			delayMs: this.recoveryDelayMs,
		});
		this.scheduleRecovery(this.recoveryDelayMs);
	}

	private scheduleRecovery(delayMs: number): void {
		if (this.stopped || !this.relayOffline || this.recoveryTask !== undefined) return;
		if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			if (this.stopped || !this.relayOffline) return;
			const task = this.options
				.recover()
				.then(() => {
					this.options.log("info", "requested Iroh relay registration recovery");
				})
				.catch((error: unknown) => {
					this.options.log("warn", "Iroh relay registration recovery failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					if (this.recoveryTask === task) this.recoveryTask = undefined;
					if (!this.stopped && this.relayOffline) this.scheduleRecovery(this.retryDelayMs);
				});
			this.recoveryTask = task;
		}, delayMs);
		this.recoveryTimer.unref?.();
	}
}
