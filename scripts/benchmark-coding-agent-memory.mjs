import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, tmpdir, totalmem, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceCliPath = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const workerPath = join(scriptDir, "benchmark-coding-agent-memory-worker.mjs");
const preloadPath = join(scriptDir, "benchmark-coding-agent-memory-preload.cjs");
const REPORT_SCHEMA_VERSION = 1;
const SNAPSHOT_PROTOCOL_VERSION = 1;
const EVENT_PREFIX = "VOLT_MEMORY_BENCHMARK_EVENT ";
const DEFAULT_SETTLE_MS = 250;
const COMMAND_TIMEOUT_MS = 90_000;
const WORKER_TIMEOUT_MS = 120_000;
const PROCESS_EXIT_GRACE_MS = 5_000;

export const MEMORY_BENCHMARK_SCENARIOS = Object.freeze([
	"daemon-idle",
	"rpc-idle",
	"runtime-idle",
	"conversation",
	"reconnect-retention",
	"extension",
	"mcp",
	"lsp",
]);

export const MEMORY_BENCHMARK_CHECKPOINTS = Object.freeze({
	"daemon-idle": ["idle"],
	"rpc-idle": ["idle"],
	"runtime-idle": ["baseline", "post-disposal"],
	conversation: ["baseline", "populated", "post-disposal"],
	"reconnect-retention": ["baseline", "detached", "post-cycle", "post-disposal"],
	extension: ["before-activation", "active", "post-disposal"],
	mcp: ["before-activation", "active", "post-disposal"],
	lsp: ["before-activation", "active", "post-disposal"],
});

const CREDENTIAL_ENV_NAMES = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"KIMI_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"BEDROCK_EXTENSIVE_MODEL_TEST",
]);

function printHelp() {
	process.stdout.write(`Usage:
  npm run benchmark:memory -- [options]

Options:
  --scenario <name[,name]>  Run selected scenarios (repeatable; default: all)
  --runs <n>                Measured fresh-process runs per scenario (default: 3)
  --warmup <n>              Warmup fresh-process runs per scenario (default: 1)
  --quick                   Run one measured process per scenario with no warmup
  --settle-ms <n>           Delay before each settled double-GC snapshot (default: 250)
  --output <path>           Write a versioned JSON report
  --compare <path>          Compare medians with a compatible JSON report
  --help                    Show this help

Scenarios:
  ${MEMORY_BENCHMARK_SCENARIOS.join(", ")}

This is an observational, build-free source benchmark. It has no memory pass/fail thresholds.
`);
}

function parseInteger(value, flag, { minimum, maximum = Number.MAX_SAFE_INTEGER }) {
	if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${flag}: ${value}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`Invalid ${flag}: ${value}`);
	}
	return parsed;
}

export function parseMemoryBenchmarkArgs(argv, cwd = process.cwd()) {
	const selected = new Set();
	let runs = 3;
	let warmup = 1;
	let settleMs = DEFAULT_SETTLE_MS;
	let output;
	let compare;
	let quick = false;
	let samplingOverride = false;
	let help = false;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--quick") {
			quick = true;
			continue;
		}
		if (!["--scenario", "--runs", "--warmup", "--settle-ms", "--output", "--compare"].includes(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (index + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
		const value = argv[++index];
		if (arg === "--scenario") {
			for (const scenario of value.split(",").map((entry) => entry.trim()).filter(Boolean)) {
				if (!MEMORY_BENCHMARK_SCENARIOS.includes(scenario)) {
					throw new Error(`Invalid --scenario: ${scenario}`);
				}
				selected.add(scenario);
			}
			if (selected.size === 0) throw new Error("--scenario requires at least one scenario name");
			continue;
		}
		if (arg === "--runs") {
			runs = parseInteger(value, arg, { minimum: 1, maximum: 100 });
			samplingOverride = true;
			continue;
		}
		if (arg === "--warmup") {
			warmup = parseInteger(value, arg, { minimum: 0, maximum: 100 });
			samplingOverride = true;
			continue;
		}
		if (arg === "--settle-ms") {
			settleMs = parseInteger(value, arg, { minimum: 0, maximum: 60_000 });
			continue;
		}
		if (arg === "--output") output = resolve(cwd, value);
		if (arg === "--compare") compare = resolve(cwd, value);
	}

	if (quick && samplingOverride) throw new Error("--quick cannot be combined with --runs or --warmup");
	if (quick) {
		runs = 1;
		warmup = 0;
	}
	const scenarios = MEMORY_BENCHMARK_SCENARIOS.filter(
		(scenario) => selected.size === 0 || selected.has(scenario),
	);
	return { scenarios, runs, warmup, settleMs, output, compare, quick, help };
}

export function summarizeMemoryBenchmarkValues(values) {
	if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
		throw new Error("summary requires one or more finite numbers");
	}
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return {
		min: sorted[0],
		median,
		average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		max: sorted.at(-1),
	};
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFiniteNonNegative(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid snapshot ${label}`);
	}
}

export function validateMemorySnapshotResponse(message, expectedId) {
	if (!isRecord(message) || message.version !== SNAPSHOT_PROTOCOL_VERSION || message.type !== "snapshot_result") {
		throw new Error("Invalid snapshot protocol response");
	}
	if (message.id !== expectedId) throw new Error(`Unexpected snapshot response id: ${String(message.id)}`);
	if (message.ok !== true) throw new Error(`Snapshot failed: ${String(message.error ?? "unknown error")}`);
	const snapshot = message.snapshot;
	if (!isRecord(snapshot) || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) {
		throw new Error("Invalid snapshot pid");
	}
	for (const groupName of ["memory", "v8", "activeResources", "timing"]) {
		if (!isRecord(snapshot[groupName])) throw new Error(`Invalid snapshot ${groupName}`);
	}
	for (const [name, value] of Object.entries(snapshot.memory)) requireFiniteNonNegative(value, `memory.${name}`);
	for (const [name, value] of Object.entries(snapshot.v8)) requireFiniteNonNegative(value, `v8.${name}`);
	for (const [name, value] of Object.entries(snapshot.activeResources)) {
		if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid snapshot activeResources.${name}`);
	}
	for (const [name, value] of Object.entries(snapshot.timing)) requireFiniteNonNegative(value, `timing.${name}`);
	return snapshot;
}

export class MemoryBenchmarkCleanup {
	#tasks = [];
	#runPromise;

	add(label, task) {
		this.#tasks.push({ label, task });
	}

	run() {
		if (this.#runPromise) return this.#runPromise;
		this.#runPromise = (async () => {
			const errors = [];
			for (const { label, task } of [...this.#tasks].reverse()) {
				try {
					await task();
				} catch (error) {
					errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "memory benchmark cleanup failed");
		})();
		return this.#runPromise;
	}
}

export function parsePosixProcessTable(text) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024 });
	}
	return rows;
}

export function parseWindowsProcessTable(text) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) });
	}
	return rows;
}

export function aggregateProcessTree(rows, rootPid) {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const children = new Map();
	for (const row of rows) {
		const values = children.get(row.ppid) ?? [];
		values.push(row.pid);
		children.set(row.ppid, values);
	}
	const pids = [];
	const pending = [rootPid];
	const seen = new Set();
	while (pending.length > 0) {
		const pid = pending.pop();
		if (seen.has(pid)) continue;
		seen.add(pid);
		if (byPid.has(pid)) pids.push(pid);
		for (const childPid of children.get(pid) ?? []) pending.push(childPid);
	}
	return {
		pids,
		processCount: pids.length,
		aggregateRssBytes: pids.reduce((sum, pid) => sum + (byPid.get(pid)?.rssBytes ?? 0), 0),
	};
}

function runCapture(executable, args, options = {}) {
	return new Promise((resolveCapture, rejectCapture) => {
		const child = spawn(executable, args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		options.onSpawn?.(child);
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			void terminateProcessTree(child.pid, child).finally(() =>
				rejectCapture(new Error(`${options.label ?? executable} timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms`)),
			);
		}, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectCapture(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveCapture({ code: code ?? 0, signal, stdout, stderr });
		});
	});
}

async function getProcessRows() {
	if (process.platform === "win32") {
		const command =
			'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }';
		const result = await runCapture(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
			{ label: "Windows process table", timeoutMs: 15_000 },
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `PowerShell exited ${result.code}`);
		return parseWindowsProcessTable(result.stdout);
	}
	if (process.platform === "linux" || process.platform === "darwin") {
		const result = await runCapture("ps", ["-Ao", "pid=,ppid=,rss="], {
			label: "POSIX process table",
			timeoutMs: 15_000,
		});
		if (result.code !== 0) throw new Error(result.stderr.trim() || `ps exited ${result.code}`);
		return parsePosixProcessTable(result.stdout);
	}
	throw new Error(`process-tree RSS is unsupported on ${process.platform}`);
}

async function collectProcessTree(rootPid) {
	try {
		const aggregate = aggregateProcessTree(await getProcessRows(), rootPid);
		if (!aggregate.pids.includes(rootPid)) throw new Error(`root pid ${rootPid} was not present in the process table`);
		return { supported: true, aggregateRssBytes: aggregate.aggregateRssBytes, processCount: aggregate.processCount };
	} catch (error) {
		return {
			supported: false,
			aggregateRssBytes: null,
			processCount: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function processIsAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (processIsAlive(pid) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	return !processIsAlive(pid);
}

async function terminateProcessTree(pid, child) {
	if (!pid || !processIsAlive(pid)) return;
	if (process.platform === "win32") {
		await runCapture("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
			label: `taskkill ${pid}`,
			timeoutMs: 15_000,
		}).catch(() => undefined);
		return;
	}
	let descendants = [];
	try {
		descendants = aggregateProcessTree(await getProcessRows(), pid).pids.filter((entry) => entry !== pid).reverse();
	} catch {
		// Root signalling remains available when the process table cannot be read.
	}
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				child?.kill(signal);
			} catch {
				// Already exited.
			}
		}
		for (const descendant of descendants) {
			try {
				process.kill(descendant, signal);
			} catch {
				// Already exited.
			}
		}
		if (await waitForProcessExit(pid, signal === "SIGTERM" ? 1_000 : 2_000)) return;
	}
}

class SnapshotServer {
	constructor(role) {
		this.role = role;
		this.token = randomBytes(32).toString("hex");
		this.sequence = 0;
		this.pending = new Map();
		this.sockets = new Set();
		this.helloPromise = new Promise((resolveHello, rejectHello) => {
			this.resolveHello = resolveHello;
			this.rejectHello = rejectHello;
		});
	}

	async start() {
		this.server = createServer((socket) => this.accept(socket));
		await new Promise((resolveListen, rejectListen) => {
			this.server.once("error", rejectListen);
			this.server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = this.server.address();
		if (!isRecord(address)) throw new Error("snapshot server did not bind a TCP port");
		this.port = address.port;
	}

	accept(socket) {
		this.sockets.add(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					socket.destroy();
					continue;
				}
				if (message?.type === "hello") {
					if (
						message.version !== SNAPSHOT_PROTOCOL_VERSION ||
						message.token !== this.token ||
						message.role !== this.role ||
						!Number.isInteger(message.pid)
					) {
						socket.destroy();
						continue;
					}
					if (this.socket && this.socket !== socket) {
						socket.destroy();
						continue;
					}
					this.socket = socket;
					this.resolveHello({ pid: message.pid, role: message.role });
					continue;
				}
				const pending = this.pending.get(message?.id);
				if (!pending) continue;
				this.pending.delete(message.id);
				clearTimeout(pending.timeout);
				pending.resolve(message);
			}
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
			if (this.socket === socket) this.socket = undefined;
		});
		socket.on("error", () => {});
	}

	async waitForHello(timeoutMs = 30_000) {
		let timeout;
		try {
			return await Promise.race([
				this.helloPromise,
				new Promise((_, rejectTimeout) => {
					timeout = setTimeout(() => rejectTimeout(new Error(`timed out waiting for ${this.role} snapshot preload`)), timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
	}

	request(type, fields = {}, timeoutMs = 30_000) {
		if (!this.socket || this.socket.destroyed) throw new Error("snapshot preload is not connected");
		const id = `${type}-${++this.sequence}`;
		return new Promise((resolveResponse, rejectResponse) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectResponse(new Error(`${type} request timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timeout });
			this.socket.write(`${JSON.stringify({ version: SNAPSHOT_PROTOCOL_VERSION, type, id, ...fields })}\n`);
		});
	}

	async snapshot(settleMs) {
		const id = `snapshot-${this.sequence + 1}`;
		const response = await this.request("snapshot", { settleMs }, settleMs + 30_000);
		return validateMemorySnapshotResponse(response, id);
	}

	async release() {
		if (!this.socket || this.socket.destroyed) return;
		const response = await this.request("release");
		if (response?.type !== "released" || response.ok !== true) throw new Error("snapshot preload release failed");
		this.socket.end();
	}

	async close() {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("snapshot server closed"));
		}
		this.pending.clear();
		for (const socket of this.sockets) socket.destroy();
		if (this.server) {
			await new Promise((resolveClose) => this.server.close(() => resolveClose()));
		}
	}
}

class WorkerEventQueue {
	constructor(stream, childExit) {
		this.queue = [];
		this.waiters = [];
		this.buffer = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => this.onData(chunk));
		childExit.then(
			(result) => this.finish(new Error(`worker exited before completing checkpoints (code ${result.code}, signal ${result.signal ?? "none"})`)),
			(error) => this.finish(error),
		);
	}

	onData(chunk) {
		this.buffer += chunk;
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) break;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.startsWith(EVENT_PREFIX)) continue;
			let event;
			try {
				event = JSON.parse(line.slice(EVENT_PREFIX.length));
			} catch (error) {
				this.finish(error);
				continue;
			}
			const waiter = this.waiters.shift();
			if (waiter) waiter.resolve(event);
			else this.queue.push(event);
		}
	}

	finish(error) {
		this.error ??= error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
	}

	next(timeoutMs = WORKER_TIMEOUT_MS) {
		if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
		if (this.error) return Promise.reject(this.error);
		return new Promise((resolveEvent, rejectEvent) => {
			const waiter = {
				resolve: (event) => {
					clearTimeout(timeout);
					resolveEvent(event);
				},
				reject: (error) => {
					clearTimeout(timeout);
					rejectEvent(error);
				},
			};
			const timeout = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				rejectEvent(new Error("timed out waiting for worker checkpoint"));
			}, timeoutMs);
			this.waiters.push(waiter);
		});
	}
}

function spawnLongRunning(executable, args, options) {
	const child = spawn(executable, args, {
		cwd: options.cwd,
		env: options.env,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const exit = new Promise((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", (code, signal) => resolveExit({ code: code ?? 0, signal }));
	});
	return { child, exit, getStderr: () => stderr };
}

async function waitForExit(running, timeoutMs = COMMAND_TIMEOUT_MS) {
	let timeout;
	try {
		const result = await Promise.race([
			running.exit,
			new Promise((_, rejectTimeout) => {
				timeout = setTimeout(() => rejectTimeout(new Error(`process ${running.child.pid} did not exit`)), timeoutMs);
			}),
		]);
		if (result.signal || result.code !== 0) {
			throw new Error(
				running.getStderr().trim() ||
					`process ${running.child.pid} exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}`,
			);
		}
		return result;
	} finally {
		clearTimeout(timeout);
	}
}

function benchmarkNodeOptions() {
	const normalizedPreload = preloadPath.replaceAll("\\", "/");
	return `--expose-gc --experimental-strip-types --conditions=volt-source --require=${JSON.stringify(normalizedPreload)}`;
}

function createHermeticEnvironment(paths, snapshotServer, role) {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (
			CREDENTIAL_ENV_NAMES.has(name) ||
			name.endsWith("_API_KEY") ||
			name.endsWith("_ACCESS_TOKEN") ||
			name.startsWith("AWS_")
		) {
			delete env[name];
		}
	}
	for (const name of ["VOLT_PACKAGE_DIR", "VOLT_PROFILE", "VOLT_STARTUP_BENCHMARK"]) delete env[name];
	env.HOME = paths.home;
	env.USERPROFILE = paths.home;
	env.XDG_CONFIG_HOME = join(paths.home, ".config");
	env.XDG_CACHE_HOME = join(paths.home, ".cache");
	env.VOLT_CODING_AGENT_DIR = paths.agentDir;
	env.VOLT_OFFLINE = "1";
	env.VOLT_SKIP_VERSION_CHECK = "1";
	env.VOLT_NO_LOCAL_LLM = "1";
	env.VOLT_IROH_RELAY_MODE = "disabled";
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	env.NODE_OPTIONS = benchmarkNodeOptions();
	env.VOLT_MEMORY_BENCHMARK_PRELOAD = "1";
	env.VOLT_MEMORY_BENCHMARK_ROLE = role;
	env.VOLT_MEMORY_BENCHMARK_PORT = String(snapshotServer.port);
	env.VOLT_MEMORY_BENCHMARK_TOKEN = snapshotServer.token;
	env.VOLT_MEMORY_BENCHMARK_TARGET_PATH = workerPath;
	return env;
}

async function removeDirectoryWithRetry(path) {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 19) throw error;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
	}
}

async function createRunContext(role) {
	const root = await mkdtemp(join(tmpdir(), "volt-memory-benchmark-"));
	const paths = {
		root,
		home: join(root, "home"),
		agentDir: join(root, "agent"),
		workspace: join(root, "workspace"),
	};
	await Promise.all(Object.values(paths).slice(1).map((path) => mkdir(path, { recursive: true })));
	const cleanup = new MemoryBenchmarkCleanup();
	cleanup.add("remove benchmark temporary directory", () => removeDirectoryWithRetry(root));
	const snapshotServer = new SnapshotServer(role);
	await snapshotServer.start();
	cleanup.add("close snapshot server", () => snapshotServer.close());
	return { paths, cleanup, snapshotServer, env: createHermeticEnvironment(paths, snapshotServer, role) };
}

async function captureCheckpoint(snapshotServer, name, startedAt, settleMs) {
	const snapshot = await snapshotServer.snapshot(settleMs);
	const processTree = await collectProcessTree(snapshot.pid);
	return {
		name,
		elapsedMs: performance.now() - startedAt,
		snapshot,
		processTree,
	};
}

async function runWorkerScenario(scenario, options, setActiveCleanup) {
	const context = await createRunContext("worker");
	setActiveCleanup(() => context.cleanup.run());
	const startedAt = performance.now();
	let running;
	try {
		const retentionTtlMs = options.settleMs + 1_000;
		running = spawnLongRunning(
			process.execPath,
			[
				"--expose-gc",
				"--experimental-strip-types",
				"--conditions",
				"volt-source",
				workerPath,
				"--scenario",
				scenario,
				"--root",
				context.paths.root,
				"--retention-ttl-ms",
				String(retentionTtlMs),
			],
			{ cwd: repoRoot, env: context.env },
		);
		context.cleanup.add("terminate benchmark worker", () => terminateProcessTree(running.child.pid, running.child));
		const events = new WorkerEventQueue(running.child.stdout, running.exit);
		const hello = await context.snapshotServer.waitForHello();
		assert.equal(hello.pid, running.child.pid);
		const checkpoints = [];
		const expectedCheckpoints = MEMORY_BENCHMARK_CHECKPOINTS[scenario];
		for (let checkpointIndex = 0; checkpointIndex < expectedCheckpoints.length; checkpointIndex++) {
			const expectedName = expectedCheckpoints[checkpointIndex];
			const event = await events.next();
			if (event?.type !== "checkpoint" || event.name !== expectedName || typeof event.id !== "string") {
				throw new Error(`Expected ${scenario}/${expectedName} checkpoint, received ${JSON.stringify(event)}`);
			}
			const checkpoint = await captureCheckpoint(
				context.snapshotServer,
				expectedName,
				startedAt,
				options.settleMs,
			);
			checkpoint.invariants = event.details;
			checkpoints.push(checkpoint);
			if (checkpointIndex === expectedCheckpoints.length - 1) {
				await context.snapshotServer.release();
			}
			running.child.stdin.write(`${JSON.stringify({ type: "continue", id: event.id })}\n`);
		}
		const done = await events.next();
		if (done?.type !== "done") throw new Error(`Expected ${scenario} completion, received ${JSON.stringify(done)}`);
		running.child.stdin.end();
		await waitForExit(running, WORKER_TIMEOUT_MS);
		return { checkpoints, durationMs: performance.now() - startedAt };
	} finally {
		try {
			await context.cleanup.run();
		} finally {
			setActiveCleanup(undefined);
		}
	}
}

async function runSourceCommand(args, env, cwd, label, options = {}) {
	const result = await runCapture(
		process.execPath,
		["--experimental-strip-types", "--conditions", "volt-source", sourceCliPath, ...args],
		{ cwd, env, label, ...options },
	);
	if (result.code !== 0 || result.signal) {
		throw new Error(
			result.stderr.trim() ||
				`${label} exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}`,
		);
	}
	return result;
}

async function waitForDaemonReady(context) {
	const deadline = Date.now() + 30_000;
	const logPath = join(context.paths.agentDir, "daemon", "voltd.log");
	let lastError = "daemon did not report status";
	while (Date.now() < deadline) {
		try {
			const statusResult = await runSourceCommand(
				["daemon", "status", "--json"],
				context.env,
				context.paths.workspace,
				"daemon status",
			);
			const statusLine = statusResult.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.at(-1);
			const status = JSON.parse(statusLine);
			if (existsSync(logPath)) {
				const log = readFileSync(logPath, "utf8");
				if (log.includes("failed to start iroh endpoint")) throw new Error("daemon Iroh endpoint failed to start");
				if (log.includes("iroh endpoint online") && status.running === true) {
					assert.deepEqual(status.workspaces, []);
					assert.deepEqual(status.clients, []);
					assert.deepEqual(status.leases, []);
					assert.equal(status.phoneConnections, 0);
					return status;
				}
			}
			lastError = "daemon status was healthy before the Iroh endpoint became ready";
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(lastError);
}

async function runDaemonScenario(options, setActiveCleanup) {
	const context = await createRunContext("daemon");
	setActiveCleanup(() => context.cleanup.run());
	const startedAt = performance.now();
	let daemonPid;
	let stopPromise;
	const stopDaemon = () => {
		stopPromise ??= (async () => {
			await runSourceCommand(["daemon", "stop"], context.env, context.paths.workspace, "daemon stop");
			if (daemonPid && !(await waitForProcessExit(daemonPid, PROCESS_EXIT_GRACE_MS))) {
				throw new Error(`daemon pid ${daemonPid} remained after graceful shutdown`);
			}
		})();
		return stopPromise;
	};
	context.cleanup.add("stop benchmark daemon", stopDaemon);
	try {
		await runSourceCommand(
			["daemon", "start"],
			context.env,
			context.paths.workspace,
			"daemon start",
			{
				onSpawn: (child) =>
					context.cleanup.add("terminate daemon start command", () =>
						child.exitCode === null && child.signalCode === null
							? terminateProcessTree(child.pid, child)
							: undefined,
					),
			},
		);
		const hello = await context.snapshotServer.waitForHello();
		daemonPid = hello.pid;
		const status = await waitForDaemonReady(context);
		assert.equal(status.pid, daemonPid);
		const checkpoint = await captureCheckpoint(context.snapshotServer, "idle", startedAt, options.settleMs);
		checkpoint.invariants = {
			authenticatedStatus: true,
			workspaces: status.workspaces.length,
			clients: status.clients.length,
			leases: status.leases.length,
			phoneConnections: status.phoneConnections,
		};
		await context.snapshotServer.release();
		await stopDaemon();
		return { checkpoints: [checkpoint], durationMs: performance.now() - startedAt };
	} finally {
		try {
			await context.cleanup.run();
		} finally {
			setActiveCleanup(undefined);
		}
	}
}

function assertRpcIdleState(state) {
	if (!isRecord(state)) throw new Error("RPC get_state returned no state object");
	assert.equal(state.isStreaming, false);
	assert.equal(state.isBusy, false);
	assert.equal(state.isCompacting, false);
	assert.equal(state.messageCount, 0);
	assert.equal(state.pendingMessageCount, 0);
	assert.deepEqual(state.steeringQueue, []);
	assert.deepEqual(state.followUpQueue, []);
	assert.equal(state.activeTools, undefined);
	assert.equal(state.activeCompaction, undefined);
	assert.equal(state.activeRetry, undefined);
}

async function waitForRpcResponse(stream, requestId, running) {
	let buffer = "";
	return await new Promise((resolveResponse, rejectResponse) => {
		const timeout = setTimeout(() => rejectResponse(new Error("RPC get_state timed out")), 30_000);
		const onData = (chunk) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch (error) {
					clearTimeout(timeout);
					rejectResponse(error);
					return;
				}
				if (message?.type === "response" && message.id === requestId && message.command === "get_state") {
					clearTimeout(timeout);
					stream.off("data", onData);
					resolveResponse(message);
					return;
				}
			}
		};
		stream.setEncoding("utf8");
		stream.on("data", onData);
		running.exit.then((result) => {
			clearTimeout(timeout);
			stream.off("data", onData);
			rejectResponse(new Error(`RPC exited before get_state (code ${result.code})`));
		}, rejectResponse);
	});
}

async function runRpcScenario(options, setActiveCleanup) {
	const context = await createRunContext("rpc");
	setActiveCleanup(() => context.cleanup.run());
	const startedAt = performance.now();
	let running;
	try {
		running = spawnLongRunning(
			process.execPath,
			[
				"--expose-gc",
				"--experimental-strip-types",
				"--conditions",
				"volt-source",
				sourceCliPath,
				"--mode",
				"rpc",
				"--offline",
				"--no-session",
				"--provider",
				"openai",
				"--model",
				"gpt-5.4",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-approve",
			],
			{ cwd: context.paths.workspace, env: context.env },
		);
		context.cleanup.add("terminate RPC benchmark", () => terminateProcessTree(running.child.pid, running.child));
		const hello = await context.snapshotServer.waitForHello();
		assert.equal(hello.pid, running.child.pid);
		const requestId = "memory-benchmark-ready";
		const responsePromise = waitForRpcResponse(running.child.stdout, requestId, running);
		running.child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);
		const response = await responsePromise;
		if (response.success !== true) throw new Error(response.error ?? "RPC get_state failed");
		assertRpcIdleState(response.data);
		const checkpoint = await captureCheckpoint(context.snapshotServer, "idle", startedAt, options.settleMs);
		checkpoint.invariants = { getState: "success", messageCount: response.data.messageCount };
		await context.snapshotServer.release();
		running.child.stdin.end();
		await waitForExit(running);
		return { checkpoints: [checkpoint], durationMs: performance.now() - startedAt };
	} finally {
		try {
			await context.cleanup.run();
		} finally {
			setActiveCleanup(undefined);
		}
	}
}

async function runOneScenario(scenario, options, setActiveCleanup) {
	if (scenario === "daemon-idle") return runDaemonScenario(options, setActiveCleanup);
	if (scenario === "rpc-idle") return runRpcScenario(options, setActiveCleanup);
	return runWorkerScenario(scenario, options, setActiveCleanup);
}

function flattenCheckpointMetrics(checkpoint) {
	const metrics = { "checkpoint.elapsedMs": checkpoint.elapsedMs };
	for (const [name, value] of Object.entries(checkpoint.snapshot.memory)) metrics[`memory.${name}`] = value;
	for (const [name, value] of Object.entries(checkpoint.snapshot.v8)) metrics[`v8.${name}`] = value;
	for (const [name, value] of Object.entries(checkpoint.snapshot.activeResources)) {
		metrics[`activeResources.${name}`] = value;
	}
	for (const [name, value] of Object.entries(checkpoint.snapshot.timing)) metrics[`timing.${name}`] = value;
	if (checkpoint.processTree.supported) {
		metrics["processTree.aggregateRssBytes"] = checkpoint.processTree.aggregateRssBytes;
		metrics["processTree.processCount"] = checkpoint.processTree.processCount;
	}
	return metrics;
}

function buildSummaries(runs, scenarios) {
	const summaries = {};
	for (const scenario of scenarios) {
		const measured = runs.filter((run) => run.scenario === scenario && !run.warmup);
		const checkpointSummaries = {};
		for (const checkpointName of MEMORY_BENCHMARK_CHECKPOINTS[scenario]) {
			const flattenedRuns = measured.map((run) => {
				const checkpoint = run.checkpoints.find((entry) => entry.name === checkpointName);
				if (!checkpoint) throw new Error(`Missing ${scenario}/${checkpointName} checkpoint`);
				return flattenCheckpointMetrics(checkpoint);
			});
			const metricNames = [...new Set(flattenedRuns.flatMap((metrics) => Object.keys(metrics)))].sort();
			const entries = [];
			for (const metric of metricNames) {
				const metricValues = flattenedRuns.map((metrics) =>
					metrics[metric] === undefined && metric.startsWith("activeResources.") ? 0 : metrics[metric],
				);
				if (metricValues.some((value) => value === undefined)) continue;
				entries.push([metric, summarizeMemoryBenchmarkValues(metricValues)]);
			}
			checkpointSummaries[checkpointName] = Object.fromEntries(entries);
		}
		summaries[scenario] = checkpointSummaries;
	}
	return summaries;
}

function getGitMetadata() {
	const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
	const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return {
		revision: revision.status === 0 ? revision.stdout.trim() : null,
		dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
	};
}

function createReport(options, runs) {
	const cpuList = cpus();
	const retentionTtlMs = options.settleMs + 1_000;
	const report = {
		schemaVersion: REPORT_SCHEMA_VERSION,
		kind: "volt-coding-agent-memory",
		createdAt: new Date().toISOString(),
		git: getGitMetadata(),
		runtime: {
			node: process.versions.node,
			v8: process.versions.v8,
			platform: platform(),
			arch: arch(),
			execPath: process.execPath,
		},
		host: {
			hostname: hostname(),
			osType: type(),
			osRelease: release(),
			totalMemoryBytes: totalmem(),
			cpuCount: cpuList.length,
			cpuModel: cpuList[0]?.model ?? null,
		},
		parameters: {
			scenarios: options.scenarios,
			warmupRuns: options.warmup,
			measuredRuns: options.runs,
			workload: {
				schemaVersion: 1,
				settleMs: options.settleMs,
				gcPasses: 2,
				conversation: { turns: 20, payloadBytesPerMessage: 2048 },
				reconnectRetention: { cycles: 10, ttlMs: retentionTtlMs },
				extension: { schemaVersion: 1, language: "typescript", loader: "jiti" },
				mcp: { schemaVersion: 1, transport: "stdio", calls: 1 },
				lsp: { schemaVersion: 1, transport: "stdio", queries: 1 },
			},
		},
		runs,
		summaries: {},
	};
	report.summaries = buildSummaries(runs, options.scenarios);
	return report;
}

function stableEqual(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validateReportShape(report, label) {
	if (!isRecord(report) || report.schemaVersion !== REPORT_SCHEMA_VERSION || report.kind !== "volt-coding-agent-memory") {
		throw new Error(`${label} is not a version ${REPORT_SCHEMA_VERSION} coding-agent memory report`);
	}
	if (!isRecord(report.runtime) || !isRecord(report.parameters) || !isRecord(report.parameters.workload)) {
		throw new Error(`${label} is missing compatibility metadata`);
	}
	if (!Array.isArray(report.parameters.scenarios) || !isRecord(report.summaries)) {
		throw new Error(`${label} is missing scenario summaries`);
	}
	return report;
}

export function compareMemoryBenchmarkReports(currentInput, baselineInput) {
	const current = validateReportShape(currentInput, "current report");
	const baseline = validateReportShape(baselineInput, "baseline report");
	const compatibility = [
		["Node version", current.runtime.node, baseline.runtime.node],
		["platform", current.runtime.platform, baseline.runtime.platform],
		["architecture", current.runtime.arch, baseline.runtime.arch],
		["scenario set", current.parameters.scenarios, baseline.parameters.scenarios],
		["workload", current.parameters.workload, baseline.parameters.workload],
	];
	for (const [label, currentValue, baselineValue] of compatibility) {
		if (!stableEqual(currentValue, baselineValue)) {
			throw new Error(
				`Incompatible reports: ${label} differs (current ${JSON.stringify(currentValue)}, baseline ${JSON.stringify(baselineValue)})`,
			);
		}
	}
	const deltas = [];
	for (const scenario of current.parameters.scenarios) {
		for (const checkpoint of MEMORY_BENCHMARK_CHECKPOINTS[scenario]) {
			const currentMetrics = current.summaries[scenario]?.[checkpoint];
			const baselineMetrics = baseline.summaries[scenario]?.[checkpoint];
			if (!isRecord(currentMetrics) || !isRecord(baselineMetrics)) {
				throw new Error(`Incompatible reports: missing ${scenario}/${checkpoint} summary`);
			}
			const metricNames = [...new Set([...Object.keys(currentMetrics), ...Object.keys(baselineMetrics)])].sort();
			for (const metric of metricNames) {
				let currentMedian = currentMetrics[metric]?.median;
				let baselineMedian = baselineMetrics[metric]?.median;
				if (metric.startsWith("activeResources.")) {
					currentMedian ??= 0;
					baselineMedian ??= 0;
				} else if (metric.startsWith("processTree.") && (currentMedian === undefined || baselineMedian === undefined)) {
					continue;
				}
				if (!Number.isFinite(currentMedian) || !Number.isFinite(baselineMedian)) {
					throw new Error(`Incompatible reports: metric set differs for ${scenario}/${checkpoint}/${metric}`);
				}
				const absolute = currentMedian - baselineMedian;
				deltas.push({
					scenario,
					checkpoint,
					metric,
					baseline: baselineMedian,
					current: currentMedian,
					absolute,
					percent: baselineMedian === 0 ? null : (absolute / baselineMedian) * 100,
				});
			}
		}
	}
	return deltas;
}

function metricUnit(metric) {
	if (metric.endsWith("Bytes")) return "bytes";
	if (metric.endsWith("Ms")) return "ms";
	return "count";
}

function formatBytes(value) {
	return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function printReport(report) {
	process.stdout.write("\nMemory summary (measured runs)\n");
	for (const scenario of report.parameters.scenarios) {
		process.stdout.write(`\n${scenario}\n`);
		for (const checkpoint of MEMORY_BENCHMARK_CHECKPOINTS[scenario]) {
			const metrics = report.summaries[scenario][checkpoint];
			const rss = metrics["memory.rssBytes"];
			const heap = metrics["memory.heapUsedBytes"];
			const tree = metrics["processTree.aggregateRssBytes"];
			process.stdout.write(`  ${checkpoint}\n`);
			for (const [label, summary] of [
				["root RSS", rss],
				["heap used", heap],
				["process-tree RSS", tree],
			]) {
				if (!summary) continue;
				process.stdout.write(
					`    ${label}: min ${formatBytes(summary.min)}, median ${formatBytes(summary.median)}, average ${formatBytes(summary.average)}, max ${formatBytes(summary.max)}\n`,
				);
			}
			for (const metric of Object.keys(metrics).sort()) {
				const summary = metrics[metric];
				process.stdout.write(
					`METRIC scenario=${scenario} checkpoint=${checkpoint} metric=${metric} unit=${metricUnit(metric)} min=${summary.min.toFixed(3)} median=${summary.median.toFixed(3)} average=${summary.average.toFixed(3)} max=${summary.max.toFixed(3)}\n`,
				);
			}
		}
	}
}

function printComparison(deltas) {
	process.stdout.write("\nComparison (current median versus baseline median)\n");
	for (const delta of deltas) {
		process.stdout.write(
			`COMPARE scenario=${delta.scenario} checkpoint=${delta.checkpoint} metric=${delta.metric} baseline=${delta.baseline.toFixed(3)} current=${delta.current.toFixed(3)} absolute=${delta.absolute.toFixed(3)} percent=${delta.percent === null ? "n/a" : delta.percent.toFixed(3)}\n`,
		);
	}
}

async function writeJsonReport(path, report) {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	await rename(temporaryPath, path);
}

export async function runMemoryBenchmark(options) {
	for (const path of [sourceCliPath, workerPath, preloadPath]) {
		if (!existsSync(path)) throw new Error(`Benchmark source file not found: ${path}`);
	}
	let activeCleanup;
	const setActiveCleanup = (cleanup) => {
		activeCleanup = cleanup;
	};
	let signalInProgress = false;
	const signalHandlers = new Map();
	for (const signal of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])]) {
		const handler = () => {
			if (signalInProgress) return;
			signalInProgress = true;
			Promise.resolve(activeCleanup?.())
				.catch((error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`))
				.finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
		};
		process.on(signal, handler);
		signalHandlers.set(signal, handler);
	}
	try {
		const runs = [];
		for (const scenario of options.scenarios) {
			const totalRuns = options.warmup + options.runs;
			for (let index = 0; index < totalRuns; index++) {
				const warmup = index < options.warmup;
				const measuredIndex = warmup ? null : index - options.warmup + 1;
				const label = warmup ? `warmup ${index + 1}` : `run ${measuredIndex}`;
				process.stdout.write(`[${scenario}] ${label}...\n`);
				const result = await runOneScenario(scenario, options, setActiveCleanup);
				process.stdout.write(`[${scenario}] ${label} completed in ${result.durationMs.toFixed(1)}ms\n`);
				runs.push({ scenario, warmup, run: warmup ? index + 1 : measuredIndex, ...result });
			}
		}
		const report = createReport(options, runs);
		printReport(report);
		if (options.compare) {
			const baseline = JSON.parse(await readFile(options.compare, "utf8"));
			printComparison(compareMemoryBenchmarkReports(report, baseline));
		}
		if (options.output) {
			await writeJsonReport(options.output, report);
			process.stdout.write(`\nWrote ${options.output}\n`);
		}
		return report;
	} finally {
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
	}
}

async function main() {
	const options = parseMemoryBenchmarkArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	await runMemoryBenchmark(options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
