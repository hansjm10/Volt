import { describe, expect, it } from "vitest";
import { cloneCanonicalData } from "../src/core/canonical-data.ts";

describe("canonical JSON data", () => {
	it("owns valid JSON trees without losing __proto__ data", () => {
		const source: Record<string, unknown> = { nested: { values: [null, true, "text", 42] } };
		Object.defineProperty(source, "__proto__", {
			value: { retained: true },
			enumerable: true,
			writable: true,
			configurable: true,
		});

		const clone = cloneCanonicalData(source, "Example");
		(source.nested as { values: unknown[] }).values[3] = 7;

		expect(clone.nested).toEqual({ values: [null, true, "text", 42] });
		expect(clone.__proto__).toEqual({ retained: true });
		expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
		expect(Object.hasOwn(clone, "__proto__")).toBe(true);
	});

	it.each([
		["undefined", { value: undefined }, "$.value: undefined is not permitted; omit optional properties"],
		["bigint", { value: 1n }, "$.value: bigint is not permitted"],
		["symbol", { value: Symbol("value") }, "$.value: symbols are not permitted"],
		["function", { value: () => undefined }, "$.value: functions are not permitted"],
		["non-finite number", { value: Number.POSITIVE_INFINITY }, "$.value: numbers must be finite"],
		["negative zero", { value: -0 }, "$.value: negative zero does not round-trip through JSON"],
		["Map", { value: new Map([["key", "value"]]) }, "$.value: objects must use the ordinary Object prototype"],
		["Set", { value: new Set(["value"]) }, "$.value: objects must use the ordinary Object prototype"],
		["Date", { value: new Date(0) }, "$.value: objects must use the ordinary Object prototype"],
		["Error", { value: new Error("no") }, "$.value: objects must use the ordinary Object prototype"],
		["RegExp", { value: /no/ }, "$.value: objects must use the ordinary Object prototype"],
		["ArrayBuffer", { value: new ArrayBuffer(1) }, "$.value: objects must use the ordinary Object prototype"],
		["typed array", { value: new Uint8Array([1]) }, "$.value: objects must use the ordinary Object prototype"],
		["Buffer", { value: Buffer.from([1]) }, "$.value: objects must use the ordinary Object prototype"],
		[
			"DataView",
			{ value: new DataView(new ArrayBuffer(1)) },
			"$.value: objects must use the ordinary Object prototype",
		],
		[
			"SharedArrayBuffer",
			{ value: new SharedArrayBuffer(1) },
			"$.value: objects must use the ordinary Object prototype",
		],
	])("rejects %s with a path-specific error", (_name, value, reason) => {
		expect(() => cloneCanonicalData(value, "Example")).toThrow(
			`Example must contain only JSON-compatible data; invalid value at ${reason}`,
		);
	});

	it("rejects cycles, sparse arrays, accessors, symbols, and unusual prototypes", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => cloneCanonicalData(cyclic, "Cycle")).toThrow(
			"Cycle must contain only JSON-compatible data; invalid value at $.self: cyclic references are not permitted",
		);

		const sparse: unknown[] = [];
		sparse.length = 2;
		expect(() => cloneCanonicalData(sparse, "Sparse")).toThrow(
			"Sparse must contain only JSON-compatible data; invalid value at $[0]: sparse arrays are not permitted",
		);

		const accessor = Object.defineProperty({}, "value", { get: () => 1, enumerable: true });
		expect(() => cloneCanonicalData(accessor, "Accessor")).toThrow(
			"Accessor must contain only JSON-compatible data; invalid value at $.value: accessor properties are not permitted",
		);

		const nonEnumerable = Object.defineProperty({}, "value", { value: 1 });
		expect(() => cloneCanonicalData(nonEnumerable, "Non-enumerable")).toThrow(
			"Non-enumerable must contain only JSON-compatible data; invalid value at $.value: non-enumerable properties are not permitted",
		);

		const extraArrayProperty = Object.assign([1], { label: "value" });
		expect(() => cloneCanonicalData(extraArrayProperty, "Array property")).toThrow(
			"Array property must contain only JSON-compatible data; invalid value at $.label: extra array properties are not permitted",
		);

		const symbolKeyed = { [Symbol("key")]: "value" };
		expect(() => cloneCanonicalData(symbolKeyed, "Symbol key")).toThrow(
			"Symbol key must contain only JSON-compatible data; invalid value at $: symbol-keyed properties are not permitted",
		);

		expect(() => cloneCanonicalData(Object.create(null), "Prototype")).toThrow(
			"Prototype must contain only JSON-compatible data; invalid value at $: objects must use the ordinary Object prototype",
		);
	});
});
