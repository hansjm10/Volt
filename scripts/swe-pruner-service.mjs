#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function envValue(name, fallback) {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : fallback;
}

function envFlag(name, fallback) {
	const value = process.env[name];
	if (!value || !value.trim()) return fallback;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveFromRepo(path) {
	return resolve(repoRoot, path);
}

function resolveFromSwePrunerDir(swePrunerDir, path) {
	return resolve(swePrunerDir, path);
}

async function assertExists(path, label, mode = constants.R_OK) {
	try {
		await access(path, mode);
	} catch {
		console.error(`${label} not found or not accessible: ${path}`);
		process.exit(1);
	}
}

function readConfig() {
	return {
		swePrunerDir: resolveFromRepo(envValue("SWE_PRUNER_DIR", "../swe-pruner/swe-pruner")),
		swePrunerBin: resolveFromRepo(envValue("SWE_PRUNER_BIN", "../swe-pruner/.venv/bin/swe-pruner")),
		backend: envValue("SWE_PRUNER_BACKEND", "coreai"),
		modelPath: envValue("SWE_PRUNER_MODEL_PATH", "./model"),
		coreAiModelPath: envValue("SWE_PRUNER_COREAI_MODEL_PATH", "./swe-pruner.aimodel"),
		host: envValue("SWE_PRUNER_HOST", "127.0.0.1"),
		port: envValue("SWE_PRUNER_PORT", "8000"),
		maxLength: envValue("SWE_PRUNER_MAX_LENGTH", "8192"),
		dynamicSequenceLength: envFlag("SWE_PRUNER_DYNAMIC_SEQUENCE_LENGTH", true),
		coreAiFunctionName: envValue("SWE_PRUNER_COREAI_FUNCTION_NAME", "main"),
		logPath: resolveFromRepo(envValue("SWE_PRUNER_LOG", ".volt/swe-pruner.log")),
	};
}

function runOutput(command, args) {
	return new Promise((resolveResult, rejectResult) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", rejectResult);
		child.once("exit", (code) => {
			resolveResult({ code: code ?? 0, stdout, stderr });
		});
	});
}

async function healthCheck(host, port) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2000);
	try {
		const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
		if (!response.ok) return undefined;
		const payload = await response.json();
		if (!payload || typeof payload !== "object") return undefined;
		if (!("backend" in payload) || !("model_loaded" in payload)) return undefined;
		return payload;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

async function startService(background) {
	const config = readConfig();

	await assertExists(config.swePrunerDir, "SWE-Pruner directory");
	await assertExists(config.swePrunerBin, "SWE-Pruner CLI", constants.X_OK);
	await assertExists(resolveFromSwePrunerDir(config.swePrunerDir, config.modelPath), "SWE-Pruner model directory");

	const args = [
		"--backend",
		config.backend,
		"--model-path",
		config.modelPath,
		"--host",
		config.host,
		"--port",
		config.port,
		"--max-length",
		config.maxLength,
	];
	if (config.backend === "coreai") {
		await assertExists(
			resolveFromSwePrunerDir(config.swePrunerDir, config.coreAiModelPath),
			"SWE-Pruner Core AI model",
		);
		args.push("--coreai-model-path", config.coreAiModelPath, "--coreai-function-name", config.coreAiFunctionName);
		if (config.dynamicSequenceLength) {
			args.push("--dynamic-sequence-length");
		}
	}

	console.log(`Starting SWE-Pruner ${config.backend} service on ${config.host}:${config.port}`);
	console.log(`SWE-Pruner directory: ${config.swePrunerDir}`);

	if (background) {
		const health = await healthCheck(config.host, config.port);
		if (health) {
			console.log(`SWE-Pruner service is already running at http://${config.host}:${config.port}/health`);
			return;
		}

		await mkdir(dirname(config.logPath), { recursive: true });
		const logFile = await open(config.logPath, "a");
		const child = spawn(config.swePrunerBin, args, {
			cwd: config.swePrunerDir,
			detached: true,
			stdio: ["ignore", logFile.fd, logFile.fd],
			env: process.env,
		});
		child.unref();
		await logFile.close();

		console.log(`Started SWE-Pruner service in the background (pid ${child.pid})`);
		console.log(`Logs: ${config.logPath}`);
		return;
	}

	const child = spawn(config.swePrunerBin, args, {
		cwd: config.swePrunerDir,
		stdio: "inherit",
		env: process.env,
	});
	child.once("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
	child.once("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 0);
	});
}

async function stopService() {
	const { host, port } = readConfig();
	const health = await healthCheck(host, port);
	if (!health) {
		console.log(`No SWE-Pruner service found at http://${host}:${port}/health`);
		return;
	}

	const result = await runOutput("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
	const pids = result.stdout
		.split(/\s+/)
		.map((value) => value.trim())
		.filter(Boolean);
	if (pids.length === 0) {
		console.log(`SWE-Pruner responded on ${host}:${port}, but no listening process was found with lsof.`);
		return;
	}

	for (const pid of pids) {
		process.kill(Number(pid), "SIGTERM");
	}
	console.log(`Stopped SWE-Pruner service on ${host}:${port} (pid${pids.length === 1 ? "" : "s"} ${pids.join(", ")})`);
}

async function main() {
	const command = process.argv[2] ?? "start";
	const background = process.argv.slice(3).includes("--background");
	if (command === "start") {
		await startService(background);
		return;
	}
	if (command === "stop") {
		await stopService();
		return;
	}
	console.error("Usage: node scripts/swe-pruner-service.mjs <start|stop> [--background]");
	process.exit(1);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
