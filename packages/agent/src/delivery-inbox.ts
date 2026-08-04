import type { QueueMode } from "./types.ts";

export interface InboxDelivery<TKind extends string, TMessage> {
	readonly deliveryId: string;
	readonly kind: TKind;
	readonly messages: readonly TMessage[];
	readonly sequence: number;
}

type LeaseEntry<TKind extends string, TMessage> = {
	delivery: InboxDelivery<TKind, TMessage>;
	status: "leased" | "emitting" | "committed" | "revoked";
};

/** Opaque capability for one FIFO selection owned by a dispatcher decision. */
export class DeliveryLease<TKind extends string, TMessage> {
	private readonly inbox: DeliveryInbox<TKind, TMessage>;
	private readonly entries: LeaseEntry<TKind, TMessage>[];
	private active = true;

	constructor(inbox: DeliveryInbox<TKind, TMessage>, deliveries: readonly InboxDelivery<TKind, TMessage>[]) {
		this.inbox = inbox;
		this.entries = deliveries.map((delivery) => ({ delivery, status: "leased" }));
	}

	get deliveries(): readonly InboxDelivery<TKind, TMessage>[] {
		return this.entries.flatMap((entry) => (entry.status === "leased" ? [entry.delivery] : []));
	}

	owns(deliveryId: string): boolean {
		return this.active && this.entries.some((entry) => entry.delivery.deliveryId === deliveryId);
	}

	/** Commit a still-live delivery while keeping synchronous commit observers from revoking it. */
	begin(deliveryId: string, commit?: () => void): InboxDelivery<TKind, TMessage> | undefined {
		if (!this.active) return undefined;
		const entry = this.entries.find((candidate) => candidate.delivery.deliveryId === deliveryId);
		if (entry?.status !== "leased") return undefined;
		entry.status = "emitting";
		try {
			commit?.();
		} catch (error) {
			entry.status = "leased";
			throw error;
		}
		entry.status = "committed";
		return entry.delivery;
	}

	/** Restore only deliveries whose commit boundary was never crossed. */
	rollback(): readonly InboxDelivery<TKind, TMessage>[] {
		if (!this.active) return [];
		this.active = false;
		const restored = this.entries.flatMap((entry) => (entry.status === "leased" ? [entry.delivery] : []));
		this.inbox.finishLease(this, restored);
		return restored;
	}

	revoke(kind: TKind): readonly InboxDelivery<TKind, TMessage>[] {
		if (!this.active) return [];
		const revoked: InboxDelivery<TKind, TMessage>[] = [];
		for (const entry of this.entries) {
			if (entry.status === "leased" && entry.delivery.kind === kind) {
				entry.status = "revoked";
				revoked.push(entry.delivery);
			}
		}
		return revoked;
	}

	hasRevocableDeliveries(): boolean {
		return this.active && this.entries.some((entry) => entry.status === "leased");
	}

	listRevocable(kind?: TKind): readonly InboxDelivery<TKind, TMessage>[] {
		if (!this.active) return [];
		return this.entries.flatMap((entry) =>
			entry.status === "leased" && (kind === undefined || entry.delivery.kind === kind) ? [entry.delivery] : [],
		);
	}
}

/** Small in-memory FIFO with one explicit revocable lease at a time. */
export class DeliveryInbox<TKind extends string, TMessage> {
	private pending: Array<InboxDelivery<TKind, TMessage>> = [];
	private activeLease?: DeliveryLease<TKind, TMessage>;
	private nextSequence = 0;
	private readonly createId: () => string;

	constructor(createId: () => string = () => globalThis.crypto.randomUUID()) {
		this.createId = createId;
	}

	enqueue(kind: TKind, messages: readonly TMessage[]): InboxDelivery<TKind, TMessage> {
		const delivery: InboxDelivery<TKind, TMessage> = {
			deliveryId: this.createId(),
			kind,
			messages: messages.slice(),
			sequence: this.nextSequence++,
		};
		this.pending.push(delivery);
		return delivery;
	}

	select(kind: TKind, mode: QueueMode): readonly InboxDelivery<TKind, TMessage>[] {
		const matching = this.pending.filter((delivery) => delivery.kind === kind);
		return mode === "all" ? matching : matching.slice(0, 1);
	}

	lease(deliveries: readonly InboxDelivery<TKind, TMessage>[]): DeliveryLease<TKind, TMessage> {
		if (this.activeLease?.hasRevocableDeliveries()) {
			throw new Error("Delivery inbox already has an active revocable lease");
		}
		this.activeLease?.rollback();
		const selectedIds = new Set(deliveries.map((delivery) => delivery.deliveryId));
		const claimed = this.pending.filter((delivery) => selectedIds.has(delivery.deliveryId));
		this.pending = this.pending.filter((delivery) => !selectedIds.has(delivery.deliveryId));
		const lease = new DeliveryLease(this, claimed);
		this.activeLease = lease;
		return lease;
	}

	revoke(kind: TKind): readonly InboxDelivery<TKind, TMessage>[] {
		const revoked = this.pending.filter((delivery) => delivery.kind === kind);
		this.pending = this.pending.filter((delivery) => delivery.kind !== kind);
		const leased = this.activeLease?.revoke(kind) ?? [];
		return [...revoked, ...leased].sort((left, right) => left.sequence - right.sequence);
	}

	hasPending(kind?: TKind): boolean {
		return this.list(kind).length > 0;
	}

	list(kind?: TKind): readonly InboxDelivery<TKind, TMessage>[] {
		return [
			...this.pending.filter((delivery) => kind === undefined || delivery.kind === kind),
			...(this.activeLease?.listRevocable(kind) ?? []),
		].sort((left, right) => left.sequence - right.sequence);
	}

	rollbackActiveLease(): readonly InboxDelivery<TKind, TMessage>[] {
		return this.activeLease?.rollback() ?? [];
	}

	reset(): void {
		this.activeLease?.rollback();
		this.pending = [];
		this.activeLease = undefined;
	}

	finishLease(lease: DeliveryLease<TKind, TMessage>, restored: readonly InboxDelivery<TKind, TMessage>[]): void {
		if (this.activeLease !== lease) return;
		this.pending = [...restored, ...this.pending].sort((left, right) => left.sequence - right.sequence);
		this.activeLease = undefined;
	}
}
