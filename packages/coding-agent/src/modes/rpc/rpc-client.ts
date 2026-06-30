import { type ChildProcess, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { RpcClientBase } from "./rpc-client-base.ts";
import type { RpcCommand, RpcExtensionUIResponse, RpcHostActionResponse } from "./rpc-types.ts";

export type {
	ModelInfo,
	RpcClientEvent,
	RpcEventListener,
	RpcExtensionErrorEvent,
	RpcSubagentEndEvent,
	RpcSubagentEvent,
} from "./rpc-client-base.ts";
export type { RpcWorkflowEvent, RpcWorkflowToolEvent } from "./rpc-types.ts";

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Milliseconds to wait for a command response. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
}

/**
 * RPC client for programmatic access to the coding agent.
 *
 * This subprocess adapter spawns the Volt CLI in RPC mode and exchanges strict
 * JSONL over stdin/stdout. Use RpcTransportClient when the RPC transport already
 * exists in-process or over another transport such as Iroh.
 */
export class RpcClient extends RpcClientBase {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private stderr = "";
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		super({ requestTimeoutMs: options.requestTimeoutMs });
		this.options = options;
	}

	/** Start the RPC agent process. */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		this.clearFailureError();
		this.stderr = "";

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		childProcess.stderr?.on("data", (data: Buffer) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) {
				return;
			}
			this.handleProcessFailure(this.createProcessExitError(code, signal));
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) {
				return;
			}
			this.handleProcessFailure(new Error(`Agent process error: ${error.message}. ${this.getErrorContext()}`));
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) {
				return;
			}
			this.handleProcessFailure(new Error(`Agent process stdin error: ${error.message}. ${this.getErrorContext()}`));
		});

		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		try {
			await this.getState();
		} catch (error: unknown) {
			const readinessError = this.createReadinessError(toError(error));
			try {
				await this.cleanupFailedStart(childProcess);
			} catch (cleanupError: unknown) {
				throw new Error(
					`${readinessError.message}; additionally failed to clean up child process: ${toError(cleanupError).message}`,
				);
			}
			throw readinessError;
		}
	}

	/** Stop the RPC agent process. */
	async stop(): Promise<void> {
		const childProcess = this.process;
		if (!childProcess) {
			return;
		}

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.rejectPendingRequests(new Error("RPC client stopped"));
		await this.terminateChildProcess(childProcess);

		if (this.process === childProcess) {
			this.process = null;
		}
	}

	/** Get collected stderr output. */
	getStderr(): string {
		return this.stderr;
	}

	protected assertCanSend(): void {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		super.assertCanSend();
		if (this.hasProcessExited(childProcess)) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.handleProcessFailure(error);
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. ${this.getErrorContext()}`);
			this.handleProcessFailure(error);
			throw error;
		}
	}

	protected writeMessage(message: RpcCommand | RpcExtensionUIResponse | RpcHostActionResponse): void {
		const stdin = this.process?.stdin;
		if (!stdin) {
			throw new Error("Client not started");
		}
		stdin.write(serializeJsonLine(message));
	}

	protected getErrorContext(): string {
		return `Stderr: ${this.stderr}`;
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). ${this.getErrorContext()}`);
	}

	private createReadinessError(error: Error): Error {
		const context = this.getErrorContext();
		const contextSuffix = context && !error.message.includes(context) ? `. ${context}` : "";
		return new Error(`RPC readiness probe failed: ${error.message}${contextSuffix}`);
	}

	private async cleanupFailedStart(childProcess: ChildProcess): Promise<void> {
		if (this.process !== childProcess) {
			return;
		}

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.rejectPendingRequests(new Error("RPC client startup failed"));
		this.process = null;
		await this.terminateChildProcess(childProcess);
	}

	private async terminateChildProcess(childProcess: ChildProcess): Promise<void> {
		if (childProcess.pid === undefined || this.hasProcessExited(childProcess)) {
			return;
		}

		await new Promise<void>((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeout) {
					clearTimeout(timeout);
				}
				childProcess.off("exit", finish);
				resolve();
			};
			timeout = setTimeout(() => {
				if (!this.hasProcessExited(childProcess)) {
					childProcess.kill("SIGKILL");
				}
				finish();
			}, 1000);
			childProcess.once("exit", finish);

			if (this.hasProcessExited(childProcess)) {
				finish();
				return;
			}
			childProcess.kill("SIGTERM");
		});
	}

	private hasProcessExited(childProcess: ChildProcess): boolean {
		return childProcess.exitCode !== null || childProcess.signalCode !== null;
	}

	private handleProcessFailure(error: Error): void {
		this.setFailureError(error);
		this.rejectPendingRequests(error);
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
