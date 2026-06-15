/**
 * Terminal-Bench Harbor integration for Volt.
 *
 * Provides /tbench helpers and ships the Harbor agent wrapper in
 * volt_tbench_harbor/agent.py.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/volt-coding-agent";

const DATASET = "terminal-bench/terminal-bench-2-1";
const AGENT_IMPORT_PATH = "volt_tbench_harbor.agent:VoltAgent";
const DEFAULT_MODEL = "openai/gpt-4o";

type CheckStatus = "ok" | "missing" | "error";

interface CheckResult {
	name: string;
	command: string;
	status: CheckStatus;
	detail: string;
}

function getPackageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function quotePosix(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function getJobsDir(): string {
	return path.resolve(process.cwd(), "jobs", "terminal-bench-volt");
}

function splitArgs(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
}

function truncateOutput(text: string, limit = 2400): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n... truncated ...`;
}

function summarizeExec(result: ExecResult): string {
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	const prefix = `exit ${result.code}${result.killed ? " (killed)" : ""}`;
	return output ? `${prefix}\n${truncateOutput(output)}` : prefix;
}

function getHarborArgs(model: string, extraArgs: string[] = []): string[] {
	return [
		"run",
		"-d",
		DATASET,
		"--agent-import-path",
		AGENT_IMPORT_PATH,
		"-m",
		model,
		"--jobs-dir",
		getJobsDir(),
		...extraArgs,
	];
}

function renderCommand(model: string): string {
	const packageRoot = getPackageRoot();
	const jobsDir = getJobsDir();
	const posix = [
		`cd ${quotePosix(packageRoot)} && \\`,
		"harbor run \\",
		`  -d ${DATASET} \\`,
		`  --agent-import-path ${AGENT_IMPORT_PATH} \\`,
		`  -m ${quotePosix(model)} \\`,
		"  --agent-env OPENAI_API_KEY=$OPENAI_API_KEY \\",
		"  --agent-kwarg source_ref=main \\",
		`  --jobs-dir ${quotePosix(jobsDir)} \\`,
		"  -l 1 \\",
		"  -n 1",
	].join("\n");
	const powershell = [
		`Push-Location ${quotePowerShell(packageRoot)}`,
		"harbor run `",
		`  -d ${DATASET} \``,
		`  --agent-import-path ${AGENT_IMPORT_PATH} \``,
		`  -m ${quotePowerShell(model)} \``,
		'  --agent-env "OPENAI_API_KEY=$env:OPENAI_API_KEY" `',
		"  --agent-kwarg source_ref=main `",
		`  --jobs-dir ${quotePowerShell(jobsDir)} \``,
		"  -l 1 `",
		"  -n 1",
		"Pop-Location",
	].join("\n");
	return [`PowerShell:\n${powershell}`, `sh:\n${posix}`].join("\n\n");
}

async function checkCommand(volt: ExtensionAPI, name: string, command: string, args: string[]): Promise<CheckResult> {
	try {
		const result = await volt.exec(command, args, { timeout: 10_000 });
		const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join(" ");
		return {
			name,
			command: [command, ...args].join(" "),
			status: result.code === 0 ? "ok" : "error",
			detail: truncateOutput(output || `exit ${result.code}`, 500),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { name, command: [command, ...args].join(" "), status: "missing", detail: message };
	}
}

function formatChecks(checks: CheckResult[]): string {
	return checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n");
}

async function runTbenchCommand(
	volt: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
	timeout: number,
): Promise<void> {
	ctx.ui.setStatus("tbench", ctx.ui.theme.fg("accent", "tbench: running"));
	try {
		const result = await volt.exec("harbor", args, {
			cwd: getPackageRoot(),
			timeout,
			signal: ctx.signal,
		});
		const message = summarizeExec(result);
		ctx.ui.notify(message, result.code === 0 ? "info" : "error");
	} finally {
		ctx.ui.setStatus("tbench", undefined);
	}
}

export default function terminalBenchHarbor(volt: ExtensionAPI) {
	volt.registerCommand("tbench", {
		description: "Terminal-Bench Harbor helpers for Volt",
		handler: async (rawArgs, ctx) => {
			const [action = "command", model = DEFAULT_MODEL, ...rest] = splitArgs(rawArgs);
			if (action === "doctor") {
				const checks = await Promise.all([
					checkCommand(volt, "harbor", "harbor", ["--version"]),
					checkCommand(volt, "docker", "docker", ["--version"]),
					checkCommand(volt, "volt", "volt", ["--version"]),
					checkCommand(volt, "node", "node", ["--version"]),
				]);
				ctx.ui.notify(formatChecks(checks), checks.every((check) => check.status === "ok") ? "info" : "warning");
				return;
			}

			if (action === "command") {
				ctx.ui.notify(renderCommand(model), "info");
				return;
			}

			if (action === "adapter") {
				ctx.ui.notify(`Run Harbor from ${getPackageRoot()} with --agent-import-path ${AGENT_IMPORT_PATH}`, "info");
				return;
			}

			if (action === "oracle") {
				await runTbenchCommand(volt, ctx, ["run", "-d", DATASET, "-a", "oracle", "--jobs-dir", getJobsDir(), "-l", "1", "-n", "1", ...rest], 3_600_000);
				return;
			}

			if (action === "smoke") {
				await runTbenchCommand(volt, ctx, getHarborArgs(model, ["-l", "1", "-n", "1", ...rest]), 3_600_000);
				return;
			}

			ctx.ui.notify("Usage: /tbench doctor | command [model] | adapter | oracle [harbor args] | smoke [model] [harbor args]", "warning");
		},
	});
}
