#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const hostScript = join(repoRoot, "packages", "coding-agent", "src", "remote", "iroh-host.mjs");
const sourceCliScript = join(repoRoot, "scripts", "run-coding-agent-source.mjs");
const SOURCE_IMPORT_CONDITION_ARGS = ["--conditions", "volt-source"];

function resolveCommand(command) {
	if (command === "host") return { entrypoint: hostScript, prefixArgs: [] };
	if (command === "client") return { entrypoint: sourceCliScript, prefixArgs: ["remote", "client"] };
	throw new Error(`Unknown Iroh remote command: ${command}`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!command) {
		console.error("Usage: node scripts/iroh-sidecar-run.mjs <host|client> [...args]");
		process.exit(1);
	}

	const resolved = resolveCommand(command);
	if (command === "host") {
		await access(hostScript);
	} else if (command === "client") {
		await access(sourceCliScript);
	}
	const child = spawn(process.execPath, [...SOURCE_IMPORT_CONDITION_ARGS, resolved.entrypoint, ...resolved.prefixArgs, ...args], {
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
