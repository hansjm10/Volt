import { spawn } from "node:child_process";

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	signal: NodeJS.Signals | null;
}

export interface CommandOptions {
	cwd: string;
	stdin?: string;
	maxOutputBytes?: number;
}

export interface CommandAdapter {
	run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
	runShell(command: string, options: CommandOptions): Promise<CommandResult>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class NodeCommandAdapter implements CommandAdapter {
	run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
		return runProcess(command, args, options, false);
	}

	runShell(command: string, options: CommandOptions): Promise<CommandResult> {
		return runProcess(command, [], options, true);
	}
}

function runProcess(
	command: string,
	args: readonly string[],
	options: CommandOptions,
	shell: boolean,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			shell,
			windowsHide: true,
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const maximum = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let overflow: Error | undefined;

		const append = (current: string, chunk: Buffer | string): string => {
			const text = chunk.toString();
			outputBytes += Buffer.byteLength(text, "utf8");
			if (outputBytes > maximum) {
				overflow = new Error(`Command output exceeded ${maximum} bytes: ${command}`);
				child.kill();
				return current;
			}
			return current + text;
		};

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = append(stderr, chunk);
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (overflow) {
				reject(overflow);
				return;
			}
			resolve({ code, signal, stdout, stderr });
		});
		if (options.stdin !== undefined) {
			child.stdin?.end(options.stdin);
		}
	});
}

export function requireSuccessfulCommand(result: CommandResult, description: string): string {
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.code)}`;
		throw new Error(`${description} failed: ${detail}`);
	}
	return result.stdout;
}
