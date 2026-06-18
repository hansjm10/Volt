#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sidecarDir = join(repoRoot, "packages", "coding-agent", "examples", "remote", "iroh-sidecar");
const irohPackageJson = join(sidecarDir, "node_modules", "@number0", "iroh", "package.json");
const SOURCE_IMPORT_CONDITION_ARGS = ["--conditions", "volt-source"];

async function assertInstalled() {
	try {
		await access(irohPackageJson);
	} catch {
		console.error("Iroh sidecar dependencies are not installed.");
		console.error("Run from the repository root:");
		console.error("  npm run iroh:poc:install");
		process.exit(1);
	}
}

function resolveEntrypoint(command) {
	if (command === "host") return join(sidecarDir, "host.mjs");
	if (command === "client") return join(sidecarDir, "client.mjs");
	throw new Error(`Unknown Iroh sidecar command: ${command}`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!command) {
		console.error("Usage: node scripts/iroh-sidecar-run.mjs <host|client> [...args]");
		process.exit(1);
	}

	await assertInstalled();
	const entrypoint = resolveEntrypoint(command);
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
