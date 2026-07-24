import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function assertPrivateRegularFile(stat: ReturnType<typeof fstatSync>, filePath: string): void {
	if (!stat.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${filePath}`);
	}
	if (stat.nlink !== 1) {
		throw new Error(`Refusing to use multiply-linked private file: ${filePath}`);
	}
}

/** Open an existing owner-only regular file without following a symlink leaf. */
export async function openPrivateRegularFile(filePath: string, flags: number): Promise<FileHandle> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(filePath, flags | noFollow);
	try {
		const handleStat = await handle.stat();
		assertPrivateRegularFile(handleStat, filePath);
		if (noFollow === 0) {
			// Platforms without O_NOFOLLOW need a post-open identity check. A symlink
			// leaf has different lstat identity from the object the handle followed;
			// a concurrent replacement with another regular file also mismatches.
			const pathStat = await lstat(filePath);
			if (
				pathStat.isSymbolicLink() ||
				!pathStat.isFile() ||
				pathStat.dev !== handleStat.dev ||
				pathStat.ino !== handleStat.ino
			) {
				throw new Error(`Refusing to use non-private file path: ${filePath}`);
			}
		}
		await handle.chmod(PRIVATE_FILE_MODE);
		return handle;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

/**
 * Create a directory if needed, reject a symlink leaf, and make it owner-only.
 *
 * Set `hardenExisting` to false for a caller-provided parent directory. This
 * still creates a missing leaf privately without unexpectedly chmodding a
 * shared directory such as the process temp root.
 */
export function ensurePrivateDirectorySync(directoryPath: string, options: { hardenExisting?: boolean } = {}): void {
	let existed = true;
	try {
		lstatSync(directoryPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		existed = false;
	}
	mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	const stat = lstatSync(directoryPath);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Refusing to use non-directory private path: ${directoryPath}`);
	}
	if (!existed || options.hardenExisting !== false) {
		chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
	}
}

/** Reject links and tighten an existing sensitive file to owner-only access. */
export function hardenPrivateRegularFileSync(filePath: string): void {
	const stat = lstatSync(filePath);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${filePath}`);
	}
	if (stat.nlink !== 1) {
		throw new Error(`Refusing to use multiply-linked private file: ${filePath}`);
	}
	chmodSync(filePath, PRIVATE_FILE_MODE);
}

function appendPrivateFileWithDurabilitySync(filePath: string, content: string, durable: boolean): void {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const fd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND | noFollow);
	try {
		assertPrivateRegularFile(fstatSync(fd), filePath);
		fchmodSync(fd, PRIVATE_FILE_MODE);
		writeFileSync(fd, content, "utf8");
		if (durable) {
			fsyncSync(fd);
		}
	} finally {
		closeSync(fd);
	}
}

/** Append through an owner-only, no-follow handle. The file must already exist. */
export function appendPrivateFileSync(filePath: string, content: string): void {
	appendPrivateFileWithDurabilitySync(filePath, content, false);
}

/** Append and fsync through an owner-only, no-follow handle. The file must already exist. */
export function appendDurablePrivateFileSync(filePath: string, content: string): void {
	appendPrivateFileWithDurabilitySync(filePath, content, true);
}

/** Create a collision-resistant owner-only directory beneath a caller-provided prefix. */
export function createPrivateTempDirectorySync(prefixPath: string): string {
	const directoryPath = mkdtempSync(prefixPath);
	chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
	return directoryPath;
}

/** Create a new owner-only file asynchronously without ever replacing an existing path. */
export async function writePrivateNewFile(filePath: string, content: string): Promise<void> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let handle: FileHandle | undefined;
	let created = false;
	try {
		handle = await open(
			filePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
			PRIVATE_FILE_MODE,
		);
		created = true;
		assertPrivateRegularFile(await handle.stat(), filePath);
		await handle.chmod(PRIVATE_FILE_MODE);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		if (process.platform !== "win32") {
			const parentHandle = await open(dirname(filePath), "r");
			try {
				await parentHandle.sync();
			} finally {
				await parentHandle.close();
			}
		}
	} catch (error) {
		if (handle) {
			await handle.close().catch(() => {});
		}
		if (created) {
			await rm(filePath, { force: true }).catch(() => {});
		}
		throw error;
	}
}

/** Create a new owner-only scratch file without ever replacing an existing path. */
export function writePrivateNewFileSync(filePath: string, content: string | NodeJS.ArrayBufferView): void {
	const fd = openSync(filePath, "wx", PRIVATE_FILE_MODE);
	try {
		fchmodSync(fd, PRIVATE_FILE_MODE);
		writeFileSync(fd, content);
		fsyncSync(fd);
		closeSync(fd);
		if (process.platform !== "win32") {
			const parentFd = openSync(dirname(filePath), "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		}
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// Preserve the original creation error.
		}
		try {
			rmSync(filePath, { force: true });
		} catch {
			// Preserve the original creation error.
		}
		throw error;
	}
}
