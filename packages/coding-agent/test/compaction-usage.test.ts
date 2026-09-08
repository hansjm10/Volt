import { describe, expect, test } from "vitest";
import { formatCompactionUsage } from "../src/modes/interactive/compaction-usage.ts";

const request = {
	strategy: "native",
	attempt: 1,
	provider: "test-provider",
	model: "test-model",
	stopReason: "stop",
	usage: { input: 1000, output: 30000, cacheRead: 68000, cacheWrite: 1000, totalTokens: 100000 },
};

describe("formatCompactionUsage", () => {
	test("includes cache writes in prompt tokens and excludes output from the hit rate", () => {
		expect(formatCompactionUsage({ requests: [request] })).toEqual([
			`Native compaction request 1 (stop): ${(68000).toLocaleString()} cached / ${(70000).toLocaleString()} prompt tokens — 97.1% hit`,
		]);
	});

	test("reports an actual zero hit rate when nonzero prompt usage is available", () => {
		expect(
			formatCompactionUsage({
				requests: [
					{
						...request,
						strategy: "chunked",
						attempt: 4,
						usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 20, totalTokens: 130 },
					},
				],
			}),
		).toEqual(["Chunked compaction request 4 (stop): 0 cached / 120 prompt tokens — 0.0% hit"]);
	});

	test.each([0, 100])("treats zero prompt tokens as unavailable even with %i output tokens", (output) => {
		expect(
			formatCompactionUsage({
				requests: [
					{
						...request,
						usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output },
					},
				],
			}),
		).toEqual(["Native compaction request 1 (stop): cache usage unavailable"]);
	});

	test("does not infer a terminal response from usage alone", () => {
		expect(formatCompactionUsage({ requests: [{ ...request, stopReason: undefined }] })).toEqual([
			"Native compaction request 1 (no terminal response): cache usage unavailable",
		]);
	});

	test.each(["stop", "length", "toolUse", "error", "aborted"])("retains the %s terminal reason", (stopReason) => {
		expect(formatCompactionUsage({ requests: [{ ...request, stopReason, usage: undefined }] })).toEqual([
			`Native compaction request 1 (${stopReason}): cache usage unavailable`,
		]);
	});

	test.each([undefined, null, false, 42, "details", [], {}, { requests: null }, { requests: {} }, { requests: [] }])(
		"ignores absent or malformed request collections: %j",
		(details) => {
			expect(formatCompactionUsage(details)).toEqual([]);
		},
	);

	test.each([
		null,
		false,
		"request",
		[],
		{},
		{ ...request, strategy: "unknown" },
		{ ...request, attempt: 0 },
		{ ...request, attempt: -1 },
		{ ...request, attempt: 1.5 },
		{ ...request, attempt: "1" },
		{ ...request, attempt: Number.MAX_SAFE_INTEGER + 1 },
		{ ...request, provider: null },
		{ ...request, provider: " " },
		{ ...request, model: undefined },
		{ ...request, model: "" },
		{ ...request, stopReason: null },
		{ ...request, stopReason: "\u001b[31mstop\nforged statistics" },
	])("ignores malformed request identities without dropping later valid records: %j", (malformed) => {
		expect(formatCompactionUsage({ requests: [malformed, request] })).toEqual(
			formatCompactionUsage({ requests: [request] }),
		);
	});

	test.each([undefined, null, "usage", [], {}, { input: 10, cacheRead: 10, cacheWrite: 0 }])(
		"marks missing or malformed usage as unavailable: %j",
		(usage) => {
			expect(formatCompactionUsage({ requests: [{ ...request, usage }] })).toEqual([
				"Native compaction request 1 (stop): cache usage unavailable",
			]);
		},
	);

	test.each(["input", "output", "cacheRead", "cacheWrite", "totalTokens"])(
		"rejects invalid %s counts rather than calculating fabricated statistics",
		(field) => {
			for (const value of [undefined, null, "1000", -1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				expect(
					formatCompactionUsage({ requests: [{ ...request, usage: { ...request.usage, [field]: value } }] }),
				).toEqual(["Native compaction request 1 (stop): cache usage unavailable"]);
			}
		},
	);

	test("does not calculate a rate from an unsafe prompt-token sum", () => {
		expect(
			formatCompactionUsage({
				requests: [{ ...request, usage: { ...request.usage, cacheRead: Number.MAX_SAFE_INTEGER } }],
			}),
		).toEqual(["Native compaction request 1 (stop): cache usage unavailable"]);
	});
});
