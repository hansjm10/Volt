#!/usr/bin/env node
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sidecarDir = join(repoRoot, "packages", "coding-agent", "examples", "remote", "iroh-sidecar");
const hostScript = join(sidecarDir, "host.mjs");
const clientScript = join(sidecarDir, "client.mjs");
const irohPackageJson = join(sidecarDir, "node_modules", "@number0", "iroh", "package.json");
const SOURCE_IMPORT_CONDITION_ARGS = ["--conditions", "volt-source"];

async function assertInstalled() {
	try {
		await access(irohPackageJson);
	} catch {
		throw new Error("Iroh sidecar dependencies are not installed. Run: npm run iroh:poc:install");
	}
}

function collectProcess(child) {
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

function waitForExit(child, label) {
	return new Promise((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolveExit();
				return;
			}
			rejectExit(new Error(`${label} exited with ${signal ?? code}`));
		});
	});
}

async function waitForFirstStdoutLine(child, output, label) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 10_000) {
		const newlineIndex = output.stdout.indexOf("\n");
		if (newlineIndex !== -1) {
			return output.stdout.slice(0, newlineIndex).trim();
		}
		if (child.exitCode !== null) {
			throw new Error(`${label} exited before printing a ticket:\n${output.stderr}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`${label} did not print a ticket within 10s:\n${output.stderr}`);
}

async function runClient(ticket, clientStatePath) {
	const client = spawn(
		process.execPath,
		[
			...SOURCE_IMPORT_CONDITION_ARGS,
			clientScript,
			ticket,
			"--state",
			clientStatePath,
			"--message",
			"smoke",
			"--timeout-ms",
			"10000",
		],
		{
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const output = collectProcess(client);
	await waitForExit(client, "client").catch((error) => {
		throw new Error(`${error.message}\n${output.stderr}`);
	});
	return output;
}

async function main() {
	await assertInstalled();
	const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-sidecar-smoke-"));
	const hostStatePath = join(stateDir, "host.json");
	const clientStatePath = join(stateDir, "client.json");
	let host;
	try {
		host = spawn(process.execPath, [...SOURCE_IMPORT_CONDITION_ARGS, hostScript, "--state", hostStatePath, "--once"], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const hostOutput = collectProcess(host);
		const ticket = await waitForFirstStdoutLine(host, hostOutput, "host");
		const clientOutput = await runClient(ticket, clientStatePath);
		await waitForExit(host, "host").catch((error) => {
			throw new Error(`${error.message}\n${hostOutput.stderr}`);
		});

		const expected = "fake RPC response over Iroh: smoke";
		if (!clientOutput.stdout.includes(expected)) {
			throw new Error(`Expected client output to contain ${JSON.stringify(expected)}, got:\n${clientOutput.stdout}`);
		}
		console.log(clientOutput.stdout.trim());
		console.log("Iroh sidecar smoke test passed.");
	} finally {
		if (host && host.exitCode === null) host.kill();
		await rm(stateDir, { force: true, recursive: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
