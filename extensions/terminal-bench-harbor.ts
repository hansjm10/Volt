/**
 * Terminal-Bench Harbor integration for Volt.
 *
 * Provides /tbench helpers and ships the Harbor agent wrapper in
 * volt_tbench_harbor/agent.py.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/volt-coding-agent";

const DATASET = "terminal-bench/terminal-bench-2-1";
const AGENT_IMPORT_PATH = "volt_tbench_harbor.agent:VoltAgent";
const DEFAULT_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_TASK_LIMIT = "1";
const DEFAULT_CONCURRENT_TRIALS = "1";

type CheckStatus = "ok" | "missing" | "error";
type RunOptionName = "taskLimit" | "concurrentTrials";

interface CheckResult {
	name: string;
	command: string;
	status: CheckStatus;
	detail: string;
}

interface ModelIdentity {
	provider: string;
	id: string;
}

interface ParsedRunArgs {
	model: string | undefined;
	taskLimit: string | undefined;
	concurrentTrials: string | undefined;
	extraArgs: string[];
}

interface RunConfig {
	model: string;
	taskLimit: string;
	concurrentTrials: string;
	extraArgs: string[];
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

function getJobsDir(projectRoot: string): string {
	return path.resolve(projectRoot, "jobs", "terminal-bench-volt");
}

function getProjectVoltDir(projectRoot: string): string | undefined {
	const projectVoltDir = path.resolve(projectRoot, ".volt");
	return fs.existsSync(projectVoltDir) && fs.statSync(projectVoltDir).isDirectory() ? projectVoltDir : undefined;
}

function getInheritedAgentKwargs(projectRoot: string): string[] {
	const args = [
		"force_auth_json=true",
		"inherit_agent_dir=true",
		"tools=",
		"exclude_tools=",
	];
	const projectVoltDir = getProjectVoltDir(projectRoot);
	if (projectVoltDir) {
		args.push(`project_volt_dir=${projectVoltDir}`);
	}
	return args;
}

function splitArgs(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
}

function formatModelName(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function getDefaultModel(ctx: ExtensionCommandContext): string {
	return ctx.model ? formatModelName(ctx.model) : DEFAULT_MODEL;
}

function getModelOptions(ctx: ExtensionCommandContext): string[] {
	const availableModels = ctx.modelRegistry
		.getAvailable()
		.map(formatModelName)
		.sort((left, right) => left.localeCompare(right));
	if (availableModels.length === 0) {
		return unique([getDefaultModel(ctx), DEFAULT_MODEL]);
	}
	const preferredModels = unique([getDefaultModel(ctx), DEFAULT_MODEL]).filter((model) =>
		availableModels.includes(model),
	);
	return unique([...preferredModels, ...availableModels]);
}

function getRunOptionName(arg: string): RunOptionName | undefined {
	if (arg === "-l" || arg === "--n-tasks") return "taskLimit";
	if (arg === "-n" || arg === "--n-concurrent") return "concurrentTrials";
	return undefined;
}

function getAssignedRunOption(arg: string): { name: RunOptionName; value: string } | undefined {
	for (const [prefix, name] of [
		["-l=", "taskLimit"],
		["--n-tasks=", "taskLimit"],
		["-n=", "concurrentTrials"],
		["--n-concurrent=", "concurrentTrials"],
	] as const) {
		if (arg.startsWith(prefix)) {
			return { name, value: arg.slice(prefix.length) };
		}
	}
	return undefined;
}

function parseRunArgs(args: string[]): ParsedRunArgs {
	const [firstArg, ...restArgs] = args;
	const model = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
	const harborArgs = model ? restArgs : args;
	const parsed: ParsedRunArgs = {
		model,
		taskLimit: undefined,
		concurrentTrials: undefined,
		extraArgs: [],
	};

	for (let index = 0; index < harborArgs.length; index++) {
		const arg = harborArgs[index];
		const assigned = getAssignedRunOption(arg);
		if (assigned) {
			parsed[assigned.name] = assigned.value;
			continue;
		}

		const optionName = getRunOptionName(arg);
		if (optionName) {
			const value = harborArgs[index + 1];
			if (value && !value.startsWith("-")) {
				parsed[optionName] = value;
				index++;
			} else {
				parsed.extraArgs.push(arg);
			}
			continue;
		}

		parsed.extraArgs.push(arg);
	}

	return parsed;
}

function validatePositiveInteger(value: string, label: string, ctx: ExtensionCommandContext): string | undefined {
	const normalized = value.trim();
	if (/^[1-9]\d*$/.test(normalized)) return normalized;
	ctx.ui.notify(`${label} must be a positive integer.`, "warning");
	return undefined;
}

async function promptPositiveInteger(
	ctx: ExtensionCommandContext,
	title: string,
	defaultValue: string,
	label: string,
): Promise<string | undefined> {
	const value = await ctx.ui.input(title, defaultValue);
	if (value === undefined) return undefined;
	return validatePositiveInteger(value.trim() || defaultValue, label, ctx);
}

async function promptRunConfig(ctx: ExtensionCommandContext): Promise<RunConfig | undefined> {
	const model = await ctx.ui.select("Terminal-Bench model", getModelOptions(ctx));
	if (model === undefined) return undefined;
	const taskLimit = await promptPositiveInteger(ctx, "Terminal-Bench task limit (-l)", DEFAULT_TASK_LIMIT, "-l");
	if (taskLimit === undefined) return undefined;
	const concurrentTrials = await promptPositiveInteger(
		ctx,
		"Terminal-Bench concurrent trials (-n)",
		DEFAULT_CONCURRENT_TRIALS,
		"-n",
	);
	if (concurrentTrials === undefined) return undefined;
	return { model, taskLimit, concurrentTrials, extraArgs: [] };
}

async function getRunConfig(args: string[], ctx: ExtensionCommandContext): Promise<RunConfig | undefined> {
	if (args.length === 0 && ctx.hasUI) {
		return promptRunConfig(ctx);
	}

	const parsed = parseRunArgs(args);
	const model = (parsed.model ?? getDefaultModel(ctx)).trim();
	if (!model) {
		ctx.ui.notify("Model is required.", "warning");
		return undefined;
	}
	const taskLimit = validatePositiveInteger(parsed.taskLimit ?? DEFAULT_TASK_LIMIT, "-l", ctx);
	if (taskLimit === undefined) return undefined;
	const concurrentTrials = validatePositiveInteger(parsed.concurrentTrials ?? DEFAULT_CONCURRENT_TRIALS, "-n", ctx);
	if (concurrentTrials === undefined) return undefined;
	return { model, taskLimit, concurrentTrials, extraArgs: parsed.extraArgs };
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

function getHarborArgs(projectRoot: string, model: string, extraArgs: string[] = []): string[] {
	return [
		"run",
		"-d",
		DATASET,
		"--agent-import-path",
		AGENT_IMPORT_PATH,
		"-m",
		model,
		"--jobs-dir",
		getJobsDir(projectRoot),
		...getInheritedAgentKwargs(projectRoot).flatMap((arg) => ["--agent-kwarg", arg]),
		"--yes",
		...extraArgs,
	];
}

function renderCommand(projectRoot: string, model: string, taskLimit: string, concurrentTrials: string): string {
	const packageRoot = getPackageRoot();
	const jobsDir = getJobsDir(projectRoot);
	const inheritedKwargs = getInheritedAgentKwargs(projectRoot);
	const posix = [
		`cd ${quotePosix(packageRoot)} && \\`,
		"harbor run \\",
		`  -d ${DATASET} \\`,
		`  --agent-import-path ${AGENT_IMPORT_PATH} \\`,
		`  -m ${quotePosix(model)} \\`,
		...inheritedKwargs.map((arg) => `  --agent-kwarg ${quotePosix(arg)} \\`),
		"  --agent-kwarg source_ref=main \\",
		`  --jobs-dir ${quotePosix(jobsDir)} \\`,
		`  -l ${quotePosix(taskLimit)} \\`,
		`  -n ${quotePosix(concurrentTrials)} \\`,
		"  --yes",
	].join("\n");
	const powershell = [
		`Push-Location ${quotePowerShell(packageRoot)}`,
		"harbor run `",
		`  -d ${DATASET} \``,
		`  --agent-import-path ${AGENT_IMPORT_PATH} \``,
		`  -m ${quotePowerShell(model)} \``,
		...inheritedKwargs.map((arg) => `  --agent-kwarg ${quotePowerShell(arg)} \``),
		"  --agent-kwarg source_ref=main `",
		`  --jobs-dir ${quotePowerShell(jobsDir)} \``,
		`  -l ${quotePowerShell(taskLimit)} \``,
		`  -n ${quotePowerShell(concurrentTrials)} \``,
		"  --yes",
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
			const [action = "command", ...rest] = splitArgs(rawArgs);
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
				const config = await getRunConfig(rest, ctx);
				if (config === undefined) return;
				ctx.ui.notify(renderCommand(ctx.cwd, config.model, config.taskLimit, config.concurrentTrials), "info");
				return;
			}

			if (action === "adapter") {
				ctx.ui.notify(`Run Harbor from ${getPackageRoot()} with --agent-import-path ${AGENT_IMPORT_PATH}`, "info");
				return;
			}

			if (action === "oracle") {
				await runTbenchCommand(
					volt,
					ctx,
					[
						"run",
						"-d",
						DATASET,
						"-a",
						"oracle",
						"--jobs-dir",
						getJobsDir(ctx.cwd),
						"-l",
						"1",
						"-n",
						"1",
						"--yes",
						...rest,
					],
					3_600_000,
				);
				return;
			}

			if (action === "smoke") {
				const config = await getRunConfig(rest, ctx);
				if (config === undefined) return;
				await runTbenchCommand(
					volt,
					ctx,
					getHarborArgs(ctx.cwd, config.model, [
						"-l",
						config.taskLimit,
						"-n",
						config.concurrentTrials,
						...config.extraArgs,
					]),
					3_600_000,
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /tbench doctor | command [model] [-l tasks] [-n concurrent] | adapter | oracle [harbor args] | smoke [model] [-l tasks] [-n concurrent] [harbor args]",
				"warning",
			);
		},
	});
}
