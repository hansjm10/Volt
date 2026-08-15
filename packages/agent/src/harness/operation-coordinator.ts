import type { AgentAbortAcceptance, AgentAbortSource } from "../types.ts";

export type HarnessOperationKind = "turn" | "compaction" | "branch_summary";
export type HarnessOperationPhase = "admitted" | "executing" | "terminalizing" | "notifying" | "settled";

export class HarnessAbortGate {
	private readonly controller = new AbortController();
	private sealed = false;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get isSealed(): boolean {
		return this.sealed;
	}

	seal(): boolean {
		if (this.sealed) return false;
		this.sealed = true;
		return true;
	}

	request(): boolean {
		if (this.sealed) return false;
		this.controller.abort();
		return true;
	}
}

export interface HarnessOperationLease {
	readonly id: string;
	kind: HarnessOperationKind;
	readonly abortGate: HarnessAbortGate;
	phase: HarnessOperationPhase;
	abortSource?: AgentAbortSource;
	diagnosticTimestamp?: number;
	requestAccepted: boolean;
}

export interface HarnessSuccessorReservation {
	readonly lease: HarnessOperationLease;
	readonly ready: Promise<void>;
	cancel(): boolean;
}

/** Owns admission and abort authority for every exclusive Harness operation. */
export class HarnessOperationCoordinator {
	private active: HarnessOperationLease | undefined;
	private successor:
		| { lease: HarnessOperationLease; ready: Promise<void>; resolveReady(): void; cancelled: boolean }
		| undefined;
	private readonly successorSettlementWaiters = new Map<string, Array<() => void>>();
	private lifecycle: "open" | "closing" | "closed" = "open";
	private resolveIdle: (() => void) | undefined;
	private idlePromise: Promise<void> = Promise.resolve();
	private resolveClosed: (() => void) | undefined;
	private readonly closedPromise = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});

	get current(): HarnessOperationLease | undefined {
		return this.active;
	}

	get isOpen(): boolean {
		return this.lifecycle === "open";
	}

	get isClosing(): boolean {
		return this.lifecycle !== "open";
	}

	reserve(kind: HarnessOperationKind): HarnessOperationLease | undefined {
		if (this.lifecycle !== "open" || this.active || this.successor) return undefined;
		const lease = this.createLease(kind);
		this.active = lease;
		this.beginBusyPeriod();
		return lease;
	}

	reserveSuccessor(kind: HarnessOperationKind): HarnessSuccessorReservation | undefined {
		if (this.lifecycle !== "open" || !this.active || this.successor) return undefined;
		return this.createSuccessor(kind);
	}

	/** Replace a known pending successor without opening an idle admission gap. */
	reserveSuccessorReplacing(
		replacedKind: HarnessOperationKind,
		kind: HarnessOperationKind,
	): HarnessSuccessorReservation | undefined {
		if (this.lifecycle !== "open" || !this.active || this.successor?.lease.kind !== replacedKind) return undefined;
		const replaced = this.successor;
		replaced.cancelled = true;
		this.successor = undefined;
		const replacement = this.createSuccessor(kind);
		const inheritedWaiters = this.successorSettlementWaiters.get(replaced.lease.id) ?? [];
		this.successorSettlementWaiters.delete(replaced.lease.id);
		this.successorSettlementWaiters.set(replacement.lease.id, [...inheritedWaiters, replaced.resolveReady]);
		return replacement;
	}

	private createSuccessor(kind: HarnessOperationKind): HarnessSuccessorReservation {
		const lease = this.createLease(kind);
		let resolveReady = (): void => undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const pending = { lease, ready, resolveReady, cancelled: false };
		this.successor = pending;
		return {
			lease,
			ready,
			cancel: () => {
				if (this.successor !== pending) return false;
				pending.cancelled = true;
				this.successor = undefined;
				resolveReady();
				this.resolveSuccessorSettlementWaiters(lease);
				return true;
			},
		};
	}

	private resolveSuccessorSettlementWaiters(lease: HarnessOperationLease): void {
		const waiters = this.successorSettlementWaiters.get(lease.id);
		if (!waiters) return;
		this.successorSettlementWaiters.delete(lease.id);
		for (const resolve of waiters) resolve();
	}

	private createLease(kind: HarnessOperationKind): HarnessOperationLease {
		return {
			id: `harness-operation:${globalThis.crypto.randomUUID()}`,
			kind,
			abortGate: new HarnessAbortGate(),
			phase: "admitted",
			requestAccepted: false,
		};
	}

	private beginBusyPeriod(): void {
		this.idlePromise = new Promise<void>((resolve) => {
			this.resolveIdle = resolve;
		});
	}

	start(lease: HarnessOperationLease): void {
		if (this.active !== lease || lease.phase !== "admitted") {
			throw new Error("Harness operation lease cannot start");
		}
		lease.phase = "executing";
	}

	reclassify(lease: HarnessOperationLease, kind: HarnessOperationKind): boolean {
		if (this.active !== lease || lease.phase !== "admitted") return false;
		lease.kind = kind;
		return true;
	}

	sealTerminal(lease: HarnessOperationLease): boolean {
		if (this.active !== lease || lease.phase === "settled") return false;
		if (!lease.abortGate.seal()) return false;
		lease.phase = "terminalizing";
		return true;
	}

	beginNotifications(lease: HarnessOperationLease): void {
		if (this.active !== lease || lease.phase === "settled") return;
		lease.phase = "notifying";
	}

	finish(lease: HarnessOperationLease): void {
		if (this.active !== lease) return;
		lease.phase = "settled";
		this.resolveSuccessorSettlementWaiters(lease);
		const successor = this.successor;
		this.successor = undefined;
		if (successor && !successor.cancelled && this.lifecycle === "open") {
			this.active = successor.lease;
			successor.resolveReady();
			return;
		}
		this.active = undefined;
		const resolveIdle = this.resolveIdle;
		this.resolveIdle = undefined;
		resolveIdle?.();
		if (this.lifecycle === "closing") this.finishClose();
	}

	requestAbort(source?: AgentAbortSource): AgentAbortAcceptance {
		const lease = this.active;
		if (!lease || lease.phase === "settled" || lease.abortGate.isSealed || lease.abortGate.signal.aborted) {
			return Object.freeze({
				runId: lease?.id,
				accepted: false,
				source: lease?.abortSource,
			});
		}
		if (source !== undefined && lease.abortSource === undefined) {
			lease.abortSource = source;
			lease.diagnosticTimestamp = Date.now();
		}
		lease.abortGate.request();
		return Object.freeze({ runId: lease.id, accepted: true, source: lease.abortSource });
	}

	requestClose(source: AgentAbortSource = "disposal"): boolean {
		if (this.lifecycle !== "open") return false;
		this.lifecycle = "closing";
		const successor = this.successor;
		this.successor = undefined;
		if (successor) {
			successor.cancelled = true;
			successor.resolveReady();
			this.resolveSuccessorSettlementWaiters(successor.lease);
		}
		this.requestAbort(source);
		if (!this.active) this.finishClose();
		return true;
	}

	waitForIdle(): Promise<void> {
		return this.idlePromise;
	}

	waitForClosed(): Promise<void> {
		return this.closedPromise;
	}

	private finishClose(): void {
		if (this.lifecycle !== "closing") return;
		this.lifecycle = "closed";
		this.resolveClosed?.();
		this.resolveClosed = undefined;
	}
}
