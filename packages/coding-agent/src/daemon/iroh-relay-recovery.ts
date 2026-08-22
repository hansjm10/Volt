import type { IrohAddrWatchCallback, IrohEndpointAddrLike, IrohWatchHandleLike } from "./iroh-native.ts";

export const IROH_RELAY_RECOVERY_DELAY_MS = 15_000;
export const IROH_RELAY_RECOVERY_RETRY_MS = 30_000;

export interface IrohRelayRecoveryMonitorOptions {
	watchAddr(callback: IrohAddrWatchCallback): IrohWatchHandleLike;
	recover(): Promise<void>;
	log(level: "info" | "warn", message: string, details?: Record<string, unknown>): void;
	recoveryDelayMs?: number;
	retryDelayMs?: number;
}

function isIrohEndpointAddrLike(value: unknown): value is IrohEndpointAddrLike {
	return typeof value === "object" && value !== null && "relayUrl" in value && typeof value.relayUrl === "function";
}

/** Recycles live relay configuration after a previously-online endpoint loses every advertised home relay. */
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
		this.watchHandle = this.options.watchAddr((errorOrAddr, addr) => {
			const normalized = addr ?? (isIrohEndpointAddrLike(errorOrAddr) ? errorOrAddr : undefined);
			if (normalized === undefined) {
				this.options.log("warn", "Iroh relay registration watcher emitted an invalid update");
				return;
			}
			this.observeRelayAddress(normalized);
		});
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
			if (recovered) this.options.log("info", "Iroh relay registration recovered");
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
			let shouldRetry = false;
			const task = this.options
				.recover()
				.then(() => this.options.log("info", "requested Iroh relay registration recovery"))
				.catch((error: unknown) => {
					shouldRetry = true;
					this.options.log("warn", "Iroh relay registration recovery failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					if (this.recoveryTask === task) this.recoveryTask = undefined;
					if (shouldRetry && !this.stopped && this.relayOffline) this.scheduleRecovery(this.retryDelayMs);
				});
			this.recoveryTask = task;
		}, delayMs);
		this.recoveryTimer.unref?.();
	}
}
