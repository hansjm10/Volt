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
		expect(inbox.hasPending("steer")).toBe(true);
		expect(inbox.hasPending("followUp")).toBe(true);
	});

	it("generates unique default delivery IDs", () => {
		const inbox = new DeliveryInbox<"steer" | "followUp", string>();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("followUp", ["second"]);

		expect(first.deliveryId).not.toBe("");
		expect(second.deliveryId).not.toBe(first.deliveryId);
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

	it("rejects non-FIFO selections while allowing mixed-kind policy order", () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const followUp = inbox.enqueue("followUp", ["later"]);

		expect(() => inbox.lease([second])).toThrow(
			`Delivery selection violates FIFO order for steer: expected ${first.deliveryId} before ${second.deliveryId}`,
		);
		expect(() => inbox.lease([second, first])).toThrow(
			`Delivery selection violates FIFO order for steer: expected ${first.deliveryId} before ${second.deliveryId}`,
		);
		expect(inbox.list()).toEqual([first, second, followUp]);

		const lease = inbox.lease([followUp, first]);
		expect(lease.deliveries).toEqual([first, followUp]);
		expect(lease.rollback()).toEqual([first, followUp]);
		expect(inbox.list()).toEqual([first, second, followUp]);
	});

	it("rejects overlapping leases and restores them ahead of later arrivals", async () => {
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
		expect(lease.deliveries).toEqual([]);
		expect(lease.owns(first.deliveryId)).toBe(false);
		expect(await lease.begin(first.deliveryId)).toBeUndefined();
		expect(lease.rollback()).toEqual([]);
	});

	it("retires an exhausted lease before leasing later arrivals", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const firstLease = inbox.lease([first]);

		expect(await firstLease.begin(first.deliveryId)).toBe(first);
		expect(firstLease.owns(first.deliveryId)).toBe(true);

		const second = inbox.enqueue("steer", ["second"]);
		const secondLease = inbox.lease([second]);

		expect(firstLease.owns(first.deliveryId)).toBe(false);
		expect(firstLease.rollback()).toEqual([]);
		expect(secondLease.owns(second.deliveryId)).toBe(true);
		expect(await secondLease.begin(second.deliveryId)).toBe(second);
		expect(inbox.list()).toEqual([]);
	});

	it("invalidates retained leases on reset and remains reusable", async () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["discarded"]);
		const lease = inbox.lease([delivery]);

		inbox.reset();

		expect(inbox.list()).toEqual([]);
		expect(inbox.hasPending()).toBe(false);
		expect(lease.deliveries).toEqual([]);
		expect(lease.owns(delivery.deliveryId)).toBe(false);
		expect(await lease.begin(delivery.deliveryId)).toBeUndefined();
		expect(lease.rollback()).toEqual([]);

		const next = inbox.enqueue("followUp", ["next"]);
		expect(next.sequence).toBe(1);
		expect(inbox.list()).toEqual([next]);
	});

	it("keeps a committing delivery terminal when reset runs during commit", async () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["committed"]);
		inbox.enqueue("followUp", ["discarded"]);
		const lease = inbox.lease([delivery]);

		expect(
			await lease.begin(delivery.deliveryId, () => {
				inbox.reset();
			}),
		).toBe(delivery);
		expect(inbox.list()).toEqual([]);
		expect(lease.owns(delivery.deliveryId)).toBe(false);
		expect(await lease.begin(delivery.deliveryId)).toBeUndefined();
	});

	it("does not restore a committing delivery when reset precedes commit failure", async () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["discarded"]);
		const lease = inbox.lease([delivery]);

		await expect(
			lease.begin(delivery.deliveryId, () => {
				inbox.reset();
				throw new Error("commit failed");
			}),
		).rejects.toThrow("commit failed");
		expect(inbox.list()).toEqual([]);
		expect(lease.deliveries).toEqual([]);
		expect(lease.owns(delivery.deliveryId)).toBe(false);
	});

	it("protects a committing delivery from reentrant same-kind revocation", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(
			await lease.begin(first.deliveryId, () => {
				expect(inbox.revoke("steer")).toEqual([second]);
			}),
		).toBe(first);
		expect(inbox.list()).toEqual([]);
		expect(lease.rollback()).toEqual([]);
	});

	it("restores only unbegun deliveries when rollback runs during commit", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(
			await lease.begin(first.deliveryId, () => {
				expect(inbox.rollbackActiveLease()).toEqual([second]);
			}),
		).toBe(first);
		expect(inbox.list()).toEqual([second]);
		expect(lease.owns(first.deliveryId)).toBe(false);
		expect(await lease.begin(second.deliveryId)).toBeUndefined();
	});

	it("restores a failed committing delivery after reentrant rollback", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		await expect(
			lease.begin(first.deliveryId, () => {
				expect(inbox.rollbackActiveLease()).toEqual([second]);
				throw new Error("commit failed");
			}),
		).rejects.toThrow("commit failed");
		expect(inbox.list()).toEqual([first, second]);
		expect(lease.deliveries).toEqual([]);
		expect(lease.owns(first.deliveryId)).toBe(false);
	});

	it("lets reset supersede a failed begin after reentrant rollback", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		await expect(
			lease.begin(first.deliveryId, () => {
				expect(inbox.rollbackActiveLease()).toEqual([second]);
				inbox.reset();
				throw new Error("commit failed");
			}),
		).rejects.toThrow("commit failed");
		expect(inbox.list()).toEqual([]);
		expect(lease.deliveries).toEqual([]);
		expect(lease.owns(first.deliveryId)).toBe(false);
	});

	it("keeps mixed all-mode begin, revoke, and rollback states terminal", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const followUp = inbox.enqueue("followUp", ["later"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(await lease.begin(first.deliveryId)).toBe(first);
		expect(inbox.revoke("steer")).toEqual([second]);
		expect(await lease.begin(second.deliveryId)).toBeUndefined();
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

	it("commits and rolls back only deliveries whose commit never began", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const lease = inbox.lease(inbox.select("steer", "all"));

		expect(await lease.begin(first.deliveryId)).toBe(first);
		expect(await lease.begin(first.deliveryId)).toBeUndefined();
		expect(lease.rollback()).toEqual([second]);
		expect(inbox.list()).toEqual([second]);
	});

	it("restores a delivery when its commit fails", async () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("steer", ["retry me"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		await expect(
			lease.begin(delivery.deliveryId, () => {
				throw new Error("commit failed");
			}),
		).rejects.toThrow("commit failed");
		expect(lease.rollback()).toEqual([delivery]);
		expect(inbox.list()).toEqual([delivery]);
	});

	it("returns exact pending and leased revocations in admission order", async () => {
		const inbox = createInbox();
		const first = inbox.enqueue("steer", ["first"]);
		const second = inbox.enqueue("steer", ["second"]);
		const followUp = inbox.enqueue("followUp", ["later"]);
		const lease = inbox.lease(inbox.select("steer", "one-at-a-time"));

		expect(inbox.revoke("steer")).toEqual([first, second]);
		expect(await lease.begin(first.deliveryId)).toBeUndefined();
		expect(inbox.list()).toEqual([followUp]);
	});

	it("never revokes or restores a delivery after begin", async () => {
		const inbox = createInbox();
		const delivery = inbox.enqueue("followUp", ["committed"]);
		const lease = inbox.lease(inbox.select("followUp", "all"));

		expect(await lease.begin(delivery.deliveryId)).toBe(delivery);
		expect(inbox.revoke("followUp")).toEqual([]);
		expect(lease.rollback()).toEqual([]);
		expect(inbox.hasPending()).toBe(false);
	});

	it("preserves queue and lease invariants across deterministic operation sequences", async () => {
		type Kind = "steer" | "followUp";
		type Status = "pending" | "leased" | "terminal";
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

		function project(kind?: Kind, status?: Status): InboxDelivery<Kind, string>[] {
			return model
				.filter(
					(entry) =>
						(kind === undefined || entry.delivery.kind === kind) &&
						(status === undefined ? entry.status !== "terminal" : entry.status === status),
				)
				.map((entry) => entry.delivery)
				.sort((left, right) => left.sequence - right.sequence);
		}

		for (let step = 0; step < 400; step++) {
			const operation = step < 2 ? 0 : nextRandom(8);
			const kind = kinds[nextRandom(kinds.length)];

			switch (operation) {
				case 0:
				case 7: {
					const delivery = inbox.enqueue(kind, [`message-${step}`]);
					model.push({ delivery, status: "pending" });
					break;
				}
				case 1: {
					if (project(undefined, "leased").length > 0) break;
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
					const delivery = leased[nextRandom(leased.length)];
					expect(await activeLease.begin(delivery.deliveryId)).toBe(delivery);
					const entry = model.find((candidate) => candidate.delivery === delivery);
					if (entry) entry.status = "terminal";
					break;
				}
				case 3: {
					const leased = project(undefined, "leased");
					if (!activeLease || leased.length === 0) break;
					const delivery = leased[nextRandom(leased.length)];
					await expect(
						activeLease.begin(delivery.deliveryId, () => {
							throw new Error("modeled commit failure");
						}),
					).rejects.toThrow("modeled commit failure");
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
					break;
				}
				case 5: {
					const expected = project(undefined, "leased");
					expect(inbox.rollbackActiveLease()).toEqual(expected);
					for (const entry of model) {
						if (entry.status === "leased") entry.status = "pending";
					}
					activeLease = undefined;
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
				expect(inbox.hasPending(projectedKind)).toBe(project(projectedKind).length > 0);
				expect(inbox.select(projectedKind, "all")).toEqual(project(projectedKind, "pending"));
				expect(inbox.select(projectedKind, "one-at-a-time")).toEqual(project(projectedKind, "pending").slice(0, 1));
			}
			if (activeLease) expect(activeLease.deliveries).toEqual(project(undefined, "leased"));
		}
	});
});
