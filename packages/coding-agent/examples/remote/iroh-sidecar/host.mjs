import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(sidecarDir, "..", "..", "..");
const sourceHostScript = join(packageDir, "src", "remote", "iroh-host.mjs");
const distHostScript = join(packageDir, "dist", "remote", "iroh-host.mjs");
const sourceIndex = join(packageDir, "src", "index.ts");

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const hostScript = (await pathExists(sourceHostScript)) ? sourceHostScript : distHostScript;
const conditionArgs = (await pathExists(sourceIndex)) ? ["--conditions", "volt-source"] : [];
const child = spawn(process.execPath, [...conditionArgs, hostScript, ...process.argv.slice(2)], {
	cwd: process.cwd(),
	stdio: "inherit",
});

child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

child.once("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exitCode = code ?? 0;
});
