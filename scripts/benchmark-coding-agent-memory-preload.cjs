"use strict";

const net = require("node:net");
const v8 = require("node:v8");
const { performance } = require("node:perf_hooks");

const PROTOCOL_VERSION = 1;
const ROLE = process.env.VOLT_MEMORY_BENCHMARK_ROLE;
const TARGET_PATH = process.env.VOLT_MEMORY_BENCHMARK_TARGET_PATH;

function isTargetProcess() {
	if (process.env.VOLT_MEMORY_BENCHMARK_PRELOAD !== "1") return false;
	if (ROLE === "daemon") {
		return process.argv.includes("daemon") && process.argv.includes("run") && process.argv.includes("--foreground");
	}
	if (ROLE === "rpc") {
		const modeIndex = process.argv.indexOf("--mode");
		return modeIndex !== -1 && process.argv[modeIndex + 1] === "rpc";
	}
	if (ROLE === "worker") {
		return typeof TARGET_PATH === "string" && process.argv.some((value) => value === TARGET_PATH);
	}
	return false;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function immediate() {
	return new Promise((resolve) => setImmediate(resolve));
}

function countActiveResources() {
	const counts = {};
	const resources =
		typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
	for (const resource of resources) {
		counts[resource] = (counts[resource] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function takeSnapshot(settleMs) {
	if (typeof global.gc !== "function") {
		throw new Error("benchmark target was not started with --expose-gc");
	}
	const startedAt = performance.now();
	await delay(settleMs);
	const settledAt = performance.now();
	global.gc();
	await immediate();
	global.gc();
	await immediate();
	const gcFinishedAt = performance.now();
	const memory = process.memoryUsage();
	const heap = v8.getHeapStatistics();
	const capturedAt = performance.now();
	return {
		pid: process.pid,
		uptimeMs: process.uptime() * 1000,
		capturedAt: new Date().toISOString(),
		memory: {
			rssBytes: memory.rss,
			heapTotalBytes: memory.heapTotal,
			heapUsedBytes: memory.heapUsed,
			externalBytes: memory.external,
			arrayBuffersBytes: memory.arrayBuffers,
		},
		v8: {
			totalHeapSizeBytes: heap.total_heap_size,
			totalHeapSizeExecutableBytes: heap.total_heap_size_executable,
			totalPhysicalSizeBytes: heap.total_physical_size,
			totalAvailableSizeBytes: heap.total_available_size,
			usedHeapSizeBytes: heap.used_heap_size,
			heapSizeLimitBytes: heap.heap_size_limit,
			mallocedMemoryBytes: heap.malloced_memory,
			peakMallocedMemoryBytes: heap.peak_malloced_memory,
			doesZapGarbage: heap.does_zap_garbage,
			nativeContexts: heap.number_of_native_contexts,
			detachedContexts: heap.number_of_detached_contexts,
			totalGlobalHandlesSizeBytes: heap.total_global_handles_size,
			usedGlobalHandlesSizeBytes: heap.used_global_handles_size,
			externalMemoryBytes: heap.external_memory,
		},
		activeResources: countActiveResources(),
		timing: {
			settleRequestedMs: settleMs,
			settleActualMs: settledAt - startedAt,
			gcMs: gcFinishedAt - settledAt,
			captureMs: capturedAt - gcFinishedAt,
			totalMs: capturedAt - startedAt,
		},
	};
}

function write(socket, message) {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function start() {
	const port = Number(process.env.VOLT_MEMORY_BENCHMARK_PORT);
	const token = process.env.VOLT_MEMORY_BENCHMARK_TOKEN;
	if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token || !ROLE) {
		return;
	}

	const socket = net.createConnection({ host: "127.0.0.1", port });
	let buffer = "";
	let queue = Promise.resolve();
	socket.setEncoding("utf8");
	socket.once("connect", () => {
		write(socket, {
			version: PROTOCOL_VERSION,
			type: "hello",
			token,
			role: ROLE,
			pid: process.pid,
		});
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			queue = queue.then(async () => {
				let request;
				try {
					request = JSON.parse(line);
				} catch {
					return;
				}
				if (request?.version !== PROTOCOL_VERSION || typeof request.id !== "string") return;
				if (request.type === "release") {
					write(socket, { version: PROTOCOL_VERSION, type: "released", id: request.id, ok: true });
					socket.end();
					return;
				}
				if (request.type !== "snapshot") return;
				try {
					const settleMs = Number(request.settleMs);
					if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60_000) {
						throw new Error("settleMs must be an integer from 0 through 60000");
					}
					const snapshot = await takeSnapshot(settleMs);
					write(socket, {
						version: PROTOCOL_VERSION,
						type: "snapshot_result",
						id: request.id,
						ok: true,
						snapshot,
					});
				} catch (error) {
					write(socket, {
						version: PROTOCOL_VERSION,
						type: "snapshot_result",
						id: request.id,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
		}
	});
	socket.on("error", () => {});
	socket.unref();
}

if (isTargetProcess()) start();
