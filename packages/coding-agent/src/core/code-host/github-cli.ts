import { Buffer } from "node:buffer";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";

const DEFAULT_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;

export interface GitHubCliResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
	outputLimited: boolean;
}

export interface GitHubCliRunOptions {
	cwd: string;
	input?: string;
	signal?: AbortSignal;
	stdoutMaxBytes?: number;
	stderrMaxBytes?: number;
	cancellationMessage?: string;
}

export async function runGitHubCli(args: readonly string[], options: GitHubCliRunOptions): Promise<GitHubCliResult> {
	const cancellationMessage = options.cancellationMessage ?? "GitHub CLI command was cancelled.";
	if (options.signal?.aborted) throw new Error(cancellationMessage);
	const stdoutMaxBytes = options.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES;
	const stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES;
	const result = await new Promise<GitHubCliResult>((resolveResult) => {
		const child = spawnProcess("gh", [...args], {
			cwd: options.cwd,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: process.env,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let outputLimited = false;
		let settled = false;
		const terminate = (): void => {
			child.stdin?.destroy();
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const onAbort = (): void => terminate();
		const finish = (commandResult: GitHubCliResult): void => {
			if (settled) return;
			settled = true;
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
		child.on("error", (error) => {
			finish({ ok: false, stdout: Buffer.concat(stdout), stderr: error.message, outputLimited: false });
		});
		child.on("close", (code) => {
			finish({
				ok: code === 0 && !outputLimited,
				stdout: outputLimited ? Buffer.alloc(0) : Buffer.concat(stdout, stdoutBytes),
				stderr: outputLimited
					? "GitHub CLI output exceeded its capture limit."
					: Buffer.concat(stderr).toString("utf8"),
				outputLimited,
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
