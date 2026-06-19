#!/usr/bin/env node
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const requireModule = createRequire(import.meta.url);
const sidecarDir = join(repoRoot, "packages", "coding-agent", "examples", "remote", "iroh-sidecar");
const hostScript = join(repoRoot, "packages", "coding-agent", "src", "remote", "iroh-host.mjs");
const SOURCE_IMPORT_CONDITION_ARGS = ["--conditions", "volt-source"];

async function assertClientNativeDependencyInstalled() {
	try {
		requireModule("@number0/iroh/index.js");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error("The optional @number0/iroh native adapter is not available.");
		console.error(`Native adapter error: ${detail}`);
		console.error("Run from the repository root:");
		console.error("  npm run iroh:poc:install");
		console.error("Then retry on a platform supported by @number0/iroh.");
		process.exit(1);
	}
}

function resolveEntrypoint(command) {
	if (command === "host") return hostScript;
	if (command === "client") return join(sidecarDir, "client.mjs");
	throw new Error(`Unknown Iroh remote command: ${command}`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!command) {
		console.error("Usage: node scripts/iroh-sidecar-run.mjs <host|client> [...args]");
		process.exit(1);
	}

	const entrypoint = resolveEntrypoint(command);
	if (command === "host") {
		await access(hostScript);
	} else if (command === "client") {
		await assertClientNativeDependencyInstalled();
	}
	const child = spawn(process.execPath, [...SOURCE_IMPORT_CONDITION_ARGS, entrypoint, ...args], {
		cwd: repoRoot,
		stdio: "inherit",
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

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
