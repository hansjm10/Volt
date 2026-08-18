import { describe, expect, it } from "vitest";
import { DeliveryInbox } from "../src/delivery-inbox.ts";

describe("DeliveryInbox", () => {
	function createInbox(): DeliveryInbox<"steer" | "followUp", string> {
		let nextId = 0;
		return new DeliveryInbox(() => `delivery-${nextId++}`);
	}

	it("owns admitted messages, sequence, and epoch", () => {
		const inbox = createInbox();
		const messages = ["first"];
		const first = inbox.enqueue("steer", messages);
		const second = inbox.enqueue("steer", ["second"]);
		messages.push("mutated");

		expect(first).toMatchObject({ messages: ["first"], sequence: 0, epoch: 0 });
		expect(second).toMatchObject({ sequence: 1, epoch: 0 });
		expect(inbox.select("steer", "one-at-a-time")).toEqual([first]);
		expect(inbox.select("steer", "all")).toEqual([first, second]);
	});

	it("rejects duplicate, foreign, and non-FIFO selections", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const foreignInbox = new DeliveryInbox<"steer" | "followUp", string>(() => first.deliveryId);
		const foreign = foreignInbox.enqueue("steer", ["foreign"]);

		expect(() => inbox.lease([foreign])).toThrow(`Delivery is not pending in this inbox: ${first.deliveryId}`);
		expect(() => inbox.lease([first, first])).toThrow("Delivery selection contains duplicate ID");
		expect(() => inbox.lease([second])).toThrow("Delivery selection violates FIFO order");
	});

	it("keeps preparation revocable and rejects late preparation completion", () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["first"]);
		const lease = inbox.lease([delivery]);
		const attempt = lease.prepare(delivery.deliveryId);
		expect(attempt).toMatchObject({ delivery, attemptId: expect.any(String) });

		expect(inbox.revoke("steer")).toEqual([delivery]);
		expect(lease.completePreparation(delivery.deliveryId, attempt!.attemptId, "prepared")).toBeUndefined();
		expect(lease.beginCommit(delivery.deliveryId, attempt!.attemptId)).toBeUndefined();
		expect(inbox.list()).toEqual([]);
	});

	it("crosses the revocation cutoff only after preparation is ready", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));
		const attempt = lease.prepare(first.deliveryId)!;

		expect(lease.beginCommit(first.deliveryId, attempt.attemptId)).toBeUndefined();
		expect(lease.completePreparation(first.deliveryId, attempt.attemptId, "prepared")).toBe(first);
		expect(lease.beginCommit(first.deliveryId, attempt.attemptId)).toBe(first);
		expect(inbox.revoke("steer")).toEqual([second]);
		expect(lease.rollback()).toEqual([]);
		expect(lease.settleCommit(first.deliveryId, attempt.attemptId, "committed")).toBe(first);
		expect(inbox.list()).toEqual([]);
	});

	it("restores an explicitly retained attempt with stable identity and FIFO order", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));
		const firstAttempt = lease.prepare(first.deliveryId)!;
		expect(lease.completePreparation(first.deliveryId, firstAttempt.attemptId, "prepared")).toBe(first);
		expect(lease.beginCommit(first.deliveryId, firstAttempt.attemptId)).toBe(first);
		expect(lease.rollback()).toEqual([second]);

		expect(lease.settleCommit(first.deliveryId, firstAttempt.attemptId, "retained")).toBe(first);
		expect(inbox.list()).toEqual([first]);
		expect(lease.settleRollback(second.deliveryId, "retained")).toBe(second);
		expect(inbox.list()).toEqual([first, second]);
		const retry = inbox.lease([first]).prepare(first.deliveryId)!;
		expect(retry.attemptId).not.toBe(firstAttempt.attemptId);
	});

	it("preserves a committed prefix and restores a retained current delivery plus suffix", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const third = inbox.enqueue("steer", ["third"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		const firstAttempt = lease.prepare(first.deliveryId)!;
		lease.completePreparation(first.deliveryId, firstAttempt.attemptId, "prepared");
		lease.beginCommit(first.deliveryId, firstAttempt.attemptId);
		lease.settleCommit(first.deliveryId, firstAttempt.attemptId, "committed");
		const secondAttempt = lease.prepare(second.deliveryId)!;
		lease.completePreparation(second.deliveryId, secondAttempt.attemptId, "prepared");
		lease.beginCommit(second.deliveryId, secondAttempt.attemptId);
		lease.settleCommit(second.deliveryId, secondAttempt.attemptId, "retained");
		expect(lease.rollback()).toEqual([third]);

		expect(inbox.list()).toEqual([second]);
		expect(lease.settleRollback(third.deliveryId, "retained")).toBe(third);
		expect(inbox.list()).toEqual([second, third]);
	});

	it("never restores terminal failures or stale generations", () => {
		const inbox = createInbox();
		const failed = inbox.enqueue("steer", ["failed"]);
		const failedLease = inbox.lease([failed]);
		const failedAttempt = failedLease.prepare(failed.deliveryId)!;
		expect(failedLease.completePreparation(failed.deliveryId, failedAttempt.attemptId, "terminally_failed")).toBe(
			failed,
		);
		expect(inbox.list()).toEqual([]);

		const stale = inbox.enqueue("steer", ["stale"]);
		const staleLease = inbox.lease([stale]);
		const staleAttempt = staleLease.prepare(stale.deliveryId)!;
		staleLease.completePreparation(stale.deliveryId, staleAttempt.attemptId, "prepared");
		staleLease.beginCommit(stale.deliveryId, staleAttempt.attemptId);
		inbox.reset();
		expect(staleLease.settleCommit(stale.deliveryId, staleAttempt.attemptId, "retained")).toBe(stale);
		expect(inbox.list()).toEqual([]);
		expect(inbox.enqueue("followUp", ["new"])).toMatchObject({ epoch: 1 });
	});
});
