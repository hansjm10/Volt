import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarDir = dirname(fileURLToPath(import.meta.url));
const sourceIndex = join(sidecarDir, "..", "..", "..", "src", "index.ts");

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const [entrypoint, ...args] = process.argv.slice(2);
if (!entrypoint) {
	console.error("Missing sidecar entrypoint");
	process.exit(1);
}

const conditionArgs = (await pathExists(sourceIndex)) ? ["--conditions", "volt-source"] : [];
const child = spawn(process.execPath, [...conditionArgs, join(sidecarDir, entrypoint), ...args], {
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
