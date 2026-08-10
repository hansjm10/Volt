import type { QueueMode } from "./types.ts";

export interface InboxDelivery<TKind extends string, TMessage> {
	readonly deliveryId: string;
	readonly kind: TKind;
	readonly messages: readonly TMessage[];
	readonly sequence: number;
}

export type DeliveryLeaseSettlement = "committed" | "retained" | "terminally_failed";

type LeaseEntry<TKind extends string, TMessage> = {
	delivery: InboxDelivery<TKind, TMessage>;
	status: "leased" | "committing" | "committed" | "restored" | "revoked" | "terminally_failed";
};

/** Opaque capability for one FIFO selection owned by a dispatcher decision. */
export interface DeliveryLease<TKind extends string, TMessage> {
	readonly deliveries: readonly InboxDelivery<TKind, TMessage>[];
	owns(deliveryId: string): boolean;
	canPrepare(deliveryId: string): boolean;
	begin(deliveryId: string): InboxDelivery<TKind, TMessage> | undefined;
	settle(deliveryId: string, outcome: DeliveryLeaseSettlement): InboxDelivery<TKind, TMessage> | undefined;
	rollback(): readonly InboxDelivery<TKind, TMessage>[];
}

class InboxDeliveryLease<TKind extends string, TMessage> implements DeliveryLease<TKind, TMessage> {
	private readonly entries: LeaseEntry<TKind, TMessage>[];
	private readonly finish: (
		lease: InboxDeliveryLease<TKind, TMessage>,
		restored: readonly InboxDelivery<TKind, TMessage>[],
	) => void;
	private readonly restoreSettlement: (delivery: InboxDelivery<TKind, TMessage>) => void;
	private active = true;

	constructor(
		deliveries: readonly InboxDelivery<TKind, TMessage>[],
		finish: (lease: InboxDeliveryLease<TKind, TMessage>, restored: readonly InboxDelivery<TKind, TMessage>[]) => void,
		restoreSettlement: (delivery: InboxDelivery<TKind, TMessage>) => void,
	) {
		this.entries = deliveries.map((delivery) => ({ delivery, status: "leased" }));
		this.finish = finish;
		this.restoreSettlement = restoreSettlement;
	}

	get deliveries(): readonly InboxDelivery<TKind, TMessage>[] {
		if (!this.active) return [];
		return this.entries.flatMap((entry) => (entry.status === "leased" ? [entry.delivery] : []));
	}

	owns(deliveryId: string): boolean {
		const entry = this.entries.find((candidate) => candidate.delivery.deliveryId === deliveryId);
		return entry?.status === "committing" || (this.active && entry?.status === "leased");
	}

	canPrepare(deliveryId: string): boolean {
		return (
			this.active &&
			this.entries.some((entry) => entry.delivery.deliveryId === deliveryId && entry.status === "leased")
		);
	}

	/** Cross the revocation cutoff without deciding the participant outcome. */
	begin(deliveryId: string): InboxDelivery<TKind, TMessage> | undefined {
		if (!this.active) return undefined;
		const entry = this.entries.find((candidate) => candidate.delivery.deliveryId === deliveryId);
		if (entry?.status !== "leased") return undefined;
		entry.status = "committing";
		return entry.delivery;
	}

	/** Settle exactly one delivery whose revocation cutoff was crossed. */
	settle(deliveryId: string, outcome: DeliveryLeaseSettlement): InboxDelivery<TKind, TMessage> | undefined {
		const entry = this.entries.find((candidate) => candidate.delivery.deliveryId === deliveryId);
		if (entry?.status !== "committing") return undefined;
		if (outcome === "retained") {
			entry.status = "restored";
			this.restoreSettlement(entry.delivery);
		} else {
			entry.status = outcome;
		}
		this.finishIfExhausted();
		return entry.delivery;
	}

	/** Restore only deliveries whose commit boundary was never crossed. */
	rollback(): readonly InboxDelivery<TKind, TMessage>[] {
		if (!this.active) return [];
		const restored: InboxDelivery<TKind, TMessage>[] = [];
		for (const entry of this.entries) {
			if (entry.status === "leased") {
				entry.status = "restored";
				restored.push(entry.delivery);
				this.restoreSettlement(entry.delivery);
			}
		}
		if (!this.entries.some((entry) => entry.status === "committing")) {
			this.active = false;
			this.finish(this, []);
		}
		return restored;
	}

	discard(): void {
		if (!this.active) return;
		this.active = false;
		for (const entry of this.entries) {
			if (entry.status === "leased") entry.status = "revoked";
		}
		this.finish(this, []);
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
		this.finishIfExhausted();
		return revoked;
	}

	isActive(): boolean {
		return this.active;
	}

	listRevocable(kind?: TKind): readonly InboxDelivery<TKind, TMessage>[] {
		if (!this.active) return [];
		return this.entries.flatMap((entry) =>
			entry.status === "leased" && (kind === undefined || entry.delivery.kind === kind) ? [entry.delivery] : [],
		);
	}

	private finishIfExhausted(): void {
		if (!this.active || this.entries.some((entry) => entry.status === "leased" || entry.status === "committing")) {
			return;
		}
		this.active = false;
		this.finish(this, []);
	}
}

/** Small in-memory FIFO with one explicit revocable lease at a time. */
export class DeliveryInbox<TKind extends string, TMessage> {
	private pending: Array<InboxDelivery<TKind, TMessage>> = [];
	private activeLease: InboxDeliveryLease<TKind, TMessage> | undefined;
	private nextSequence = 0;
	private resetGeneration = 0;
	private readonly createId: () => string;
	private readonly issuedIds = new Set<string>();

	constructor(createId: () => string = () => globalThis.crypto.randomUUID()) {
		this.createId = createId;
	}

	enqueue(kind: TKind, messages: readonly TMessage[]): InboxDelivery<TKind, TMessage> {
		const deliveryId = this.createId();
		if (this.issuedIds.has(deliveryId)) {
			throw new Error(`Delivery inbox generated duplicate delivery ID: ${deliveryId}`);
		}
		this.issuedIds.add(deliveryId);
		const delivery: InboxDelivery<TKind, TMessage> = {
			deliveryId,
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

	/** Claim per-kind FIFO prefixes, ordered globally by admission in the returned lease. */
	lease(deliveries: readonly InboxDelivery<TKind, TMessage>[]): DeliveryLease<TKind, TMessage> {
		if (this.activeLease?.isActive()) {
			throw new Error("Delivery inbox already has an active lease");
		}
		const selectedIds = new Set<string>();
		for (const delivery of deliveries) {
			if (selectedIds.has(delivery.deliveryId)) {
				throw new Error(`Delivery selection contains duplicate ID: ${delivery.deliveryId}`);
			}
			if (!this.pending.includes(delivery)) {
				throw new Error(`Delivery is not pending in this inbox: ${delivery.deliveryId}`);
			}
			selectedIds.add(delivery.deliveryId);
		}
		const selectedByKind = new Map<TKind, Array<InboxDelivery<TKind, TMessage>>>();
		for (const delivery of deliveries) {
			const selected = selectedByKind.get(delivery.kind) ?? [];
			selected.push(delivery);
			selectedByKind.set(delivery.kind, selected);
		}
		for (const [kind, selected] of selectedByKind) {
			const pending = this.pending.filter((delivery) => delivery.kind === kind);
			for (const [index, delivery] of selected.entries()) {
				const expected = pending[index];
				if (delivery !== expected) {
					throw new Error(
						`Delivery selection violates FIFO order for ${kind}: expected ${expected?.deliveryId ?? "none"} before ${delivery.deliveryId}`,
					);
				}
			}
		}
		const selected = new Set(deliveries);
		const claimed = this.pending.filter((delivery) => selected.has(delivery));
		this.pending = this.pending.filter((delivery) => !selected.has(delivery));
		const resetGeneration = this.resetGeneration;
		const lease = new InboxDeliveryLease(
			claimed,
			(finishedLease, restored) => this.finishLease(finishedLease, restored),
			(delivery) => {
				if (this.resetGeneration !== resetGeneration) return;
				this.pending = [delivery, ...this.pending].sort((left, right) => left.sequence - right.sequence);
			},
		);
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
		this.resetGeneration++;
		this.activeLease?.discard();
		this.pending = [];
		this.activeLease = undefined;
	}

	private finishLease(
		lease: InboxDeliveryLease<TKind, TMessage>,
		restored: readonly InboxDelivery<TKind, TMessage>[],
	): void {
		if (this.activeLease !== lease) return;
		this.pending = [...restored, ...this.pending].sort((left, right) => left.sequence - right.sequence);
		this.activeLease = undefined;
	}
}
