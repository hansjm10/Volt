import { describe, expect, it } from "vitest";
import { DeliveryInbox } from "../src/delivery-inbox.ts";

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
		expect(inbox.hasPending("steer")).toBe(true);
		expect(inbox.hasPending("followUp")).toBe(true);
	});

	it("rejects duplicate generated IDs without mutating the queue", () => {
		const ids = ["duplicate", "duplicate", "next"];
		const inbox = new DeliveryInbox<"steer" | "followUp", string>(() => ids.shift() ?? "unexpected");
		const first = inbox.enqueue("steer", ["first"]);

		expect(() => inbox.enqueue("followUp", ["rejected"])).toThrow(
			"Delivery inbox generated duplicate delivery ID: duplicate",
		);
		const second = inbox.enqueue("followUp", ["second"]);

		expect(second.sequence).toBe(1);
		expect(inbox.list()).toEqual([first, second]);
	});

	it("rejects duplicate, stale, and foreign lease selections without mutating the queue", () => {
		const inbox = createInbox();
		const pending = inbox.enqueue("steer", ["pending"]);
		const foreignInbox = new DeliveryInbox<"steer" | "followUp", string>(() => pending.deliveryId);
		const foreign = foreignInbox.enqueue("steer", ["foreign"]);

		expect(() => inbox.lease([foreign])).toThrow(`Delivery is not pending in this inbox: ${pending.deliveryId}`);
		expect(() => inbox.lease([pending, pending])).toThrow(
			`Delivery selection contains duplicate ID: ${pending.deliveryId}`,
		);

		const stale = inbox.enqueue("followUp", ["stale"]);
		expect(inbox.revoke("followUp")).toEqual([stale]);
		expect(() => inbox.lease([stale])).toThrow(`Delivery is not pending in this inbox: ${stale.deliveryId}`);
		expect(inbox.list()).toEqual([pending]);
		expect(inbox.lease([pending]).deliveries).toEqual([pending]);
	});

	it("rejects overlapping leases and restores them ahead of later arrivals", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));
		const second = inbox.enqueue("steer", ["second"]);

		expect(() => inbox.lease(inbox.select("steer", "one-at-a-time"))).toThrow(
			"Delivery inbox already has an active revocable lease",
		);
		expect(inbox.rollbackActiveLease()).toEqual([first]);
		expect(inbox.list()).toEqual([first, second]);
		expect(inbox.rollbackActiveLease()).toEqual([]);
		expect(lease.owns(first.deliveryId)).toBe(false);
		expect(lease.begin(first.deliveryId)).toBeUndefined();
		expect(lease.revoke("steer")).toEqual([]);
		expect(lease.rollback()).toEqual([]);
	});

	it("retires an exhausted lease before leasing later arrivals", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const firstLease = inbox.lease([first]);

		expect(firstLease.begin(first.deliveryId)).toBe(first);
		expect(firstLease.owns(first.deliveryId)).toBe(true);

		const second = inbox.enqueue("steer", ["second"]);
		const secondLease = inbox.lease([second]);

		expect(firstLease.owns(first.deliveryId)).toBe(false);
		expect(firstLease.rollback()).toEqual([]);
		expect(secondLease.owns(second.deliveryId)).toBe(true);
		expect(secondLease.begin(second.deliveryId)).toBe(second);
		expect(inbox.list()).toEqual([]);
	});

	it("invalidates retained leases on reset and remains reusable", () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["discarded"]);
		const lease = inbox.lease([delivery]);

		inbox.reset();

		expect(inbox.list()).toEqual([]);
		expect(inbox.hasPending()).toBe(false);
		expect(lease.owns(delivery.deliveryId)).toBe(false);
		expect(lease.begin(delivery.deliveryId)).toBeUndefined();
		expect(lease.revoke("steer")).toEqual([]);
		expect(lease.rollback()).toEqual([]);

		const next = inbox.enqueue("followUp", ["next"]);
		expect(next.sequence).toBe(1);
		expect(inbox.list()).toEqual([next]);
	});

	it("keeps an emitting delivery terminal when reset runs during commit", () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["committed"]);
		inbox.enqueue("followUp", ["discarded"]);
		const lease = inbox.lease([delivery]);

		expect(
			lease.begin(delivery.deliveryId, () => {
				inbox.reset();
			}),
		).toBe(delivery);
		expect(inbox.list()).toEqual([]);
		expect(lease.owns(delivery.deliveryId)).toBe(false);
		expect(lease.begin(delivery.deliveryId)).toBeUndefined();
	});

	it("protects an emitting delivery from reentrant same-kind revocation", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(
			lease.begin(first.deliveryId, () => {
				expect(inbox.revoke("steer")).toEqual([second]);
			}),
		).toBe(first);
		expect(inbox.list()).toEqual([]);
		expect(lease.rollback()).toEqual([]);
	});

	it("restores only unbegun deliveries when rollback runs during commit", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(
			lease.begin(first.deliveryId, () => {
				expect(inbox.rollbackActiveLease()).toEqual([second]);
			}),
		).toBe(first);
		expect(inbox.list()).toEqual([second]);
		expect(lease.owns(first.deliveryId)).toBe(false);
		expect(lease.begin(second.deliveryId)).toBeUndefined();
	});

	it("keeps mixed all-mode begin, revoke, and rollback states terminal", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const followUp = inbox.enqueue("followUp", ["later"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(lease.begin(first.deliveryId)).toBe(first);
		expect(inbox.revoke("steer")).toEqual([second]);
		expect(lease.begin(second.deliveryId)).toBeUndefined();
		expect(lease.rollback()).toEqual([]);
		expect(inbox.list()).toEqual([followUp]);
	});

	it("leases FIFO selections without removing them from the pending projection", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		inbox.enqueue("followUp", ["later"]);

		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(lease.deliveries.map((delivery) => delivery.deliveryId)).toEqual([first.deliveryId]);
		expect(inbox.list().map((delivery) => delivery.deliveryId)).toEqual([
			first.deliveryId,
			second.deliveryId,
			"delivery-2",
		]);
	});

	it("begins synchronously and rolls back only deliveries that never began", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(lease.begin(first.deliveryId)).toBe(first);
		expect(lease.begin(first.deliveryId)).toBeUndefined();
		expect(lease.rollback()).toEqual([second]);
		expect(inbox.list()).toEqual([second]);
	});

	it("restores a delivery when its synchronous commit fails", () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["retry me"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(() =>
			lease.begin(delivery.deliveryId, () => {
				throw new Error("commit failed");
			}),
		).toThrow("commit failed");
		expect(lease.rollback()).toEqual([delivery]);
		expect(inbox.list()).toEqual([delivery]);
	});

	it("returns exact pending and leased revocations in admission order", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const followUp = inbox.enqueue("followUp", ["later"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(inbox.revoke("steer")).toEqual([first, second]);
		expect(lease.begin(first.deliveryId)).toBeUndefined();
		expect(inbox.list()).toEqual([followUp]);
	});

	it("never revokes or restores a delivery after begin", () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("followUp", ["committed"]);
		const lease = inbox.lease(inbox.select("followUp", "all"));

		expect(lease.begin(delivery.deliveryId)).toBe(delivery);
		expect(inbox.revoke("followUp")).toEqual([]);
		expect(lease.rollback()).toEqual([]);
		expect(inbox.hasPending()).toBe(false);
	});
});
