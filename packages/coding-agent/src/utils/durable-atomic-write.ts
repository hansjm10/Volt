import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface DurableAtomicWriteOperations {
	mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
	open(path: string, flags: string, mode?: number): Promise<Pick<FileHandle, "close" | "sync" | "writeFile">>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { force: true }): Promise<void>;
}

const DEFAULT_OPERATIONS: DurableAtomicWriteOperations = { mkdir, open, rename, rm };

export interface DurableFileSyncOperations {
	open(path: string, flags: "r" | "r+"): Promise<Pick<FileHandle, "close" | "sync">>;
}

const DEFAULT_FILE_SYNC_OPERATIONS: DurableFileSyncOperations = { open };

export interface DurableAtomicWriteSyncOperations {
	mkdir(path: string, options: { recursive: true; mode: number }): unknown;
	open(path: string, flags: string, mode?: number): number;
	writeFile(fd: number, content: string, encoding: "utf8"): void;
	fsync(fd: number): void;
	close(fd: number): void;
	rename(from: string, to: string): void;
	rm(path: string, options: { force: true }): void;
}

const DEFAULT_SYNC_OPERATIONS: DurableAtomicWriteSyncOperations = {
	mkdir: mkdirSync,
	open: openSync,
	writeFile: writeFileSync,
	fsync: fsyncSync,
	close: closeSync,
	rename: renameSync,
	rm: rmSync,
};

/**
 * Make the currently visible file and its directory entry durable. The target is
 * synchronized before its parent so callers can recheck visibility afterward.
 */
export async function syncDurableFile(
	path: string,
	options: { operations?: DurableFileSyncOperations } = {},
): Promise<void> {
	const operations = options.operations ?? DEFAULT_FILE_SYNC_OPERATIONS;
	const targetHandle = await operations.open(path, "r+");
	try {
		await targetHandle.sync();
	} finally {
		await targetHandle.close();
	}

	if (process.platform !== "win32") {
		const parentHandle = await operations.open(dirname(path), "r");
		try {
			await parentHandle.sync();
		} finally {
			await parentHandle.close();
		}
	}
}

/**
 * Atomically replace a security-sensitive file and make the replacement durable
 * across power loss: fsync the temp file before rename, then fsync its parent.
 */
export async function writeDurableAtomicFile(
	path: string,
	content: string | Uint8Array,
	options: { directoryMode?: number; fileMode?: number; operations?: DurableAtomicWriteOperations } = {},
): Promise<void> {
	const operations = options.operations ?? DEFAULT_OPERATIONS;
	const parentPath = dirname(path);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let tempHandle: Awaited<ReturnType<DurableAtomicWriteOperations["open"]>> | undefined;
	let renamed = false;

	await operations.mkdir(parentPath, { recursive: true, mode: options.directoryMode ?? 0o700 });
	try {
		tempHandle = await operations.open(tempPath, "wx", options.fileMode ?? 0o600);
		if (typeof content === "string") {
			await tempHandle.writeFile(content, "utf8");
		} else {
			await tempHandle.writeFile(content);
		}
		await tempHandle.sync();
		await tempHandle.close();
		tempHandle = undefined;

		await operations.rename(tempPath, path);
		renamed = true;

		if (process.platform !== "win32") {
			const parentHandle = await operations.open(parentPath, "r");
			try {
				await parentHandle.sync();
			} finally {
				await parentHandle.close();
			}
		}
	} catch (error) {
		if (tempHandle) {
			await tempHandle.close().catch(() => {});
		}
		if (!renamed) {
			await operations.rm(tempPath, { force: true }).catch(() => {});
		}
		throw error;
	}
}

/**
 * Synchronous counterpart to writeDurableAtomicFile for persistence paths whose
 * public API is synchronous. The replacement is created with owner-only
 * permissions and never writes through an existing destination symlink.
 */
export function writeDurableAtomicFileSync(
	path: string,
	content: string,
	options: {
		directoryMode?: number;
		fileMode?: number;
		operations?: DurableAtomicWriteSyncOperations;
	} = {},
): void {
	const operations = options.operations ?? DEFAULT_SYNC_OPERATIONS;
	const parentPath = dirname(path);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let tempFd: number | undefined;
	let renamed = false;

	operations.mkdir(parentPath, { recursive: true, mode: options.directoryMode ?? 0o700 });
	try {
		tempFd = operations.open(tempPath, "wx", options.fileMode ?? 0o600);
		operations.writeFile(tempFd, content, "utf8");
		operations.fsync(tempFd);
		operations.close(tempFd);
		tempFd = undefined;

		operations.rename(tempPath, path);
		renamed = true;

		if (process.platform !== "win32") {
			const parentFd = operations.open(parentPath, "r");
			try {
				operations.fsync(parentFd);
			} finally {
				operations.close(parentFd);
			}
		}
	} catch (error) {
		if (tempFd !== undefined) {
			try {
				operations.close(tempFd);
			} catch {
				// Preserve the original persistence error.
			}
		}
		if (!renamed) {
			try {
				operations.rm(tempPath, { force: true });
			} catch {
				// Preserve the original persistence error.
			}
		}
		throw error;
	}
}
