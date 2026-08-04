import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("rejects iteration and result after draining queued events on failure", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const failure = new Error("stream failed");
		stream.push("queued");
		stream.fail(failure);

		const events: string[] = [];
		await expect(
			(async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})(),
		).rejects.toBe(failure);
		expect(events).toEqual(["queued"]);
		await expect(stream.result()).rejects.toBe(failure);
	});

	it("rejects an iterator already waiting for the next event", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const iterator = stream[Symbol.asyncIterator]();
		const next = iterator.next();
		const failure = new Error("stream failed");
		stream.fail(failure);

		await expect(next).rejects.toBe(failure);
	});
});
