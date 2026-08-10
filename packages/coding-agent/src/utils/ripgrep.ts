import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { spawnProcess } from "./child-process.ts";

export interface RipgrepJsonMatch {
	path: string;
	lineNumber: number;
	lineText?: string;
}

export interface RipgrepJsonResult {
	exitCode: number | null;
	stderr: string;
	stoppedEarly: boolean;
}

export interface RipgrepJsonOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	maxStderrBytes?: number;
	onMatch: (match: RipgrepJsonMatch) => boolean | undefined;
}

function encodedText(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.bytes === "string") return Buffer.from(record.bytes, "base64").toString("utf8");
	return undefined;
}

function parseMatch(line: string): RipgrepJsonMatch | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>;
	if (event.type !== "match" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
		return undefined;
	}
	const data = event.data as Record<string, unknown>;
	const path = encodedText(data.path);
	const lineNumber = data.line_number;
	const lineText = encodedText(data.lines);
	if (!path || typeof lineNumber !== "number" || !Number.isSafeInteger(lineNumber) || lineNumber < 1) {
		return undefined;
	}
	return { path, lineNumber, ...(lineText === undefined ? {} : { lineText }) };
}

export function runRipgrepJson(
	executable: string,
	args: string[],
	options: RipgrepJsonOptions,
): Promise<RipgrepJsonResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawnProcess(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.env ? { env: options.env } : {}),
		});
		const lines = createInterface({ input: child.stdout });
		const maximumStderrBytes = options.maxStderrBytes ?? 64 * 1024;
		let stderr = Buffer.alloc(0);
		let stderrExceeded = false;
		let stoppedEarly = false;
		let aborted = false;
		let callbackError: unknown;
		let settled = false;

		const cleanup = (): void => {
			lines.close();
			options.signal?.removeEventListener("abort", onAbort);
		};
		const stop = (): void => {
			if (!child.killed) child.kill();
		};
		const onAbort = (): void => {
			aborted = true;
			stop();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrExceeded) return;
			if (stderr.length + chunk.length > maximumStderrBytes) {
				stderrExceeded = true;
				stderr = Buffer.alloc(0);
				stop();
				return;
			}
			stderr = Buffer.concat([stderr, chunk]);
		});
		lines.on("line", (line) => {
			if (stoppedEarly || callbackError !== undefined) return;
			const match = parseMatch(line);
			if (!match) return;
			try {
				if (options.onMatch(match) === false) {
					stoppedEarly = true;
					stop();
				}
			} catch (error) {
				callbackError = error;
				stop();
			}
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`Failed to run ripgrep: ${error.message}`));
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			if (callbackError !== undefined) {
				reject(callbackError);
				return;
			}
			if (stderrExceeded) {
				reject(new Error(`ripgrep stderr exceeded ${maximumStderrBytes} bytes`));
				return;
			}
			resolve({ exitCode, stderr: stderr.toString("utf8"), stoppedEarly });
		});
	});
}
