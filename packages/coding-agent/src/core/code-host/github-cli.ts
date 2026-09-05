import { Buffer } from "node:buffer";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";

const DEFAULT_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function createGitHubCliEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of [
		"GH_REPO",
		"GH_HOST",
		"GH_DEBUG",
		"GH_FORCE_TTY",
		"GH_BROWSER",
		"GH_EDITOR",
		"GH_CONFIG_DIR",
		"DEBUG",
	]) {
		delete environment[key];
	}
	environment.GH_PROMPT_DISABLED = "1";
	environment.GH_PAGER = "cat";
	environment.PAGER = "cat";
	environment.GH_NO_UPDATE_NOTIFIER = "1";
	environment.NO_COLOR = "1";
	environment.CLICOLOR = "0";
	return environment;
}

export interface GitHubCliResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
	outputLimited: boolean;
	timedOut: boolean;
}

export interface GitHubCliRunOptions {
	cwd: string;
	input?: string;
	signal?: AbortSignal;
	stdoutMaxBytes?: number;
	stderrMaxBytes?: number;
	timeoutMs?: number;
	cancellationMessage?: string;
}

export async function runGitHubCli(args: readonly string[], options: GitHubCliRunOptions): Promise<GitHubCliResult> {
	const cancellationMessage = options.cancellationMessage ?? "GitHub CLI command was cancelled.";
	if (options.signal?.aborted) throw new Error(cancellationMessage);
	const stdoutMaxBytes = Math.max(1, options.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES);
	const stderrMaxBytes = Math.max(1, options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES);
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const result = await new Promise<GitHubCliResult>((resolveResult) => {
		const child = spawnProcess("gh", [...args], {
			cwd: options.cwd,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: createGitHubCliEnvironment(),
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let outputLimited = false;
		let timedOut = false;
		let settled = false;
		const terminate = (): void => {
			child.stdin?.destroy();
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const onAbort = (): void => terminate();
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		timeout.unref?.();
		const finish = (commandResult: GitHubCliResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			resolveResult(commandResult);
		};
		const limitOutput = (): void => {
			if (outputLimited) return;
			outputLimited = true;
			terminate();
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (outputLimited) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > stdoutMaxBytes) limitOutput();
			else stdout.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (outputLimited) return;
			stderrBytes += chunk.length;
			if (stderrBytes > stderrMaxBytes) limitOutput();
			else stderr.push(chunk);
		});
		child.on("error", () => {
			finish({
				ok: false,
				stdout: Buffer.concat(stdout),
				stderr: "Unable to start GitHub CLI.",
				outputLimited: false,
				timedOut: false,
			});
		});
		child.on("close", (code) => {
			finish({
				ok: code === 0 && !outputLimited && !timedOut,
				stdout: outputLimited || timedOut ? Buffer.alloc(0) : Buffer.concat(stdout, stdoutBytes),
				stderr: outputLimited
					? "GitHub CLI output exceeded its capture limit."
					: timedOut
						? "GitHub CLI command timed out."
						: Buffer.concat(stderr).toString("utf8"),
				outputLimited,
				timedOut,
			});
		});
		child.stdin?.on("error", () => {});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		else if (options.input !== undefined) child.stdin?.end(options.input);
	});
	if (options.signal?.aborted) throw new Error(cancellationMessage);
	return result;
}
