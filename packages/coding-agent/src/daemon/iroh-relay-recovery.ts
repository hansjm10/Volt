import type { IrohEndpointAddrLike } from "./iroh-native.ts";

export const IROH_RELAY_RECOVERY_POLL_INTERVAL_MS = 5_000;
export const IROH_RELAY_RECOVERY_DELAY_MS = 30_000;
export const IROH_RELAY_RECOVERY_RETRY_MS = 30_000;

export interface IrohRelayRecoveryMonitorOptions {
	readAddr(): IrohEndpointAddrLike;
	recover(): Promise<void>;
	log(level: "info" | "warn", message: string, details?: Record<string, unknown>): void;
	pollIntervalMs?: number;
	recoveryDelayMs?: number;
	retryDelayMs?: number;
}

/**
 * Polls the endpoint's advertised relay address and recycles its relay-map
 * entry when a previously-online endpoint remains offline. The native online()
 * promise only reports first registration and does not cover later outages.
 */
export class IrohRelayRecoveryMonitor {
	private readonly options: IrohRelayRecoveryMonitorOptions;
	private readonly pollIntervalMs: number;
	private readonly recoveryDelayMs: number;
	private readonly retryDelayMs: number;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveryTask: Promise<void> | undefined;
	private hasConnected = false;
	private relayOffline = false;
	private started = false;
	private stopped = false;

	constructor(options: IrohRelayRecoveryMonitorOptions) {
		this.options = options;
		this.pollIntervalMs = options.pollIntervalMs ?? IROH_RELAY_RECOVERY_POLL_INTERVAL_MS;
		this.recoveryDelayMs = options.recoveryDelayMs ?? IROH_RELAY_RECOVERY_DELAY_MS;
		this.retryDelayMs = options.retryDelayMs ?? IROH_RELAY_RECOVERY_RETRY_MS;
	}

	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.pollRelayAddress();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.pollTimer !== undefined) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.recoveryTimer !== undefined) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
		await Promise.allSettled([this.recoveryTask]);
	}

	private pollRelayAddress(): void {
		if (this.stopped) return;
		try {
			this.observeRelayAddress(this.options.readAddr());
		} catch (error) {
			this.options.log("warn", "failed to inspect Iroh relay registration", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			this.pollRelayAddress();
		}, this.pollIntervalMs);
		this.pollTimer.unref?.();
	}

	private observeRelayAddress(addr: IrohEndpointAddrLike): void {
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
