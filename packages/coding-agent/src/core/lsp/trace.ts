/**
 * LSP protocol tracing.
 *
 * Appends timestamped JSON-RPC traffic, server stderr, and lifecycle events
 * to a log file. The file handle is opened once and kept open (per-line
 * open/append/close is prohibitively slow under antivirus scanning). Writes
 * are serialized and best-effort: tracing must never affect the operations
 * it observes.
 */

import { type FileHandle, open } from "node:fs/promises";

export type LspTraceDirection = "send" | "recv" | "stderr" | "info";

/** Cap per-entry payload size so didOpen/didChange of large files stay readable. */
const MAX_ENTRY_LENGTH = 4000;

export class LspTracer {
	readonly filePath: string;
	private handle: FileHandle | undefined;
	private failed = false;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	log(serverName: string, direction: LspTraceDirection, text: string): void {
		let payload = text.replace(/\r?\n$/, "");
		if (payload.length > MAX_ENTRY_LENGTH) {
			payload = `${payload.slice(0, MAX_ENTRY_LENGTH)}... (${payload.length - MAX_ENTRY_LENGTH} more chars)`;
		}
		const line = `${new Date().toISOString()} [${serverName}] ${direction}: ${payload}\n`;
		this.writeQueue = this.writeQueue.then(async () => {
			if (this.failed) {
				return;
			}
			try {
				this.handle ??= await open(this.filePath, "a");
				await this.handle.write(line);
			} catch {
				// Tracing is best-effort; disable on the first write failure
				// (e.g. unwritable path) instead of retrying every entry.
				this.failed = true;
			}
		});
	}

	/** Wait for queued writes to land (used by tests). */
	flush(): Promise<void> {
		return this.writeQueue;
	}

	/** Close the trace file after pending writes complete. */
	dispose(): void {
		this.writeQueue = this.writeQueue
			.then(async () => {
				await this.handle?.close();
				this.handle = undefined;
				this.failed = true;
			})
			.catch(() => {
				this.handle = undefined;
				this.failed = true;
			});
	}
}
