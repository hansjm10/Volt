import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("settles every waiting iterator when a completion event arrives", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const firstIterator = stream[Symbol.asyncIterator]();
		const secondIterator = stream[Symbol.asyncIterator]();
		const firstNext = firstIterator.next();
		const secondNext = secondIterator.next();

		stream.push("done");

		await expect(firstNext).resolves.toEqual({ value: "done", done: false });
		await expect(secondNext).resolves.toEqual({ value: undefined, done: true });
		await expect(firstIterator.next()).resolves.toEqual({ value: undefined, done: true });
		await expect(stream.result()).resolves.toBe("done");
	});

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
