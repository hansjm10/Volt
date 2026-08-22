export const IROH_RELAY_RECOVERY_DELAY_MS = 30_000;
export const IROH_RELAY_RECOVERY_RETRY_MS = 30_000;

export interface IrohRelayRecoveryMonitorOptions {
	recover(): Promise<void>;
	log(level: "info" | "warn", message: string, details?: Record<string, unknown>): void;
	recoveryDelayMs?: number;
	retryDelayMs?: number;
}

/**
 * Debounces relay-map recycling after an authenticated transport fails
 * unexpectedly. Graceful client closes never reach this monitor, and a fresh
 * authenticated connection cancels recovery before it mutates relay state.
 */
export class IrohRelayRecoveryMonitor {
	private readonly options: IrohRelayRecoveryMonitorOptions;
	private readonly recoveryDelayMs: number;
	private readonly retryDelayMs: number;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveryTask: Promise<void> | undefined;
	private stopped = false;

	constructor(options: IrohRelayRecoveryMonitorOptions) {
		this.options = options;
		this.recoveryDelayMs = options.recoveryDelayMs ?? IROH_RELAY_RECOVERY_DELAY_MS;
		this.retryDelayMs = options.retryDelayMs ?? IROH_RELAY_RECOVERY_RETRY_MS;
	}

	reportUnexpectedTransportFailure(): void {
		if (this.stopped || this.recoveryTimer !== undefined || this.recoveryTask !== undefined) return;
		this.options.log("warn", "authenticated Iroh transport lost; scheduling relay registration recovery", {
			delayMs: this.recoveryDelayMs,
		});
		this.scheduleRecovery(this.recoveryDelayMs);
	}

	reportAuthenticatedConnection(): void {
		if (this.stopped || this.recoveryTimer === undefined) return;
		clearTimeout(this.recoveryTimer);
		this.recoveryTimer = undefined;
		this.options.log("info", "cancelled Iroh relay registration recovery after authenticated reconnect");
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.recoveryTimer !== undefined) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
		await Promise.allSettled([this.recoveryTask]);
	}

	private scheduleRecovery(delayMs: number): void {
		if (this.stopped || this.recoveryTask !== undefined) return;
		if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			if (this.stopped) return;
			let shouldRetry = false;
			const task = this.options
				.recover()
				.then(() => {
					this.options.log("info", "requested Iroh relay registration recovery");
				})
				.catch((error: unknown) => {
					shouldRetry = true;
					this.options.log("warn", "Iroh relay registration recovery failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					if (this.recoveryTask === task) this.recoveryTask = undefined;
					if (shouldRetry && !this.stopped) this.scheduleRecovery(this.retryDelayMs);
				});
			this.recoveryTask = task;
		}, delayMs);
		this.recoveryTimer.unref?.();
	}
}
