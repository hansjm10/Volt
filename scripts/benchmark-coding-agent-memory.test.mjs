import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
	MemoryBenchmarkCleanup,
	aggregateProcessTree,
	compareMemoryBenchmarkReports,
	parseMemoryBenchmarkArgs,
	parsePosixProcessTable,
	parseWindowsProcessTable,
	summarizeMemoryBenchmarkValues,
	validateMemorySnapshotResponse,
} from "./benchmark-coding-agent-memory.mjs";

function summary(median) {
	return { min: median, median, average: median, max: median };
}

function report(options = {}) {
	const metrics = options.metrics ?? {
		"memory.rssBytes": summary(100),
		"processTree.aggregateRssBytes": summary(120),
		"activeResources.PipeWrap": summary(1),
	};
	return {
		schemaVersion: 1,
		kind: "volt-coding-agent-memory",
		runtime: {
			node: options.node ?? "24.1.0",
			platform: options.platform ?? "linux",
			arch: options.arch ?? "x64",
		},
		parameters: {
			scenarios: ["daemon-idle"],
			workload: options.workload ?? { schemaVersion: 1, settleMs: 250 },
		},
		summaries: { "daemon-idle": { idle: metrics } },
	};
}

function validSnapshotResponse(overrides = {}) {
	return {
		version: 1,
		type: "snapshot_result",
		id: "snapshot-1",
		ok: true,
		snapshot: {
			pid: 123,
			memory: {
				rssBytes: 100,
				heapTotalBytes: 80,
				heapUsedBytes: 40,
				externalBytes: 10,
				arrayBuffersBytes: 5,
			},
			v8: { totalHeapSizeBytes: 80, nativeContexts: 1 },
			activeResources: { PipeWrap: 2 },
			timing: { settleRequestedMs: 10, settleActualMs: 11, gcMs: 2, captureMs: 1, totalMs: 14 },
			...overrides,
		},
	};
}

describe("memory benchmark argument parsing", () => {
	test("uses repeatable default sampling and all canonical scenarios", () => {
		const parsed = parseMemoryBenchmarkArgs([], "/repo");
		assert.equal(parsed.runs, 3);
		assert.equal(parsed.warmup, 1);
		assert.equal(parsed.settleMs, 250);
		assert.equal(parsed.scenarios.length, 8);
	});

	test("quick selects one measured run and canonicalizes selected scenarios", () => {
		const parsed = parseMemoryBenchmarkArgs(
			["--quick", "--scenario", "lsp,daemon-idle", "--scenario", "lsp", "--output", "report.json"],
			"/repo",
		);
		assert.equal(parsed.runs, 1);
		assert.equal(parsed.warmup, 0);
		assert.deepEqual(parsed.scenarios, ["daemon-idle", "lsp"]);
		assert.equal(parsed.output, resolve("/repo", "report.json"));
	});

	test("rejects malformed and conflicting values", () => {
		assert.throws(() => parseMemoryBenchmarkArgs(["--runs", "1x"]), /Invalid --runs/);
		assert.throws(() => parseMemoryBenchmarkArgs(["--runs", "0"]), /Invalid --runs/);
		assert.throws(() => parseMemoryBenchmarkArgs(["--quick", "--warmup", "0"]), /cannot be combined/);
		assert.throws(() => parseMemoryBenchmarkArgs(["--scenario", "missing"]), /Invalid --scenario/);
		assert.throws(() => parseMemoryBenchmarkArgs(["--settle-ms"]), /Missing value/);
		assert.throws(() => parseMemoryBenchmarkArgs(["--unknown"]), /Unknown option/);
	});
});

describe("memory benchmark statistics", () => {
	test("computes min, median, average, and max without mutating input", () => {
		const values = [9, 1, 5, 3];
		assert.deepEqual(summarizeMemoryBenchmarkValues(values), { min: 1, median: 4, average: 4.5, max: 9 });
		assert.deepEqual(values, [9, 1, 5, 3]);
	});

	test("rejects empty and non-finite samples", () => {
		assert.throws(() => summarizeMemoryBenchmarkValues([]), /finite numbers/);
		assert.throws(() => summarizeMemoryBenchmarkValues([1, Number.NaN]), /finite numbers/);
	});
});

describe("memory benchmark snapshot protocol", () => {
	test("accepts a complete settled snapshot", () => {
		const response = validSnapshotResponse();
		assert.equal(validateMemorySnapshotResponse(response, "snapshot-1"), response.snapshot);
	});

	test("rejects identity, error, and metric violations", () => {
		assert.throws(() => validateMemorySnapshotResponse(validSnapshotResponse(), "other"), /Unexpected.*id/);
		assert.throws(
			() => validateMemorySnapshotResponse({ ...validSnapshotResponse(), ok: false, error: "gc missing" }, "snapshot-1"),
			/Snapshot failed: gc missing/,
		);
		assert.throws(
			() =>
				validateMemorySnapshotResponse(
					validSnapshotResponse({ memory: { ...validSnapshotResponse().snapshot.memory, rssBytes: -1 } }),
					"snapshot-1",
				),
			/Invalid snapshot memory.rssBytes/,
		);
	});
});

describe("memory benchmark report comparison", () => {
	test("computes absolute and percentage median deltas", () => {
		const baseline = report();
		const current = report({
			metrics: {
				"memory.rssBytes": summary(125),
				"processTree.aggregateRssBytes": summary(150),
				"activeResources.PipeWrap": summary(2),
			},
		});
		const deltas = compareMemoryBenchmarkReports(current, baseline);
		assert.deepEqual(
			deltas.find((delta) => delta.metric === "memory.rssBytes"),
			{
				scenario: "daemon-idle",
				checkpoint: "idle",
				metric: "memory.rssBytes",
				baseline: 100,
				current: 125,
				absolute: 25,
				percent: 25,
			},
		);
	});

	test("treats missing active resource categories as zero and optional process-tree metrics as best effort", () => {
		const baseline = report({ metrics: { "memory.rssBytes": summary(100) } });
		const current = report({
			metrics: {
				"memory.rssBytes": summary(100),
				"activeResources.Timeout": summary(1),
				"processTree.aggregateRssBytes": summary(140),
			},
		});
		const deltas = compareMemoryBenchmarkReports(current, baseline);
		assert.equal(deltas.some((delta) => delta.metric === "processTree.aggregateRssBytes"), false);
		assert.deepEqual(deltas.find((delta) => delta.metric === "activeResources.Timeout"), {
			scenario: "daemon-idle",
			checkpoint: "idle",
			metric: "activeResources.Timeout",
			baseline: 0,
			current: 1,
			absolute: 1,
			percent: null,
		});
	});

	test("rejects incompatible runtime and workload metadata", () => {
		assert.throws(() => compareMemoryBenchmarkReports(report({ node: "24.2.0" }), report()), /Node version differs/);
		assert.throws(
			() => compareMemoryBenchmarkReports(report({ workload: { schemaVersion: 2 } }), report()),
			/workload differs/,
		);
	});
});

describe("memory benchmark cleanup and process tables", () => {
	test("runs cleanup in reverse order once and aggregates errors after all tasks", async () => {
		const calls = [];
		const cleanup = new MemoryBenchmarkCleanup();
		cleanup.add("first", () => calls.push("first"));
		cleanup.add("broken", () => {
			calls.push("broken");
			throw new Error("failure");
		});
		cleanup.add("last", async () => calls.push("last"));
		const firstRun = cleanup.run();
		await assert.rejects(firstRun, (error) => {
			assert(error instanceof AggregateError);
			assert.match(error.errors[0].message, /broken: failure/);
			return true;
		});
		assert.deepEqual(calls, ["last", "broken", "first"]);
		assert.equal(cleanup.run(), firstRun);
		await assert.rejects(cleanup.run(), AggregateError);
		assert.deepEqual(calls, ["last", "broken", "first"]);
	});

	test("normalizes process RSS and aggregates descendants with cycle protection", () => {
		const posix = parsePosixProcessTable(" 10 1 100\n11 10 25\n12 11 5\n");
		assert.deepEqual(posix[0], { pid: 10, ppid: 1, rssBytes: 102400 });
		assert.deepEqual(aggregateProcessTree(posix, 10), {
			pids: [10, 11, 12],
			processCount: 3,
			aggregateRssBytes: 133120,
		});
		assert.deepEqual(parseWindowsProcessTable("10 1 1024\r\n"), [{ pid: 10, ppid: 1, rssBytes: 1024 }]);
	});
});
