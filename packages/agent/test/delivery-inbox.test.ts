import { describe, expect, it } from "vitest";
import { DeliveryInbox, type DeliveryLease, type InboxDelivery } from "../src/delivery-inbox.ts";

describe("DeliveryInbox", () => {
	function createInbox(): DeliveryInbox<"steer" | "followUp", string> {
		let nextId = 0;
		return new DeliveryInbox(() => `delivery-${nextId++}`);
	}

	it("snapshots messages and filters FIFO projections", () => {
		const inbox = createInbox();
		const messages = ["first"];
		const first = inbox.enqueue("steer", messages);
		const followUp = inbox.enqueue("followUp", ["later"]);
		const second = inbox.enqueue("steer", ["second"]);
		messages.push("mutated");

		expect(first.messages).toEqual(["first"]);
		expect([first.sequence, followUp.sequence, second.sequence]).toEqual([0, 1, 2]);
		expect(inbox.select("steer", "one-at-a-time")).toEqual([first]);
		expect(inbox.select("steer", "all")).toEqual([first, second]);
		expect(inbox.list("followUp")).toEqual([followUp]);
	});

	it("generates unique IDs and rejects a duplicate without mutating admission order", () => {
		const ids = ["first", "first", "second"];
		const inbox = new DeliveryInbox<"steer" | "followUp", string>(() => ids.shift() ?? "unexpected");
		const first = inbox.enqueue("steer", ["first"]);

		expect(() => inbox.enqueue("followUp", ["rejected"])).toThrow(
			"Delivery inbox generated duplicate delivery ID: first",
		);
		const second = inbox.enqueue("followUp", ["second"]);

		expect(second.sequence).toBe(1);
		expect(inbox.list()).toEqual([first, second]);
	});

	it("rejects duplicate, stale, foreign, and non-FIFO selections", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const foreignInbox = new DeliveryInbox<"steer" | "followUp", string>(() => first.deliveryId);
		const foreign = foreignInbox.enqueue("steer", ["foreign"]);

		expect(() => inbox.lease([foreign])).toThrow(`Delivery is not pending in this inbox: ${first.deliveryId}`);
		expect(() => inbox.lease([first, first])).toThrow(
			`Delivery selection contains duplicate ID: ${first.deliveryId}`,
		);
		expect(() => inbox.lease([second])).toThrow(
			`Delivery selection violates FIFO order for steer: expected ${first.deliveryId} before ${second.deliveryId}`,
		);

		const stale = inbox.enqueue("followUp", ["stale"]);
		expect(inbox.revoke("followUp")).toEqual([stale]);
		expect(() => inbox.lease([stale])).toThrow(`Delivery is not pending in this inbox: ${stale.deliveryId}`);
		expect(inbox.list()).toEqual([first, second]);
	});

	it("projects leased deliveries and restores them ahead of later arrivals", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const lease = inbox.lease([first]);
		const second = inbox.enqueue("steer", ["second"]);

		expect(inbox.list()).toEqual([first, second]);
		expect(() => inbox.lease([second])).toThrow("Delivery inbox already has an active lease");
		expect(lease.rollback()).toEqual([first]);
		expect(inbox.list()).toEqual([first, second]);
		expect(lease.deliveries).toEqual([]);
		expect(lease.begin(first.deliveryId)).toBeUndefined();
	});

	it("protects a committing delivery from revocation and rollback", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(lease.begin(first.deliveryId)).toBe(first);
		expect(lease.owns(first.deliveryId)).toBe(true);
		expect(inbox.revoke("steer")).toEqual([second]);
		expect(lease.rollback()).toEqual([]);
		expect(lease.owns(first.deliveryId)).toBe(true);
		const later = inbox.enqueue("followUp", ["later"]);
		expect(() => inbox.lease([later])).toThrow("Delivery inbox already has an active lease");
		expect(lease.settle(first.deliveryId, "committed")).toBe(first);
		expect(lease.owns(first.deliveryId)).toBe(false);
		expect(inbox.list()).toEqual([later]);
	});

	it("restores a retained settlement with its original identity and FIFO position", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(lease.begin(first.deliveryId)).toBe(first);
		expect(inbox.rollbackActiveLease()).toEqual([second]);
		const third = inbox.enqueue("steer", ["third"]);
		expect(lease.settle(first.deliveryId, "retained")).toBe(first);

		expect(inbox.list()).toEqual([first, second, third]);
		expect(inbox.select("steer", "all")).toEqual([first, second, third]);
	});

	it("never restores a terminally failed settlement", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(lease.begin(first.deliveryId)).toBe(first);
		expect(lease.rollback()).toEqual([second]);
		expect(lease.settle(first.deliveryId, "terminally_failed")).toBe(first);
		expect(inbox.list()).toEqual([second]);
		expect(lease.settle(first.deliveryId, "retained")).toBeUndefined();
	});

	it("preserves a committed prefix and restores a retained current delivery plus unbegun suffix", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const third = inbox.enqueue("steer", ["third"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(lease.begin(first.deliveryId)).toBe(first);
		expect(lease.settle(first.deliveryId, "committed")).toBe(first);
		expect(lease.begin(second.deliveryId)).toBe(second);
		expect(lease.settle(second.deliveryId, "retained")).toBe(second);
		expect(lease.rollback()).toEqual([third]);

		expect(inbox.list()).toEqual([second, third]);
		expect(inbox.hasPending()).toBe(true);
	});

	it("makes revocation before begin terminal for that attempt", () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("followUp", ["revoke"]);
		const lease = inbox.lease([delivery]);

		expect(inbox.revoke("followUp")).toEqual([delivery]);
		expect(lease.begin(delivery.deliveryId)).toBeUndefined();
		expect(lease.settle(delivery.deliveryId, "committed")).toBeUndefined();
		expect(inbox.list()).toEqual([]);
	});

	it("retires an exhausted lease after settlement and admits later work", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const firstLease = inbox.lease([first]);
		expect(firstLease.begin(first.deliveryId)).toBe(first);
		expect(firstLease.settle(first.deliveryId, "committed")).toBe(first);

		const second = inbox.enqueue("steer", ["second"]);
		const secondLease = inbox.lease([second]);
		expect(firstLease.owns(first.deliveryId)).toBe(false);
		expect(secondLease.begin(second.deliveryId)).toBe(second);
		expect(secondLease.settle(second.deliveryId, "committed")).toBe(second);
		expect(inbox.list()).toEqual([]);
	});

	it("invalidates leased work on reset and does not resurrect an earlier generation", () => {
		const inbox = createInbox();
		const committing = inbox.enqueue("steer", ["committing"]);
		inbox.enqueue("followUp", ["discarded"]);
		const lease = inbox.lease([committing]);
		expect(lease.begin(committing.deliveryId)).toBe(committing);

		inbox.reset();
		expect(inbox.list()).toEqual([]);
		expect(lease.settle(committing.deliveryId, "retained")).toBe(committing);
		expect(inbox.list()).toEqual([]);

		const next = inbox.enqueue("followUp", ["next"]);
		expect(next.sequence).toBe(2);
		expect(inbox.list()).toEqual([next]);
	});

	it("preserves queue and settlement invariants across deterministic operation sequences", () => {
		type Kind = "steer" | "followUp";
		type Status = "pending" | "leased" | "committing" | "terminal";
		type ModelEntry = {
			delivery: InboxDelivery<Kind, string>;
			status: Status;
		};

		let nextId = 0;
		let seed = 0x5eed1234;
		const inbox = new DeliveryInbox<Kind, string>(() => `delivery-${nextId++}`);
		const model: ModelEntry[] = [];
		const kinds = ["steer", "followUp"] as const;
		let activeLease: DeliveryLease<Kind, string> | undefined;

		function nextRandom(limit: number): number {
			seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
			return seed % limit;
		}

		function pickRandom<T>(values: readonly T[]): T {
			const value = values[nextRandom(values.length)];
			if (value === undefined) throw new Error("Cannot pick from an empty collection");
			return value;
		}

		function project(kind?: Kind, status?: Status): InboxDelivery<Kind, string>[] {
			return model
				.filter(
					(entry) =>
						(kind === undefined || entry.delivery.kind === kind) &&
						(status === undefined
							? entry.status === "pending" || entry.status === "leased"
							: entry.status === status),
				)
				.map((entry) => entry.delivery)
				.sort((left, right) => left.sequence - right.sequence);
		}

		for (let step = 0; step < 400; step++) {
			const operation = step < 2 ? 0 : nextRandom(8);
			const kind = pickRandom(kinds);

			switch (operation) {
				case 0:
				case 7: {
					const delivery = inbox.enqueue(kind, [`message-${step}`]);
					model.push({ delivery, status: "pending" });
					break;
				}
				case 1: {
					if (project(undefined, "leased").length > 0 || project(undefined, "committing").length > 0) break;
					const mode = nextRandom(2) === 0 ? "one-at-a-time" : "all";
					const selected = inbox.select(kind, mode);
					if (selected.length === 0) break;
					const pending = project(kind, "pending");
					expect(selected).toEqual(mode === "all" ? pending : pending.slice(0, 1));
					activeLease = inbox.lease(selected);
					for (const entry of model) {
						if (selected.includes(entry.delivery)) entry.status = "leased";
					}
					break;
				}
				case 2: {
					const leased = project(undefined, "leased");
					if (!activeLease || leased.length === 0) break;
					const delivery = pickRandom(leased);
					expect(activeLease.begin(delivery.deliveryId)).toBe(delivery);
					const entry = model.find((candidate) => candidate.delivery === delivery);
					if (entry) entry.status = "committing";
					break;
				}
				case 3: {
					const committing = project(undefined, "committing");
					if (!activeLease || committing.length === 0) break;
					const delivery = pickRandom(committing);
					const settlement = ["committed", "retained", "terminally_failed"] as const;
					const outcome = pickRandom(settlement);
					expect(activeLease.settle(delivery.deliveryId, outcome)).toBe(delivery);
					const entry = model.find((candidate) => candidate.delivery === delivery);
					if (entry) entry.status = outcome === "retained" ? "pending" : "terminal";
					if (project(undefined, "leased").length === 0 && project(undefined, "committing").length === 0) {
						activeLease = undefined;
					}
					break;
				}
				case 4: {
					const expected = model
						.filter(
							(entry) =>
								entry.delivery.kind === kind && (entry.status === "pending" || entry.status === "leased"),
						)
						.map((entry) => entry.delivery)
						.sort((left, right) => left.sequence - right.sequence);
					expect(inbox.revoke(kind)).toEqual(expected);
					for (const entry of model) {
						if (expected.includes(entry.delivery)) entry.status = "terminal";
					}
					if (project(undefined, "leased").length === 0 && project(undefined, "committing").length === 0) {
						activeLease = undefined;
					}
					break;
				}
				case 5: {
					if (!activeLease) break;
					const expected = project(undefined, "leased");
					expect(inbox.rollbackActiveLease()).toEqual(expected);
					for (const entry of model) {
						if (entry.status === "leased") entry.status = "pending";
					}
					if (project(undefined, "committing").length === 0) activeLease = undefined;
					break;
				}
				case 6:
					inbox.reset();
					for (const entry of model) {
						if (entry.status !== "terminal") entry.status = "terminal";
					}
					activeLease = undefined;
					break;
			}

			expect(inbox.list()).toEqual(project());
			expect(inbox.hasPending()).toBe(project().length > 0);
			for (const projectedKind of kinds) {
				expect(inbox.list(projectedKind)).toEqual(project(projectedKind));
				expect(inbox.select(projectedKind, "all")).toEqual(project(projectedKind, "pending"));
				expect(inbox.select(projectedKind, "one-at-a-time")).toEqual(project(projectedKind, "pending").slice(0, 1));
			}
			if (activeLease) expect(activeLease.deliveries).toEqual(project(undefined, "leased"));
		}
	});
});
