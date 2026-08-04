import { describe, expect, it } from "vitest";
import { DeliveryInbox } from "../src/delivery-inbox.ts";

describe("DeliveryInbox", () => {
	function createInbox(): DeliveryInbox<"steer" | "followUp", string> {
		let nextId = 0;
		return new DeliveryInbox(() => `delivery-${nextId++}`);
	}

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
