#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SWEBENCH_DATASET = "SWE-bench/SWE-bench_Verified";
export const SWEBENCH_REVISION = "d9e75108aeb7563efa25064099670058d0ab2121";
export const DEFAULT_INSTANCE = "sympy__sympy-20590";
export const DEFAULT_THINKING = "high";
export const DEFAULT_TIMEOUT_SECONDS = 1_800;
export const DEFAULT_PYTHON = "python3";
export const DEFAULT_TOOLS = "read,bash,edit,write,grep,find,ls";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MODEL_PATTERN = /^openai-codex\/[A-Za-z0-9._-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/;
const METADATA_SCRIPT = `
import json
import sys
from swebench.harness.utils import load_swebench_dataset

instance_id = sys.argv[1]
rows = load_swebench_dataset(${JSON.stringify(SWEBENCH_DATASET)}, "test", [instance_id])
if len(rows) != 1:
    raise RuntimeError(f"expected one instance for {instance_id}, received {len(rows)}")
row = rows[0]
print(json.dumps({key: row[key] for key in ("instance_id", "image", "problem_statement")}))
`;
const PYTHON_PREFLIGHT_SCRIPT = `
from swebench.harness.utils import load_swebench_dataset
import swebench.harness.run_evaluation
print("swebench-ok")
`;

export class CommandError extends Error {
	constructor(message, result) {
		super(message);
		this.name = "CommandError";
		this.result = result;
	}
}

export class CleanupStack {
	#tasks = [];
	#promise;

	add(label, task) {
		this.#tasks.push({ label, task });
	}

	run() {
		if (this.#promise) return this.#promise;
		this.#promise = (async () => {
			const errors = [];
			for (const { label, task } of [...this.#tasks].reverse()) {
				try {
					await task();
				} catch (error) {
					errors.push(new Error(`${label}: ${formatError(error)}`, { cause: error }));
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "SWE-bench cleanup failed");
		})();
		return this.#promise;
	}
}

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, flag, maximum = 86_400) {
	if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new Error(`${flag} must be between 1 and ${maximum}`);
	}
	return parsed;
}

function expandHome(path, home) {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function safeSlug(value) {
	const slug = value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
	return slug || "run";
}

export function createRunId(instanceId, date = new Date(), suffix = randomBytes(3).toString("hex")) {
	const timestamp = date.toISOString().replaceAll(/[-:]/g, "").replace(".000", "").replace("Z", "z");
	return `volt-${safeSlug(instanceId)}-${timestamp}-${safeSlug(suffix)}`;
}

export function formatHelp() {
	return `Usage:
  npm run benchmark:swebench -- --volt-dir <dir> --model openai-codex/<id> [options]

Required:
  --volt-dir <dir>          Extracted Linux x64 standalone directory containing volt
  --model <provider/id>     Exact OpenAI Codex model (must start with openai-codex/)

Options:
  --instance <id>           SWE-bench Verified instance (default: ${DEFAULT_INSTANCE})
  --thinking <level>        off|minimal|low|medium|high|xhigh|max (default: ${DEFAULT_THINKING})
  --timeout-seconds <n>     Volt wall timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --auth-file <path>        Source Volt auth.json (default: ~/.volt/agent/auth.json)
  --python <command>        Python with the pinned SWE-bench package (default: ${DEFAULT_PYTHON})
  --output-dir <path>       Artifact directory (default: swebench-output/<generated-run-id>)
  --help, -h                Show this help

This v1 runner supports one sequential task on Linux x64. It uses only the stored
openai-codex OAuth entry; API-key inputs are intentionally unsupported.
`;
}

export function parseArgs(argv, context = {}) {
	const cwd = context.cwd ?? process.cwd();
	const home = context.home ?? homedir();
	let instance = DEFAULT_INSTANCE;
	let thinking = DEFAULT_THINKING;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let authFile = join(home, ".volt", "agent", "auth.json");
	let python = DEFAULT_PYTHON;
	let outputDir;
	let voltDir;
	let model;
	let help = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (
			![
				"--volt-dir",
				"--model",
				"--instance",
				"--thinking",
				"--timeout-seconds",
				"--auth-file",
				"--python",
				"--output-dir",
			].includes(argument)
		) {
			throw new Error(`Unknown option: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		index += 1;
		if (argument === "--volt-dir") voltDir = resolve(cwd, expandHome(value, home));
		if (argument === "--model") model = value;
		if (argument === "--instance") instance = value;
		if (argument === "--thinking") thinking = value;
		if (argument === "--timeout-seconds") timeoutSeconds = parsePositiveInteger(value, argument);
		if (argument === "--auth-file") authFile = resolve(cwd, expandHome(value, home));
		if (argument === "--python") python = value;
		if (argument === "--output-dir") outputDir = resolve(cwd, expandHome(value, home));
	}

	if (help) return { help: true };
	if (!voltDir) throw new Error("--volt-dir is required");
	if (!model) throw new Error("--model is required");
	if (!MODEL_PATTERN.test(model) || model.endsWith("/")) {
		throw new Error("--model must be an exact openai-codex/<id> value");
	}
	if (!INSTANCE_ID_PATTERN.test(instance)) throw new Error(`Invalid --instance: ${instance}`);
	if (!THINKING_LEVELS.has(thinking)) throw new Error(`Invalid --thinking: ${thinking}`);
	if (!python.trim()) throw new Error("--python requires a non-empty command");

	const runId = createRunId(instance, context.now, context.suffix);
	return {
		help: false,
		voltDir,
		model,
		instance,
		thinking,
		timeoutSeconds,
		authFile,
		python,
		runId,
		outputDir: outputDir ?? resolve(cwd, "swebench-output", runId),
	};
}

export function parseInstanceMetadata(output, expectedInstanceId) {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length !== 1) throw new Error("SWE-bench metadata command returned malformed output");
	let value;
	try {
		value = JSON.parse(lines[0]);
	} catch (error) {
		throw new Error("SWE-bench metadata command did not return JSON", { cause: error });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("SWE-bench metadata must be an object");
	}
	const keys = Object.keys(value).sort();
	const expectedKeys = ["image", "instance_id", "problem_statement"];
	if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
		throw new Error(`SWE-bench metadata fields must be exactly ${expectedKeys.join(", ")}`);
	}
	if (value.instance_id !== expectedInstanceId) throw new Error("SWE-bench returned the wrong instance");
	if (typeof value.image !== "string" || !value.image.trim() || /[\r\n]/.test(value.image)) {
		throw new Error("SWE-bench instance image is invalid");
	}
	if (typeof value.problem_statement !== "string" || !value.problem_statement.trim()) {
		throw new Error("SWE-bench problem statement is empty");
	}
	return {
		instanceId: value.instance_id,
		image: value.image,
		problemStatement: value.problem_statement,
	};
}

export function buildPrompt(problemStatement) {
	if (typeof problemStatement !== "string" || !problemStatement.trim()) {
		throw new Error("problem statement must be non-empty");
	}
	return `Resolve the following SWE-bench issue in the repository in your current working directory.

Inspect the repository, implement the complete fix, and run focused tests when useful. Modify the working tree; do not only describe a solution. Do not use web tools, fetch remote commits, or look up the issue or its solution externally.

Issue:
${problemStatement.trim()}
`;
}

export function isolateCodexAuth(authData) {
	if (!authData || typeof authData !== "object" || Array.isArray(authData)) {
		throw new Error("auth.json must contain an object");
	}
	const credential = authData["openai-codex"];
	if (!credential || typeof credential !== "object" || Array.isArray(credential) || credential.type !== "oauth") {
		throw new Error('auth.json must contain an OAuth credential at "openai-codex"');
	}
	if (typeof credential.access !== "string" || !credential.access) {
		throw new Error("OpenAI Codex OAuth credential is missing its access token");
	}
	if (typeof credential.refresh !== "string" || !credential.refresh) {
		throw new Error("OpenAI Codex OAuth credential is missing its refresh token");
	}
	return { "openai-codex": structuredClone(credential) };
}

export function collectCredentialSecrets(value, secrets = new Set()) {
	if (typeof value === "string") {
		if (value.length >= 8 && value !== "openai-codex") secrets.add(value);
		return [...secrets].sort((left, right) => right.length - left.length);
	}
	if (Array.isArray(value)) {
		for (const item of value) collectCredentialSecrets(item, secrets);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectCredentialSecrets(item, secrets);
	}
	return [...secrets].sort((left, right) => right.length - left.length);
}

export function redactText(text, secrets) {
	let redacted = text;
	for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
	return redacted;
}

function assertMountPath(path, label) {
	if (path.includes(",") || /[\r\n]/.test(path)) {
		throw new Error(`${label} cannot contain commas or newlines because Docker --mount cannot represent it safely`);
	}
}

export function buildDockerCreateArgs({ containerName, image, voltDir, authDir, outputDir }) {
	for (const [path, label] of [
		[voltDir, "Volt directory"],
		[authDir, "temporary auth directory"],
		[outputDir, "output directory"],
	]) {
		assertMountPath(path, label);
	}
	return [
		"create",
		"--name",
		containerName,
		"--user",
		"root",
		"--cap-add",
		"SYS_ADMIN",
		"--mount",
		`type=bind,src=${voltDir},dst=/opt/volt,readonly`,
		"--mount",
		`type=bind,src=${authDir},dst=/volt-agent`,
		"--mount",
		`type=bind,src=${outputDir},dst=/volt-run,readonly`,
		image,
		"tail",
		"-f",
		"/dev/null",
	];
}

export function buildVoltExecArgs({ containerName, model, thinking }) {
	return [
		"exec",
		"--workdir",
		"/testbed",
		"--env",
		"VOLT_CODING_AGENT_DIR=/volt-agent",
		"--env",
		"VOLT_OFFLINE=1",
		"--env",
		"VOLT_SKIP_VERSION_CHECK=1",
		"--env",
		"VOLT_TELEMETRY=0",
		containerName,
		"/opt/volt/volt",
		"-p",
		"--offline",
		"--no-session",
		"--no-context-files",
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--tools",
		DEFAULT_TOOLS,
		"--model",
		model,
		"--thinking",
		thinking,
		"@/volt-run/prompt.md",
	];
}

export function buildEvaluatorArgs({ predictionsPath, runId, instanceId, reportDir }) {
	return [
		"-m",
		"swebench.harness.run_evaluation",
		"--dataset_name",
		SWEBENCH_DATASET,
		"--predictions_path",
		predictionsPath,
		"--max_workers",
		"1",
		"--run_id",
		runId,
		"--instance_ids",
		instanceId,
		"--report_dir",
		reportDir,
	];
}

export function createPrediction(instanceId, model, patch) {
	return {
		instance_id: instanceId,
		model_name_or_path: `volt-${safeSlug(model)}`,
		model_patch: patch,
	};
}

function terminateChild(child) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	setTimeout(() => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, 1_000).unref();
}

export function runCommand(executable, args, options = {}) {
	return new Promise((resolveCommand, rejectCommand) => {
		if (options.signal?.aborted) {
			rejectCommand(new CommandError(`${options.label ?? executable} was aborted`, { stdout: "", stderr: "", aborted: true }));
			return;
		}
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			detached: process.platform !== "win32",
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const timeout =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
					timedOut = true;
					terminateChild(child);
				}, options.timeoutMs);
		const onAbort = () => {
			aborted = true;
			terminateChild(child);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (options.tee) process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (options.tee) process.stderr.write(chunk);
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			rejectCommand(new CommandError(`${options.label ?? executable} failed to start: ${error.message}`, { stdout, stderr, error }));
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			const result = { code: code ?? 0, signal, stdout, stderr, timedOut, aborted };
			if (timedOut) {
				rejectCommand(new CommandError(`${options.label ?? executable} timed out`, result));
				return;
			}
			if (aborted) {
				rejectCommand(new CommandError(`${options.label ?? executable} was aborted`, result));
				return;
			}
			if (options.check !== false && (signal || code !== 0)) {
				rejectCommand(
					new CommandError(
						stderr.trim() || `${options.label ?? executable} exited with ${signal ?? `code ${code}`}`,
						result,
					),
				);
				return;
			}
			resolveCommand(result);
		});
		if (options.stdin !== undefined) child.stdin.end(options.stdin);
	});
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readSourceAuth(authFile) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(authFile, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read ${authFile}: ${formatError(error)}`, { cause: error });
	}
	return isolateCodexAuth(parsed);
}

async function writeTemporaryAuth(isolatedAuth, onDirectoryCreated) {
	const authDir = await mkdtemp(join(tmpdir(), "volt-swebench-auth-"));
	onDirectoryCreated(authDir);
	await chmod(authDir, 0o700);
	const authPath = join(authDir, "auth.json");
	await writeFile(authPath, `${JSON.stringify(isolatedAuth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(authPath, 0o600);
	return authDir;
}

export async function preflight(options, dependencies = {}) {
	const command = dependencies.runCommand ?? runCommand;
	const platform = dependencies.platform ?? process.platform;
	const architecture = dependencies.arch ?? process.arch;
	if (platform !== "linux" || architecture !== "x64") {
		throw new Error(`SWE-bench smoke runs require Linux x64; received ${platform} ${architecture}`);
	}
	const voltDirectory = await stat(options.voltDir).catch(() => undefined);
	if (!voltDirectory?.isDirectory()) throw new Error(`--volt-dir is not a directory: ${options.voltDir}`);
	const voltPath = join(options.voltDir, "volt");
	await access(voltPath, fsConstants.X_OK).catch(() => {
		throw new Error(`Standalone executable is missing or not executable: ${voltPath}`);
	});
	if (await pathExists(options.outputDir)) throw new Error(`Output directory already exists: ${options.outputDir}`);
	const isolatedAuth = await readSourceAuth(options.authFile);
	await command("docker", ["version", "--format", "{{.Server.Version}}"], {
		label: "Docker preflight",
		timeoutMs: 30_000,
		signal: dependencies.signal,
	});
	await command(voltPath, ["--version"], {
		label: "Volt standalone preflight",
		timeoutMs: 30_000,
		signal: dependencies.signal,
	});
	await command(options.python, ["-c", PYTHON_PREFLIGHT_SCRIPT], {
		label: "SWE-bench Python preflight",
		timeoutMs: 60_000,
		signal: dependencies.signal,
	});
	return { isolatedAuth, voltPath };
}

async function resolveInstance(options, command, signal) {
	const result = await command(options.python, ["-c", METADATA_SCRIPT, options.instance], {
		label: "SWE-bench instance lookup",
		timeoutMs: 300_000,
		signal,
	});
	return parseInstanceMetadata(result.stdout, options.instance);
}

async function pullImageIfNeeded(image, command, signal) {
	const inspected = await command("docker", ["image", "inspect", image], {
		label: "Docker image lookup",
		check: false,
		timeoutMs: 30_000,
		signal,
	});
	if (inspected.code === 0) return;
	await command("docker", ["pull", image], {
		label: `Pull ${image}`,
		timeoutMs: 1_800_000,
		signal,
		tee: true,
	});
}

async function writeVoltLogs(outputDir, errorOrResult, secrets) {
	const result = errorOrResult instanceof CommandError ? errorOrResult.result : errorOrResult;
	await Promise.all([
		writeFile(join(outputDir, "volt.stdout.log"), redactText(result?.stdout ?? "", secrets), "utf8"),
		writeFile(join(outputDir, "volt.stderr.log"), redactText(result?.stderr ?? "", secrets), "utf8"),
	]);
}

async function runGeneration(options, metadata, isolatedAuth, dependencies) {
	const command = dependencies.runCommand ?? runCommand;
	const cleanup = new CleanupStack();
	let failure;
	let patch;
	try {
		const authDir = await writeTemporaryAuth(isolatedAuth, (createdAuthDir) => {
			cleanup.add("remove temporary Codex OAuth directory", () => rm(createdAuthDir, { recursive: true, force: true }));
		});
		const secrets = collectCredentialSecrets(isolatedAuth);
		await pullImageIfNeeded(metadata.image, command, dependencies.signal);
		const containerName = `volt-swebench-${process.pid}-${randomBytes(4).toString("hex")}`;
		cleanup.add("remove SWE-bench generation container", async () => {
			const result = await command("docker", ["rm", "--force", containerName], {
				label: "Remove SWE-bench generation container",
				check: false,
				timeoutMs: 30_000,
			});
			if (result.code !== 0 && !result.stderr.includes("No such container")) {
				throw new CommandError(result.stderr.trim() || "Failed to remove SWE-bench generation container", result);
			}
		});
		await command(
			"docker",
			buildDockerCreateArgs({
				containerName,
				image: metadata.image,
				voltDir: options.voltDir,
				authDir,
				outputDir: options.outputDir,
			}),
			{ label: "Create SWE-bench generation container", timeoutMs: 60_000, signal: dependencies.signal },
		);
		await command("docker", ["start", containerName], {
			label: "Start SWE-bench generation container",
			timeoutMs: 30_000,
			signal: dependencies.signal,
		});
		const statusResult = await command(
			"docker",
			["exec", "--workdir", "/testbed", containerName, "git", "status", "--porcelain", "--untracked-files=all"],
			{ label: "Check initial SWE-bench worktree", timeoutMs: 30_000, signal: dependencies.signal },
		);
		if (statusResult.stdout.trim()) throw new Error("SWE-bench image /testbed is not clean before Volt starts");
		const headResult = await command(
			"docker",
			["exec", "--workdir", "/testbed", containerName, "git", "rev-parse", "HEAD"],
			{ label: "Record initial SWE-bench HEAD", timeoutMs: 30_000, signal: dependencies.signal },
		);
		const initialHead = headResult.stdout.trim();
		if (!GIT_SHA_PATTERN.test(initialHead)) throw new Error("SWE-bench image returned an invalid initial HEAD");

		let voltResult;
		try {
			voltResult = await command("docker", buildVoltExecArgs({ containerName, model: options.model, thinking: options.thinking }), {
				label: "Volt SWE-bench generation",
				timeoutMs: options.timeoutSeconds * 1_000,
				signal: dependencies.signal,
			});
		} catch (error) {
			await writeVoltLogs(options.outputDir, error, secrets);
			if (error instanceof CommandError) {
				throw new CommandError(redactText(error.message, secrets), {
					...error.result,
					stdout: redactText(error.result.stdout ?? "", secrets),
					stderr: redactText(error.result.stderr ?? "", secrets),
				});
			}
			throw error instanceof Error
				? new Error(redactText(error.message, secrets), { cause: error })
				: new Error(redactText(String(error), secrets));
		}
		await writeVoltLogs(options.outputDir, voltResult, secrets);
		await command("docker", ["exec", "--workdir", "/testbed", containerName, "git", "add", "-A"], {
			label: "Stage SWE-bench patch",
			timeoutMs: 30_000,
			signal: dependencies.signal,
		});
		const patchResult = await command(
			"docker",
			[
				"exec",
				"--workdir",
				"/testbed",
				containerName,
				"git",
				"diff",
				"--cached",
				"--binary",
				initialHead,
				"--",
			],
			{ label: "Capture SWE-bench patch", timeoutMs: 60_000, signal: dependencies.signal },
		);
		patch = patchResult.stdout;
	} catch (error) {
		failure = error;
	} finally {
		try {
			await cleanup.run();
		} catch (cleanupError) {
			failure = failure
				? new AggregateError([failure, cleanupError], "SWE-bench generation and cleanup failed")
				: cleanupError;
		}
	}
	if (failure) throw failure;
	if (patch === undefined) throw new Error("SWE-bench generation ended without a patch result");
	return patch;
}

async function findJsonReports(directory) {
	const reports = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) reports.push(...(await findJsonReports(path)));
		else if (entry.isFile() && entry.name.endsWith(".json")) reports.push(path);
	}
	return reports;
}

async function writeEvaluationLogs(outputDir, errorOrResult) {
	const result = errorOrResult instanceof CommandError ? errorOrResult.result : errorOrResult;
	await Promise.all([
		writeFile(join(outputDir, "evaluation.stdout.log"), result?.stdout ?? "", "utf8"),
		writeFile(join(outputDir, "evaluation.stderr.log"), result?.stderr ?? "", "utf8"),
	]);
}

export async function runBenchmark(options, dependencies = {}) {
	const command = dependencies.runCommand ?? runCommand;
	const { isolatedAuth } = await preflight(options, dependencies);
	const metadata = await resolveInstance(options, command, dependencies.signal);
	await mkdir(options.outputDir, { recursive: true });
	const reportDir = join(options.outputDir, "evaluation");
	await mkdir(reportDir);
	await writeFile(join(options.outputDir, "prompt.md"), buildPrompt(metadata.problemStatement), "utf8");
	const patch = await runGeneration(options, metadata, isolatedAuth, dependencies);
	const patchPath = join(options.outputDir, "patch.diff");
	const predictionsPath = join(options.outputDir, "predictions.jsonl");
	await writeFile(patchPath, patch, "utf8");
	await writeFile(
		predictionsPath,
		`${JSON.stringify(createPrediction(metadata.instanceId, options.model, patch))}\n`,
		"utf8",
	);
	let evaluation;
	try {
		evaluation = await command(
			options.python,
			buildEvaluatorArgs({
				predictionsPath,
				runId: options.runId,
				instanceId: metadata.instanceId,
				reportDir,
			}),
			{
				cwd: options.outputDir,
				label: "SWE-bench evaluation",
				timeoutMs: 3_600_000,
				signal: dependencies.signal,
				tee: true,
			},
		);
	} catch (error) {
		await writeEvaluationLogs(options.outputDir, error);
		throw error;
	}
	await writeEvaluationLogs(options.outputDir, evaluation);
	const reports = await findJsonReports(reportDir);
	if (reports.length === 0) throw new Error("SWE-bench evaluation completed without writing a JSON report");
	for (const report of reports) {
		try {
			JSON.parse(await readFile(report, "utf8"));
		} catch (error) {
			throw new Error(`SWE-bench evaluation wrote malformed JSON: ${report}`, { cause: error });
		}
	}
	return { metadata, patchPath, predictionsPath, reportDir, reports };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(formatHelp());
		return;
	}
	const abortController = new AbortController();
	let receivedSignal;
	const handlers = new Map();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		const handler = () => {
			if (receivedSignal) return;
			receivedSignal = signal;
			abortController.abort();
		};
		process.on(signal, handler);
		handlers.set(signal, handler);
	}
	try {
		const result = await runBenchmark(options, { signal: abortController.signal });
		if (receivedSignal) {
			process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGHUP" ? 129 : 143;
		} else {
			process.stdout.write(`\nPredictions: ${result.predictionsPath}\nReports: ${result.reportDir}\n`);
		}
	} catch (error) {
		if (!receivedSignal) throw error;
		process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGHUP" ? 129 : 143;
	} finally {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
