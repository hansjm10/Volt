#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptPath = fileURLToPath(import.meta.url);
const mebibyte = 1024 * 1024;
let benchmarkSink = 0;

function usage() {
	console.log(`Usage:
  node scripts/benchmark-node-runtime.mjs --baseline <node> --candidate <node> [--runs <count>]

Runs identical Volt-relevant API workloads under two Node.js executables.

Options:
  --baseline <node>   Baseline Node.js executable
  --candidate <node>  Candidate Node.js executable
  --runs <count>      Paired benchmark runs (default: 5)
  --help              Show this help`);
}

function parseArgs(argv) {
	const options = { baseline: undefined, candidate: undefined, runs: 5 };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			options.help = true;
			continue;
		}
		if (argument === "--worker") {
			options.worker = true;
			continue;
		}
		if (argument !== "--baseline" && argument !== "--candidate" && argument !== "--runs") {
			throw new Error(`Unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		if (argument === "--runs") {
			const runs = Number.parseInt(value, 10);
			if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
			options.runs = runs;
		} else {
			options[argument.slice(2)] = value;
		}
		index += 1;
	}
	return options;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function buildJsonPayload() {
	const messageText = "Volt runtime benchmark payload for provider, RPC, and session serialization. ".repeat(8);
	return {
		id: "runtime-benchmark",
		model: "provider/model",
		messages: Array.from({ length: 16 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `${index}:${messageText}` }],
			timestamp: 1_788_361_200_000 + index,
		})),
		tools: Array.from({ length: 8 }, (_, index) => ({
			name: `benchmark_tool_${index}`,
			description: messageText,
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					line: { type: "integer", minimum: 1 },
				},
				required: ["path"],
			},
		})),
	};
}

function benchmarkProcessStartup() {
	const warmupRuns = 3;
	const measuredRuns = 30;
	for (let index = 0; index < warmupRuns; index += 1) {
		const result = spawnSync(process.execPath, ["--no-warnings", "-e", ""], { stdio: "ignore", windowsHide: true });
		if (result.status !== 0) throw new Error(`Node startup warmup failed with status ${result.status}`);
	}
	const startedAt = performance.now();
	for (let index = 0; index < measuredRuns; index += 1) {
		const result = spawnSync(process.execPath, ["--no-warnings", "-e", ""], { stdio: "ignore", windowsHide: true });
		if (result.status !== 0) throw new Error(`Node startup benchmark failed with status ${result.status}`);
	}
	return (performance.now() - startedAt) / measuredRuns;
}

function benchmarkJsonStringify() {
	const payload = buildJsonPayload();
	const serializedBytes = Buffer.byteLength(JSON.stringify(payload));
	for (let index = 0; index < 2_000; index += 1) benchmarkSink ^= JSON.stringify(payload).length;

	const iterations = 30_000;
	const startedAt = performance.now();
	for (let index = 0; index < iterations; index += 1) benchmarkSink ^= JSON.stringify(payload).length;
	const elapsedSeconds = (performance.now() - startedAt) / 1_000;
	return (serializedBytes * iterations) / mebibyte / elapsedSeconds;
}

function benchmarkSqlite() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE events (
			sequence INTEGER PRIMARY KEY,
			session_id TEXT NOT NULL,
			payload TEXT NOT NULL
		);
		CREATE INDEX events_session_id ON events(session_id);
	`);
	const insert = database.prepare("INSERT INTO events (sequence, session_id, payload) VALUES (?, ?, ?)");
	const select = database.prepare("SELECT sequence, payload FROM events WHERE sequence = ?");
	const payload = JSON.stringify(buildJsonPayload()).slice(0, 2 * 1024);

	database.exec("BEGIN IMMEDIATE");
	for (let index = -1_000; index < 0; index += 1) insert.run(index, `session-${index % 32}`, payload);
	database.exec("COMMIT; DELETE FROM events");

	const writes = 40_000;
	database.exec("BEGIN IMMEDIATE");
	const writeStartedAt = performance.now();
	for (let index = 0; index < writes; index += 1) insert.run(index, `session-${index % 32}`, payload);
	database.exec("COMMIT");
	const writeElapsedSeconds = (performance.now() - writeStartedAt) / 1_000;

	for (let index = 0; index < 2_000; index += 1) benchmarkSink ^= Number(select.get(index)?.sequence ?? 0);
	const reads = 100_000;
	const readStartedAt = performance.now();
	for (let index = 0; index < reads; index += 1) {
		benchmarkSink ^= Number(select.get(index % writes)?.sequence ?? 0);
	}
	const readElapsedSeconds = (performance.now() - readStartedAt) / 1_000;
	database.close();

	return {
		readsPerSecond: reads / readElapsedSeconds,
		writesPerSecond: writes / writeElapsedSeconds,
	};
}

async function runConcurrent(count, concurrency, operation) {
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (nextIndex < count) {
				const index = nextIndex;
				nextIndex += 1;
				await operation(index);
			}
		}),
	);
}

async function benchmarkFetch() {
	const chunk = Buffer.alloc(8 * 1024, 0x61);
	const chunksPerResponse = 8;
	const bytesPerResponse = chunk.length * chunksPerResponse;
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytesPerResponse });
		for (let index = 0; index < chunksPerResponse; index += 1) response.write(chunk);
		response.end();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Benchmark server did not expose a TCP port");
	const url = `http://127.0.0.1:${address.port}/stream`;
	const request = async () => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Benchmark fetch failed with HTTP ${response.status}`);
		const body = await response.arrayBuffer();
		if (body.byteLength !== bytesPerResponse) throw new Error(`Benchmark fetch returned ${body.byteLength} bytes`);
		benchmarkSink ^= body.byteLength;
	};

	try {
		await runConcurrent(32, 8, request);
		const requests = 512;
		const startedAt = performance.now();
		await runConcurrent(requests, 16, request);
		const elapsedSeconds = (performance.now() - startedAt) / 1_000;
		return (bytesPerResponse * requests) / mebibyte / elapsedSeconds;
	} finally {
		await new Promise((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

async function runWorker() {
	const sqlite = benchmarkSqlite();
	const result = {
		version: process.version,
		metrics: {
			processStartupMs: benchmarkProcessStartup(),
			jsonStringifyMibPerSecond: benchmarkJsonStringify(),
			fetchMibPerSecond: await benchmarkFetch(),
			sqliteWritesPerSecond: sqlite.writesPerSecond,
			sqliteReadsPerSecond: sqlite.readsPerSecond,
		},
		benchmarkSink,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

function executeWorker(executable) {
	const result = spawnSync(executable, ["--no-warnings", scriptPath, "--worker"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${executable} benchmark failed with status ${result.status}: ${result.stderr || result.stdout}`);
	}
	return JSON.parse(result.stdout);
}

function formatValue(value, unit) {
	if (unit === "ms") return `${value.toFixed(2)} ms`;
	if (unit === "MiB/s") return `${value.toFixed(1)} MiB/s`;
	return `${Math.round(value).toLocaleString("en-US")} ops/s`;
}

function summarizeResults(results, metric) {
	const values = results.map((result) => result.metrics[metric]);
	return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function formatSummary(summary, unit) {
	return `${formatValue(summary.median, unit)} (${formatValue(summary.min, unit)}–${formatValue(summary.max, unit)})`;
}

function printComparison(baselineResults, candidateResults, runs) {
	const baselineVersion = baselineResults[0].version;
	const candidateVersion = candidateResults[0].version;
	const processor = cpus()[0]?.model ?? "unknown CPU";
	const metrics = [
		{ key: "processStartupMs", label: "Empty-process startup (lower is better)", unit: "ms" },
		{ key: "jsonStringifyMibPerSecond", label: "RPC-style JSON.stringify", unit: "MiB/s" },
		{ key: "fetchMibPerSecond", label: "Local streaming fetch", unit: "MiB/s" },
		{ key: "sqliteWritesPerSecond", label: "In-memory SQLite transaction writes", unit: "ops/s" },
		{ key: "sqliteReadsPerSecond", label: "In-memory SQLite primary-key reads", unit: "ops/s" },
	];

	process.stdout.write("# Node.js runtime benchmark\n\n");
	process.stdout.write(`- Recorded: ${new Date().toISOString()}\n`);
	process.stdout.write(`- Host: ${platform()} ${release()} ${arch()}, ${processor}, ${cpus().length} logical CPUs, ${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM\n`);
	process.stdout.write(`- Method: ${runs} paired runs in alternating order; cells show median (minimum–maximum).\n\n`);
	process.stdout.write(`| Benchmark | ${baselineVersion} | ${candidateVersion} | Node 26 delta |\n`);
	process.stdout.write("| --- | ---: | ---: | ---: |\n");
	for (const metric of metrics) {
		const baseline = summarizeResults(baselineResults, metric.key);
		const candidate = summarizeResults(candidateResults, metric.key);
		const delta = ((candidate.median - baseline.median) / baseline.median) * 100;
		process.stdout.write(
			`| ${metric.label} | ${formatSummary(baseline, metric.unit)} | ${formatSummary(candidate, metric.unit)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% |\n`,
		);
	}
	process.stdout.write("\nPositive deltas mean higher throughput except for empty-process startup, where a negative delta is faster.\n");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	if (options.worker) {
		await runWorker();
		return;
	}
	if (!options.baseline || !options.candidate) {
		usage();
		throw new Error("--baseline and --candidate are required");
	}

	const baselineResults = [];
	const candidateResults = [];
	for (let run = 0; run < options.runs; run += 1) {
		const order = run % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
		for (const runtime of order) {
			process.stderr.write(`Run ${run + 1}/${options.runs}: ${runtime}\n`);
			const result = executeWorker(options[runtime]);
			(runtime === "baseline" ? baselineResults : candidateResults).push(result);
		}
	}
	printComparison(baselineResults, candidateResults, options.runs);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
