import { describe, expect, expectTypeOf, it } from "vitest";
import type { JsonCompatibleInput, JsonObject, JsonValue } from "../src/index.ts";

interface RendererDetails {
	path: string;
	stats?: {
		lines: number;
	};
}

describe("JSON data types", () => {
	it("preserves concrete renderer detail shapes", () => {
		const details: JsonCompatibleInput<RendererDetails> = {
			path: "README.md",
			stats: { lines: 12 },
		};
		expectTypeOf(details).toMatchTypeOf<RendererDetails>();
		expect(details.stats?.lines).toBe(12);

		const object: JsonObject = { details: { ...details } };
		const value: JsonValue = [object, null, true, "text", 1];
		expect(value).toHaveLength(5);
	});

	it("rejects statically known non-JSON input shapes", () => {
		// @ts-expect-error Map is not JSON data
		const map: JsonCompatibleInput<{ value: Map<string, string> }> = { value: new Map() };
		// @ts-expect-error functions are not JSON data
		const callback: JsonCompatibleInput<{ value: () => void }> = { value: () => undefined };
		// @ts-expect-error bigint is not JSON data
		const bigint: JsonCompatibleInput<{ value: bigint }> = { value: 1n };
		// @ts-expect-error Date is not JSON data
		const date: JsonCompatibleInput<{ value: Date }> = { value: new Date(0) };
		expect([map, callback, bigint, date]).toHaveLength(4);
	});
});
