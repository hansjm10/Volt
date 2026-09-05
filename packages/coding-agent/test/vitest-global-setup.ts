import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const TEST_AGENT_DIR_PREFIX = "volt-coding-agent-vitest-";

function requireTestAgentDir(project: TestProject): string {
	const configured = project.config.env.VOLT_CODING_AGENT_DIR;
	if (!configured) throw new Error("Coding-agent tests require an isolated VOLT_CODING_AGENT_DIR");
	if (project.config.env.VOLT_CODING_AGENT_SESSION_DIR !== "") {
		throw new Error("Coding-agent tests must neutralize VOLT_CODING_AGENT_SESSION_DIR");
	}

	const tempRoot = resolve(tmpdir());
	const agentDir = resolve(configured);
	const relativePath = relative(tempRoot, agentDir);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath) ||
		!basename(agentDir).startsWith(TEST_AGENT_DIR_PREFIX)
	) {
		throw new Error(`Refusing to manage unsafe Vitest agent directory: ${agentDir}`);
	}
	return agentDir;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const agentDir = requireTestAgentDir(project);
	await mkdir(agentDir, { mode: 0o700 });
	await chmod(agentDir, 0o700);

	const cleanup = async () => {
		await rm(agentDir, {
			recursive: true,
			force: true,
			...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 50 } : {}),
		});
	};

	try {
		// Compile the shared Jiti source cache before parallel workers contend for
		// CPU. CLI behavior tests keep their existing per-process deadlines.
		const warmupDir = resolve(agentDir, "source-cli-warmup");
		await mkdir(warmupDir, { mode: 0o700 });
		await promisify(execFile)(
			process.execPath,
			[fileURLToPath(new URL("./source-cli-runner.mjs", import.meta.url)), "--version"],
			{
				cwd: warmupDir,
				env: {
					...process.env,
					VOLT_CODING_AGENT_DIR: warmupDir,
					VOLT_CODING_AGENT_SESSION_DIR: "",
					VOLT_OFFLINE: "1",
				},
				timeout: 50_000,
				killSignal: "SIGKILL",
			},
		);
		await rm(warmupDir, { recursive: true, force: true });
	} catch (error) {
		await cleanup();
		throw error;
	}

	return cleanup;
}
