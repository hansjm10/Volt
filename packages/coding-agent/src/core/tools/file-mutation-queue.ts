import { realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let existingPath = resolvedPath;
	while (true) {
		try {
			const canonicalParent = await realpath(existingPath);
			const suffix = relative(existingPath, resolvedPath);
			return suffix ? join(canonicalParent, suffix) : canonicalParent;
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
			const parent = dirname(existingPath);
			if (parent === existingPath) {
				return resolvedPath;
			}
			existingPath = parent;
		}
	}
}

/**
 * Serialize mutation operations that touch any overlapping path. The complete
 * sorted key set is registered atomically so callers cannot deadlock by
 * requesting the same paths in different orders.
 */
export async function withFileMutationQueues<T>(filePaths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const keys = [...new Set(await Promise.all(filePaths.map(getMutationQueueKey)))].sort();
		const currentQueues = keys.map((key) => fileMutationQueues.get(key) ?? Promise.resolve());
		const currentQueue = Promise.all(currentQueues).then(() => undefined);

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		for (const key of keys) {
			fileMutationQueues.set(key, chainedQueue);
		}

		return { keys, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { keys, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		for (const key of keys) {
			if (fileMutationQueues.get(key) === chainedQueue) {
				fileMutationQueues.delete(key);
			}
		}
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return withFileMutationQueues([filePath], fn);
}
