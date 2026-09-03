import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SQLiteSessionStoreLease,
} from "../src/core/session-store/index.ts";

function environmentInteger(name: string, fallback: number, minimum: number): number {
	const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
	return value;
}

function exactPaddedAscii(prefix: string, bytes: number, dimension: string): string {
	const prefixBytes = Buffer.byteLength(prefix, "utf8");
	if (prefixBytes > bytes) {
		throw new Error(`${dimension} must be at least ${prefixBytes} bytes for the configured query count`);
	}
	return `${prefix}${"x".repeat(bytes - prefixBytes)}`;
}

function regexPattern(bytes: number): string {
	if (bytes < 13) {
		return `${bytes % 2 === 1 ? "." : ""}${"x?".repeat(Math.floor(bytes / 2))}`;
	}
	const prefix = bytes % 2 === 1 ? "target-[0-9]+" : "target-[0-9]+?";
	return `${prefix}${"x?".repeat((bytes - prefix.length) / 2)}`;
}

const sessionCount = environmentInteger("VOLT_BENCH_SESSION_COUNT", 100, 1);
const storeCount = environmentInteger("VOLT_BENCH_STORE_COUNT", 4, 1);
const summaryBytes = environmentInteger("VOLT_BENCH_SESSION_SUMMARY_BYTES", 128, 1);
const nonSearchableBytes = environmentInteger("VOLT_BENCH_SESSION_NON_SEARCHABLE_BYTES", 256 * 1024, 0);
const searchablePayloadBytes = environmentInteger("VOLT_BENCH_SESSION_SEARCHABLE_BYTES", 64 * 1024, 1);
const queryTokenCount = environmentInteger("VOLT_BENCH_QUERY_TOKEN_COUNT", 3, 1);
const queryTokenBytes = environmentInteger("VOLT_BENCH_QUERY_TOKEN_BYTES", 12, 1);
const phraseCount = environmentInteger("VOLT_BENCH_QUERY_PHRASE_COUNT", 2, 1);
const phraseBytes = environmentInteger("VOLT_BENCH_QUERY_PHRASE_BYTES", 24, 1);
const regexBytes = environmentInteger("VOLT_BENCH_QUERY_REGEX_BYTES", 64, 1);

const tokenTerms = Array.from({ length: queryTokenCount }, (_, index) =>
	exactPaddedAscii(`t${index}`, queryTokenBytes, "VOLT_BENCH_QUERY_TOKEN_BYTES"),
);
const phraseTerms = Array.from({ length: phraseCount }, (_, index) =>
	exactPaddedAscii(`p${index} value`, phraseBytes, "VOLT_BENCH_QUERY_PHRASE_BYTES"),
);
const requiredSearchableTerms = [...tokenTerms, ...phraseTerms].join(" ");
const minimumSearchablePayloadBytes = Buffer.byteLength(
	`${requiredSearchableTerms} target-${sessionCount - 1}`,
	"utf8",
);
if (minimumSearchablePayloadBytes > searchablePayloadBytes) {
	throw new Error(
		`VOLT_BENCH_SESSION_SEARCHABLE_BYTES must be at least ${minimumSearchablePayloadBytes} bytes for the configured queries`,
	);
}
const searchablePayloadForSession = (index: number): string => {
	const target = `target-${index}`;
	const requiredBytes = Buffer.byteLength(`${requiredSearchableTerms} ${target}`, "utf8");
	return `${requiredSearchableTerms} ${"x".repeat(searchablePayloadBytes - requiredBytes)}${target}`;
};
const tokenQuery = tokenTerms.join(" ");
const phraseQuery = phraseTerms.map((phrase) => `"${phrase}"`).join(" ");
const regexQuery = `re:${regexPattern(regexBytes)}`;

const root = mkdtempSync(join(tmpdir(), "volt-session-list-benchmark-"));
const agentDir = join(root, "agent");
const previousAgentDir = process.env[ENV_AGENT_DIR];
process.env[ENV_AGENT_DIR] = agentDir;
const workspaces = Array.from({ length: storeCount }, (_, index) => join(root, `workspace-${index}`));
for (const workspace of workspaces) mkdirSync(workspace, { recursive: true });
const sessionDirs = workspaces.map((workspace) => getDefaultSessionDir(workspace, agentDir));

async function measured<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const before = process.memoryUsage();
	let peakRss = before.rss;
	const sample = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 5);
	sample.unref();
	const startedAt = performance.now();
	try {
		const result = await operation();
		const elapsedMs = performance.now() - startedAt;
		const after = process.memoryUsage();
		peakRss = Math.max(peakRss, after.rss);
		const heapDeltaMiB = (after.heapUsed - before.heapUsed) / 1024 / 1024;
		const peakRssDeltaMiB = (peakRss - before.rss) / 1024 / 1024;
		console.log(
			`${name}: ${elapsedMs.toFixed(1)}ms, main heap delta ${heapDeltaMiB.toFixed(2)} MiB, process peak RSS delta ${peakRssDeltaMiB.toFixed(2)} MiB`,
		);
		return result;
	} finally {
		clearInterval(sample);
	}
}

function requireResultCount(name: string, actual: number): void {
	if (actual !== sessionCount) throw new Error(`${name} returned ${actual} of ${sessionCount} benchmark sessions`);
}

const managers = new Set<SessionManager>();
const warmLeases = new Set<SQLiteSessionStoreLease>();
const sessionsPerStore = Array.from({ length: storeCount }, () => 0);
const extractedSearchableBytesPerSession = summaryBytes + 1 + searchablePayloadBytes;
const extractedSearchableBytesPerStore = Array.from({ length: storeCount }, () => 0);
const nonSearchablePayloadBytesPerStore = Array.from({ length: storeCount }, () => 0);
const releaseWarmLeases = async (): Promise<void> => {
	const leases = [...warmLeases];
	warmLeases.clear();
	await Promise.all(leases.map((lease) => lease.release()));
};

try {
	const summary = "s".repeat(summaryBytes);
	const nonSearchablePayload = "n".repeat(nonSearchableBytes);
	for (const sessionDir of sessionDirs) warmLeases.add(await acquireSharedSQLiteSessionStore(sessionDir));
	for (let index = 0; index < sessionCount; index += 1) {
		const storeIndex = index % storeCount;
		const manager = await SessionManager.create(workspaces[storeIndex]!, sessionDirs[storeIndex]!);
		managers.add(manager);
		manager.appendMessage({ role: "user", content: summary, timestamp: Date.now() + index });
		manager.appendCustomEntry("benchmark-non-searchable", nonSearchablePayload);
		manager.appendCustomMessageEntry(
			"benchmark-searchable",
			searchablePayloadForSession(index),
			true,
		);
		await manager.flush();
		await manager.closePersistence();
		managers.delete(manager);
		sessionsPerStore[storeIndex]!++;
		extractedSearchableBytesPerStore[storeIndex]! += extractedSearchableBytesPerSession;
		nonSearchablePayloadBytesPerStore[storeIndex]! += nonSearchableBytes;
	}
	await releaseWarmLeases();

	const cold = await measured("cold list across stores", () => SessionManager.listAll());
	requireResultCount("cold list", cold.length);
	const coldTokenResults = await measured("cold deep token search across stores", () =>
		SessionManager.searchAll(tokenQuery),
	);
	requireResultCount("cold deep token search", coldTokenResults.length);

	const selected = cold[Math.floor(cold.length / 2)]!;
	const openSelected = async (): Promise<SessionManager> => {
		const ref = await SessionManager.findForResume(selected.ref.sessionDirectory, selected.id);
		if (!ref) throw new Error("Benchmark session disappeared");
		return SessionManager.open(ref);
	};
	const opened = await measured("cold exact lookup + open", openSelected);
	managers.add(opened);
	for (const sessionDir of sessionDirs) warmLeases.add(await acquireSharedSQLiteSessionStore(sessionDir));

	const warm = await measured("warm list across stores", () => SessionManager.listAll());
	requireResultCount("warm list", warm.length);
	const warmOpened = await measured("warm exact lookup + open", openSelected);
	managers.add(warmOpened);
	await warmOpened.closePersistence();
	managers.delete(warmOpened);
	const warmTokenResults = await measured("warm deep token search across stores", () =>
		SessionManager.searchAll(tokenQuery),
	);
	requireResultCount("warm deep token search", warmTokenResults.length);
	const warmPhraseResults = await measured("warm deep phrase search across stores", () =>
		SessionManager.searchAll(phraseQuery),
	);
	requireResultCount("warm deep phrase search", warmPhraseResults.length);
	const warmRegexResults = await measured("warm deep regex search across stores", () =>
		SessionManager.searchAll(regexQuery),
	);
	requireResultCount("warm deep regex search", warmRegexResults.length);

	await opened.closePersistence();
	managers.delete(opened);
	await releaseWarmLeases();

	console.log(
		JSON.stringify({
			sessionCount,
			storeCount,
			sessionsPerStore,
			summaryBytesPerSession: summaryBytes,
			nonSearchablePayloadBytesPerSession: nonSearchableBytes,
			searchablePayloadBytesPerSession: searchablePayloadBytes,
			extractedSearchableBytesPerSession,
			nonSearchablePayloadBytesPerStore,
			extractedSearchableBytesPerStore,
			totalNonSearchablePayloadMiB: (sessionCount * nonSearchableBytes) / 1024 / 1024,
			totalExtractedSearchableMiB: (sessionCount * extractedSearchableBytesPerSession) / 1024 / 1024,
			queries: {
				token: {
					bytes: Buffer.byteLength(tokenQuery, "utf8"),
					count: queryTokenCount,
					bytesPerToken: queryTokenBytes,
				},
				phrase: {
					bytes: Buffer.byteLength(phraseQuery, "utf8"),
					count: phraseCount,
					bytesPerPhrase: phraseBytes,
				},
				regex: {
					bytes: Buffer.byteLength(regexQuery.slice(3), "utf8"),
					queryBytes: Buffer.byteLength(regexQuery, "utf8"),
				},
			},
		}),
	);
} finally {
	try {
		await releaseWarmLeases();
		await Promise.all([...managers].map((manager) => manager.closePersistence()));
	} finally {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}
