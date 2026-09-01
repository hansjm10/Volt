import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/core/session-manager.ts";

const sessionCount = Number.parseInt(process.env.VOLT_BENCH_SESSION_COUNT ?? "100", 10);
const payloadBytes = Number.parseInt(process.env.VOLT_BENCH_SESSION_PAYLOAD_BYTES ?? String(256 * 1024), 10);
if (!Number.isSafeInteger(sessionCount) || sessionCount <= 0) throw new Error("Invalid VOLT_BENCH_SESSION_COUNT");
if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new Error("Invalid VOLT_BENCH_SESSION_PAYLOAD_BYTES");

const root = mkdtempSync(join(tmpdir(), "volt-session-list-benchmark-"));
const cwd = join(root, "workspace");
const sessionDir = join(root, "sessions");
mkdirSync(cwd, { recursive: true });

async function measured<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const beforeHeap = process.memoryUsage().heapUsed;
	const startedAt = performance.now();
	const result = await operation();
	const elapsedMs = performance.now() - startedAt;
	const heapDeltaMiB = (process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024;
	console.log(`${name}: ${elapsedMs.toFixed(1)}ms, heap delta ${heapDeltaMiB.toFixed(2)} MiB`);
	return result;
}

try {
	const payload = "x".repeat(payloadBytes);
	for (let index = 0; index < sessionCount; index += 1) {
		const manager = await SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: `session ${index}`, timestamp: Date.now() + index });
		manager.appendCustomEntry("benchmark-payload", { payload });
		await manager.flush();
	}

	const cold = await measured("cold list", () => SessionManager.list(cwd, sessionDir));
	await measured("warm list", () => SessionManager.list(cwd, sessionDir));
	await measured("exact lookup + open", async () => {
		const ref = await SessionManager.findForResume(sessionDir, cold[Math.floor(cold.length / 2)]!.id);
		if (!ref) throw new Error("Benchmark session disappeared");
		return SessionManager.open(ref);
	});
	await measured("deep search", () => SessionManager.search(cwd, `session ${sessionCount - 1}`, sessionDir));

	console.log(
		JSON.stringify({ sessionCount, payloadBytesPerSession: payloadBytes, totalPayloadMiB: (sessionCount * payloadBytes) / 1024 / 1024 }),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
